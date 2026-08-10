/**
 * Endpoint: POST /api/quote-acceptance/descuento-ejecutivo
 *
 * DESCUENTO FLEXIBLE PARA EL EJECUTIVO (Lalo 10-ago, caso Cigpa/Anderson).
 *
 * La escalera oficial (10% → 20%, solo sube, tope 20%, vigencia fija de 6
 * meses) está pensada de cara al CLIENTE: es una herramienta de cierre de
 * Vicky. Cuando el que edita es un EJECUTIVO desde el panel interno, esa
 * rigidez se volvió un obstáculo real:
 *
 *   - Pidió 10% y el sistema le comiteó 20%, porque la escalera solo avanza
 *     al escalón siguiente desde lo ya comiteado.
 *   - No pudo tocar la vigencia: los 6 meses eran una constante del código.
 *
 * Acá el ejecutivo manda: fija el porcentaje EXACTO (puede bajarlo, puede
 * dejarlo en 0) y la VIGENCIA en meses (1..N, o 0 = indefinido). Nada de
 * escalones. Los punteros de la escalera se dejan coherentes para que una
 * negociación posterior por WhatsApp no retroceda ni repita lo ya dado.
 *
 * Body:
 *   {
 *     quoteId: "<id Zoho>",
 *     pct: 10,              // opcional: 0..40. Omitir = no tocar el %.
 *     meses: 3,             // opcional: 0 = indefinido, null = política por
 *                           //   defecto (6). Omitir = no tocar la vigencia.
 *     regenerarPdf: false,  // opcional: flujo "confirmar una vez" del editor
 *     condicion: "..."      // opcional: condición discursiva al pie
 *   }
 *
 * Auth: x-vicky-secret == VICKY_COTIZADORA_SECRET (o Bearer CRON_SECRET).
 */

const {
  getRecord,
  getRecordWithFields,
  updateRecord,
  toText,
} = require("../_shared/zoho-crm");
const { actualizarPunteroPdf, marcarPdfPendiente } = require("../_shared/pointer-sync");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { tramoModuloCL } = require("../_shared/tramos-cl");
const {
  DISCOUNT_LADDER,
  textoVigenciaCorto,
  mesesDescuentoNormalizados,
} = require("../_shared/proposal-constants");
const { leerMesesDescuento, guardarMesesDescuento } = require("../_shared/descuento-meses");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");
const { getUFActualSafe } = require("../_shared/uf-actual");
const { ufDeCotizacion } = require("../_shared/uf-cotizacion");
const { resolverEjecutivoCL } = require("../_shared/ejecutivo-cl");
const crypto = require("crypto");

// Tope del canal interno. Más alto que la escalera de cara al cliente (20%)
// porque acá decide una persona con criterio comercial; sigue acotado para
// que un error de tipeo no regale la cuenta. Override por env.
const TOPE_EJECUTIVO_PCT = Math.min(
  40,
  Math.max(0, Number(process.env.DESCUENTO_EJECUTIVO_TOPE_PCT || 40)),
);

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return typeof req.body === "object" && req.body ? req.body : {};
}

// País firmado en el token (espejo de regenerate-pdf): este endpoint renderiza
// con el builder CHILENO. Una CO/MX acá saldría con montos de Chile.
function paisEnToken(acceptanceUrl) {
  try {
    const m = String(acceptanceUrl || "").match(/[?&]token=([^&]+)/);
    if (!m) return "";
    const body = decodeURIComponent(m[1]).split(".")[0];
    const json = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return String(JSON.parse(json)?.pais || "").toLowerCase();
  } catch {
    return "";
  }
}

async function buildClienteParaHtml(quote, config) {
  const accountId = toText(quote?.Cuenta_Asociada?.id);
  const contactId = toText(
    quote?.[config.quoteContactLookupField]?.id || quote?.[config.quoteContactLookupField],
  );
  const account = accountId
    ? await getRecordWithFields("Accounts", accountId, ["Account_Name", "RUT_Empresa"])
    : null;
  const contact = contactId
    ? await getRecordWithFields("Contacts", contactId, ["First_Name", "Last_Name"])
    : null;
  const contactoFullName = [contact?.First_Name, contact?.Last_Name].filter(Boolean).join(" ").trim();
  // Mismo criterio que regenerate-pdf (caso Lotus Pet/COT315): el PDF presenta
  // al DUEÑO DEL DEAL; la cotización queda de respaldo.
  const dealId = toText(quote?.[config.quoteDealLookupField]?.id || quote?.Deal_Asociado?.id);
  const dealOwner = dealId
    ? await getRecordWithFields("Deals", dealId, ["Owner"]).catch(() => null)
    : null;
  const ejec = await resolverEjecutivoCL([toText(dealOwner?.Owner?.id), toText(quote?.Owner?.id)]);
  return {
    empresa: toText(account?.Account_Name) || toText(quote?.Name) || "EMPRESA",
    contacto: contactoFullName || "",
    contactoEmail: toText(quote?.[config.contactEmailField]),
    rutEmpresa: toText(quote?.[config.companyRutField]) || toText(account?.RUT_Empresa),
    ejecutivo: ejec.nombre,
    ejecutivoEmail: ejec.email,
    ejecutivoTelefono: ejec.telefono,
  };
}

