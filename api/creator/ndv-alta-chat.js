/**
 * NOTA DE VENTA del ALTA POR CHAT — convertir + confirmar ANTES de la
 * Implementación (orden de Lalo 07-sep: "la NDV la confirmamos NOSOTROS en el
 * flujo, antes de crear la implementación, para tener el ID desde antes").
 *
 * Camino: cuando Vicky crea la empresa en la plataforma (alta por chat), el
 * agente llama acá con la cotización PAGADA y el companyId que devolvió la API
 * de alta. Este endpoint:
 *   1. ubica el ESPEJO de la cotización en Creator (CRM_REFERENCE_ID = id de
 *      la cotización del CRM; la emisión lo estampa en el maestro);
 *   2. si aún no hay Nota de Venta, la CONVIERTE con la empresa YA creada
 *      ("Creada en Plataforma" + Empresa_dropdown NOMBRE-RUT-ID) — sin eso el
 *      equipo crea una segunda empresa (caso Maquinarias);
 *   3. la CONFIRMA cuando su PDF existe (ConfirmNDV: totales, CONFIRMADA, SO
 *      si hay hardware, y la Referencia NDV en el CRM);
 *   4. localiza la Referencia NDV del CRM (ID_ZOHO = id del registro Creator)
 *      y la deja enlazada en la cotización (lookup Nota_de_Venta).
 *
 * Es IDEMPOTENTE y MULTI-PASADA: cada llamada avanza lo que puede dentro de
 * su presupuesto de tiempo y responde `listo:true` solo cuando la Referencia
 * NDV existe. El agente reintenta (cron cada ~2') hasta que esté listo o se
 * venza su tope, y recién ahí crea la Implementación con el id de la NDV.
 *
 * Auth: x-vicky-secret (agente) o Bearer CRON_SECRET.
 * POST { quoteId, companyId, empresaNombre?, rut? }
 */
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getRecord, updateRecordBestEffort, coqlQuery, toText } = require("../_shared/zoho-crm");
const { getCreatorConfig, creatorApiFetch } = require("../_shared/zoho-creator-auth");
const { convertirYConfirmar, confirmarNota } = require("../_shared/ndv-conversion");

// Bajo el maxDuration (60 s) con margen para responder.
const PRESUPUESTO_MS = 48_000;
const REFERENCIAS_MODULE = toText(process.env.ZOHO_NDV_REFERENCIAS_MODULE) || "Referencias_NDV";
// Lookup de la cotización a la Referencia NDV (verificado: COT1245 →
// Nota_de_Venta = {id de Referencias_NDV, name "NDV-31587"}).
const QUOTE_NDV_REF_FIELD = toText(process.env.QUOTE_NDV_REFERENCIA_FIELD) || "Nota_de_Venta";

function texto(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return String(v.display_value || v.zc_display_value || v.ID || v.id || "").trim();
  return String(v).trim();
}
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}
function parseBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return typeof req.body === "object" && req.body ? req.body : {};
}
function authorized(req) {
  if (secretoValido(req)) return true;
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  return Boolean(cronSecret) && bearer === cronSecret;
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function reportPath(cfg) {
  return (
    `/creator/v2.1/data/${encodeURIComponent(cfg.ownerName)}/${encodeURIComponent(cfg.appLinkName)}` +
    `/report/${encodeURIComponent(cfg.reportLinkName)}`
  );
}
async function filasCreator(cfg, criteria) {
  try {
    const r = await creatorApiFetch(
      `${reportPath(cfg)}?criteria=${encodeURIComponent(criteria)}&limit=50&field_config=all`,
      { method: "GET" },
    );
    // Creator responde 404 (código 3100) cuando el criterio no trae filas.
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j?.data) ? j.data : [];
  } catch {
    return [];
  }
}
async function leerRegistro(cfg, id) {
  try {
    const r = await creatorApiFetch(`${reportPath(cfg)}/${encodeURIComponent(id)}?field_config=all`, { method: "GET" });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    return j?.data || null;
  } catch {
    return null;
  }
}

/** "NOMBRE-RUT-ID": RUT sin puntos ni guión, con DV (así lo espera el dropdown
 * de la app; verificado con NDV-31587: "Maquinarias Santa Sara Spa-774072896-49"). */
