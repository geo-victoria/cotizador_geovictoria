/**
 * Calculo de montos a cobrar a partir de los items de una cotizacion.
 *
 * Replica la logica de totales de `api/quote-acceptance/session.js`
 * (sanitizeItems / clampDescuentoPct / isRecurrentModalidad) y agrega el
 * desglose por bucket (one-shot vs recurrente) con IVA separado, necesario
 * para mapear montos a Mercado Pago.
 *
 * Convenciones de negocio (heredadas del cotizador):
 * - Hay tres descuentos posibles, todos acumulativos sobre líneas distintas:
 *     · recurrentePct: aplica al bucket recurrente (plan mensual + 1er mes).
 *     · instalacionRMPct: aplica solo a items de instalación con zona RM.
 *     · instalacionRegionPct: aplica solo a items de instalación con zona
 *       "regiones".
 * - "venta" / "no recurrente" => pago unico (one-shot).
 * - Cualquier otra modalidad => recurrente.
 * - IVA = 19% sobre items afectos.
 */

const IVA_RATE = 0.19;

const DEFAULT_FIELD_MAP = {
  itemName: "Nombre_Item",
  qty: "Cantidad",
  unitUF: "Precio_Unitario_UF",
  unitCLP: "Precio_Unitario_CLP",
  subtotalUF: "Subtotal_UF",
  subtotalCLP: "Subtotal_CLP",
  modalidad: "Modalidad",
  afectoIva: "Afecto_IVA",
  codigo: "Codigo_Item",
  zonaTarifa: "Zona_Tarifa",
};

// Codigo_Item de los servicios de instalación reconocidos. Si en el futuro
// se agregan más tipos de instalación (cámaras, etc.), añadirlos acá.
const CODIGOS_INSTALACION = new Set(["instalacion_reloj"]);

function isInstalacionItem(row) {
  const codigo = String(row?.codigo || "").toLowerCase();
  return CODIGOS_INSTALACION.has(codigo);
}

