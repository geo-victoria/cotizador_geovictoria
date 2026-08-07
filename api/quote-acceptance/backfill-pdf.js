/**
 * Cron de respaldo del PDF: POST/GET /api/quote-acceptance/backfill-pdf
 *
 * Red de seguridad para el render del PDF en segundo plano de create-from-vicky.
 * Ese endpoint responde a Vicky de inmediato con el acceptanceUrl y deja el PDF
 * + el correo al cliente para un `waitUntil` (Chromium headless). Si ese trabajo
 * en segundo plano falla (Chromium revienta, PDFShift cae, la función se recicla),
 * la cotización queda "Enviada" con su URL de aceptación pero SIN PDF_URL y, como
 * el correo va después del PDF, el cliente nunca recibe nada.
 *
 * Este cron barre las cotizaciones en ese estado (Enviada + PDF_URL vacío +
 * URL_Aceptacion_Web presente) y, por cada una:
 *   1. Regenera el PDF desde el estado actual en Zoho (mismos helpers que
 *      regenerate-pdf.js: ítems del subform + descuentos comiteados).
 *   2. Sube el PDF a Supabase y setea PDF_URL.
 *   3. Reenvía el correo de la cotización al cliente (mismo correo que producción).
 *
 * Idempotencia: setear PDF_URL saca a la cotización de la próxima barrida, así no
 * se reprocesa ni se duplica el correo. Se respeta una ventana de gracia para no
 * pisar un render en segundo plano que todavía esté corriendo legítimamente.
 *
 * Auth: header `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron) o
 * `x-vicky-secret = ${VICKY_COTIZADORA_SECRET}` (disparo manual).
 */

const { getRecord, getRecordWithFields, updateRecord, toText } = require("../_shared/zoho-crm");
const { actualizarPunteroPdf } = require("../_shared/pointer-sync");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");
const {
  subformACotizacionItems,
  buildClienteParaHtml,
  numeroParaPdf,
  getUFActualSafe,
} = require("./regenerate-pdf");
const { buildEmailHtml, sendQuoteEmailViaZoho } = require("./create-from-vicky");

// Mismos defaults que create-from-vicky (correo de la cotización).
const VICKY_FROM_EMAIL = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";
const EJEC_EMAIL = "vicky@geovictoria.com";

// Ventana de gracia: NO tocar cotizaciones demasiado recientes; su render en
// segundo plano puede seguir corriendo (normalmente termina en < 60s). Tampoco
// reprocesar las muy antiguas (un fallo viejo ya se atendió de otra forma).
const GRACE_MINUTES = Number(process.env.PDF_BACKFILL_GRACE_MINUTES || 10);
const MAX_AGE_HOURS = Number(process.env.PDF_BACKFILL_MAX_AGE_HOURS || 72);
// Tope de PDFs por ejecución: cada render con Chromium es pesado; varios en una
// invocación revientan el maxDuration (60s). El cron corre seguido, así que el
// backlog se drena en varias pasadas.
const MAX_POR_EJECUCION = Number(process.env.PDF_BACKFILL_BATCH || 4);

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  const vickySecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  if (vickySecret && toText(req.headers["x-vicky-secret"]) === vickySecret) return true;
  return false;
}

// COQL: cotizaciones candidatas (Enviada + sin PDF + con URL de aceptación).
// Filtramos por edad en JS (la ventana de gracia evita pisar renders en curso),
// así no hay que embeber literales de datetime con offset de zona en el COQL.
async function buscarCandidatas(config) {
  const f = {
    pdf: config.quotePdfUrlField,
    estado: config.quoteStatusField,
    aceptacion: config.quoteAcceptanceUrlField,
  };
  const select =
    `select id, Created_Time, ${f.pdf}, ${f.estado}, ${f.aceptacion} ` +
    `from ${config.quoteModule} ` +
    // COQL exige paréntesis ANIDADOS con 2+ ANDs: ((A and B) and C).
    `where ((${f.estado} = 'Enviada' and ${f.pdf} is null) and ${f.aceptacion} is not null) ` +
    `order by Created_Time desc limit 50`;
  const response = await zohoApiFetch("/crm/v3/coql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ select_query: select }),
  });
  if (response.status === 204) return [];
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`COQL falló (${response.status}): ${text.slice(0, 200)}`);
  }
  const rows = JSON.parse(text)?.data || [];
  const now = Date.now();
  const minEdadMs = GRACE_MINUTES * 60 * 1000;
  const maxEdadMs = MAX_AGE_HOURS * 60 * 60 * 1000;
  return rows.filter((row) => {
    const creado = Date.parse(toText(row.Created_Time));
    if (!Number.isFinite(creado)) return false;
    const edad = now - creado;
    return edad >= minEdadMs && edad <= maxEdadMs;
  });
}

// ¿Cotización COLOMBIA o MÉXICO? create-from-vicky-co firma el token de
// aceptación con pais:"co" y create-from-vicky-mx con pais:"mx"; acá basta
// decodificar el payload (sin verificar firma: solo se usa para NO rescatar
// una cotización CO/MX con el builder/correo CHILENOS — le pondría montos en
// UF y textos de Chile). El rescate CO/MX es fase 2.
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

