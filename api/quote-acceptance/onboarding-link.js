/**
 * POST /api/quote-acceptance/onboarding-link — link de auto-onboarding bajo
 * demanda para Vicky.
 *
 * Caso de uso (MX v1 por transferencia, decisión Lalo 22-jul): mientras no
 * exista MercadoPago México, el cliente mexicano paga por transferencia y
 * manda el comprobante por WhatsApp. Al recibirlo, Vicky entrega de inmediato
 * el acceso al auto-onboarding y presenta a su ejecutivo — este endpoint le
 * da ese link. Sirve para cualquier país (el handoff es genérico).
 *
 * runOnboardingHandoff es IDEMPOTENTE: si la cotización ya tiene onboarding
 * con link, lo reutiliza; si no, crea el registro y genera el link. La
 * cotización NO se marca como pagada acá (la verificación del abono sigue
 * siendo de finanzas; el link no confirma dinero).
 *
 * Auth: header x-vicky-secret == VICKY_COTIZADORA_SECRET (mismo esquema que
 * send-reactivation-email / reenviar-cotizacion). Body: { quoteId }.
 */

const { runOnboardingHandoff } = require("../_shared/onboarding-handoff");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { getRecord, toText } = require("../_shared/zoho-crm");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
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

  if (!secretoValido(req)) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    }

    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });
    }

    const result = await runOnboardingHandoff({
      config,
      quoteId,
      dealId: toText(quote?.[config.quoteDealLookupField]?.id),
      acceptanceData: {},
    });

    const onboardingUrl = toText(result?.onboardingUrl);
    if (!onboardingUrl) {
      return sendJson(res, 502, { ok: false, error: "El handoff no devolvio link." });
    }
    return sendJson(res, 200, {
      ok: true,
      quoteId,
      onboardingUrl,
      reused: result?.reused === true,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: toText(error?.message || error) || "Error en onboarding-link.",
    });
  }
};
