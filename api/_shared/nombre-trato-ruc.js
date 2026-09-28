/**
 * RUC AL INICIO DEL NOMBRE DEL TRATO (Perú, Lalo 28-sep).
 *
 * Convención del equipo de Perú, medida sobre los últimos 200 tratos (137
 * llevan el RUC al inicio): "RUC - RAZÓN SOCIAL ...". Los tratos de Vicky
 * nacían "EMPRESA - Cotización Vicky" sin RUC (Cecilia lo marcó en la primera
 * venta). Se antepone el RUC y se CONSERVA "- Cotización Vicky" al final (Lalo:
 * "no elimines el cotización vicky del final").
 *
 * PURA. Si el nombre ya trae ese RUC, no cambia. Zoho acepta hasta 120
 * caracteres en Deal_Name: se recorta el medio y se conserva el sufijo.
 */
const SUFIJO_VICKY = " - Cotización Vicky";

function nombreTratoConRuc(nombre, ruc) {
  const doc = String(ruc || "").replace(/\D/g, "");
  const actual = String(nombre || "").trim();
  if (!/^\d{11}$/.test(doc) || !actual) return actual;
  if (actual.replace(/\D/g, "").includes(doc)) return actual;
  const completo = `${doc} - ${actual}`;
  if (completo.length <= 120) return completo;
  const tieneSufijo = actual.endsWith(SUFIJO_VICKY.trim()) || actual.endsWith(SUFIJO_VICKY);
  const sufijo = tieneSufijo ? SUFIJO_VICKY : "";
  const cuerpo = tieneSufijo ? actual.slice(0, actual.length - SUFIJO_VICKY.length) : actual;
  const espacio = 120 - `${doc} - `.length - sufijo.length;
  return `${doc} - ${cuerpo.slice(0, espacio).trim()}${sufijo}`;
}

module.exports = { nombreTratoConRuc };