function empresaDropdownDe({ nombre, rut, companyId }) {
  const r = texto(rut).replace(/[^0-9kK]/g, "").toUpperCase();
  return `${texto(nombre)}-${r}-${texto(companyId)}`;
}

/** Mensual VENDIDO según la cotización aceptada (ítems recurrentes), para
 * informar un eventual descuadre con la nota — NO bloquea la confirmación
 * (el espejo de Creator tiene diferencias conocidas: envío bonificado,
 * arriendo). El agente avisa si no calza. */
function mensualVendidoUF(quote, config) {
  const items = Array.isArray(quote?.[config.quoteItemsSubformField]) ? quote[config.quoteItemsSubformField] : [];
  const rec = items.filter((x) => x?.Es_Recurrente === true || texto(x?.Es_Recurrente) === "true");
  if (!rec.length) return null;
  return Number(rec.reduce((acc, x) => acc + (Number(x?.Subtotal_UF) || 0), 0).toFixed(5));
}

async function referenciaPorCreatorId(ndvId) {
  const rows = await coqlQuery(
    `select id, Name, ESTADO from ${REFERENCIAS_MODULE} where ID_ZOHO = '${String(ndvId).replace(/[^0-9]/g, "")}'`,
  ).catch(() => []);
  const r = rows[0];
  return r ? { id: texto(r.id), nombre: texto(r.Name), estado: texto(r.ESTADO) } : null;
}

/**
 * El espejo (Formulario "Cotización") de la cotización del CRM.
 *
 * OJO: el maestro de Creator NO guarda el id de la cotización del CRM —
 * `CRM_REFERENCE_ID` se descarta al emitir porque los ids de Zoho (19
 * dígitos) exceden el entero seguro de JS (verificado 07-sep: vacío en el
 * espejo de TESLA AUSTRAL). Se ubica por CUENTA (CRM_Account, criterio con
 * comillas — así lo consulta catastro y funciona) y, si hay varias
 * cotizaciones de la misma cuenta, por cercanía a la fecha de emisión,
 * prefiriendo las que aún no están convertidas. Alta por chat = una
 * cotización pagada por cuenta en la práctica.
 */
