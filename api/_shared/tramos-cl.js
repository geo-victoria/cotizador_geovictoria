/**
 * Tramo ("X-Y usuarios") de los módulos CL, derivado desde el subform.
 *
 * Caso Grey/COT347 (05-ago): el PDF regenerado desde Zoho perdía el tramo
 * porque `tierAplicado` solo existe en memoria durante la emisión — el
 * subform no lo persiste. Derivarlo acá lo repara para TODAS las
 * cotizaciones (incluidas las viejas), sin migrar datos:
 *   - Modalidad por usuario: la CANTIDAD es el número de usuarios → el
 *     tramo sale directo de ella (robusto ante cambios de precio).
 *   - Modalidad fija: la cantidad es 1 → el tramo sale del precio de lista
 *     (tabla de precios históricos y vigentes de asistencia y vacaciones).
 *
 * Si nada calza (precio con descuento aplicado en la línea, módulo nuevo),
 * devuelve "" y el PDF simplemente omite la frase "Tramo ...", como antes.
 */

const TRAMOS_FIJOS_UF = {
  // precioUF (lista) → tramo. Asistencia + Vacaciones (50% actual y 30% histórico).
  "0.25": "1-2 usuarios",
  "0.6": "3-10 usuarios",
  "0.125": "1-2 usuarios",
  "0.3": "3-10 usuarios",
  "0.075": "1-2 usuarios",
  "0.18": "3-10 usuarios",
};

function tramoModuloCL({ modalidad, cantidad, precioUnitarioUF }) {
  const n = Number(cantidad || 0);
  if (String(modalidad || "") === "Por usuario" && n > 0) {
    if (n >= 11 && n <= 20) return "11-20 usuarios";
    if (n >= 21 && n <= 30) return "21-30 usuarios";
    if (n >= 31 && n <= 50) return "31-50 usuarios";
    return "";
  }
  const clave = String(Number(precioUnitarioUF || 0));
  return TRAMOS_FIJOS_UF[clave] || "";
}

module.exports = { tramoModuloCL };
