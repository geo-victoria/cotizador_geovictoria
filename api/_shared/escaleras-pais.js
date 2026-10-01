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
  // Lista del 01-oct (Rodrigo, VB Lalo): 1-2 S/29 fijo · 3-10 S/65 fijo ·
  // 11-20 S/6 por persona (21-50 S/9, fuera del rango de Vicky).
  { desde: 1, hasta: 2, modalidad: "fijo", precioUF: 29 },
  { desde: 3, hasta: 10, modalidad: "fijo", precioUF: 65 },
  { desde: 11, hasta: 20, modalidad: "por_usuario", precioUF: 6 },
  { desde: 21, hasta: 50, modalidad: "por_usuario", precioUF: 9 },
  { desde: 51, hasta: 100, modalidad: "por_usuario", precioUF: 5 },
  { desde: 101, hasta: 500, modalidad: "por_usuario", precioUF: 4.5 },
]);

/** Escalera de asistencia CO en pesos colombianos (espejo de lib/paises/co/catalogo.ts
 * del agente). REGLA DEL EQUIPO COLOMBIA (Lalo 28-sep, reclamo de María Fernanda
 * Cely por COT1742): $315.000 FIJO de 1 a 20 personas; desde 21, $13.700 por
 * usuario. La tabla del 09-jul (fijo solo hasta 10, 11-20 por usuario) dejaba
 * 11-22 personas MÁS BARATAS que 10 — queda como ESCALERA_ASISTENCIA_CO_LEGADO
 * solo para las cotizaciones que ya salieron con ella (Lalo: "no le cambiemos
 * los precios a los que ya dimos precios"). */
const ESCALERA_ASISTENCIA_CO = Object.freeze([
  // Lista del 01-oct (aprobada por Rodrigo, VB Lalo): 1-2 $35.000 fijo ·
  // 3-10 $77.000 fijo · 11-20 $7.700 por persona.
  { desde: 1, hasta: 2, modalidad: "fijo", precioUF: 35000 },
  { desde: 3, hasta: 10, modalidad: "fijo", precioUF: 77000 },
  { desde: 11, hasta: 20, modalidad: "por_usuario", precioUF: 7700 },
  { desde: 21, hasta: 50, modalidad: "por_usuario", precioUF: 13700 },
]);

/** Tabla CO anterior al 28-sep: solo para cotizaciones que ya la mostraron. */
const ESCALERA_ASISTENCIA_CO_LEGADO = Object.freeze([
  { desde: 1, hasta: 10, modalidad: "fijo", precioUF: 315000 },
  { desde: 11, hasta: 20, modalidad: "por_usuario", precioUF: 13700 },
  { desde: 21, hasta: 50, modalidad: "por_usuario", precioUF: 13700 },
]);

/**
 * ¿La cotización CO salió con la tabla anterior? Sí cuando la fila del plan
 * cobra POR USUARIO con 11 a 20 personas (con la tabla vigente ese tramo es un
 * fijo de cantidad 1). Así la nota de venta de una cotización vieja imprime la
 * tabla que el cliente aceptó y no una que no calza con su precio.
 */
function cotizacionCOConTablaLegado(rows) {
  for (const r of Array.isArray(rows) ? rows : []) {
    const codigo = String(r?.Codigo_Item || r?.id || "").toLowerCase();
    if (codigo !== "plan_asistencia" && codigo !== "asistencia") continue;
    const cant = Number(r?.Cantidad ?? r?.cantidad ?? 0);
    const unit = Number(r?.Precio_Unitario_UF ?? r?.precioUnitarioCOP ?? 0);
    // Desde el 01-oct la tabla vigente TAMBIÉN cobra por usuario de 11 a 20, a
    // $7.700: la legada se reconoce por su precio ($13.700, por sobre el vigente).
    if (cant >= 11 && cant <= 20 && unit > 7700) return true;
  }
  return false;
}

/** Escalera CO que corresponde a una cotización (vigente o anterior). */
function escaleraCOPara(rows) {
  return (cotizacionCOConTablaLegado(rows) ? ESCALERA_ASISTENCIA_CO_LEGADO : ESCALERA_ASISTENCIA_CO).map((t) => ({ ...t }));
}

/** Escalera de asistencia MX en pesos mexicanos (espejo de lib/paises/mx/catalogo.ts
 * del agente, precio de Karen 24-sep: 1-15 $1,200 fijo · 16-20 $83 por usuario;
 * 21-30 $79 y 31-50 $75 quedan fuera del rango de Vicky, solo tabla de cobro). */
