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
// IGV Perú (18 %). OJO 21-sep: se borró por accidente en 7e35c53 y la sesión
// de aceptación PE respondió 500 ("IGV_RATE_PE is not defined") hasta el fix.
const IGV_RATE_PE = 0.18;

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
  // Descuento POR LÍNEA del subform (envío bonificado = 100). Lo lee la tabla
  // de cobro de Creator; sin él la línea con Subtotal_UF=0 caía al precio de
  // lista (unitario × cantidad) y la nota cobraba el envío a 0,5 UF.
  descuentoPct: "Descuento_Pct",
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
    descuentoPct: toNumber(row?.[fieldMap.descuentoPct || "Descuento_Pct"]),
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
// ¿La fila es la ACTIVACIÓN colombiana (= primer mes del plan cobrado por
// adelantado)? Lleva el mismo descuento que el plan: es un mes del plan.
function esFilaActivacionCO(row) {
  const id = String(row?.codigo || "").toLowerCase();
  const nombre = String(row?.nombre || "").toLowerCase();
  return /activaci/.test(id) || /activaci/.test(nombre);
}

// ¿La fila es el PLAN (software recurrente) y no el alquiler del equipo? El
// descuento colombiano aplica SOLO al plan (misma regla que Chile y Perú).
function esFilaPlanCO(row) {
  const codigo = String(row?.codigo || "").toLowerCase();
  if (codigo.startsWith("plan")) return true;
  if (/reloj|equipo|hardware|arriendo|envio|instalacion/.test(codigo)) return false;
  return (
    isRecurrentModalidad(row?.modalidad) &&
    row?.afectoIva !== true &&
    /asistencia|plan/.test(String(row?.nombre || "").toLowerCase())
  );
}

/**
 * ¿La fila (forma AGENTE: {tipo,id,nombre}) es la "Activación"? Compartido por
 * los endpoints de emisión y buildSubformItemsPais de todos los países.
 */
function esItemActivacion(item) {
  const tipo = String(item?.tipo || "").toLowerCase();
  const id = String(item?.id || item?.codigo || "").toLowerCase();
  const nombre = String(item?.nombre || "").toLowerCase();
  return tipo === "activacion" || /activaci/.test(id) || /activaci/.test(nombre);
}

/**
 * PATRÓN CHILE (Lalo 21-sep PE, 23-sep CO: "quita la activación, toma como
 * ejemplo cómo se arma la aceptación online en Chile"): NINGUNA cotización
 * lleva fila de Activación. El primer mes adelantado lo calcula
 * computeTotalsPais desde las filas recurrentes (con el descuento del plan),
 * igual que computePaymentAmounts en CL con includeFirstMonth. Si un agente
 * viejo todavía manda la fila, se descarta acá para que Zoho, el PDF y la
 * aceptación no la muestren como "Equipo / Venta" (caso Rodrigo 23-sep).
 */
function quitarFilaActivacion(items, etiqueta) {
  const lista = Array.isArray(items) ? items : [];
  const sin = lista.filter((it) => !esItemActivacion(it));
  if (sin.length !== lista.length) {
    console.warn(`[${etiqueta || "quote-pricing"}] fila de Activación descartada: el primer mes lo calcula el cotizador (patrón CL).`);
  }
  return sin;
}

/**
 * TOTALES POR PAÍS — UNA sola función para PE y CO (Lalo 23-sep: "en la
 * cotizadora también hay que eliminar las brechas por país"). Chile sigue en
 * computePaymentAmounts (UF/CLP con conversión); acá la unidad de pricing es
 * la moneda del país y el subform la guarda en los campos *_CLP.
 *
 *   · `descuentos.recurrentePct` (Descuento_Recurrente_Pct, escalera 10 → 20 %)
 *     rebaja SOLO las filas del plan (`cfg.esFilaPlan`); arriendos, envío e
 *     instalación van a lista.
 *   · Pago inicial = pagos ÚNICOS + PRIMER MES de los recurrentes (patrón CL,
 *     includeFirstMonth). Se devuelven los dos componentes (`unicos*`,
 *     `primerMes*`) para que página, PDF y checkout de MP armen las mismas
 *     dos líneas que Chile.
 *   · LEGADO: una cotización emitida ANTES del cambio trae una fila
 *     "Activación" que YA es el primer mes. Si existe, ella manda y no se
 *     calcula otro (`conActivacionLegada`). En CO esa fila nació a LISTA y
 *     recibe el descuento del plan (`activacionLegadaConDescuento`); en PE
 *     llegaba ya rebajada por el agente.
 *   · Impuesto POR LÍNEA según `afectoIva` (CO: solo el hardware; PE: todo).
 *
 * Devuelve claves NEUTRAS; los wrappers por país las sufijan (Cop/Iva, Pen/Igv)
 * para no romper a sus consumidores.
 */
