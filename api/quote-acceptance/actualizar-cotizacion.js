/**
 * Endpoint: POST /api/quote-acceptance/actualizar-cotizacion
 *
 * Capacidad "Vicky administra sus cotizaciones" (16-jul): el cliente pide un
 * cambio a su cotización formal YA enviada (agregar reloj, cambiar dotación,
 * quitar un servicio) y Vicky lo ejecuta sola — lo que hoy hace Anderson a
 * mano. Cada derivación evitada es un punto para la tasa 100% Vicky.
 *
 * Qué hace:
 *   1. Guards: la cotización existe y NO está Aceptada/Rechazada (pagada
 *      jamás se toca — eso es post-venta, territorio humano).
 *   2. Reemplaza el subform de ítems (estrategia validada 16-jul: filas
 *      nuevas sin id se INSERTAN + filas viejas con {id, _delete: null} se
 *      BORRAN, en un solo update — Zoho apila si no borras explícito).
 *   3. Los descuentos COMITEADOS (campos pct) se conservan: la página de
 *      aceptación y el checkout los aplican en runtime sobre los ítems
 *      nuevos, así que los montos se recalculan solos.
 *   4. El LINK DE ACEPTACIÓN NO CAMBIA: la página lee el subform en vivo;
 *      el mismo token/URL muestra la información actualizada al instante.
 *   5. El PDF sí se regenera (versión+1) y se reenvía por correo.
 *
 * Reusa los helpers de create-from-vicky (buildSubformItems, mailer, HTML
 * del correo) para que no exista drift entre crear y actualizar.
 *
 * Auth: x-vicky-secret == VICKY_COTIZADORA_SECRET (o Bearer CRON_SECRET).
 */

const {
  getRecord,
  getRecordWithFields,
  updateRecord,
  toText,
} = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");
const { ejecutivoPorOwner } = require("../_shared/ejecutivo-cl");
const crypto = require("crypto");

const createFromVicky = require("./create-from-vicky.js");
const { buildSubformItems, sendQuoteEmailViaZoho, buildEmailHtml } = createFromVicky;

// Identidad del ejecutivo (misma que el flujo de creación).
// Identidad del ejecutivo: el HUMANO dueño de la cotización (Rodrigo 27-jul).
// Se resuelve por Owner en el handler; estos defaults solo cubren el arranque.
const { EJECUTIVO_CL_DEFAULT } = require("../_shared/ejecutivo-cl");
const EJEC_NOMBRE = process.env.VICKY_EJECUTIVO_NOMBRE || EJECUTIVO_CL_DEFAULT.nombre;
const EJEC_EMAIL = process.env.VICKY_EJECUTIVO_EMAIL || EJECUTIVO_CL_DEFAULT.email;
const EJEC_TELEFONO = process.env.VICKY_EJECUTIVO_TELEFONO || EJECUTIVO_CL_DEFAULT.telefono;
const VICKY_FROM_EMAIL = process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com";

let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch {
  waitUntil = (p) => { p.catch(() => {}); };
}

