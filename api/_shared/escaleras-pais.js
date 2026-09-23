/**
 * Moneda, país de facturación y escalera de asistencia POR PAÍS para el puente
 * a Zoho Creator (17-sep, "terminar de implementar Perú").
 *
 * El módulo Cotizaciones_GeoVictoria NO tiene campos Moneda ni País (95
 * campos, verificado 15-sep): el handoff los defaulteaba a UF/Chile y una
 * cotización peruana habría nacido en Creator como si fuera chilena, con la
 * tabla de cobro en "UF" y la escalera completada con los tramos chilenos.
 * Acá se infieren del DEAL (Territorio + Monda_del_trato, que la emisión PE
 * sí estampa: "Perú" / "SOL") y se declara la escalera peruana en soles
 * (espejo literal de lib/paises/pe/catalogo.ts del agente, VB Diego 05-ago:
 * 1-10 S/100 fijo · 11-20 S/200 fijo · 21-50 S/5 por usuario — la anomalía
 * 21+ es del excel y está aprobada).
 */

/** Escalera de asistencia PE en soles, en la forma que lee ndv-charge-table. */
const ESCALERA_ASISTENCIA_PE = Object.freeze([
  { desde: 1, hasta: 10, modalidad: "fijo", precioUF: 55 },
  { desde: 11, hasta: 50, modalidad: "por_usuario", precioUF: 5.5 },
  { desde: 51, hasta: 100, modalidad: "por_usuario", precioUF: 5 },
  { desde: 101, hasta: 500, modalidad: "por_usuario", precioUF: 4.5 },
]);

/** Escalera de asistencia CO en pesos colombianos (espejo de lib/paises/co/catalogo.ts
 * del agente, Lalo 09/10-jul: 1-10 $315.000 fijo · 11-50 $13.700 por usuario). */
const ESCALERA_ASISTENCIA_CO = Object.freeze([
  { desde: 1, hasta: 10, modalidad: "fijo", precioUF: 315000 },
  { desde: 11, hasta: 50, modalidad: "por_usuario", precioUF: 13700 },
]);

const MONEDA_POR_PAIS = Object.freeze({
  chile: { moneda: "UF", pais: "Chile" },
  peru: { moneda: "PEN", pais: "Perú" },
  colombia: { moneda: "COP", pais: "Colombia" },
  mexico: { moneda: "MXN", pais: "México" },
});

function normalizar(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Moneda y país de facturación de una cotización. Prioridad: overrides
 * explícitos → campos del registro (si algún día existen) → deal (Territorio o
 * Monda_del_trato) → Chile/UF.
 */
function monedaYPais({ overrides, quote, deal } = {}) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const monedaExplicita = String(o.moneda || quote?.Moneda || "").trim();
  const paisExplicito = String(o.pais || quote?.Pa_s_Facturaci_n || "").trim();
  if (monedaExplicita && paisExplicito) return { moneda: monedaExplicita, pais: paisExplicito, origen: "explicito" };

  const territorio = normalizar(deal?.Territorio);
  const monedaDeal = normalizar(deal?.Monda_del_trato);
  let base = null;
  if (territorio.includes("peru") || monedaDeal === "sol" || monedaDeal === "pen") base = MONEDA_POR_PAIS.peru;
  else if (territorio.includes("colombia") || monedaDeal === "cop") base = MONEDA_POR_PAIS.colombia;
  else if (territorio.includes("mexico") || monedaDeal === "mxn") base = MONEDA_POR_PAIS.mexico;
  else if (territorio.includes("chile") || monedaDeal === "uf" || monedaDeal === "clp") base = MONEDA_POR_PAIS.chile;

  if (base) {
    return { moneda: monedaExplicita || base.moneda, pais: paisExplicito || base.pais, origen: "deal" };
  }
  return { moneda: monedaExplicita || "UF", pais: paisExplicito || "Chile", origen: "default" };
}

/**
 * Escalera por defecto cuando la emisión no dejó ninguna en memoria y la
 * cotización no es chilena (la chilena la completa ndv-charge-table desde
 * PRICING_TIERS; en soles esa escalera NO aplica).
 */
function escalerasDefaultPorMoneda(moneda) {
  const m = normalizar(moneda);
  // El plan PE viaja en el subform como `plan_asistencia` (agente pe/tools.ts);
  // `asistencia` queda por simetría con Chile.
  if (m === "pen" || m === "sol") {
    const filas = ESCALERA_ASISTENCIA_PE.map((t) => ({ ...t }));
    return { plan_asistencia: filas, asistencia: filas.map((t) => ({ ...t })) };
  }
  // Colombia (23-sep): el plan viaja en el subform como `plan_asistencia`.
  if (m === "cop") {
    const filas = ESCALERA_ASISTENCIA_CO.map((t) => ({ ...t }));
    return { plan_asistencia: filas, asistencia: filas.map((t) => ({ ...t })) };
  }
  return {};
}

module.exports = { ESCALERA_ASISTENCIA_PE, ESCALERA_ASISTENCIA_CO, monedaYPais, escalerasDefaultPorMoneda };
