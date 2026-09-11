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

function tsCreator(v) {
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(texto(v));
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] + 3, +m[5], +m[6]) : 0;
}

/** Bloques Formulario_de_Equipos del espejo (HARDWARE_ALL_DATA). */
async function bloquesHardwareDe(cfg, cotId) {
  try {
    const path =
      `/creator/v2.1/data/${encodeURIComponent(cfg.ownerName)}/${encodeURIComponent(cfg.appLinkName)}` +
      `/report/HARDWARE_ALL_DATA?criteria=${encodeURIComponent(`ID_Formulario==${cotId}`)}&limit=20&field_config=all`;
    const r = await creatorApiFetch(path, { method: "GET" });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j?.data) ? j.data : [];
  } catch {
    return [];
  }
}

/**
 * ¿El espejo sirve para convertirlo tal cual? NO cuando:
 *  (a) es más viejo que la última (re)emisión de la cotización — el cliente
 *      cambió ítems después (Molinas 07-sep: pidió reloj + instalación 5 min
 *      antes de pagar y la NDV nació sin ellos);
 *  (b) nació con el puente viejo y trae el defecto del arriendo (fila del reloj
 *      con Monto=0 → PDF vacío) o el envío bonificado cobrado a lista
 *      (TESLA NDV-31596, Molinas NDV-31616/31619).
 * En ambos casos se regenera desde los ítems VIGENTES de la cotización pagada.
 */
async function diagnosticoEspejo(cfg, cot, quote, config) {
  const motivos = [];
  const emitida = Date.parse(String(quote?.Fecha_Hora_Cotizacion || quote?.Created_Time || "")) || 0;
  const nacido = tsCreator(cot.Added_Time);
  if (emitida && nacido && nacido < emitida - 3 * 60 * 1000) motivos.push("espejo anterior a la última emisión");
  const bloques = await bloquesHardwareDe(cfg, texto(cot.ID));
  const items = Array.isArray(quote?.[config.quoteItemsSubformField]) ? quote[config.quoteItemsSubformField] : [];
  const envioBonificado = items.some(
    (x) => /envio/i.test(texto(x?.Codigo_Item)) && Number(x?.Descuento_Pct) >= 100,
  );
  for (const b of bloques) {
    const eq = Array.isArray(b.Equipos) ? b.Equipos : [];
    const sv = Array.isArray(b.Servicios) ? b.Servicios : [];
    if (/arriendo/i.test(texto(b.Servicio_Producto)) && eq.length > 0 && Number(b.Monto) <= 0) {
      motivos.push("bloque de arriendo con fila y Monto=0");
    }
    if (envioBonificado && sv.some((r) => /^907/.test(texto(r.Items)) && Number(r.Valor_Unidad) > 0)) {
      motivos.push("envío bonificado cobrado a lista");
    }
  }
  return { regenerar: motivos.length > 0, motivos };
}

/** Espejo nuevo desde los ítems vigentes: mismo camino que crear-ndv-desde-cot
 * (self-request, así se reusa TODO el puente sin duplicar código). */