async function espejoDeCotizacion(cfg, quote, quoteId) {
  const idNum = quoteId.replace(/\D/g, "");
  // Por si algún día el id cabe / se guarda como texto: exacto primero.
  let filas = await filasCreator(cfg, `(CRM_REFERENCE_ID == "${idNum}")`);
  let cots = filas.filter((f) => texto(f.Formulario) === "Cotización");
  if (cots.length) return { cot: cots[0], por: "CRM_REFERENCE_ID", candidatos: cots.length };

  const accountId = texto(quote?.Cuenta_Asociada?.id || quote?.Cuenta_Asociada);
  if (!accountId) return { cot: null, por: "sin_cuenta" };
  const porCuenta = (await filasCreator(cfg, `(CRM_Account == "${accountId}")`)).filter(
    (f) => texto(f.Formulario) === "Cotización",
  );
  if (!porCuenta.length) return { cot: null, por: "sin_espejo" };
  const emitida = Date.parse(String(quote?.Fecha_Hora_Cotizacion || quote?.Created_Time || "")) || 0;
  // Added_Time viene "DD-MM-YYYY HH:mm:ss" en hora de Chile (UTC-3/-4).
  const ts = (f) => {
    const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(texto(f.Added_Time));
    return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] + 3, +m[5], +m[6]) : 0;
  };
  const rutQ = texto(quote?.RUT_Cliente).replace(/[^0-9kK]/g, "").toUpperCase();
  const puntaje = (f) => {
    const convertida = texto(f.ESTADO_COT) === "Convertida a NDV" ? 1 : 0;
    const rutF = texto(f.Identificador_Tributario_Empresa).replace(/[^0-9kK]/g, "").toUpperCase();
    const rutDistinto = rutQ && rutF && rutQ !== rutF ? 1 : 0;
    return [rutDistinto, convertida, Math.abs(ts(f) - emitida)];
  };
  porCuenta.sort((a, b) => {
    const pa = puntaje(a);
    const pb = puntaje(b);
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  });
  return { cot: porCuenta[0], por: "CRM_Account+fecha", candidatos: porCuenta.length };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Método no permitido." });
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });

  const inicio = Date.now();
  const queda = () => PRESUPUESTO_MS - (Date.now() - inicio);
  let paso = "init";
  const pasos = [];
  try {
    const body = parseBody(req);
    const quoteId = toText(body.quoteId).replace(/\D/g, "");
    const companyId = toText(body.companyId).replace(/\D/g, "");
    if (!quoteId) return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    if (!companyId) return sendJson(res, 400, { ok: false, error: "Falta companyId (id de la empresa en la plataforma)." });

    const config = getAcceptanceConfig(req);
    paso = "load_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) return sendJson(res, 404, { ok: false, error: `No se encontró la cotización ${quoteId}.` });

    // 0. Ya enlazada: nada que hacer.
    const refActual = quote?.[QUOTE_NDV_REF_FIELD];
    const refActualId = texto(refActual?.id || refActual);
    if (refActualId && /^\d{10,}$/.test(refActualId)) {
      const ref = await getRecord(REFERENCIAS_MODULE, refActualId).catch(() => null);
      return sendJson(res, 200, {
        ok: true,
        listo: true,
        yaEstaba: true,
        referenciaId: refActualId,
        idNdv: texto(ref?.Name || refActual?.name),
        estadoReferencia: texto(ref?.ESTADO),
        ndvId: texto(ref?.ID_ZOHO),
      });
    }

    const cfg = getCreatorConfig();
    if (cfg.missing.length > 0) {
      return sendJson(res, 500, { ok: false, error: `Faltan variables de Zoho Creator: ${cfg.missing.join(", ")}` });
    }

    // 1. Espejo en Creator. `cotId` explícito (admin) fuerza uno: al REHACER
    //    una nota, el espejo viejo —convertido a una NDV que luego se anuló—
    //    sigue siendo el más cercano a la fecha de emisión y ganaría el sorteo.
    paso = "espejo";
    const cotForzado = toText(body.cotId).replace(/\D/g, "");
    const { cot, por, candidatos } = cotForzado
      ? {
          cot: (await filasCreator(cfg, `(ID == ${cotForzado})`)).find((f) => texto(f.Formulario) === "Cotización") || null,
          por: "cotId",
          candidatos: 1,
        }
      : await espejoDeCotizacion(cfg, quote, quoteId);
    if (!cot) {
      return sendJson(res, 200, {
        ok: false,
        listo: false,
        reintentable: false,
        error: `la cotización ${quoteId} no tiene espejo en Creator (${por})`,
      });
    }
    const cotId = texto(cot.ID);
    pasos.push({ espejo: { cotId, numero: texto(cot.ID_NDV), por, candidatos, estadoCot: texto(cot.ESTADO_COT) } });

    const empresaDropdown = empresaDropdownDe({
      nombre: toText(body.empresaNombre) || texto(cot.CRM_ACCOUNT_NAME) || texto(quote?.Cuenta_Asociada?.name),
      rut: toText(body.rut) || texto(quote?.RUT_Cliente) || texto(cot.Identificador_Tributario_Empresa),
      companyId,
    });

    // 2. Nota de venta existente (cualquier estado) o conversión nueva.
    paso = "nota";
    // Una nota ANULADA no cuenta: se convierte de nuevo (caso Molinas 07-sep,
    // NDV-31616/31619 anuladas para rehacer la nota con el reloj).
    let nota =
      (await filasCreator(cfg, `(Cotizacion_Origen == ${cotId})`)).find(
        (f) => texto(f.Formulario) === "Nota de Venta" && texto(f.STATUS) !== "ANULADA",
      ) || null;
    if (!nota) {
      if (texto(cot.ESTADO_COT) === "Convertida a NDV") {
        return sendJson(res, 200, {
          ok: false,
          listo: false,
          reintentable: false,
          cotId,
          error: "la cotización figura convertida pero no se localiza su nota (revisar en Creator)",
        });
      }
      if (queda() < 20_000) {
        return sendJson(res, 200, { ok: true, listo: false, reintentable: true, pendiente: "convertir", cotId, pasos });
      }
      const conv = await convertirYConfirmar(cotId, { confirmar: false, empresaDropdown }).catch((e) => ({
        ok: false,
        error: e.message,
      }));
      pasos.push({ convertir: conv });
      if (!conv?.ok || !texto(conv.ndvId)) {
        return sendJson(res, 200, {
          ok: false,
          listo: false,
          reintentable: true,
          cotId,
          error: `no se pudo convertir: ${texto(conv?.error) || texto(conv?.paso) || "sin detalle"}`,
          pasos,
        });
      }
      nota = (await leerRegistro(cfg, conv.ndvId)) || { ID: conv.ndvId };
    }
    const ndvId = texto(nota.ID);
    let estado = texto(nota.STATUS);
    let idNdv = texto(nota.ID_NDV);

    // 2b. La empresa de la plataforma en la nota: ConfirmNDV arma la Referencia
    // NDV (Nombre_Empresa / ID_GeoVictoria) desde ID_Empresa_GeoVictoria del
    // registro — si la nota ya existía sin ese dato, se estampa antes.
    if (estado !== "CONFIRMADA" && !texto(nota.ID_Empresa_GeoVictoria)) {
      await creatorApiFetch(`${reportPath(cfg)}/${encodeURIComponent(ndvId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { ID_Empresa_GeoVictoria: companyId, GeoCompanyIdCRM: companyId } }),
      }).catch(() => null);
      pasos.push({ empresaEnNota: companyId });
    }

    // 3. Confirmar cuando el PDF exista.
    paso = "confirmar";
    if (estado !== "CONFIRMADA") {
      let conf = null;
      for (let i = 0; i < 8; i++) {
        conf = await confirmarNota(ndvId).catch((e) => ({ ok: false, error: e.message }));
        if (conf?.confirmada) break;
        if (!conf?.reintentable || queda() < 12_000) break;
        await dormir(4000);
      }
      pasos.push({ confirmar: conf });
      idNdv = texto(conf?.idNdv) || idNdv;
      if (!conf?.confirmada) {
        return sendJson(res, 200, {
          ok: true,
          listo: false,
          reintentable: conf?.reintentable !== false,
          pendiente: conf?.reintentable ? "pdf" : "confirmacion",
          error: texto(conf?.error) || undefined,
          cotId,
          ndvId,
          idNdv,
          empresaDropdown,
          pasos,
        });
      }
      estado = "CONFIRMADA";
    }

    // 4. Referencia NDV en el CRM (la crea ConfirmNDV; puede tardar segundos).
    paso = "referencia";
    let ref = null;
    for (let i = 0; i < 5; i++) {
      ref = await referenciaPorCreatorId(ndvId);
      if (ref || queda() < 4_000) break;
      await dormir(3000);
    }
    if (!ref) {
      return sendJson(res, 200, {
        ok: true,
        listo: false,
        reintentable: true,
        pendiente: "referencia",
        cotId,
        ndvId,
        idNdv,
        empresaDropdown,
        pasos,
      });
    }
    paso = "enlazar";
    await updateRecordBestEffort(config.quoteModule, quoteId, { [QUOTE_NDV_REF_FIELD]: { id: ref.id } }, true).catch(
      () => null,
    );
    const notaFinal = (await leerRegistro(cfg, ndvId)) || nota;
    const totalNota = Number(texto(notaFinal.TOTAL_SERVICIOS_MENSUALES)) || 0;
    const vendido = mensualVendidoUF(quote, config);
    const descuadreUF =
      vendido !== null && totalNota > 0 ? Number((totalNota - vendido).toFixed(5)) : null;
    return sendJson(res, 200, {
      ok: true,
      listo: true,
      cotId,
      ndvId,
      idNdv: ref.nombre || idNdv,
      referenciaId: ref.id,
      estadoReferencia: ref.estado,
      empresaDropdown,
      totalMensualNotaUF: totalNota || null,
      mensualVendidoUF: vendido,
      descuadreUF,
      idSo: texto(notaFinal.ID_SO) || null,
      pasos,
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, paso, error: error?.message || String(error), pasos });
  }
};