function subformACotizacionItems(quote, config) {
  const subform = quote?.[config.quoteItemsSubformField];
  if (!Array.isArray(subform)) return [];
  return subform.map((row) => {
    const modalidadZoho = String(row?.Modalidad || "");
    const codigo = String(row?.Codigo_Item || "").toLowerCase();
    let tipo = "modulo";
    if (codigo === "instalacion_reloj") tipo = "servicio";
    else if (modalidadZoho === "Arriendo" || modalidadZoho === "Venta") tipo = "hardware";
    return {
      tipo,
      id: codigo,
      nombre: String(row?.Nombre_Item || ""),
      descripcion: String(row?.Descripcion_Item || ""),
      modalidad:
        modalidadZoho === "Recurrente"
          ? "Por usuario"
          : modalidadZoho === "Único"
          ? "Fijo"
          : modalidadZoho === "Arriendo"
          ? "Arriendo mensual"
          : modalidadZoho === "Venta"
          ? "Venta única"
          : "Cobro único",
      cantidad: Number(row?.Cantidad || 0),
      precioUnitarioUF: Number(row?.Precio_Unitario_UF || 0),
      subtotalUF: Number(row?.Subtotal_UF || 0),
      zonaTarifa: String(row?.[config.quoteItemZonaTarifaField] || ""),
      descuentoPct: Number(row?.Descuento_Pct || 0),
      tierAplicado:
        tipo === "modulo"
          ? tramoModuloCL({
              modalidad:
                modalidadZoho === "Recurrente" || modalidadZoho === "Por usuario"
                  ? "Por usuario"
                  : "Fijo",
              cantidad: Number(row?.Cantidad || 0),
              precioUnitarioUF: Number(row?.Precio_Unitario_UF || 0),
            })
          : undefined,
    };
  });
}

function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