function esCotizacionCO(acceptanceUrl) {
  return paisEnToken(acceptanceUrl) === "co";
}

function esCotizacionMX(acceptanceUrl) {
  return paisEnToken(acceptanceUrl) === "mx";
}

// Regenera el PDF de una cotización + reenvía el correo. Espejo del trabajo en
// segundo plano de create-from-vicky, pero a partir del estado actual en Zoho.
async function rescatarCotizacion(quoteId, config) {
  const quote = await getRecord(config.quoteModule, quoteId);
  if (!quote) throw new Error("cotización no encontrada");

  // Carrera entre ticks: si otra pasada ya la rescató, PDF_URL ya está seteado.
  if (toText(quote[config.quotePdfUrlField])) {
    return { skipped: "pdf_ya_presente" };
  }

  // Cotización CO: este cron es chileno (PDF UF + correo en tuteo); saltarla.
  if (esCotizacionCO(quote[config.quoteAcceptanceUrlField])) {
    return { skipped: "cotizacion_co" };
  }
  // Cotización MX: mismo motivo (PDF en MXN/IVA 16% con builder propio).
  if (esCotizacionMX(quote[config.quoteAcceptanceUrlField])) {
    return { skipped: "cotizacion_mx" };
  }

  const descuentos = {
    recurrentePct: Number(quote[config.quoteDiscountPctField] || 0),
    instalacionRMPct: Number(quote[config.quoteDiscountInstRMPctField] || 0),
    instalacionRegionPct: Number(quote[config.quoteDiscountInstRegionPctField] || 0),
  };
  const cliente = await buildClienteParaHtml(quote, config);
  const ufActual = await getUFActualSafe();
  const items = subformACotizacionItems(quote, config);
  const acceptanceUrl = toText(quote[config.quoteAcceptanceUrlField]);
  // Versión vigente (NO se incrementa: este es el PDF v1 que debió existir, no
  // una regeneración por edición posterior).
  const version = Math.max(1, Number(quote[config.quoteVersionPdfField] || 1));

  const html = buildProposalHtml({
    cliente,
    cotizacion: { items, ufActual },
    acceptanceUrl,
    cotizacionId: numeroParaPdf(quote.Numero_Cotizacion, quoteId),
    validezHasta: new Date(Date.now() + config.validityDays * 24 * 60 * 60 * 1000).toISOString(),
    version,
    descuentos,
  });
  const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
  const { pdfUrl } = await uploadPdfToSupabase({ pdfBuffer, quoteId, empresa: cliente.empresa });

  // Setear PDF_URL ANTES de enviar el correo (mismo orden que create-from-vicky):
  // garantiza que la cotización salga de la próxima barrida y no se reprocese.
  await updateRecord(config.quoteModule, quoteId, { [config.quotePdfUrlField]: pdfUrl }, true);
  // Propaga al puntero de Supabase (principio Lalo 07-ago: el PDF nuevo en TODOS lados)
  await actualizarPunteroPdf(quoteId, pdfUrl);

  const tieneReloj = items.some((it) => it && it.tipo === "hardware");
  await sendQuoteEmailViaZoho({
    quoteModule: config.quoteModule,
    quoteId,
    fromEmail: VICKY_FROM_EMAIL,
    replyToEmail: EJEC_EMAIL,
    ccEmail: EJEC_EMAIL,
    toEmail: cliente.contactoEmail,
    toName: cliente.contacto,
    subject: `Tu cotización GeoVictoria — ${cliente.empresa}`,
    htmlBody: buildEmailHtml({
      contacto: cliente.contacto,
      empresa: cliente.empresa,
      pdfUrl,
      tieneReloj,
    }),
  });

  return { pdfUrl };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Método no permitido." });
  }
  if (!authorized(req)) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const config = getAcceptanceConfig(req);
    const candidatas = await buscarCandidatas(config);

    const resultados = [];
    let rescatadas = 0;
    for (const row of candidatas) {
      if (rescatadas >= MAX_POR_EJECUCION) break;
      const quoteId = toText(row.id);
      if (!quoteId) continue;
      try {
        const out = await rescatarCotizacion(quoteId, config);
        if (out.skipped) {
          resultados.push({ quoteId, ok: true, skipped: out.skipped });
        } else {
          rescatadas++;
          resultados.push({ quoteId, ok: true, pdfUrl: out.pdfUrl });
          console.log(`[backfill-pdf] rescatada cotización ${quoteId} → PDF regenerado y correo reenviado.`);
        }
      } catch (err) {
        resultados.push({ quoteId, ok: false, error: String(err?.message || err).slice(0, 200) });
        console.error(`[backfill-pdf] falló rescate de ${quoteId}:`, err?.message || err);
      }
    }

    return sendJson(res, 200, {
      ok: true,
      candidatas: candidatas.length,
      rescatadas,
      pendientes: Math.max(0, candidatas.length - rescatadas),
      resultados,
    });
  } catch (error) {
    console.error("[backfill-pdf] ERROR:", error?.message || error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo correr el respaldo del PDF.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};
