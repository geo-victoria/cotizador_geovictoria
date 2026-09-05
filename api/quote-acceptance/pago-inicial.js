/**
 * PAGO INICIAL ESPERADO de una cotización — la misma fórmula que cobra el
 * checkout (computePaymentAmounts con la config MP del país), expuesta para
 * el agente.
 *
 * Nació el 05-sep (orden de Lalo tras la prueba E3: un comprobante de
 * $20.000 contra un pago inicial de $26.756 se aceptó como pago completo).
 * Vicky compara el monto del comprobante contra esto y, si es menor, no
 * habilita el alta y pide la diferencia. Fuente única: acá no se recalcula
 * nada a mano, se llama a lo mismo que usa pago.html.
 *
 *   GET /api/quote-acceptance/pago-inicial?quoteId=...
 *   auth: x-vicky-secret (compartido con el agente)
 *   → { ok, pais, oneShotClp, firstMonthClp, recurringClp, estado, numero }
 *
 * `oneShotClp` es el pago inicial SIN recargo de tarjeta (el 3% es solo
 * para Mercado Pago; la transferencia no lo lleva).
 */

const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { getRecord, toText } = require("../_shared/zoho-crm");
const { secretoValido } = require("../_shared/secreto-vicky");
const {
  sanitizeItems,
  clampDescuentoPct,
  computePaymentAmounts,
  computePaymentAmountsCO,
  computePaymentAmountsPE,
} = require("../_shared/quote-pricing");
const {
  getMercadoPagoConfig,
  getMercadoPagoConfigForQuoteCO,
  getMercadoPagoConfigForQuotePE,
} = require("../_shared/mercadopago-config");
const { esCotizacionCO, esCotizacionPE } = require("../_shared/payment-session");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  if (!secretoValido(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  const quoteId = toText(req.query?.quoteId).replace(/\D/g, "");
  if (!quoteId) return sendJson(res, 400, { ok: false, error: "falta quoteId" });

  try {
    const config = getAcceptanceConfig(req);
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) return sendJson(res, 404, { ok: false, error: "cotización no encontrada" });

    const pais = (await esCotizacionCO(quote, null, config))
      ? "co"
      : (await esCotizacionPE(quote, null, config))
        ? "pe"
        : "cl";
    const items = sanitizeItems(quote?.[config.quoteItemsSubformField]);
    const descuentoPct = clampDescuentoPct(quote?.[config.quoteDiscountPctField]);

    let amounts;
    if (pais === "co") {
      amounts = computePaymentAmountsCO(items);
    } else if (pais === "pe") {
      amounts = computePaymentAmountsPE(items);
    } else {
      const mpConfig = getMercadoPagoConfig(req);
      amounts = computePaymentAmounts(items, descuentoPct, {
        includeIva: mpConfig.includeIva,
        includeFirstMonth: mpConfig.oneShotIncludeFirstMonth,
      });
    }
    return sendJson(res, 200, {
      ok: true,
      pais,
      quoteId,
      numero: toText(quote?.Numero_Cotizacion),
      estado: toText(quote?.Estado_Cotizacion),
      oneShotClp: Math.round(Number(amounts?.oneShotClp) || 0),
      firstMonthClp: Math.round(Number(amounts?.firstMonthClp) || 0),
      recurringClp: Math.round(Number(amounts?.recurringClp) || 0),
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: toText(error?.message || error) });
  }
};