// Puntero de escalera coherente con un pct arbitrario: cuántos escalones de la
// escalera quedan cubiertos. Con [10, 20]: 8 → 0 · 15 → 1 · 22 → 2 (tope).
function punteroEscaleraPorPct(pct) {
  let idx = 0;
  for (let i = 0; i < DISCOUNT_LADDER.length; i++) {
    if (DISCOUNT_LADDER[i].pct <= pct) idx = i + 1;
  }
  return idx;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });

  const expectedSecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  const providedSecret = toText(req.headers["x-vicky-secret"]);
  const bearer = toText(req.headers.authorization).replace(/^Bearer\s+/i, "");
  const cronSecret = toText(process.env.CRON_SECRET);
  const ok = (expectedSecret && expectedSecret === providedSecret) || (cronSecret && cronSecret === bearer);
  if (!ok) return sendJson(res, 401, { ok: false, error: "Unauthorized" });

  let stage = "init";
  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const quoteId = toText(body.quoteId);
    if (!quoteId) return sendJson(res, 400, { ok: false, error: "Falta quoteId." });

    const tocaPct = body.pct !== undefined && body.pct !== null && body.pct !== "";
    const tocaMeses = Object.prototype.hasOwnProperty.call(body, "meses");
    if (!tocaPct && !tocaMeses) {
      return sendJson(res, 400, { ok: false, error: "Nada que cambiar: pasa pct, meses o ambos." });
    }
    const pctPedido = tocaPct ? Math.round(Number(body.pct) * 10) / 10 : null;
    if (tocaPct && (!Number.isFinite(pctPedido) || pctPedido < 0)) {
      return sendJson(res, 400, { ok: false, error: "pct debe ser un número entre 0 y " + TOPE_EJECUTIVO_PCT + "." });
    }
    if (tocaPct && pctPedido > TOPE_EJECUTIVO_PCT) {
      return sendJson(res, 400, {
        ok: false,
        error: `El tope autorizado para el panel interno es ${TOPE_EJECUTIVO_PCT}%. Un descuento mayor lo aplica el ejecutivo directamente en Zoho.`,
      });
    }

    stage = "fetch_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });

    const paisQuote = paisEnToken(toText(quote?.[config.quoteAcceptanceUrlField]));
    if (paisQuote === "co" || paisQuote === "mx") {
      return sendJson(res, 422, {
        ok: false,
        error: `COTIZACION_${paisQuote.toUpperCase()}: este canal solo soporta Chile por ahora.`,
      });
    }

    // Cotización cerrada: los ajustes post-aceptación son territorio humano en
    // Zoho (misma regla que actualizar-cotizacion).
    const estado = toText(quote?.[config.quoteStatusField]);
    if (/aceptad|pagad|rechazad/i.test(estado)) {
      return sendJson(res, 409, {
        ok: false,
        cotizacionCerrada: true,
        estado,
        error: `La cotización está en estado "${estado}": los cambios de descuento post-aceptación se coordinan directamente en Zoho.`,
      });
    }

    // ── Estado nuevo ──
    const pctVigente = Number(quote?.[config.quoteDiscountPctField] || 0);
    const pctFinal = tocaPct ? pctPedido : pctVigente;
    const mesesGuardados = await leerMesesDescuento(quoteId, quote);
    const mesesFinal = tocaMeses
      ? body.meses === null || body.meses === ""
        ? null
        : Math.min(120, Math.max(0, Math.trunc(Number(body.meses) || 0)))
      : mesesGuardados;

    const descRM = Number(quote?.[config.quoteDiscountInstRMPctField] || 0);
    const descRegion = Number(quote?.[config.quoteDiscountInstRegionPctField] || 0);
    const versionNueva = Math.max(1, Number(quote?.[config.quoteVersionPdfField] || 1)) + 1;
    const puntero = punteroEscaleraPorPct(pctFinal);

    stage = "guardar_vigencia";
    const camposMeses = tocaMeses ? await guardarMesesDescuento(quoteId, mesesFinal) : {};

    stage = "update_quote";
    await updateRecord(
      config.quoteModule,
      quoteId,
      {
        [config.quoteDiscountPctField]: pctFinal,
        [config.quoteDiscountUnlockedField]: pctFinal > 0,
        [config.quoteEscalonField]: puntero,
        [config.quoteEscalonNegociacionField]: puntero,
        [config.quoteVersionPdfField]: versionNueva,
        ...camposMeses,
      },
      true,
    );

    const resumen =
      `${pctFinal > 0 ? `${pctFinal}% de descuento sobre el plan mensual` : "sin descuento en el plan"}` +
      `${pctFinal > 0 ? `, ${textoVigenciaCorto(mesesFinal)}` : ""}`;

    // ── Flujo "confirmar una vez" del editor interno (Lalo 07-ago): el
    // vendedor hace varios ajustes y la versión definitiva del PDF nace en la
    // confirmación, no en cada cambio.
    if (body.regenerarPdf === false) {
      await marcarPdfPendiente(quoteId);
      return sendJson(res, 200, {
        ok: true,
        pct_aplicado: pctFinal,
        meses_descuento: mesesFinal === null ? mesesDescuentoNormalizados(null) : mesesFinal,
        meses_indefinido: mesesFinal === 0,
        version: versionNueva,
        pdf_pendiente: true,
        resumen,
      });
    }

    stage = "render_pdf";
    const cliente = await buildClienteParaHtml(quote, config);
    const ufQuote = ufDeCotizacion(quote, config.quoteItemsSubformField);
    const ufActual = ufQuote.uf > 0 ? ufQuote.uf : await getUFActualSafe();
    const items = subformACotizacionItems(quote, config);
    const dealId = toText(quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]);
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const acceptanceToken = signAcceptancePayload({
      quoteId,
      dealId,
      iat: Date.now(),
      exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(acceptanceToken)}`;

    const html = buildProposalHtml({
      cliente,
      cotizacion: { items, ufActual },
      acceptanceUrl,
      cotizacionId: numeroParaPdf(quote && quote.Numero_Cotizacion, quoteId),
      validezHasta: new Date(expMs).toISOString(),
      version: versionNueva,
      descuentos: {
        recurrentePct: pctFinal,
        instalacionRMPct: descRM,
        instalacionRegionPct: descRegion,
        mesesPlan: mesesFinal,
      },
      condicionDiscursiva: toText(body.condicion) || null,
    });

    stage = "upload_pdf";
    const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
    const { pdfUrl } = await uploadPdfToSupabase({ pdfBuffer, quoteId, empresa: cliente.empresa });

    stage = "update_pdf_url";
    await updateRecord(
      config.quoteModule,
      quoteId,
      {
        [config.quotePdfUrlField]: pdfUrl,
        [config.quoteAcceptanceUrlField]: acceptanceUrl,
      },
      true,
    );
    await actualizarPunteroPdf(quoteId, pdfUrl);

    return sendJson(res, 200, {
      ok: true,
      pct_aplicado: pctFinal,
      meses_descuento: mesesFinal === null ? mesesDescuentoNormalizados(null) : mesesFinal,
      meses_indefinido: mesesFinal === 0,
      version: versionNueva,
      link_pdf: pdfUrl,
      acceptance_url: acceptanceUrl,
      resumen,
    });
  } catch (error) {
    console.error(`[descuento-ejecutivo] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo aplicar el descuento.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};
