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
const { getAcceptanceConfig } = require("./quote-acceptance-config");
const { getMercadoPagoConfig, getMercadoPagoConfigForQuoteCO, getMercadoPagoConfigForQuotePE } = require("./mercadopago-config");
const { verifyVerificationToken, normalizeEmail } = require("./verification-token");
const {
  sanitizeItems,
  clampDescuentoPct,
  computePaymentAmounts,
  computePaymentAmountsCO,
  computePaymentAmountsPE,
} = require("./quote-pricing");

const PAYMENT_SESSION_PURPOSE = "payment_session";

/**
 * true si la cotización es COLOMBIA. Mecanismo primario: el token (de pago o
 * de aceptación) viene firmado con pais:"co" — lo hace create-from-vicky-co y
 * se propaga a los tokens de pago en confirm.js / session.js — así no hay
 * llamadas extra a Zoho. Respaldo: Territorio del Deal = "Colombia" (el MISMO
 * criterio que usa session.js), para tokens antiguos o re-minteados sin la
 * marca. Chile no cambia: sin marca y sin territorio CO → false.
 */
async function esCotizacionCO(quote, tokenPayload, acceptanceConfig) {
  if (toText(tokenPayload?.pais).toLowerCase() === "co") return true;
  const dealField = toText(acceptanceConfig?.quoteDealLookupField) || "Deal_Asociado";
  const dealId = toText(quote?.[dealField]?.id || quote?.[dealField]);
  if (!dealId) return false;
  // Best-effort: si Zoho falla en este respaldo, se asume Chile (el
  // comportamiento previo), nunca se rompe la sesión de pago por esto.
  const deal = await getRecordWithFields("Deals", dealId, ["id", "Territorio"]).catch(() => null);
  return /colombia/i.test(toText(deal?.Territorio));
}

/** true si la cotización es PERÚ. Mismo mecanismo que CO: token firmado con
 * pais:"pe" (create-from-vicky-pe) y respaldo Territorio del Deal = "Perú". */
async function esCotizacionPE(quote, tokenPayload, acceptanceConfig) {
  if (toText(tokenPayload?.pais).toLowerCase() === "pe") return true;
  const dealField = toText(acceptanceConfig?.quoteDealLookupField) || "Deal_Asociado";
  const dealId = toText(quote?.[dealField]?.id || quote?.[dealField]);
  if (!dealId) return false;
  const deal = await getRecordWithFields("Deals", dealId, ["id", "Territorio"]).catch(() => null);
  return /per[uú]/i.test(toText(deal?.Territorio));
}

async function resolvePaymentSession(req, token) {
  const acceptanceConfig = getAcceptanceConfig(req);

  const payload = verifyVerificationToken(token, PAYMENT_SESSION_PURPOSE);
  const quoteId = toText(payload?.quoteId);
  if (!quoteId) {
    throw new Error("Token de pago sin cotizacion.");
  }

  const quote = await getRecord(acceptanceConfig.quoteModule, quoteId);
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

  // País de la cotización: define credenciales de MP (app CO en COP vs app CL
  // en CLP) y la fórmula de montos (CO: IVA 19% solo en líneas de hardware,
  // resto precios finales — vs flag global chileno).
  const pais = (await esCotizacionCO(quote, payload, acceptanceConfig))
    ? "co"
    : (await esCotizacionPE(quote, payload, acceptanceConfig))
      ? "pe"
      : "cl";
  const mpConfig =
    pais === "co"
      ? getMercadoPagoConfigForQuoteCO(req, quote, acceptanceConfig)
      : pais === "pe"
        ? getMercadoPagoConfigForQuotePE(req, quote, acceptanceConfig)
        : getMercadoPagoConfig(req);

  const items = sanitizeItems(quote?.[acceptanceConfig.quoteItemsSubformField]);
  const descuentos = {
    recurrentePct: clampDescuentoPct(quote?.[acceptanceConfig.quoteDiscountPctField]),
    instalacionRMPct: Number(quote?.[acceptanceConfig.quoteDiscountInstRMPctField] || 0),
    instalacionRegionPct: Number(quote?.[acceptanceConfig.quoteDiscountInstRegionPctField] || 0),
  };
  const amounts =
    pais === "co"
      ? // CO: pago único = ítems no recurrentes (+IVA 19% solo en los de
        // hardware); la Activación ya es el primer mes → sin "primer mes"
        // adicional. Sin descuentos v1.
        computePaymentAmountsCO(items)
      : pais === "pe"
      ? // PE: pago único = no recurrentes (Activación = primer mes completo
        // adelantado) + IGV 18% por línea afecta (en PE: todas).
        computePaymentAmountsPE(items)
      : computePaymentAmounts(items, descuentos, {
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
    // "co" = Colombia (COP, IVA solo en hardware); "cl" = Chile (sin cambios).
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
  };
}

module.exports = {
  PAYMENT_SESSION_PURPOSE,
  resolvePaymentSession,
  esCotizacionCO,
  esCotizacionPE,
};
