/**
 * Cliente minimo para la API de Mercado Pago (https://api.mercadopago.com).
 *
 * Solo se usa desde el backend. Autentica con el Access Token de la aplicacion
 * (no requiere OAuth porque GeoVictoria cobra en su propia cuenta).
 *
 * Cubre lo necesario para el journey del cotizador:
 * - Pago unico:  POST /checkout/preferences  +  GET /v1/payments/search
 * - Validacion de firma de webhook (x-signature, HMAC-SHA256).
 */

const crypto = require("crypto");
const { MP_API_BASE } = require("./mercadopago-config");

function ensureAccessToken(config) {
  const token = config?.accessToken;
  if (!token) {
    throw new Error(
      "Mercado Pago no esta configurado: falta MP_ACCESS_TOKEN en el entorno."
    );
  }
  return token;
}

async function mpRequest(config, path, { method = "GET", body, idempotencyKey } = {}) {
  const accessToken = ensureAccessToken(config);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) {
    headers["X-Idempotency-Key"] = idempotencyKey;
  }

  const url = `${config.apiBase || MP_API_BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_error) {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const detail = parsed?.message || parsed?.error || parsed?.raw || text || "";
    const error = new Error(`Mercado Pago ${method} ${path} -> HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }

  return parsed;
}

function createPreference(config, preference) {
  return mpRequest(config, "/checkout/preferences", {
    method: "POST",
    body: preference,
    idempotencyKey: preference?.external_reference
      ? `pref-${preference.external_reference}`
      : undefined,
  });
}

function getPayment(config, paymentId) {
  return mpRequest(config, `/v1/payments/${encodeURIComponent(paymentId)}`);
}

async function searchPaymentsByExternalReference(config, externalReference) {
  const qs = new URLSearchParams({
    external_reference: externalReference,
    sort: "date_created",
    criteria: "desc",
  }).toString();
  const result = await mpRequest(config, `/v1/payments/search?${qs}`);
  const all = Array.isArray(result?.results) ? result.results : [];
  // El search de MP no siempre filtra de forma estricta por external_reference,
  // asi que filtramos en cliente para quedarnos solo con los de esta cotizacion.
  return all.filter(
    (p) => String(p?.external_reference || "") === String(externalReference)
  );
}




/**
 * Valida la firma del webhook de Mercado Pago.
 *
 * Header `x-signature: ts=<ts>,v1=<hmac>`. El manifest es
 *   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 * y el HMAC-SHA256 se calcula con el secreto del webhook. Si `data.id` es
 * alfanumerico debe ir en minusculas.
 *
 * Si no hay secreto configurado, devuelve { valid: true, skipped: true } para
 * no bloquear ambientes de prueba sin secreto (configurable subiendo el secreto).
 */
function validateWebhookSignature({ xSignature, xRequestId, dataId, secret }) {
  if (!secret) {
    return { valid: true, skipped: true };
  }
  const sig = String(xSignature || "");
  if (!sig) return { valid: false, reason: "missing_signature" };

  let ts = "";
  let v1 = "";
  sig.split(",").forEach((part) => {
    const [rawKey, rawValue] = part.split("=");
    const key = String(rawKey || "").trim();
    const value = String(rawValue || "").trim();
    if (key === "ts") ts = value;
    if (key === "v1") v1 = value;
  });

  if (!ts || !v1) return { valid: false, reason: "malformed_signature" };

  const normalizedId = /^[a-zA-Z0-9]+$/.test(String(dataId || ""))
    ? String(dataId).toLowerCase()
    : String(dataId || "");

  const manifest = `id:${normalizedId};request-id:${xRequestId || ""};ts:${ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(v1);
  const valid =
    expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf);

  return { valid, reason: valid ? "ok" : "signature_mismatch" };
}

// external_reference helpers: codifican el quoteId y el tipo de flujo.
function buildExternalReference(quoteId, kind) {
  return `qa:${String(quoteId || "")}:${kind}`;
}

function parseExternalReference(externalReference) {
  const parts = String(externalReference || "").split(":");
  if (parts.length < 3 || parts[0] !== "qa") return null;
  return { quoteId: parts[1], kind: parts[2] };
}

const APPROVED_PAYMENT_STATUSES = new Set(["approved", "authorized"]);

function hasApprovedPayment(payments) {
  return (Array.isArray(payments) ? payments : []).some((p) =>
    APPROVED_PAYMENT_STATUSES.has(String(p?.status || "").toLowerCase())
  );
}


module.exports = {
  mpRequest,
  createPreference,
  getPayment,
  searchPaymentsByExternalReference,
  validateWebhookSignature,
  buildExternalReference,
  parseExternalReference,
  hasApprovedPayment,
  APPROVED_PAYMENT_STATUSES,
};