const ESCALERA_ASISTENCIA_MX = Object.freeze([
  // Lista del 01-oct (Rodrigo, VB Lalo): 1-2 $229 fijo · 3-10 $499 fijo ·
  // 11-20 $49 por persona.
  { desde: 1, hasta: 2, modalidad: "fijo", precioUF: 229 },
  { desde: 3, hasta: 10, modalidad: "fijo", precioUF: 499 },
  { desde: 11, hasta: 20, modalidad: "por_usuario", precioUF: 49 },
  { desde: 21, hasta: 30, modalidad: "por_usuario", precioUF: 79 },
  { desde: 31, hasta: 50, modalidad: "por_usuario", precioUF: 75 },
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
function escalerasDefaultPorMoneda(moneda, rows) {
  const m = normalizar(moneda);
  // El plan PE viaja en el subform como `plan_asistencia` (agente pe/tools.ts);
  // `asistencia` queda por simetría con Chile.
  if (m === "pen" || m === "sol") {
    const filas = ESCALERA_ASISTENCIA_PE.map((t) => ({ ...t }));
    return { plan_asistencia: filas, asistencia: filas.map((t) => ({ ...t })) };
  }
  // Colombia (23-sep): el plan viaja en el subform como `plan_asistencia`.
  if (m === "cop") {
    const filas = escaleraCOPara(rows);
    return { plan_asistencia: filas, asistencia: filas.map((t) => ({ ...t })) };
  }
  // México (24-sep): mismo patrón, plan como `plan_asistencia`.
  if (m === "mxn") {
    const filas = ESCALERA_ASISTENCIA_MX.map((t) => ({ ...t }));
    return { plan_asistencia: filas, asistencia: filas.map((t) => ({ ...t })) };
  }
  return {};
}

/**
 * La tabla de cobro de la nota de venta debe llevar el precio que el cliente
 * PAGÓ, no el de la lista vigente (28-sep, Carlos/Blessed Consulting COT1735:
 * se le honró S/55 y la NDV salió con la lista peruana de S/100). Ajusta el
 * tramo que rige la fila del plan de la cotización:
 *   - plan fijo (Cantidad 1) → el primer tramo "fijo" toma su subtotal;
 *   - plan por usuario (Cantidad N) → el tramo por usuario que contiene N toma
 *     su precio unitario.
 * Los demás tramos quedan como la lista (sirven para crecer). Sin fila de plan
 * legible, la escalera no se toca.
 */
function alinearEscaleraConCotizacion(escalera, rows) {
  const filas = (Array.isArray(escalera) ? escalera : []).map((t) => ({ ...t }));
  const plan = (Array.isArray(rows) ? rows : []).find((r) => {
    const c = String(r?.Codigo_Item || r?.id || "").toLowerCase();
    return c === "plan_asistencia" || c === "asistencia";
  });
  if (!plan || !filas.length) return filas;
  const cant = Number(plan.Cantidad ?? plan.cantidad ?? 0);
  const unit = Number(plan.Precio_Unitario_UF ?? plan.precioUnitario ?? 0);
  const sub = Number(plan.Subtotal_UF ?? plan.subtotal ?? 0) || unit * cant;
  if (!(cant > 0) || !(unit > 0)) return filas;
  if (cant === 1) {
    // Desde el 01-oct hay DOS tramos fijos (1-2 y 3-10): si el subtotal ya es el
    // de uno de ellos, la tabla calza tal cual; si no (precio honrado), se
    // ajusta el tramo fijo de lista más cercano a lo que el cliente pagó.
    const fijos = filas.map((t, i) => ({ t, i })).filter((x) => x.t.modalidad === "fijo");
    if (!fijos.length || !(sub > 0)) return filas;
    if (fijos.some((x) => Number(x.t.precioUF) === sub)) return filas;
    const cerca = fijos.reduce((a, b) => (Math.abs(Number(b.t.precioUF) - sub) < Math.abs(Number(a.t.precioUF) - sub) ? b : a));
    filas[cerca.i].precioUF = sub;
    return filas;
  }
  const j = filas.findIndex((t) => t.modalidad === "por_usuario" && cant >= t.desde && cant <= t.hasta);
  if (j >= 0 && Number(filas[j].precioUF) !== unit) filas[j].precioUF = unit;
  return filas;
}

module.exports = { alinearEscaleraConCotizacion, ESCALERA_ASISTENCIA_PE, ESCALERA_ASISTENCIA_CO, ESCALERA_ASISTENCIA_CO_LEGADO, ESCALERA_ASISTENCIA_MX, cotizacionCOConTablaLegado, escaleraCOPara, monedaYPais, escalerasDefaultPorMoneda };