async function regenerarEspejo(quoteId, timeoutMs) {
  const base = toText(process.env.COTIZADOR_SELF_BASE) || "https://cotizacion.geovictoria.com";
  const secreto = toText(process.env.VICKY_COTIZADORA_SECRET);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/api/creator/crear-ndv-desde-cot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vicky-secret": secreto, "User-Agent": "Mozilla/5.0 vicky-ndv-alta" },
      body: JSON.stringify({ quoteId, status: "BORRADOR", formulario: "Cotizacion" }),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j?.ok !== false, ndvId: texto(j?.ndvId), idNdv: texto(j?.idNdv), error: texto(j?.error) };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : texto(e?.message) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * ARREGLO EN SITIO antes de regenerar (Lalo 11-sep: "por qué en vez de anular
 * no actualiza? está generando muchos correlativos"). Compara el espejo con la
 * venta pagada y, si la diferencia es de VALORES (dotación, tabla de cobro,
 * descuento) o hay un bloque de hardware sobrante, lo PARCHEA en sitio con los
 * mismos campos que el puente escribe al crear — cero correlativos quemados.
 * Devuelve null cuando no se pudo arreglar así: ahí el llamador regenera, que
 * es el camino probado.
 */
async function intentarArregloEnSitio(cfg, cotId, quote, config) {
  try {
    const { serviciosDelEspejo, bloquesDelEspejo, planEnSitio, aplicarPlanEnSitio } =
      require("../_shared/ndv-espejo-sitio");
    const { buildChargeTables, resolverDescuentos } = require("../_shared/ndv-charge-table");
    const {
      resolveServiciosRecurrentesDeFila,
      inferCommittedEmployees,
      inferServiciosCreator,
    } = require("../_shared/ndv-handoff");

    const [serviciosEspejo, bloquesEspejo] = await Promise.all([
      serviciosDelEspejo(cfg, cotId),
      bloquesDelEspejo(cfg, cotId),
    ]);
    if (!serviciosEspejo.length) return null; // sin hijos legibles: no arriesgar

    const servicios = inferServiciosCreator(quote, config);
    const empleados = inferCommittedEmployees(quote, null, undefined);
    const principal = texto(servicios?.serviciosRecurrentes?.[0]) || "Control de Asistencia";
    const tablas = buildChargeTables({
      quote,
      config,
      committedEmployees: empleados,
      moneda: texto(quote?.Moneda) || "UF",
      servicioPrincipal: principal,
      resolveServicios: resolveServiciosRecurrentesDeFila,
    });
    const items = Array.isArray(quote?.[config.quoteItemsSubformField]) ? quote[config.quoteItemsSubformField] : [];
    const hayHardware = items.some((x) => /hardware|equipo/i.test(texto(x?.Tipo_Item) || texto(x?.Tipo)));

    const plan = planEnSitio({
      serviciosEspejo,
      bloquesEspejo,
      deseado: {
        empleados,
        descuentoPct: resolverDescuentos(quote, config).recurrentePct,
        tablasPorServicio: tablas?.porServicio || {},
        hayHardware,
      },
    });
    if (plan.modo === "regenerar") {
      console.log(`[ndv-alta-chat] espejo ${cotId}: en sitio NO alcanza (${plan.motivos.join("; ")})`);
      return null;
    }
    if (plan.modo === "ok") return { modo: "ok", acciones: [] };
    const aplicado = await aplicarPlanEnSitio(cfg, plan);
    if (!aplicado.ok) return null;
    console.log(
      `[ndv-alta-chat] espejo ${cotId} ARREGLADO EN SITIO (${plan.acciones.map((a) => a.tipo).join(", ")}) — sin quemar correlativo`,
    );
    return { modo: "en_sitio", acciones: aplicado.resultados };
  } catch (e) {
    console.warn(`[ndv-alta-chat] arreglo en sitio falló (${String(e?.message || e).slice(0, 120)}) — se regenera`);
    return null;
  }
}

async function anularEspejo(cfg, cotId) {
  try {
    const r = await creatorApiFetch(`${reportPath(cfg)}/${encodeURIComponent(cotId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { STATUS: "ANULADA", UpdateCheckbox: true } }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok && Number(j?.code) === 3000;
  } catch {
    return false;
  }
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
    (f) => texto(f.Formulario) === "Cotización" && texto(f.STATUS) !== "ANULADA",
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
    // FRESCO = nacido en (o después de) la última emisión/actualización de la
    // cotización. Un espejo regenerado por este mismo endpoint es más nuevo
    // que la emisión y debe ganarle al original aunque el original esté "más
    // cerca" en el tiempo.
    const viejo = ts(f) < emitida - 3 * 60 * 1000 ? 1 : 0;
    return [rutDistinto, convertida, viejo, Math.abs(ts(f) - emitida)];
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
    if (!companyId && body.soloEspejo !== true) {
      return sendJson(res, 400, { ok: false, error: "Falta companyId (id de la empresa en la plataforma)." });
    }

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

    // soloEspejo=true: ubica/diagnostica/regenera el espejo SIN convertir nada
    // (para preparar la nota antes del alta, o para inspección admin).
    if (body.soloEspejo === true) {
      const diag = await diagnosticoEspejo(cfg, cot, quote, config);
      if (diag.regenerar && !cotForzado) {
        const anulado = await anularEspejo(cfg, cotId);
        const nuevo = await regenerarEspejo(quoteId, Math.max(15_000, queda() - 5_000));
        return sendJson(res, 200, { ok: true, soloEspejo: true, cotId, diag, viejoAnulado: anulado, nuevo, pasos });
      }
      return sendJson(res, 200, { ok: true, soloEspejo: true, cotId, diag, pasos });
    }

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
      // 1b. ESPEJO DESACTUALIZADO O DEFECTUOSO → se regenera desde los ítems
      //     vigentes de la cotización PAGADA (la fuente de verdad), se anula el
      //     viejo y la próxima pasada convierte el nuevo. Con `cotId` forzado
      //     no se toca (el admin ya eligió).
      const yaConvertidaSinNota = texto(cot.ESTADO_COT) === "Convertida a NDV";
      const diag = cotForzado ? { regenerar: false, motivos: [] } : await diagnosticoEspejo(cfg, cot, quote, config);
      if (yaConvertidaSinNota && !cotForzado) diag.motivos.push("figura convertida pero su nota no está viva");
      if (diag.motivos.length > 0 && !cotForzado) {
        // Primero EN SITIO: si la diferencia es de valores (o hay un bloque
        // sobrante que se puede neutralizar), se parchea y se sigue con la
        // conversión en esta misma pasada, sin quemar un correlativo.
        paso = "arreglo_en_sitio";
        const enSitio = await intentarArregloEnSitio(cfg, cotId, quote, config);
        if (enSitio) {
          // El maestro no se toca en este arreglo (los PATCH van a sus hijos),
          // así que `cot` sigue vigente y la conversión continúa en esta pasada.
          pasos.push({ arregloEnSitio: { motivos: diag.motivos, ...enSitio } });
        } else {
        paso = "regenerar_espejo";
        const anulado = await anularEspejo(cfg, cotId);
        const nuevo = queda() > 20_000 ? await regenerarEspejo(quoteId, Math.max(15_000, queda() - 8_000)) : { ok: false, error: "sin presupuesto" };
        pasos.push({ regenerarEspejo: { motivos: diag.motivos, viejoAnulado: anulado, nuevo } });
        console.log(
          `[ndv-alta-chat] espejo ${cotId} regenerado (${diag.motivos.join("; ")}) → ${nuevo.ok ? nuevo.ndvId : `pendiente: ${nuevo.error}`}`,
        );
        // Siempre reintentable: si el POST alcanzó a crear el espejo aunque el
        // timeout cortara la respuesta, la próxima pasada lo encuentra (es el
        // fresco y el viejo quedó anulado); si no, vuelve a intentarlo.
        return sendJson(res, 200, {
          ok: true,
          listo: false,
          reintentable: true,
          pendiente: "espejo_regenerado",
          cotId,
          espejoNuevo: nuevo.ndvId || undefined,
          pasos,
        });
        }
      }
      if (yaConvertidaSinNota) {
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
