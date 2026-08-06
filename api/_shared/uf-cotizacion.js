/**
 * UF por COTIZACIÓN (pedido Lalo 06-ago): al actualizar/regenerar, respetar la
 * UF con que la cotización NACIÓ en vez de la UF del día — y dejar que la
 * ejecutiva la controle desde Zoho.
 *
 * Prioridad:
 *   1. UF_Valor de la cotización (editable en Zoho: escribe el valor y esa UF
 *      manda; para usar la UF de hoy, escribe la UF de hoy).
 *   2. Derivada del subform (Precio_Unitario_CLP / Precio_Unitario_UF de una
 *      línea congelada) — hace retroactivo el comportamiento para todas las
 *      cotizaciones emitidas antes de que UF_Valor se llenara.
 *   3. 0 (el caller decide el fallback, normalmente la UF del día).
 *
 * La fecha para la línea "UF del día de la cotización (dd/mm/yyyy)": UF_Fecha
 * si existe; si no, Fecha_Cotizacion.
 */

function fechaDdMmYyyy(iso) {
  const t = String(iso || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return "";
  return t.split("-").reverse().join("/");
}

function ufDeCotizacion(quote, subformField) {
  const explicita = Number(quote?.UF_Valor || 0);
  const fechaCampo = fechaDdMmYyyy(quote?.UF_Fecha);
  const fechaEmision = fechaDdMmYyyy(quote?.Fecha_Cotizacion);
  if (explicita > 0) {
    return { uf: explicita, fecha: fechaCampo || fechaEmision, origen: "campo" };
  }
  const filas = Array.isArray(quote?.[subformField]) ? quote[subformField] : [];
  for (const f of filas) {
    const clp = Number(f?.Precio_Unitario_CLP || 0);
    const uf = Number(f?.Precio_Unitario_UF || 0);
    if (clp > 0 && uf >= 0.01) {
      return { uf: Math.round(clp / uf), fecha: fechaEmision, origen: "derivada" };
    }
  }
  return { uf: 0, fecha: "", origen: "" };
}

module.exports = { ufDeCotizacion, fechaDdMmYyyy };
