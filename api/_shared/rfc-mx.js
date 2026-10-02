/**
 * RFC mexicano para la cotización (02-oct, Lalo "cotiza sin RFC y pide la
 * constancia fiscal al aceptar").
 *
 * En México el RFC es dato de FACTURACIÓN, no de cotización: pedirlo para
 * cotizar espantó a un cliente (Antonio Vázquez, 02-oct: "no es obligatorio
 * dar ese dato solo para cotizaciones… suena hasta sospechoso"). La formal
 * nace con el RFC genérico del SAT para "público en general" y el RFC real
 * —con su Constancia de Situación Fiscal— se pide en la página de aceptación,
 * que es donde se juntan los datos para facturar.
 */
const RFC_GENERICO_MX = "XAXX010101000";

function compactarRfc(v) {
  return String(v || "").replace(/[.\s_-]/g, "").toUpperCase();
}

function esRfcGenerico(v) {
  const c = compactarRfc(v);
  return c === RFC_GENERICO_MX || c === "XEXX010101000";
}

// 3 letras (persona moral) o 4 (física) + fecha AAMMDD + homoclave.
function rfcFormatoValido(v) {
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(compactarRfc(v));
}

/** RFC que sirve para FACTURAR: formato válido y no genérico. */
function rfcParaFacturar(v) {
  return rfcFormatoValido(v) && !esRfcGenerico(v);
}

module.exports = { RFC_GENERICO_MX, compactarRfc, esRfcGenerico, rfcFormatoValido, rfcParaFacturar };
