/**
 * Endpoint ADMIN (temporal) de consulta de pago en Mercado Pago por quoteId.
 *
 * Devuelve los datos del/los pago(s) asociados a una cotización (para armar el
 * comprobante interno). Solo lectura. Gateado por ADMIN_LOOKUP_KEY (env preview).
 *
 * GET /api/payments/admin-lookup?quoteId=<id>&key=<ADMIN_LOOKUP_KEY>
 */

const { toText } = require("../_shared/zoho-crm");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getMercadoPagoConfig } = require("../_shared/mercadopago-config");
const {
  searchPaymentsByExternalReference,
  buildExternalReference,
} = require("../_shared/mercadopago-client");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  // Auth: la clave dedicada ADMIN_LOOKUP_KEY o el secreto interno estándar
  // (x-vicky-secret, 25-ago) — así el proxy admin del agente puede consultar
  // números de operación de MP sin repartir otra llave.
  const expected = toText(process.env.ADMIN_LOOKUP_KEY);
  const provided = toText(req?.query?.key || req?.headers?.["x-lookup-key"]);
  const porLookupKey = Boolean(expected) && provided === expected;
  if (!porLookupKey && !secretoValido(req)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  const quoteId = toText(req?.query?.quoteId);
  if (!quoteId) return sendJson(res, 400, { ok: false, error: "quoteId requerido" });

  const mpConfig = getMercadoPagoConfig(req);
  if (!mpConfig.enabled || !mpConfig.accessToken) {
    return sendJson(res, 503, { ok: false, error: "MP no configurado" });
  }
  try {
    const kinds = ["oneshot", "sub"];
    const all = [];
    for (const kind of kinds) {
      const payments = await searchPaymentsByExternalReference(
        mpConfig,
        buildExternalReference(quoteId, kind),
      );
      for (const p of payments || []) {
        all.push({
          kind,
          id: p.id,
          status: p.status,
          status_detail: p.status_detail,
          amount: p.transaction_amount,
          currency: p.currency_id,
          date_approved: p.date_approved,
          date_created: p.date_created,
          payment_method: p.payment_method_id,
          payment_type: p.payment_type_id,
          installments: p.installments,
          payer_email: p?.payer?.email,
          card_last_four: p?.card?.last_four_digits,
          external_reference: p.external_reference,
          receipt_url:
            p?.transaction_details?.external_resource_url ||
            p?.point_of_interaction?.transaction_data?.ticket_url ||
            null,
          net_received: p?.transaction_details?.net_received_amount,
        });
      }
    }
    return sendJson(res, 200, { ok: true, quoteId, count: all.length, payments: all });
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: toText(error?.message || error).slice(0, 300) });
  }
};
