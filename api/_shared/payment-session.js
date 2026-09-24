/**
 * Resuelve el contexto de una sesion de pago a partir del token firmado que
 * genera `confirm.js` (purpose "payment_session").
 *
 * Carga la cotizacion, valida coherencia del token vs. el Deal de la
 * cotizacion y calcula los montos a cobrar (one-shot y recurrente).
 *
 * MULTI-PAÍS: aquí se decide con qué app de MercadoPago se cobra. Una
 * cotización COLOMBIA usa la config CO (cuenta MCO, moneda COP y — si es la
 * empresa de prueba — credenciales sandbox) y montos con IVA POR LÍNEA; el
 * resto sigue con la config chilena de siempre (Chile NO cambia).
 */

const { getRecord, getRecordWithFields, toText } = require("./zoho-crm");
const { getQuoteConRespaldo } = require("./respaldo-cotizacion");
const { getAcceptanceConfig } = require("./quote-acceptance-config");
const { getMercadoPagoConfigForQuotePais } = require("./mercadopago-config");
const { paisDeToken, paisPorTerritorio } = require("./pais-pago");
const { verifyVerificationToken, normalizeEmail } = require("./verification-token");
const {
  sanitizeItems,
  clampDescuentoPct,
  computePaymentAmountsPais,
} = require("./quote-pricing");

const PAYMENT_SESSION_PURPOSE = "payment_session";

/**
 * País de la cotización — UNA función para todos (24-sep). Mecanismo
 * primario: el token (de pago o de aceptación) firmado con `pais` por la
 * emisión del país y propagado por confirm.js / session.js, así no hay
 * llamadas extra a Zoho. Respaldo: Territorio del Deal (tokens antiguos o sin
 * la marca). Sin marca y sin territorio conocido → "cl" (Chile no cambia).
 * Best-effort: si Zoho falla en el respaldo se asume Chile, nunca se rompe la
 * sesión de pago por esto.
 */
async function resolverPaisCotizacion(quote, tokenPayload, acceptanceConfig) {
  const delToken = paisDeToken(tokenPayload);
  if (delToken) return delToken;
  const dealField = toText(acceptanceConfig?.quoteDealLookupField) || "Deal_Asociado";
  const dealId = toText(quote?.[dealField]?.id || quote?.[dealField]);
  if (!dealId) return "cl";
  const deal = await getRecordWithFields("Deals", dealId, ["id", "Territorio"]).catch(() => null);
  return paisPorTerritorio(deal?.Territorio);
}

// Compatibilidad con los llamadores de antes.
async function esCotizacionCO(quote, tokenPayload, acceptanceConfig) {
  return (await resolverPaisCotizacion(quote, tokenPayload, acceptanceConfig)) === "co";
}
async function esCotizacionPE(quote, tokenPayload, acceptanceConfig) {
  return (await resolverPaisCotizacion(quote, tokenPayload, acceptanceConfig)) === "pe";
}

async function resolvePaymentSession(req, token) {
  const acceptanceConfig = getAcceptanceConfig(req);

  const payload = verifyVerificationToken(token, PAYMENT_SESSION_PURPOSE);
  const quoteId = toText(payload?.quoteId);
  if (!quoteId) {
    throw new Error("Token de pago sin cotizacion.");
  }

  // Con Zoho caído se sirve la copia guardada en vez de tumbar el estado de
  // pago (21 fallos entre el 27-ago y el 2-sep dejaron a clientes sin poder
  // pagar). Ver api/_shared/respaldo-cotizacion.js.
  const { quote, degradado } = await getQuoteConRespaldo(acceptanceConfig.quoteModule, quoteId);
  if (!quote) {
    throw new Error("No se encontro la cotizacion.");
  }

  const quoteDealId = toText(
    quote?.[acceptanceConfig.quoteDealLookupField]?.id ||
      quote?.[acceptanceConfig.quoteDealLookupField]
  );
  const tokenDealId = toText(payload?.dealId);
  if (tokenDealId && quoteDealId && tokenDealId !== quoteDealId) {
    throw new Error("El token de pago no corresponde a esta cotizacion.");
  }

  // País de la cotización: define credenciales de MP (app del país, su
  // moneda y — si es la empresa de prueba — credenciales sandbox) y la
  // fórmula de montos (impuesto por línea, redondeo, primer mes).
  const pais = await resolverPaisCotizacion(quote, payload, acceptanceConfig);
  const mpConfig = getMercadoPagoConfigForQuotePais(req, quote, acceptanceConfig, pais);

  const items = sanitizeItems(quote?.[acceptanceConfig.quoteItemsSubformField]);
  const descuentos = {
    recurrentePct: clampDescuentoPct(quote?.[acceptanceConfig.quoteDiscountPctField]),
    instalacionRMPct: Number(quote?.[acceptanceConfig.quoteDiscountInstRMPctField] || 0),
    instalacionRegionPct: Number(quote?.[acceptanceConfig.quoteDiscountInstRegionPctField] || 0),
  };
  const amounts = computePaymentAmountsPais(pais, items, descuentos, {
    includeIva: mpConfig.includeIva,
    includeFirstMonth: mpConfig.oneShotIncludeFirstMonth,
  });

  const billingEmail =
    normalizeEmail(payload?.billingEmail) ||
    normalizeEmail(quote?.[acceptanceConfig.billingEmailField]) ||
    normalizeEmail(quote?.[acceptanceConfig.contactEmailField]);

  return {
    acceptanceConfig,
    mpConfig,
    // cl | co | pe | mx (ficha en pais-pago.js).
    pais,
    quote,
    quoteId,
    dealId: quoteDealId || tokenDealId,
    billingEmail,
    billingPhone: toText(quote?.[acceptanceConfig.billingPhoneField]),
    companyRut: toText(quote?.[acceptanceConfig.companyRutField]),
    quoteName: toText(quote?.Name),
    amounts,
    token,
    // true = el dato viene del respaldo porque Zoho no respondió.
    degradado,
  };
}

module.exports = {
  PAYMENT_SESSION_PURPOSE,
  resolvePaymentSession,
  resolverPaisCotizacion,
  esCotizacionCO,
  esCotizacionPE,
};