function computeTotalsPais(items, descuentos, cfg) {
  const rows = Array.isArray(items) ? items : [];
  const d = normalizeDescuentos(descuentos);
  const pct = Number(d.recurrentePct || 0);
  const factorPlan = pct > 0 ? 1 - pct / 100 : 1;
  const tasa = Number(cfg.tasa);
  const round = cfg.round;
  const esFilaPlan = cfg.esFilaPlan;
  const esFilaActivacion = cfg.esFilaActivacion;
  const legadaConDcto = cfg.activacionLegadaConDescuento === true;

  let unicosNeto = 0, unicosImp = 0, unicosListaNeto = 0;
  let mensualidadNeta = 0, mensualidadImp = 0, mensualidadListaNeta = 0, mensualidadListaImp = 0;
  let descuentoPlanNeto = 0;
  let activacionLegadaNeto = 0, activacionLegadaImp = 0, activacionLegadaListaNeto = 0;
  let conActivacionLegada = false;

  rows.forEach((row) => {
    const montoLista = toNumber(row?.subtotalClp);
    const afecto = row?.afectoIva === true;
    if (isRecurrentModalidad(row?.modalidad)) {
      const monto = esFilaPlan(row) ? montoLista * factorPlan : montoLista;
      mensualidadListaNeta += montoLista;
      mensualidadListaImp += afecto ? montoLista * tasa : 0;
      descuentoPlanNeto += montoLista - monto;
      mensualidadNeta += monto;
      mensualidadImp += afecto ? monto * tasa : 0;
    } else if (esFilaActivacion(row)) {
      conActivacionLegada = true;
      const monto = legadaConDcto ? montoLista * factorPlan : montoLista;
      activacionLegadaListaNeto += montoLista;
      activacionLegadaNeto += monto;
      activacionLegadaImp += afecto ? monto * tasa : 0;
    } else {
      unicosListaNeto += montoLista;
      unicosNeto += montoLista;
      unicosImp += afecto ? montoLista * tasa : 0;
    }
  });

  const primerMesNeto = conActivacionLegada ? activacionLegadaNeto : mensualidadNeta;
  const primerMesImp = conActivacionLegada ? activacionLegadaImp : mensualidadImp;
  const primerMesListaNeto = conActivacionLegada ? activacionLegadaListaNeto : mensualidadListaNeta;
  const pagoInicialNeto = unicosNeto + primerMesNeto;
  const pagoInicialImp = unicosImp + primerMesImp;

  return {
    pagoInicialNeto: round(pagoInicialNeto),
    pagoInicialImp: round(pagoInicialImp),
    pagoInicial: round(pagoInicialNeto + pagoInicialImp),
    unicosNeto: round(unicosNeto),
    unicosImp: round(unicosImp),
    unicos: round(unicosNeto + unicosImp),
    primerMesNeto: round(primerMesNeto),
    primerMesImp: round(primerMesImp),
    primerMes: round(primerMesNeto + primerMesImp),
    conActivacionLegada,
    mensualidadNeta: round(mensualidadNeta),
    mensualidadImp: round(mensualidadImp),
    mensualidad: round(mensualidadNeta + mensualidadImp),
    descuentoPct: pct,
    descuentoPlanNeto: round(descuentoPlanNeto),
    mensualidadListaNeta: round(mensualidadListaNeta),
    mensualidadLista: round(mensualidadListaNeta + mensualidadListaImp),
    pagoInicialLista: round(unicosListaNeto + primerMesListaNeto + pagoInicialImp),
  };
}

/** Sufija las claves neutras de computeTotalsPais ("Cop"/"Iva", "Pen"/"Igv"). */
function sufijarTotales(t, moneda, impuesto) {
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    if (k === "conActivacionLegada" || k === "descuentoPct") { out[k] = v; continue; }
    out[k.replace(/Imp$/, impuesto) + moneda] = v;
  }
  return out;
}

/**
 * Montos a cobrar (shape de computePaymentAmounts; los campos *Clp llevan la
 * moneda del país). Patrón CL: oneShotItems = pagos únicos, firstMonth =
 * primer mes de los recurrentes, oneShot = la suma. El checkout de MP arma
 * las mismas dos líneas que en Chile.
 */
