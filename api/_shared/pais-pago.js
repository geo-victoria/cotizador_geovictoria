/**
 * FICHA DE PAGO POR PAÍS — la fuente única del cobro en línea (24-sep).
 *
 * Orden de Lalo al levantar México: "un solo código global con parámetros /
 * ficha local". Hasta hoy el camino de pago repetía `pais === "co" ? … :
 * pais === "pe" ? … : chile` en config de Mercado Pago, sesión de pago,
 * webhook, preferencia, estado, finalize y página. Un país nuevo exigía
 * encontrar y tocar cada rama. Desde acá, UN país nuevo es UNA entrada en
 * esta tabla: el código lee sus parámetros y no sabe de países.
 *
 * Chile NO pasa por esta tabla en su cálculo de montos (sigue en
 * computePaymentAmounts, UF → CLP) ni en su carril de prueba (bypass del
 * pago); sí aporta sus datos de presentación (moneda, cuenta, WhatsApp).
 *
 * Todo dato sensible (credenciales) vive en variables de entorno con el
 * sufijo del país: MP_ACCESS_TOKEN<sufijo>, MP_PUBLIC_KEY<sufijo>,
 * MP_WEBHOOK_SECRET<sufijo>, MP_TEST_ACCESS_TOKEN<sufijo>,
 * MP_TEST_PUBLIC_KEY<sufijo>. Un país sin MP_ACCESS_TOKEN<sufijo> queda con
 * el cobro en línea APAGADO de hecho (conPagoEnLinea = false).
 */

const env = (k, def = "") => String(process.env[k] ?? "").trim() || def;

const PAISES_PAGO = {
  cl: {
    codigo: "cl",
    nombre: "Chile",
    envSufijo: "",
    moneda: "CLP",
    locale: "es-CL",
    decimales: 0,
    impuesto: "IVA",
    documento: "RUT",
    tipoIdentificacionMp: "RUT",
    territorio: /chile/i,
    tratamiento: "tu",
    whatsappVicky: () => env("VICKY_WHATSAPP_PHONE", "56967308227"),
    whatsappEtiqueta: "+56 9 6730 8227",
    recargoTarjeta: true,
    pieMontos: "",
    cuentaTransferencia: () => [
      { label: "Titular", value: "Victoria S.A" },
      { label: "RUT", value: "76.188.587-1" },
      { label: "Giro", value: "Empresa de Servicios Integrales de Informatica" },
      { label: "Banco", value: "Banco de Chile" },
      { label: "Cuenta corriente", value: "8001204108" },
    ],
  },
  co: {
    codigo: "co",
    nombre: "Colombia",
    envSufijo: "_CO",
    moneda: "COP",
    locale: "es-CO",
    decimales: 0,
    impuesto: "IVA",
    documento: "NIT",
    tipoIdentificacionMp: "NIT",
    territorio: /colombia/i,
    tratamiento: "usted",
    cobroUnicoTitulo: "Activación servicio GeoVictoria",
    whatsappVicky: () => env("VICKY_WHATSAPP_PHONE_CO", "573181070737"),
    whatsappEtiqueta: "+57 318 107 0737",
    recargoTarjeta: false,
    pieMontos: "Montos en pesos colombianos (COP).",
    cuentaTransferencia: () => [
      { label: "Titular", value: env("TRANSFER_CO_TITULAR", "GEOVICTORIA COLOMBIA SAS") },
      { label: "NIT", value: env("TRANSFER_CO_NIT", "901.367.959-1") },
      { label: "Banco", value: env("TRANSFER_CO_BANCO", "Bancolombia") },
      { label: env("TRANSFER_CO_TIPO_CUENTA", "Cuenta de ahorros"), value: env("TRANSFER_CO_CUENTA", "20200000237") },
    ],
    carrilPrueba: {
      docs: () => env("TEST_LANE_CO_NIT", "901.234.567-8"),
      nombres: () => env("TEST_LANE_CO_NAME", "Prueba Vicky CO SAS"),
      soloDigitos: false,
    },
  },
  pe: {
    codigo: "pe",
    nombre: "Perú",
    envSufijo: "_PE",
    moneda: "PEN",
    locale: "es-PE",
    decimales: 2,
    impuesto: "IGV",
    documento: "RUC",
    tipoIdentificacionMp: "RUC",
    territorio: /per[uú]/i,
    tratamiento: "tu",
    cobroUnicoTitulo: "Pago inicial GeoVictoria Perú",
    whatsappVicky: () => env("VICKY_WHATSAPP_PHONE_PE", "51922067167"),
    whatsappEtiqueta: "+51 922 067 167",
    recargoTarjeta: false,
    pieMontos: "Montos en soles (PEN), IGV incluido.",
    cuentaTransferencia: () => [
      { label: "Beneficiario", value: "GEOVICTORIA PERU S.A.C." },
      { label: "RUC", value: "20605842055" },
      { label: "Banco", value: "BBVA" },
      { label: "Cuenta corriente soles", value: "0011-0123-0100091134-75" },
      { label: "CCI", value: "011-123-000100091134-75" },
      { label: "Detracciones (12%, servicios informáticos)", value: "Banco de la Nación 00022055488" },
    ],
    carrilPrueba: {
      docs: () => env("TEST_LANE_PE_RUC", "20605842055"),
      nombres: () => env("TEST_LANE_PE_NAME", "Prueba Vicky PE SAC"),
      soloDigitos: true,
    },
  },
  mx: {
    codigo: "mx",
    nombre: "México",
    envSufijo: "_MX",
    moneda: "MXN",
    locale: "es-MX",
    decimales: 2,
    impuesto: "IVA",
    documento: "RFC",
    tipoIdentificacionMp: "",
    territorio: /m[eé]xico/i,
    tratamiento: "tu",
    cobroUnicoTitulo: "Pago inicial GeoVictoria México",
    whatsappVicky: () => env("VICKY_WHATSAPP_PHONE_MX", "5215659778486"),
    whatsappEtiqueta: "+52 1 56 5977 8486",
    recargoTarjeta: false,
    pieMontos: "Montos en pesos mexicanos (MXN), IVA incluido.",
    cuentaTransferencia: () => [
      { label: "Beneficiario", value: env("TRANSFER_MX_TITULAR", "CHECADOR, S.A. de C.V.") },
      { label: "RFC", value: env("TRANSFER_MX_RFC", "CEC2005286R4") },
      { label: "Banco", value: env("TRANSFER_MX_BANCO", "BANORTE") },
      { label: "Cuenta", value: env("TRANSFER_MX_CUENTA", "1161438886") },
      { label: "CLABE", value: env("TRANSFER_MX_CLABE", "072180011614388864") },
      { label: "SWIFT", value: env("TRANSFER_MX_SWIFT", "MENOMXMTXXX") },
    ],
    carrilPrueba: {
      // RFC genérico de público en general del SAT: nunca es un cliente real.
      docs: () => env("TEST_LANE_MX_RFC", "XAXX010101000"),
      nombres: () => env("TEST_LANE_MX_NAME", "Prueba Vicky MX SA de CV"),
      soloDigitos: false,
    },
  },
};

