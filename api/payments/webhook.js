const { toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { getMercadoPagoConfig, getMercadoPagoConfigCO, getMercadoPagoConfigPE } = require("../_shared/mercadopago-config");
const {
  getPayment,
  validateWebhookSignature,
  parseExternalReference,
} = require("../_shared/mercadopago-client");
const { maybeFinalizeQuote } = require("../_shared/post-payment-finalize");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  if (req?.body && typeof req.body === "object") return req.body;
  if (typeof req?.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (_error) {
      return {};
    }
  }
  if (!req || typeof req.on !== "function") return {};
  const chunks = [];
  await new Promise((resolve) => {
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", resolve);
    req.on("error", resolve);
  });
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

// Devuelve el quoteId a partir del recurso de MP referenciado por el evento.
async function resolveQuoteIdFromEvent(mpConfig, { type, dataId }) {
  if (!dataId) return null;

  if (type === "payment") {
    const payment = await getPayment(mpConfig, dataId);
    const ref = parseExternalReference(payment?.external_reference);
    return ref?.quoteId || null;
  }

  // Suscripción MP retirada (12-ago): las notificaciones de preapproval ya no
  // se procesan — no existe flujo que las genere.

  return null;
}

export default async function handler(req, res) {
  // Mercado Pago espera 200/201 rapido; cualquier error operacional se loguea
  // pero igual respondemos 200 para evitar reintentos en loop. La unica
  // respuesta no-2xx es por firma invalida.
  if (req.method !== "POST") {
    sendJson(res, 405, { received: false, error: "Metodo no permitido." });
    return;
  }

  // Multi-país: la MISMA URL recibe los webhooks de las apps de Chile y de
  // Colombia. El país se determina por CUÁL clave valida la firma (cada app
  // firma con su propia clave secreta); las credenciales para consultar el
  // pago y finalizar salen de la config de ese país.
  let mpConfig = getMercadoPagoConfig(req);
  const acceptanceConfig = getAcceptanceConfig(req);

  try {
    const body = await parseBody(req);
    const query = req?.query || {};

    // type/topic puede venir por query o por body.
    const type = toText(
      query.type || query.topic || body?.type || body?.topic
    ).toLowerCase();
    // data.id puede venir como query["data.id"], query.id o body.data.id.
    const dataId = toText(
      query["data.id"] || query.id || body?.data?.id || body?.resource
    );

    const firmaArgs = {
      xSignature: firstHeader(req?.headers?.["x-signature"]),
      xRequestId: firstHeader(req?.headers?.["x-request-id"]),
      dataId: toText(query["data.id"] || query.id || body?.data?.id),
    };
    let signature = validateWebhookSignature({ ...firmaArgs, secret: mpConfig.webhookSecret });
    if (!signature.valid) {
      const mpConfigCO = getMercadoPagoConfigCO(req);
      if (mpConfigCO.webhookSecret) {
        const firmaCO = validateWebhookSignature({ ...firmaArgs, secret: mpConfigCO.webhookSecret });
        if (firmaCO.valid) {
          signature = firmaCO;
          mpConfig = mpConfigCO;
          console.log("[mp-webhook] firma validada con la app de COLOMBIA");
        }
      }
    }
    if (!signature.valid) {
      const mpConfigPE = getMercadoPagoConfigPE(req);
      if (mpConfigPE.webhookSecret) {
        const firmaPE = validateWebhookSignature({ ...firmaArgs, secret: mpConfigPE.webhookSecret });
        if (firmaPE.valid) {
          signature = firmaPE;
          mpConfig = mpConfigPE;
          console.log("[mp-webhook] firma validada con la app de PERÚ");
        }
      }
    }

    if (!signature.valid) {
      sendJson(res, 401, { received: false, error: "Firma invalida.", reason: signature.reason });
      return;
    }

    if (!mpConfig.enabled || !mpConfig.accessToken) {
      sendJson(res, 200, { received: true, skipped: "mp_disabled" });
      return;
    }

    const quoteId = await resolveQuoteIdFromEvent(mpConfig, { type, dataId });
    if (!quoteId) {
      sendJson(res, 200, { received: true, skipped: "no_quote_reference", type });
      return;
    }

    const result = await maybeFinalizeQuote({ mpConfig, acceptanceConfig, quoteId });
    sendJson(res, 200, {
      received: true,
      quoteId,
      type,
      paymentsComplete: result.paymentsComplete,
      finalized: result.finalized,
      onboardingReady: Boolean(result.onboardingUrl),
    });
  } catch (error) {
    // Respondemos 200 con detalle del error: MP reintenta por su cuenta y el
    // endpoint de estado (status.js) tambien reconcilia desde el front.
    sendJson(res, 200, {
      received: true,
      handled: false,
      detail: toText(error?.message || error).slice(0, 300),
    });
  }
}
