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
    subscriptionEnabled: toBool(process.env.MP_SUBSCRIPTION_ENABLED, false),
    // Cobrar el primer mes de servicio por adelantado dentro del pago unico.
    oneShotIncludeFirstMonth: toBool(process.env.MP_ONESHOT_INCLUDE_FIRST_MONTH, true),
    statementDescriptor: toText(process.env.MP_STATEMENT_DESCRIPTOR || "GEOVICTORIA"),
    subscriptionReason: toText(process.env.MP_SUBSCRIPTION_REASON || "Suscripcion GeoVictoria"),
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


// ── Multi-país: COLOMBIA ────────────────────────────────────────────────────
// Variante de la config para la cuenta de MercadoPago de Geovictoria Colombia
// SAS (site MCO). Misma base operativa que Chile, con credenciales, clave de
// webhook y moneda propias (envs *_CO cargadas en Vercel el 10-jul-2026).
// El webhook decide el país validando la firma contra ambas claves.
function getMercadoPagoConfigCO(req) {
  const base = getMercadoPagoConfig(req);
  return {
    ...base,
    pais: "co",
    accessToken: toText(process.env.MP_ACCESS_TOKEN_CO),
    publicKey: toText(process.env.MP_PUBLIC_KEY_CO),
    webhookSecret: toText(process.env.MP_WEBHOOK_SECRET_CO),
    currencyId: toText(process.env.MP_CURRENCY_ID_CO || "COP"),
    // Título de la línea del checkout CO: en Colombia el pago único es la
    // Activación (equivalente al primer mes), no "servicios iniciales".
    oneShotTitle: toText(process.env.MP_ONESHOT_TITLE_CO || "Activación servicio GeoVictoria"),
    // En CO el pago único NUNCA suma un "primer mes" extra: la Activación ya lo
    // es. Se fuerza acá para que el env chileno MP_ONESHOT_INCLUDE_FIRST_MONTH
    // no pueda encenderlo por accidente en cotizaciones CO.
    oneShotIncludeFirstMonth: false,
  };
}

// ── Carril de PRUEBA COLOMBIA ──
// Espejo del patrón chileno isTestLaneQuote, pero con OTRO efecto: en Chile la
// empresa de prueba se SALTA el pago (bypass en confirm.js); en CO la empresa
// de prueba SÍ pasa por el checkout, solo que con las credenciales SANDBOX de
// la app CO, para poder probar el flujo completo con tarjetas de prueba de
// MercadoPago Colombia sin generar cobros reales.
function isTestLaneQuoteCO(quote, acceptanceConfig) {
  if (!quote) return false;
  // NIT y nombre de la empresa sandbox CO (defaults del plan COLOMBIA paso 4;
  // se normalizan igual que el RUT chileno: sin puntos, guiones ni espacios).
  const testNits = (toText(process.env.TEST_LANE_CO_NIT) || "901.234.567-8")
    .split(",").map((s) => normalizeRut(s)).filter(Boolean);
  const testNames = (toText(process.env.TEST_LANE_CO_NAME) || "Prueba Vicky CO SAS")
    .split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
  // En la cotización CO el NIT vive en RUT_Cliente (convención "documento
  // tributario del país en el mismo campo", ver create-from-vicky-co.js).
  const nit = normalizeRut(
    quote?.[acceptanceConfig?.companyRutField] || quote?.RUT_Cliente || quote?.RUT
  );
  const companyName = toText(
    quote?.Cuenta_Asociada?.name || quote?.Account_Name?.name || quote?.CRM_ACCOUNT
  ).toLowerCase().replace(/\s+/g, "");
  if (nit && testNits.includes(nit)) return true;
  if (companyName && testNames.includes(companyName)) return true;
  return false;
}

