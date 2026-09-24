/**
 * Configuracion de la integracion con Mercado Pago.
 *
 * Todo se controla por variables de entorno (Vercel). Por defecto la
 * integracion esta DESACTIVADA (`MP_PAYMENTS_ENABLED` != "true") y apunta a
 * ambiente de PRUEBA, de modo que pasar a produccion sea solo un cambio de
 * configuracion (Access Token productivo + `MP_ENVIRONMENT=production`).
 *
 * Nunca exponer `MP_ACCESS_TOKEN` en el cliente: solo se usa desde el backend.
 */

const { toText } = require("./zoho-crm");

const MP_API_BASE = "https://api.mercadopago.com";

function toBool(value, fallback = false) {
  const raw = toText(value).toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "si";
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBaseUrl(req) {
  const envBase = toText(process.env.QUOTE_ACCEPT_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL);
  if (envBase) return envBase.replace(/\/+$/, "");

  const host = toText(req?.headers?.host);
  const proto = toText(req?.headers?.["x-forwarded-proto"]) || "https";
  if (!host) {
    return "https://cotizacion.geovictoria.com";
  }
  return `${proto}://${host}`;
}

// ── Empresa de prueba (bypass de pago) ──
// Identifica la cotización de prueba (HuelleroCompany, por ID de cuenta CRM,
// RUT o nombre; configurable por env). confirm.js la usa para SALTARSE el pago
// de MercadoPago y finalizar directo (crear el COT) — permite testear el flujo
// completo sin pago, sin afectar a clientes reales (cualquier otra empresa paga
// normal). Default: HuelleroCompany.
function normalizeRut(value) {
  return toText(value).replace(/[.\s-]/g, "").toUpperCase();
}

function isTestLaneQuote(quote, acceptanceConfig) {
  if (!quote) return false;
  const testAccountIds = (toText(process.env.MP_TEST_LANE_ACCOUNT_IDS) || "3525045000208660206")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const testRuts = (toText(process.env.MP_TEST_LANE_RUTS) || "76622058-4")
    .split(",").map((s) => normalizeRut(s)).filter(Boolean);
  const testNames = (toText(process.env.MP_TEST_LANE_COMPANIES) || "huellerocompany")
    .split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
  const accountId = toText(
    quote?.Cuenta_Asociada?.id || quote?.CRM_Account?.id || quote?.[acceptanceConfig?.onboardingAccountLookupField]?.id
  );
  const rut = normalizeRut(
    quote?.[acceptanceConfig?.companyRutField] || quote?.RUT_Cliente || quote?.RUT || quote?.Identificador_Tributario_Empresa
  );
  const companyName = toText(
    quote?.Cuenta_Asociada?.name || quote?.CRM_ACCOUNT_NAME || quote?.Account_Name?.name || quote?.CRM_ACCOUNT
  ).toLowerCase().replace(/\s+/g, "");
  if (accountId && testAccountIds.includes(accountId)) return true;
  if (rut && testRuts.includes(rut)) return true;
  if (companyName && testNames.includes(companyName)) return true;
  return false;
}

function getMercadoPagoConfig(req) {
  const baseUrl = getBaseUrl(req);
  const environment = toText(process.env.MP_ENVIRONMENT || "test").toLowerCase();
  const landingPath = toText(process.env.MP_PAYMENT_LANDING_PATH || "/pago.html");

  return {
    enabled: toBool(process.env.MP_PAYMENTS_ENABLED, false),
    environment,
    isProduction: environment === "production" || environment === "prod",
    apiBase: MP_API_BASE,
    accessToken: toText(process.env.MP_ACCESS_TOKEN),
    publicKey: toText(process.env.MP_PUBLIC_KEY),
    webhookSecret: toText(process.env.MP_WEBHOOK_SECRET),
    currencyId: toText(process.env.MP_CURRENCY_ID || "CLP"),
    includeIva: toBool(process.env.MP_CHARGE_INCLUDE_IVA, true),
    // Suscripcion recurrente: desactivada por ahora. El monto recurrente varia
    // por usuarios activos/mes (input aun no integrado), asi que por defecto solo
    // se cobra el pago unico. Encender con MP_SUBSCRIPTION_ENABLED=true.
    // Cobrar el primer mes de servicio por adelantado dentro del pago unico.
    oneShotIncludeFirstMonth: toBool(process.env.MP_ONESHOT_INCLUDE_FIRST_MONTH, true),
    statementDescriptor: toText(process.env.MP_STATEMENT_DESCRIPTOR || "GEOVICTORIA"),
    oneShotTitle: toText(process.env.MP_ONESHOT_TITLE || "Servicios iniciales GeoVictoria"),
    paymentSessionTtlMinutes: toInt(process.env.MP_PAYMENT_SESSION_TTL_MINUTES, 1440),
    baseUrl,
    landingPath,
    landingUrl: `${baseUrl}${landingPath.startsWith("/") ? "" : "/"}${landingPath}`,
    notificationUrl: toText(process.env.MP_NOTIFICATION_URL) || `${baseUrl}/api/payments/webhook`,
    // Valor (best-effort) que se escribe en el campo de estado del handoff de la
    // cotizacion mientras el pago esta pendiente.
    statusPaymentPending: toText(process.env.MP_QUOTE_STATUS_PAYMENT_PENDING || "Pago Pendiente"),
  };
}

/**
 * Devuelve el init_point correcto segun ambiente. En ambiente de prueba se
 * prefiere `sandbox_init_point` cuando esta disponible (preferencias). El
 * preapproval solo expone `init_point`.
 */
function pickInitPoint(resource, config) {
  if (!resource) return "";
  if (!config.isProduction && resource.sandbox_init_point) {
    return resource.sandbox_init_point;
  }
  return resource.init_point || resource.sandbox_init_point || "";
}


// ── Multi-país: UNA config por ficha (24-sep, orden de Lalo al levantar
// México: "un solo código global con parámetros/ficha local") ───────────────
// Antes había una copia por país (getMercadoPagoConfigCO, …PE) con sus envs
// y su carril de prueba. Ahora los parámetros viven en pais-pago.js y estas
// funciones los leen: un país nuevo es una entrada en la ficha, no otra copia.
//
//   · Credenciales, clave de webhook y moneda: envs con el sufijo del país
//     (MP_ACCESS_TOKEN_<CC>, MP_PUBLIC_KEY_<CC>, MP_WEBHOOK_SECRET_<CC>,
//     MP_CURRENCY_ID_<CC>). El webhook decide el país por CUÁL clave valida.
//   · `enabled` exige además el access token del país: un país sin cuenta
//     de MP cargada queda con el cobro en línea apagado de hecho.
//   · El pago inicial (pagos únicos + primer mes) lo arma el cálculo del país
//     (computePaymentAmountsPais); el flag chileno includeFirstMonth no aplica.
const { fichaPago, PAISES_PAGO } = require("./pais-pago");

function getMercadoPagoConfigPais(req, pais) {
  const base = getMercadoPagoConfig(req);
  const f = fichaPago(pais);
  if (!f.envSufijo) return base; // Chile: la config de siempre
  const sufijo = f.envSufijo;
  const accessToken = toText(process.env[`MP_ACCESS_TOKEN${sufijo}`]);
  return {
    ...base,
    pais: f.codigo,
    enabled: base.enabled && Boolean(accessToken),
    accessToken,
    publicKey: toText(process.env[`MP_PUBLIC_KEY${sufijo}`]),
    webhookSecret: toText(process.env[`MP_WEBHOOK_SECRET${sufijo}`]),
    currencyId: toText(process.env[`MP_CURRENCY_ID${sufijo}`] || f.moneda),
    oneShotTitle: toText(process.env[`MP_ONESHOT_TITLE${sufijo}`] || f.cobroUnicoTitulo || base.oneShotTitle),
    oneShotIncludeFirstMonth: false,
  };
}

/** ¿El país tiene el cobro en línea encendido (switch global + cuenta propia)? */
function conPagoEnLinea(pais) {
  return getMercadoPagoConfigPais(null, pais).enabled === true;
}

// ── Carril de PRUEBA por país (CO/PE/MX) ──
// A diferencia de Chile (la empresa de prueba se SALTA el pago en confirm.js),
// en estos países la empresa de prueba SÍ pasa por el checkout, con las
// credenciales SANDBOX de la app del país: flujo completo con tarjetas de
// prueba, sin cobros reales.
function isTestLaneQuotePais(quote, acceptanceConfig, pais) {
  if (!quote) return false;
  const f = fichaPago(pais);
  const carril = f.carrilPrueba;
  if (!carril) return false;
  const normDoc = (v) =>
    carril.soloDigitos ? String(v || "").replace(/\D/g, "") : normalizeRut(v);
  const docs = toText(carril.docs()).split(",").map(normDoc).filter(Boolean);
  const nombres = toText(carril.nombres())
    .split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
  // El documento tributario del país vive en RUT_Cliente (convención de las
  // emisiones CO/PE/MX: "documento del país en el mismo campo").
  const doc = normDoc(quote?.[acceptanceConfig?.companyRutField] || quote?.RUT_Cliente || quote?.RUT);
  const companyName = toText(
    quote?.Cuenta_Asociada?.name || quote?.Account_Name?.name || quote?.CRM_ACCOUNT
  ).toLowerCase().replace(/\s+/g, "");
  if (doc && docs.includes(doc)) return true;
  if (companyName && nombres.includes(companyName)) return true;
  return false;
}

// Config de MP para UNA cotización concreta: producción por defecto; si es la
// empresa de prueba, credenciales sandbox. FAIL-SAFE: sin las envs de sandbox
// se lanza un error explícito — JAMÁS caer a producción en silencio, porque
// una prueba cobraría de verdad. Chile devuelve su config de siempre.
function getMercadoPagoConfigForQuotePais(req, quote, acceptanceConfig, pais) {
  const base = getMercadoPagoConfigPais(req, pais);
  const f = fichaPago(pais);
  if (!f.envSufijo) return base;
  if (!isTestLaneQuotePais(quote, acceptanceConfig, pais)) return base;

  const sufijo = f.envSufijo;
  const testAccessToken = toText(process.env[`MP_TEST_ACCESS_TOKEN${sufijo}`]);
  const testPublicKey = toText(process.env[`MP_TEST_PUBLIC_KEY${sufijo}`]);
  if (!testAccessToken) {
    throw new Error(
      `Carril de prueba ${f.codigo.toUpperCase()}: la cotizacion es de la empresa de prueba pero faltan las credenciales ` +
        `sandbox (MP_TEST_ACCESS_TOKEN${sufijo} / MP_TEST_PUBLIC_KEY${sufijo}). No se usa produccion como fallback.`
    );
  }
  return {
    ...base,
    enabled: getMercadoPagoConfig(req).enabled,
    accessToken: testAccessToken,
    publicKey: testPublicKey,
    environment: "test",
    // OJO: NO bajar isProduction. Con credenciales de PRUEBA el init_point
    // normal funciona y es el recomendado; el sandbox_init_point está
    // deprecado y produce ERR_TOO_MANY_REDIRECTS (prueba E2E CO 10-jul).
    testLane: true,
  };
}

// Alias por país (compatibilidad con los llamadores existentes).
const getMercadoPagoConfigCO = (req) => getMercadoPagoConfigPais(req, "co");
const getMercadoPagoConfigPE = (req) => getMercadoPagoConfigPais(req, "pe");
const getMercadoPagoConfigForQuoteCO = (req, q, ac) => getMercadoPagoConfigForQuotePais(req, q, ac, "co");
const getMercadoPagoConfigForQuotePE = (req, q, ac) => getMercadoPagoConfigForQuotePais(req, q, ac, "pe");
const isTestLaneQuoteCO = (q, ac) => isTestLaneQuotePais(q, ac, "co");
const isTestLaneQuotePE = (q, ac) => isTestLaneQuotePais(q, ac, "pe");

module.exports = {
  MP_API_BASE,
  getMercadoPagoConfig,
  getMercadoPagoConfigPais,
  getMercadoPagoConfigForQuotePais,
  isTestLaneQuotePais,
  conPagoEnLinea,
  PAISES_PAGO,
  getMercadoPagoConfigCO,
  getMercadoPagoConfigForQuoteCO,
  getMercadoPagoConfigPE,
  getMercadoPagoConfigForQuotePE,
  isTestLaneQuotePE,
  isTestLaneQuote,
  isTestLaneQuoteCO,
  pickInitPoint,
  toBool,
};
