/**
 * Bloque de Notas que Creator imprime al pie del documento.
 *
 * La redacción es la que fijó comercial (ver las notas de venta de referencia).
 * Dos datos NO pueden ir fijos y se resuelven en cada emisión:
 *
 *   · El ejecutivo. Hay cinco en el mapa de ejecutivo-cl.js y la cotización
 *     sigue al dueño del deal, así que quemar uno haría que las cotizaciones de
 *     Anderson o Gordillo se presenten con los datos de Eddyluz.
 *   · El valor de la UF. Cambia todos los días; un número fijo dejaría todas las
 *     cotizaciones futuras declarando la UF del día en que se escribió esto.
 *
 * La vigencia sale de config.validityDays, que es la que realmente rige el token
 * de aceptación: si el texto dijera otra cosa, el documento contradiría al link.
 */

const { ejecutivoPorOwner } = require("./ejecutivo-cl");
const { getUFActualSafe } = require("./uf-actual");

/** Formato chileno: miles con punto, decimales con coma. */
function formatearClp(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** DD-MM-YYYY, el mismo formato de fecha que usa Creator. */
function fechaCreator(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${date.getFullYear()}`;
}

/**
 * @param {object} args.config    config de aceptación (validityDays)
 * @param {string} [args.ownerId] dueño del deal; decide qué ejecutivo se presenta
 * @param {number} [args.ufActual] valor de la UF; si no viene, se consulta
 * @returns {Promise<string>} el texto listo para Notas_PDF
 */
async function construirNotasPdf({ config, ownerId, ufActual }) {
  const ejecutivo = ejecutivoPorOwner(ownerId);
  const uf = Number(ufActual) > 0 ? Number(ufActual) : await getUFActualSafe().catch(() => 0);
  const vigencia = Number(config?.validityDays) > 0 ? Number(config.validityDays) : 10;

  const lineas = [
    `Ejecutivo Comercial: ${ejecutivo.nombre}`,
    `Correo: ${ejecutivo.email}`,
    `Teléfono: ${ejecutivo.telefono}`,
    `La presente cotización tendrá una vigencia de ${vigencia} días contadas a partir de la fecha indicada al principio del documento.`,
    "",
    "Monto a pagar para la primera la primera factura por adelantado. Valores siguientes se calcularán con la UF del día de emisión de la factura (Banco Central).",
  ];

  // Sin valor de UF no se imprime la línea: mejor omitirla que declarar $0.
  if (uf > 0) {
    lineas.push("", `Valor UF: $ ${formatearClp(uf)} CLP`, "", `Fecha Valor UF: ${fechaCreator()}`);
  }

  return lineas.join("\n");
}

module.exports = { construirNotasPdf, formatearClp, fechaCreator };