// Config de MP a usar para UNA cotización CO concreta: producción por defecto;
// si es la empresa de prueba, credenciales sandbox. FAIL-SAFE: si las envs de
// sandbox no están cargadas se lanza un error explícito — JAMÁS caer a las
// credenciales productivas en silencio, porque una prueba cobraría de verdad.
function getMercadoPagoConfigForQuoteCO(req, quote, acceptanceConfig) {
  const base = getMercadoPagoConfigCO(req);
  if (!isTestLaneQuoteCO(quote, acceptanceConfig)) return base;

  const testAccessToken = toText(process.env.MP_TEST_ACCESS_TOKEN_CO);
  const testPublicKey = toText(process.env.MP_TEST_PUBLIC_KEY_CO);
  if (!testAccessToken) {
    throw new Error(
      "Carril de prueba CO: la cotizacion es de la empresa de prueba pero faltan las credenciales " +
        "sandbox (MP_TEST_ACCESS_TOKEN_CO / MP_TEST_PUBLIC_KEY_CO). No se usa produccion como fallback."
    );
  }
  return {
    ...base,
    accessToken: testAccessToken,
    publicKey: testPublicKey,
    environment: "test",
    // OJO: NO bajar isProduction acá. Con credenciales de PRUEBA el init_point
    // normal (www.mercadopago.com.co) funciona y es el recomendado; el
    // sandbox_init_point (sandbox.mercadopago.com.co) está deprecado y produce
    // ERR_TOO_MANY_REDIRECTS (visto en vivo, prueba E2E CO 10-jul).
    testLane: true,
  };
}

// ── Multi-país: PERÚ ────────────────────────────────────────────────────────
// Variante para la cuenta de MercadoPago de GEOVICTORIA PERU S.A.C. (site
// MPE). Mismo patrón que Colombia: credenciales, clave de webhook y moneda
// propias (envs *_PE). El webhook decide el país validando la firma contra
// todas las claves. La Activación PE ya incluye el primer mes → nunca se
// suma un "primer mes" extra desde el env chileno.
function getMercadoPagoConfigPE(req) {
  const base = getMercadoPagoConfig(req);
  return {
    ...base,
    pais: "pe",
    accessToken: toText(process.env.MP_ACCESS_TOKEN_PE),
    publicKey: toText(process.env.MP_PUBLIC_KEY_PE),
    webhookSecret: toText(process.env.MP_WEBHOOK_SECRET_PE),
    currencyId: toText(process.env.MP_CURRENCY_ID_PE || "PEN"),
    oneShotTitle: toText(process.env.MP_ONESHOT_TITLE_PE || "Pago inicial GeoVictoria Perú"),
    oneShotIncludeFirstMonth: false,
  };
}

// ── Carril de PRUEBA PERÚ (espejo del CO): la empresa de prueba pasa por el
// checkout con credenciales SANDBOX de la app PE — flujo completo con
// tarjetas de prueba, sin cobros reales. FAIL-SAFE: sin envs sandbox se
// lanza error explícito, jamás se cae a producción en silencio.
function isTestLaneQuotePE(quote, acceptanceConfig) {
  if (!quote) return false;
  const testRucs = (toText(process.env.TEST_LANE_PE_RUC) || "20605842055")
    .split(",").map((s) => String(s).replace(/\D/g, "")).filter(Boolean);
  const testNames = (toText(process.env.TEST_LANE_PE_NAME) || "Prueba Vicky PE SAC")
    .split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
  const ruc = String(
    quote?.[acceptanceConfig?.companyRutField] || quote?.RUT_Cliente || quote?.RUT || ""
  ).replace(/\D/g, "");
  const companyName = toText(
    quote?.Cuenta_Asociada?.name || quote?.Account_Name?.name || quote?.CRM_ACCOUNT
  ).toLowerCase().replace(/\s+/g, "");
  if (ruc && testRucs.includes(ruc)) return true;
  if (companyName && testNames.includes(companyName)) return true;
  return false;
}

function getMercadoPagoConfigForQuotePE(req, quote, acceptanceConfig) {
  const base = getMercadoPagoConfigPE(req);
  if (!isTestLaneQuotePE(quote, acceptanceConfig)) return base;

  const testAccessToken = toText(process.env.MP_TEST_ACCESS_TOKEN_PE);
  const testPublicKey = toText(process.env.MP_TEST_PUBLIC_KEY_PE);
  if (!testAccessToken) {
    throw new Error(
      "Carril de prueba PE: la cotizacion es de la empresa de prueba pero faltan las credenciales " +
        "sandbox (MP_TEST_ACCESS_TOKEN_PE / MP_TEST_PUBLIC_KEY_PE). No se usa produccion como fallback."
    );
  }
  return {
    ...base,
    accessToken: testAccessToken,
    publicKey: testPublicKey,
    environment: "test",
    // Igual que CO: NO bajar isProduction — con credenciales de prueba el
    // init_point normal funciona; el sandbox_init_point está deprecado.
    testLane: true,
  };
}

module.exports = {
  MP_API_BASE,
  getMercadoPagoConfig,
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