function getZonaTarifa(row) {
  const raw = String(row?.zonaTarifa || "").toLowerCase().trim();
  if (raw === "rm") return "RM";
  if (raw === "regiones" || raw === "region") return "regiones";
  return null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isRecurrentModalidad(value) {
  const modalidad = String(value || "").toLowerCase();
  if (!modalidad) return true;
  if (modalidad.includes("venta")) return false;
  if (modalidad.includes("no recurrente")) return false;
  return true;
}

function clampDescuentoPct(value) {
  const n = Math.round(toNumber(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Backstop de seguridad del descuento recurrente: 40%. La escalera de
  // negociación nueva tope en 20% (DISCOUNT_LADDER 10→20), pero este clamp se
  // mantiene en 40% a propósito para NO recortar cotizaciones antiguas ya
  // comiteadas a 30/40% al regenerar/cobrar (las antiguas siguen igual).
  return Math.max(0, Math.min(40, Math.round(n / 5) * 5));
}

function sanitizeItems(items, fieldMap = DEFAULT_FIELD_MAP) {
  if (!Array.isArray(items)) return [];
  return items.map((row) => ({
    nombre: String(row?.[fieldMap.itemName] || ""),
    cantidad: toNumber(row?.[fieldMap.qty]),
    precioUnitarioUf: toNumber(row?.[fieldMap.unitUF]),
    precioUnitarioClp: toNumber(row?.[fieldMap.unitCLP]),
    subtotalUf: toNumber(row?.[fieldMap.subtotalUF]),
    subtotalClp: toNumber(row?.[fieldMap.subtotalCLP]),
    modalidad: String(row?.[fieldMap.modalidad] || ""),
    afectoIva: row?.[fieldMap.afectoIva] === true,
    codigo: String(row?.[fieldMap.codigo] || ""),
    zonaTarifa: String(row?.[fieldMap.zonaTarifa] || ""),
  }));
}

// Acepta tanto la firma vieja (número = descuento recurrente) como la nueva
// (objeto con los 3 descuentos posibles).
function normalizeDescuentos(input) {
  if (input == null) return { recurrentePct: 0, instalacionRMPct: 0, instalacionRegionPct: 0 };
  if (typeof input === "number") {
    return { recurrentePct: clampDescuentoPct(input), instalacionRMPct: 0, instalacionRegionPct: 0 };
  }
  return {
    recurrentePct: clampDescuentoPct(input.recurrentePct ?? input.recurrente ?? 0),
    instalacionRMPct: clampInstalacionPct(input.instalacionRMPct ?? input.instalacionRM ?? 0),
    instalacionRegionPct: clampInstalacionPct(input.instalacionRegionPct ?? input.instalacionRegion ?? 0),
  };
}

// Descuentos de instalación: 0..50, sin múltiplos forzados (los valores
// reales del negocio son 25 y 50; igual saneamos por defensa en profundidad).
function clampInstalacionPct(value) {
  const n = Math.round(toNumber(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(50, n));
}

/**
 * Calcula los montos a cobrar en CLP para cada flujo de Mercado Pago.
 *
 * @param {Array} items  items ya sanitizados (sanitizeItems)
 * @param {number|object} descuentos  Si number, se interpreta como descuento
 *   recurrente (compat con la firma anterior). Si object:
 *     { recurrentePct, instalacionRMPct, instalacionRegionPct }
 * @param {{ includeIva?: boolean, includeFirstMonth?: boolean }} options
 */
function computePaymentAmounts(items, descuentos = 0, options = {}) {
  const includeIva = options.includeIva !== false;
  const includeFirstMonth = options.includeFirstMonth === true;
  const rows = Array.isArray(items) ? items : [];
  const { recurrentePct, instalacionRMPct, instalacionRegionPct } =
    normalizeDescuentos(descuentos);

  const factorRec = 1 - recurrentePct / 100;
  const factorInstRM = 1 - instalacionRMPct / 100;
  const factorInstRegion = 1 - instalacionRegionPct / 100;

  let oneShotNet = 0;
  let oneShotIvaBase = 0;
  let recurringNet = 0;
  let recurringIvaBase = 0;

  rows.forEach((row) => {
    const subtotal = toNumber(row?.subtotalClp);
    const afecto = row?.afectoIva !== false;
    const recurrente = isRecurrentModalidad(row?.modalidad);

    // Descuento de instalación: solo aplica al item si es de instalación con
    // la zona correspondiente. No se mezcla con el descuento del recurrente.
    let factorLinea = 1;
    if (isInstalacionItem(row)) {
      const zona = getZonaTarifa(row);
      if (zona === "RM") factorLinea = factorInstRM;
      else if (zona === "regiones") factorLinea = factorInstRegion;
    }
    const subtotalAjustado = subtotal * factorLinea;

    if (recurrente) {
      // El descuento negociado del plan mensual aplica SOLO al plan de software
      // (asistencia), NO al arriendo de hardware (reloj u otros equipos en
      // arriendo), aunque ambos vivan en el bucket recurrente. Regla comercial.
      const esArriendoHardware = String(row?.modalidad || "")
        .toLowerCase()
        .includes("arriendo");
      const factorPlan = esArriendoHardware ? 1 : factorRec;
      recurringNet += subtotalAjustado * factorPlan;
      if (afecto) recurringIvaBase += subtotalAjustado * factorPlan;
    } else {
      oneShotNet += subtotalAjustado;
      if (afecto) oneShotIvaBase += subtotalAjustado;
    }
  });

  // El descuento recurrente ya se aplicó por línea (solo al plan de software, no
  // al arriendo de hardware), así que el bucket recurrente ya viene neto.
  const recurringNetDisc = recurringNet;
  const recurringIvaBaseDisc = recurringIvaBase;

  const oneShotIva = includeIva ? oneShotIvaBase * IVA_RATE : 0;
  const recurringIva = includeIva ? recurringIvaBaseDisc * IVA_RATE : 0;

  const oneShotItemsClp = Math.round(oneShotNet + oneShotIva);
  const recurringClp = Math.round(recurringNetDisc + recurringIva);
  const firstMonthClp = includeFirstMonth ? recurringClp : 0;
  const oneShotClp = oneShotItemsClp + firstMonthClp;

  return {
    oneShotClp,
    oneShotItemsClp,
    firstMonthClp,
    recurringClp,
    includeIva,
    includeFirstMonth,
    descuentoPct: recurrentePct,
    descuentos: { recurrentePct, instalacionRMPct, instalacionRegionPct },
    breakdown: {
      oneShotNetClp: Math.round(oneShotNet),
      oneShotIvaClp: Math.round(oneShotIva),
      recurringNetClp: Math.round(recurringNetDisc),
      recurringIvaClp: Math.round(recurringIva),
    },
  };
}

// ── COLOMBIA ────────────────────────────────────────────────────────────────
// Totales CO — IMPUESTOS (decisión de negocio de Lalo, 10-jul, refinada el
// mismo día): los precios son FINALES en todo EXCEPTO el hardware — el reloj
// (arriendo y venta) lleva IVA 19%. El IVA se aplica POR LÍNEA según el flag
// Afecto_IVA del subform (el agente lo marca true solo en las filas de reloj;
// plan, activación, envío e instalación van false = precio final). Retenciones
// y artículos tributarios no se mencionan jamás.
// Convención COLOMBIA.md: en CO el subform guarda COP en los campos *_CLP, por
// eso acá `subtotalClp` se lee como COP. Buckets distintos de Chile: el "Pago
// inicial" son SOLO los pagos únicos (la Activación ya ES el primer mes cobrado
// por adelantado); la "Mensualidad" son los recurrentes, facturada desde el mes
// siguiente. Sin descuentos en CO v1.
function computeTotalsCO(items) {
  const rows = Array.isArray(items) ? items : [];
  let pagoInicialNeto = 0;
  let pagoInicialIva = 0;
  let mensualidadNeta = 0;
  let mensualidadIva = 0;

  rows.forEach((row) => {
    const montoCop = toNumber(row?.subtotalClp);
    const ivaCop = row?.afectoIva === true ? montoCop * IVA_RATE : 0;
    if (isRecurrentModalidad(row?.modalidad)) {
      mensualidadNeta += montoCop;
      mensualidadIva += ivaCop;
    } else {
      pagoInicialNeto += montoCop;
      pagoInicialIva += ivaCop;
    }
  });

  return {
    pagoInicialNetoCop: Math.round(pagoInicialNeto),
    pagoInicialIvaCop: Math.round(pagoInicialIva),
    pagoInicialCop: Math.round(pagoInicialNeto + pagoInicialIva),
    mensualidadNetaCop: Math.round(mensualidadNeta),
    mensualidadIvaCop: Math.round(mensualidadIva),
    mensualidadCop: Math.round(mensualidadNeta + mensualidadIva),
  };
}

/**
 * Montos a cobrar de una cotización COLOMBIA, en el MISMO shape que
 * computePaymentAmounts para que el resto del flujo de pago (preferencia,
 * status, finalize, pago.html) lea los montos sin ramas por país.
 *
 * POR QUÉ difiere de Chile:
 *  - El pago único CO = solo ítems NO recurrentes. IVA 19% SOLO en las líneas
 *    con Afecto_IVA=true (hardware: reloj arriendo/venta); el resto son
 *    precios finales. El flag global chileno MP_CHARGE_INCLUDE_IVA no aplica.
 *  - La fila de Activación (pago único) YA equivale al primer mes cobrado por
 *    adelantado → NUNCA se agrega un "primer mes" adicional (firstMonthClp = 0
 *    siempre, ignora MP_ONESHOT_INCLUDE_FIRST_MONTH).
 *  - Sin descuentos en CO v1.
 * Los campos *Clp del resultado llevan COP (misma convención del subform).
 */
function computePaymentAmountsCO(items) {
  const totals = computeTotalsCO(items);
  return {
    oneShotClp: totals.pagoInicialCop,
    oneShotItemsClp: totals.pagoInicialCop,
    firstMonthClp: 0,
    recurringClp: totals.mensualidadCop,
    // Compat de shape: los montos oneShot/recurring ya traen el IVA del
    // hardware sumado (nada se agrega después); el breakdown lo desglosa.
    includeIva: true,
    includeFirstMonth: false,
    descuentoPct: 0,
    descuentos: { recurrentePct: 0, instalacionRMPct: 0, instalacionRegionPct: 0 },
    breakdown: {
      oneShotNetClp: totals.pagoInicialNetoCop,
      oneShotIvaClp: totals.pagoInicialIvaCop,
      recurringNetClp: totals.mensualidadNetaCop,
      recurringIvaClp: totals.mensualidadIvaCop,
    },
    co: totals,
  };
}

// ── PERÚ ────────────────────────────────────────────────────────────────────
// Totales PE — IGV 18% POR LÍNEA según Afecto_IVA (en Perú TODOS los
// conceptos son afectos: el agente marca afectoIgv=true en todo; el flag por
// línea queda por si negocio exime algo). Convención espejo de COLOMBIA.md:
// el subform guarda PEN en los campos *_CLP/*_UF. La Activación (pago único)
// ES el primer mes COMPLETO cobrado por adelantado (plan + arriendos, patrón
// CL) → jamás se suma un "primer mes" extra. Redondeo a céntimos (2
// decimales, como MX): el descuento de cierre 20% produce céntimos exactos.
const IGV_RATE_PE = 0.18;

function computeTotalsPE(items) {
  const rows = Array.isArray(items) ? items : [];
  const r2 = (v) => Math.round(v * 100) / 100;
  let pagoInicialNeto = 0;
  let pagoInicialIgv = 0;
  let mensualidadNeta = 0;
  let mensualidadIgv = 0;

  rows.forEach((row) => {
    const montoPen = toNumber(row?.subtotalClp);
    const igvPen = row?.afectoIva === true ? montoPen * IGV_RATE_PE : 0;
    if (isRecurrentModalidad(row?.modalidad)) {
      mensualidadNeta += montoPen;
      mensualidadIgv += igvPen;
    } else {
      pagoInicialNeto += montoPen;
      pagoInicialIgv += igvPen;
    }
  });

  return {
    pagoInicialNetoPen: r2(pagoInicialNeto),
    pagoInicialIgvPen: r2(pagoInicialIgv),
    pagoInicialPen: r2(pagoInicialNeto + pagoInicialIgv),
    mensualidadNetaPen: r2(mensualidadNeta),
    mensualidadIgvPen: r2(mensualidadIgv),
    mensualidadPen: r2(mensualidadNeta + mensualidadIgv),
  };
}

/**
 * Montos a cobrar de una cotización PERÚ, en el MISMO shape que
 * computePaymentAmounts (los campos *Clp llevan PEN, misma convención del
 * subform). Pago único = no recurrentes (la Activación ya es el primer mes
 * completo adelantado) + IGV 18% por línea afecta; firstMonthClp = 0 siempre.
 */
function computePaymentAmountsPE(items) {
  const totals = computeTotalsPE(items);
  return {
    oneShotClp: totals.pagoInicialPen,
    oneShotItemsClp: totals.pagoInicialPen,
    firstMonthClp: 0,
    recurringClp: totals.mensualidadPen,
    includeIva: true,
    includeFirstMonth: false,
    descuentoPct: 0,
    descuentos: { recurrentePct: 0, instalacionRMPct: 0, instalacionRegionPct: 0 },
    breakdown: {
      oneShotNetClp: totals.pagoInicialNetoPen,
      oneShotIvaClp: totals.pagoInicialIgvPen,
      recurringNetClp: totals.mensualidadNetaPen,
      recurringIvaClp: totals.mensualidadIgvPen,
    },
    pe: totals,
  };
}

// ── MÉXICO ──────────────────────────────────────────────────────────────────
// Totales MX — IVA 16% POR LÍNEA según el flag Afecto_IVA del subform (en MX,
// a diferencia de CO, el IVA aplica en general a servicios Y hardware: el
// agente marca afectoIva=true en las líneas gravadas). Convención espejo de
// COLOMBIA.md: en MX el subform guarda MXN en los campos *_CLP/*_UF, por eso
// acá `subtotalClp` se lee como MXN.
//
// Buckets espejo de CO: "Pago inicial" = SOLO los pagos únicos (capacitación,
// venta de reloj, envío, instalación); "Mensualidad" = los recurrentes. MX NO
// tiene fila de Activación (no existe en la tropicalización MX): la
// mensualidad se factura desde la activación del servicio.
//
// REDONDEO (decisión MX): a CENTAVOS (2 decimales, Math.round(x*100)/100) en
// vez del redondeo a peso entero de CL/CO. El MXN usa centavos y el IVA 16%
// sobre precios enteros produce centavos exactos (ej: 16 usuarios × $83 =
// $1.328 + IVA = $1.540,48) — redondear a entero descontaría el cobro.
const IVA_RATE_MX = 0.16;

function round2(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function computeTotalsMX(items) {
  const rows = Array.isArray(items) ? items : [];
  let pagoInicialNeto = 0;
  let pagoInicialIva = 0;
  let mensualidadNeta = 0;
  let mensualidadIva = 0;

  rows.forEach((row) => {
    const montoMxn = toNumber(row?.subtotalClp);
    const ivaMxn = row?.afectoIva === true ? montoMxn * IVA_RATE_MX : 0;
    if (isRecurrentModalidad(row?.modalidad)) {
      mensualidadNeta += montoMxn;
      mensualidadIva += ivaMxn;
    } else {
      pagoInicialNeto += montoMxn;
      pagoInicialIva += ivaMxn;
    }
  });

  return {
    pagoInicialNetoMxn: round2(pagoInicialNeto),
    pagoInicialIvaMxn: round2(pagoInicialIva),
    pagoInicialMxn: round2(pagoInicialNeto + pagoInicialIva),
    mensualidadNetaMxn: round2(mensualidadNeta),
    mensualidadIvaMxn: round2(mensualidadIva),
    mensualidadMxn: round2(mensualidadNeta + mensualidadIva),
  };
}

module.exports = {
  IVA_RATE,
  IVA_RATE_MX,
  DEFAULT_FIELD_MAP,
  CODIGOS_INSTALACION,
  sanitizeItems,
  clampDescuentoPct,
  clampInstalacionPct,
  isRecurrentModalidad,
  isInstalacionItem,
  getZonaTarifa,
  computePaymentAmounts,
  computeTotalsCO,
  computePaymentAmountsCO,
  computeTotalsPE,
  computePaymentAmountsPE,
  computeTotalsMX,
};