function paymentAmountsDesdeTotales(t, d, extra) {
  return {
    oneShotClp: t.pagoInicial,
    oneShotItemsClp: t.unicos,
    firstMonthClp: t.primerMes,
    recurringClp: t.mensualidad,
    includeIva: true,
    includeFirstMonth: true,
    descuentoPct: d.recurrentePct,
    descuentos: d,
    breakdown: {
      oneShotNetClp: t.unicosNeto,
      oneShotIvaClp: t.unicosImp,
      firstMonthNetClp: t.primerMesNeto,
      firstMonthIvaClp: t.primerMesImp,
      recurringNetClp: t.mensualidadNeta,
      recurringIvaClp: t.mensualidadImp,
    },
    ...extra,
  };
}

/** Totales COLOMBIA (COP enteros, IVA 19 % solo en las filas afectas = hardware). */
function computeTotalsCO(items, descuentos) {
  return sufijarTotales(
    computeTotalsPais(items, descuentos, {
      tasa: IVA_RATE,
      round: Math.round,
      esFilaPlan: esFilaPlanCO,
      esFilaActivacion: esFilaActivacionCO,
      activacionLegadaConDescuento: true,
    }),
    "Cop",
    "Iva",
  );
}

function computePaymentAmountsCO(items, descuentos) {
  const totals = computeTotalsCO(items, descuentos);
  const d = normalizeDescuentos(descuentos);
  return paymentAmountsDesdeTotales(
    {
      pagoInicial: totals.pagoInicialCop, unicos: totals.unicosCop, primerMes: totals.primerMesCop, mensualidad: totals.mensualidadCop,
      unicosNeto: totals.unicosNetoCop, unicosImp: totals.unicosIvaCop, primerMesNeto: totals.primerMesNetoCop, primerMesImp: totals.primerMesIvaCop,
      mensualidadNeta: totals.mensualidadNetaCop, mensualidadImp: totals.mensualidadIvaCop,
    },
    d,
    { co: totals },
  );
}

function esFilaActivacionPE(row) {
  const t = String(row?.tipo || "").toLowerCase();
  const id = String(row?.codigo || row?.id || "").toLowerCase();
  const nombre = String(row?.nombre || "").toLowerCase();
  return t === "activacion" || /activaci/.test(id) || /activaci/.test(nombre);
}

// ¿La fila es el PLAN (servicio recurrente de software) y no el arriendo de un
// equipo? En PE el descuento aplica SOLO al plan (misma regla que Chile desde
// el fix del 11-ago: el arriendo de hardware va a lista).
function esFilaPlanPE(row) {
  const codigo = String(row?.codigo || "").toLowerCase();
  if (codigo.startsWith("plan")) return true;
  if (/reloj|equipo|hardware|arriendo/.test(codigo)) return false;
  const modalidad = String(row?.modalidad || "").toLowerCase();
  return isRecurrentModalidad(modalidad) && /asistencia|plan/.test(String(row?.nombre || "").toLowerCase());
}

/** Totales PERÚ (soles a céntimos, IGV 18 % en TODAS las filas afectas = todas). */
function computeTotalsPE(items, descuentos) {
  return sufijarTotales(
    computeTotalsPais(items, descuentos, {
      tasa: IGV_RATE_PE,
      round: (v) => Math.round(v * 100) / 100,
      esFilaPlan: esFilaPlanPE,
      esFilaActivacion: esFilaActivacionPE,
      // La fila legada PE llegaba ya rebajada por el agente: no se toca.
      activacionLegadaConDescuento: false,
    }),
    "Pen",
    "Igv",
  );
}

function computePaymentAmountsPE(items, descuentos) {
  const totals = computeTotalsPE(items, descuentos);
  const d = normalizeDescuentos(descuentos);
  return paymentAmountsDesdeTotales(
    {
      pagoInicial: totals.pagoInicialPen, unicos: totals.unicosPen, primerMes: totals.primerMesPen, mensualidad: totals.mensualidadPen,
      unicosNeto: totals.unicosNetoPen, unicosImp: totals.unicosIgvPen, primerMesNeto: totals.primerMesNetoPen, primerMesImp: totals.primerMesIgvPen,
      mensualidadNeta: totals.mensualidadNetaPen, mensualidadImp: totals.mensualidadIgvPen,
    },
    d,
    { pe: totals },
  );
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
  esFilaPlanCO,
  esFilaActivacionCO,
  esItemActivacion,
  quitarFilaActivacion,
  computeTotalsPais,
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