const PAISES = Object.keys(PAISES_PAGO);

function fichaPago(pais) {
  return PAISES_PAGO[String(pais || "").toLowerCase()] || PAISES_PAGO.cl;
}

/** Países con cuenta propia de Mercado Pago (todos menos Chile, que usa las envs sin sufijo). */
function paisesConCuentaPropia() {
  return PAISES.filter((p) => PAISES_PAGO[p].envSufijo);
}

/** País por el Territorio del deal (respaldo cuando el token no trae la marca). */
function paisPorTerritorio(territorio) {
  const t = String(territorio || "");
  for (const p of paisesConCuentaPropia()) {
    if (PAISES_PAGO[p].territorio.test(t)) return p;
  }
  return "cl";
}

/** País válido marcado en un token firmado; "" si no trae uno conocido. */
function paisDeToken(payload) {
  const p = String(payload?.pais || "").toLowerCase();
  return PAISES_PAGO[p] && p !== "cl" ? p : "";
}

/** Datos que la página de pago necesita para presentar montos y transferencia. */
function presentacionPago(pais) {
  const f = fichaPago(pais);
  return {
    pais: f.codigo,
    moneda: f.moneda,
    locale: f.locale,
    decimales: f.decimales,
    impuesto: f.impuesto,
    documento: f.documento,
    tratamiento: f.tratamiento,
    whatsappEtiqueta: f.whatsappEtiqueta,
    pieMontos: f.pieMontos || "",
  };
}

module.exports = {
  PAISES_PAGO,
  fichaPago,
  paisesConCuentaPropia,
  paisPorTerritorio,
  paisDeToken,
  presentacionPago,
};
