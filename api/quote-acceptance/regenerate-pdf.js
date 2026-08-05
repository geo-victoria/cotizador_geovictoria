/**
 * Endpoint: POST /api/quote-acceptance/regenerate-pdf
 *
 * Regenera el PDF de una cotización a partir del ESTADO ACTUAL en Zoho (subform
 * de ítems + descuentos comiteados), sin avanzar descuentos ni recalcular nada.
 * Útil cuando se editaron los ítems directamente en Zoho y el PDF_URL quedó
 * desactualizado (la página de aceptación muestra los valores nuevos en vivo,
 * pero el PDF es un artefacto congelado al momento en que se generó).
 *
 * Sube el PDF nuevo a Supabase Storage, actualiza PDF_URL y sube Version_PDF.
 * NO toca el escalón de descuento, ni los precios, ni la URL de aceptación.
 *
 * Body: { "quoteId": "<id Zoho>" }   // o { "token": "<token de aceptación>" }
 * Auth: header x-vicky-secret = VICKY_COTIZADORA_SECRET.
 *
 * Respuesta: { ok:true, version, link_pdf }
 */

const {
  getRecord,
  getRecordWithFields,
  updateRecord,
  toText,
} = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { tramoModuloCL } = require("../_shared/tramos-cl");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");
const { ejecutivoPorOwner, resolverEjecutivoCL } = require("../_shared/ejecutivo-cl");
const { getUFActualSafe } = require("../_shared/uf-actual");

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

function quoteIdFromToken(token) {
  try {
    const payloadB64 = String(token || "").split(".")[0];
    if (!payloadB64) return "";
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    return toText(payload?.quoteId);
  } catch {
    return "";
  }
}

// País firmado en el token de la URL de aceptación (espejo de backfill-pdf):
// sin campo pais, la cotización es chilena. Solo se decodifica (no se
// verifica firma): se usa únicamente para NO regenerar CO/MX con el builder CL.
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

// Espejo de buildClienteParaHtml en aplicar-siguiente-descuento.js.
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
  // El ejecutivo del PDF es el DUEÑO DEL DEAL primero (caso Lotus Pet/COT315,
  // 05-ago: la página de aceptación presenta al dueño del deal y el PDF debe
  // mostrar a la MISMA persona), dueño de la cotización de fallback. Dueños
  // fuera del mapa se resuelven contra su ficha de Zoho (adiós fallback
  // Eddyluz para dueñas nuevas).
  const dealId = toText(quote?.[config.quoteDealLookupField]?.id || quote?.Deal_Asociado?.id);
  const dealOwner = dealId
    ? await getRecordWithFields("Deals", dealId, ["Owner"]).catch(() => null)
    : null;
  const ejec = await resolverEjecutivoCL([
    toText(dealOwner?.Owner?.id),
    toText(quote?.Owner?.id),
  ]);
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

// Espejo de subformACotizacionItems en aplicar-siguiente-descuento.js.
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
          : modalidadZoho === "Por usuario"
          ? "Por usuario"
          : "Cobro único",
      cantidad: Number(row?.Cantidad || 0),
      precioUnitarioUF: Number(row?.Precio_Unitario_UF || 0),
      subtotalUF: Number(row?.Subtotal_UF || 0),
      zonaTarifa: String(row?.[config.quoteItemZonaTarifaField] || ""),
      // Descuento por línea (bonificaciones acordadas, ej. envío −100%).
      descuentoPct: Number(row?.Descuento_Pct || 0),
      // Tramo del módulo, DERIVADO (caso Grey/COT347 05-ago): el subform no
      // persiste tierAplicado y el PDF regenerado perdía el "Tramo X-Y".
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

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });
  }

  const expectedSecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  const providedSecret = toText(req.headers["x-vicky-secret"]);
  if (expectedSecret && expectedSecret !== providedSecret) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  let stage = "init";
  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const quoteId = toText(body.quoteId) || quoteIdFromToken(body.token);
    if (!quoteId) {
      return sendJson(res, 400, { ok: false, error: "Falta quoteId (o token)." });
    }

    stage = "fetch_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });
    }

    // Guard de país: este endpoint renderiza con el builder CHILENO (UF).
    // Una cotización CO/MX regenerada acá saldría con montos y textos de
    // Chile — mejor fallar claro que sobreescribir el PDF con basura.
    const paisQuote = paisEnToken(toText(quote?.[config.quoteAcceptanceUrlField]));
    if (paisQuote === "co" || paisQuote === "mx") {
      return sendJson(res, 422, {
        ok: false,
        error: `COTIZACION_${paisQuote.toUpperCase()}: regenerate-pdf solo soporta Chile por ahora; la regeneración CO/MX es fase 2.`,
      });
    }

    // Descuentos COMITEADOS actuales (no se tocan; solo se reflejan en el PDF).
    const descuentos = {
      recurrentePct: Number(quote?.[config.quoteDiscountPctField] || 0),
      instalacionRMPct: Number(quote?.[config.quoteDiscountInstRMPctField] || 0),
      instalacionRegionPct: Number(quote?.[config.quoteDiscountInstRegionPctField] || 0),
    };

    stage = "render_pdf";
    const cliente = await buildClienteParaHtml(quote, config);
    const ufActual = await getUFActualSafe();
    if (!(ufActual > 0)) {
      // Sin UF, todos los montos CLP del PDF saldrían en $0: mejor fallar.
      return sendJson(res, 502, {
        ok: false,
        error: "UF del día no disponible (mindicador.cl y respaldo caídos); reintenta en unos minutos.",
      });
    }
    const items = subformACotizacionItems(quote, config);
    const versionActual = Math.max(1, Number(quote?.[config.quoteVersionPdfField] || 1));
    const versionNueva = versionActual + 1;
    // Mantenemos la URL de aceptación vigente (no re-firmamos el token).
    const acceptanceUrl = toText(quote?.[config.quoteAcceptanceUrlField]);

    const html = buildProposalHtml({
      cliente,
      cotizacion: { items, ufActual },
      acceptanceUrl,
      cotizacionId: numeroParaPdf(quote && quote.Numero_Cotizacion, quoteId),
      validezHasta: new Date(Date.now() + config.validityDays * 24 * 60 * 60 * 1000).toISOString(),
      version: versionNueva,
      descuentos,
    });

    stage = "upload_pdf";
    const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
    const { pdfUrl } = await uploadPdfToSupabase({
      pdfBuffer,
      quoteId,
      empresa: cliente.empresa,
    });

    stage = "update_quote";
    await updateRecord(
      config.quoteModule,
      quoteId,
      {
        [config.quoteVersionPdfField]: versionNueva,
        [config.quotePdfUrlField]: pdfUrl,
      },
      true,
    );

    return sendJson(res, 200, {
      ok: true,
      version: versionNueva,
      link_pdf: pdfUrl,
    });
  } catch (error) {
    console.error(`[regenerate-pdf] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo regenerar el PDF.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};

// Reutilizados por el cron de respaldo del PDF (backfill-pdf.js), que regenera
// el PDF de las cotizaciones cuyo render en segundo plano falló. Exportarlos
// evita una tercera copia de la misma lógica de mapeo.
module.exports.subformACotizacionItems = subformACotizacionItems;
module.exports.buildClienteParaHtml = buildClienteParaHtml;
module.exports.numeroParaPdf = numeroParaPdf;
module.exports.getUFActualSafe = getUFActualSafe;
