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
 * Datos del ejecutivo que se presenta en el documento.
 *
 * MANDA EL USUARIO REAL DE ZOHO, no el mapa. La tómbola asigna dueños que
 * ejecutivo-cl.js no conoce (caso COT-58560: el deal quedó en gmelendez@, que no
 * está en el mapa), y ahí ejecutivoPorOwner devuelve el DEFAULT — el documento
 * terminaba presentando a Eddyluz mientras Correo_Vendedor decía gmelendez.
 * El mapa queda solo para el teléfono, que Zoho no siempre trae, y como
 * respaldo cuando no se pudo leer el usuario.
 */
function resolverEjecutivo(ownerId, ownerUser) {
  const delMapa = ejecutivoPorOwner(ownerId);
  const nombreReal = toTexto(ownerUser?.full_name || ownerUser?.name);
  const emailReal = toTexto(ownerUser?.email).toLowerCase();

  // El teléfono del mapa solo sirve si el mapa habla de ESTE ejecutivo.
  const mapaCoincide = !emailReal || toTexto(delMapa.email).toLowerCase() === emailReal;
  const telefono = mapaCoincide
    ? delMapa.telefono
    : toTexto(ownerUser?.phone || ownerUser?.mobile);

  return {
    nombre: nombreReal || delMapa.nombre,
    email: emailReal || delMapa.email,
    telefono,
  };
}

function toTexto(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

/**
 * @param {object} args.config    config de aceptación (validityDays)
 * @param {string} [args.ownerId] dueño del deal; decide qué ejecutivo se presenta
 * @param {object} [args.ownerUser] usuario de Zoho del dueño (fuente autoritativa)
 * @param {number} [args.ufActual] valor de la UF; si no viene, se consulta
 * @returns {Promise<string>} el texto listo para Notas_PDF
 */
async function construirNotasPdf({ config, ownerId, ownerUser, ufActual }) {
  const ejecutivo = resolverEjecutivo(ownerId, ownerUser);
  const uf = Number(ufActual) > 0 ? Number(ufActual) : await getUFActualSafe().catch(() => 0);
  const vigencia = Number(config?.validityDays) > 0 ? Number(config.validityDays) : 10;

  const lineas = [
    `Ejecutivo Comercial: ${ejecutivo.nombre}`,
    `Correo: ${ejecutivo.email}`,
    // Sin teléfono conocido se omite la línea: publicar el de otro ejecutivo
    // manda al cliente a llamar a quien no lleva su cotización.
    ...(ejecutivo.telefono ? [`Teléfono: ${ejecutivo.telefono}`] : []),
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

module.exports = { construirNotasPdf, resolverEjecutivo, formatearClp, fechaCreator };