// País firmado en el token de la URL de aceptación (espejo de backfill-pdf):
// create-from-vicky-co firma pais:"co" y create-from-vicky-mx pais:"mx"; sin
// campo pais, la cotización es chilena. Solo se decodifica (no se verifica
// firma): se usa únicamente para NO tocar cotizaciones CO/MX con lógica CL.
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
  const vickySecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  if (vickySecret && toText(req.headers["x-vicky-secret"]) === vickySecret) return true;
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  return false;
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
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });

  let stage = "init";
  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const quoteId = toText(body.quoteId);
    const cotizacion = body.cotizacion || {};
    const items = Array.isArray(cotizacion.items) ? cotizacion.items : [];
    const ufActual = Number(cotizacion.ufActual || 0);
    const resumenCambio = toText(body.resumenCambio).slice(0, 500);
    if (!quoteId) return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    if (!items.length) return sendJson(res, 400, { ok: false, error: "cotizacion.items requerido (configuración COMPLETA nueva, no solo el delta)." });
    if (!(ufActual > 0)) return sendJson(res, 400, { ok: false, error: "cotizacion.ufActual requerido." });

    stage = "fetch_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });

    // ── Guard duro: una cotización cerrada no se toca ──
    const estado = toText(quote?.[config.quoteStatusField]);
    if (/aceptada|rechazada/i.test(estado)) {
      return sendJson(res, 409, {
        ok: false,
        error: `COTIZACION_CERRADA: estado '${estado}'. Los cambios post-aceptación los gestiona un ejecutivo.`,
        estado,
      });
    }

    // ── Guard de país (mismo criterio que backfill-pdf): este endpoint asume
    // Chile de punta a punta (items en UF, buildProposalHtml chileno). Una
    // cotización CO/MX regenerada acá saldría con montos UF y textos de
    // Chile — mejor fallar claro que emitir un PDF basura.
    const paisQuote = paisEnToken(toText(quote?.[config.quoteAcceptanceUrlField]));
    if (paisQuote === "co" || paisQuote === "mx") {
      return sendJson(res, 422, {
        ok: false,
        error: `COTIZACION_${paisQuote.toUpperCase()}: actualizar-cotizacion solo soporta Chile por ahora; la actualización CO/MX es fase 2.`,
      });
    }

    // ── Reemplazo del subform: insertar nuevas + borrar viejas (1 update) ──
    stage = "swap_subform";
    const filasViejas = Array.isArray(quote?.[config.quoteItemsSubformField])
      ? quote[config.quoteItemsSubformField]
      : [];
    const filasNuevas = buildSubformItems(items, ufActual, config);
    const subformSwap = [
      ...filasNuevas,
      ...filasViejas
        .map((r) => toText(r?.id))
        .filter(Boolean)
        .map((id) => ({ id, _delete: null })),
    ];

    const versionNueva = Math.max(1, Number(quote?.[config.quoteVersionPdfField] || 1)) + 1;
    await updateRecord(config.quoteModule, quoteId, {
      [config.quoteItemsSubformField]: subformSwap,
      [config.quoteVersionPdfField]: versionNueva,
    }, true);

    // ── El link NO cambia: reusar el vigente (fallback: firmar uno nuevo) ──
    stage = "acceptance_url";
    let acceptanceUrl = toText(quote?.[config.quoteAcceptanceUrlField]);
    const dealId = toText(quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]);
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    if (!acceptanceUrl) {
      const token = signAcceptancePayload({
        quoteId, dealId: dealId || "",
        iat: Date.now(), exp: expMs,
        nonce: crypto.randomBytes(8).toString("hex"),
        v: 1,
      });
      acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;
      await updateRecord(config.quoteModule, quoteId, {
        [config.quoteAcceptanceUrlField]: acceptanceUrl,
      }, true).catch(() => {});
    }

    // ── Datos para PDF y correo ──
    const empresa =
      toText(quote?.Cuenta_Asociada?.name) ||
      toText(quote?.Name).replace(/^Cotización\s+/, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "") ||
      "Empresa";
    const contactoNombre = toText(quote?.[config.quoteContactLookupField]?.name) || "";
    const contactoEmail = toText(quote?.[config.contactEmailField]);
    const descuentos = {
      recurrentePct: Number(quote?.[config.quoteDiscountPctField] || 0),
      instalacionRMPct: Number(quote?.[config.quoteDiscountInstRMPctField] || 0),
      instalacionRegionPct: Number(quote?.[config.quoteDiscountInstRegionPctField] || 0),
    };

    // ── PDF + correo en segundo plano (misma técnica que el create) ──
    waitUntil(
      (async () => {
        const numeroCotizacion = toText(quote?.Numero_Cotizacion);
        const html = buildProposalHtml({
          cliente: {
            empresa,
            contacto: contactoNombre,
            contactoEmail,
            rutEmpresa: toText(quote?.[config.companyRutField]),
            ejecutivo: ejecutivoPorOwner(quote?.Owner?.id).nombre,
            ejecutivoEmail: ejecutivoPorOwner(quote?.Owner?.id).email,
            ejecutivoTelefono: ejecutivoPorOwner(quote?.Owner?.id).telefono,
          },
          cotizacion: { items, ufActual },
          acceptanceUrl,
          cotizacionId: numeroParaPdf(numeroCotizacion, quoteId),
          validezHasta: new Date(expMs).toISOString(),
          version: versionNueva,
          descuentos,
          condicionDiscursiva: null,
        });
        const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
        const { pdfUrl } = await uploadPdfToSupabase({ pdfBuffer, quoteId, empresa });
        await updateRecord(config.quoteModule, quoteId, {
          [config.quotePdfUrlField]: pdfUrl,
        }, true);
        if (contactoEmail) {
          const tieneReloj = items.some((it) => it && it.tipo === "hardware");
          await sendQuoteEmailViaZoho({
            quoteModule: config.quoteModule,
            quoteId,
            fromEmail: VICKY_FROM_EMAIL,
            replyToEmail: ejecutivoPorOwner(quote?.Owner?.id).email,
            ccEmail: ejecutivoPorOwner(quote?.Owner?.id).email,
            // Mismas copias fijas que la emisión (Lalo + Rodrigo, 03-ago): la
            // actualización también es una cotización que le llega al cliente.
            ccEmails: (process.env.QUOTE_EMAIL_CC_FIJO || "egomez@geovictoria.com,rlewit@geovictoria.com")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            toEmail: contactoEmail,
            toName: contactoNombre,
            subject: `Tu cotización GeoVictoria actualizada (v${versionNueva}) — ${empresa}`,
            // El bloque "Te presento a tu ejecutivo" con el DUEÑO REAL de la
            // cotización (caso DECOHOGAR 03-ago: el deal era de Tamara, el CC
            // le llegó a ella, pero el correo presentaba a Eddyluz — sin este
            // argumento buildEmailHtml cae al ejecutivo default).
            htmlBody: buildEmailHtml({
              contacto: contactoNombre,
              empresa,
              pdfUrl,
              tieneReloj,
              ejecutivo: ejecutivoPorOwner(quote?.Owner?.id),
            }),
          });
        }
        console.log(
          `[actualizar-cotizacion] quote=${quoteId} v${versionNueva} PDF+correo listos${resumenCambio ? ` (cambio: ${resumenCambio.slice(0, 120)})` : ""}`,
        );
      })().catch((bgErr) =>
        console.error("[actualizar-cotizacion] PDF/correo en segundo plano falló:", bgErr?.message || bgErr),
      ),
    );

    return sendJson(res, 200, {
      ok: true,
      version: versionNueva,
      acceptance_url: acceptanceUrl,
      mensaje_para_prospecto:
        `Listo! Tu cotización ya quedó actualizada${resumenCambio ? ` (${resumenCambio})` : ""} 🙌\n` +
        `En el mismo link de siempre ya aparece la información al día — ahí la revisas, aceptas y pagas: ${acceptanceUrl}\n` +
        `El PDF actualizado también va en camino a tu correo.`,
    });
  } catch (error) {
    console.error(`[actualizar-cotizacion] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo actualizar la cotización.",
      detail: toText(error?.message || error).slice(0, 300),
    });
  }
};
