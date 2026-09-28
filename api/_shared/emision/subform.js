/**
 * Subform Detalle_Items_Cotizacion — constructores por país (copias literales).
 *
 * - Chile: montos en UF (3 decimales) + CLP con la UF de la emisión, Afecto_IVA
 *   siempre, Descripcion_Item con el modelo del hardware, zona tarifa.
 * - Perú / Colombia / México: convención "unidad de pricing del país" — los
 *   campos *_UF y *_CLP guardan el MISMO valor en PEN/COP/MXN, con el
 *   redondeo de cada país (2 decimales · entero · 2 decimales).
 *
 * `tests/emision/subform.test.js` compara estas copias con las funciones que
 * hoy exportan los endpoints de país.
 */
const {
  mapModalidadToZoho,
  isItemRecurrente,
  mapUnidadToZoho,
  mapCategoriaToZohoCL,
  mapCategoriaToZohoPais,
} = require("./util");

// id de hardware del catálogo de Vicky → modelo real para el PDF.
const HARDWARE_ID_TO_DESCRIPCION = {
  senseface_2a: "Sense Face 2A",
  armorpad: "ARMORPAD",
  ct58: "CT58",
  in01a_4glan: "IN01-A (4G/LAN)",
  in01a_lan: "IN01-A (LAN)",
  in01a_lanwifi: "IN01-A (LAN/WIFI)",
  mb10vl: "MB10-VL",
  mb560vl: "MB560-vl",
  s922: "S922",
  senseface_3a: "Sense Face 3A",
  senseface_4a: "Sense Face 4A",
  senseface_7a: "Sense Face 7A",
  speedface_v4l: "SpeedFace V4L",
  speedface_v5l: "SpeedFace V5L",
  uru4500: "URU4500",
  x628c: "X628-C",
};

function resolveDescripcionItem(item) {
  const manual = String(item.descripcion || "").trim();
  if (manual) return manual;
  const tipo = String(item.tipo || "").toLowerCase();
  if (tipo !== "hardware") return "";
  const id = String(item.id || "").toLowerCase();
  return HARDWARE_ID_TO_DESCRIPCION[id] || "";
}

/** Chile: ítems en UF → filas del subform (CLP con la UF de la emisión). */
function buildSubformItemsCL(items, ufActual, config) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((item, index) => {
    const modalidadZoho = mapModalidadToZoho(item.modalidad);
    const tipo = String(item.tipo || "").toLowerCase();
    // Zoho acepta 3 decimales en los double del subform (caso VADIBA 11-ago).
    const precioUnitarioUF = Number((Number(item.precioUnitarioUF) || 0).toFixed(3));
    const subtotalUF = Number((Number(item.subtotalUF) || 0).toFixed(3));
    const precioUnitarioCLP = ufActual > 0 ? Math.round(precioUnitarioUF * ufActual) : 0;
    const subtotalCLP = ufActual > 0 ? Math.round(subtotalUF * ufActual) : 0;
    const zonaRaw = String(item.zonaTarifa || "").toLowerCase().trim();
    const zonaTarifa = zonaRaw === "rm" ? "RM" : zonaRaw === "regiones" ? "regiones" : "";
    const row = {
      Nombre_Item: String(item.nombre || ""),
      Descripcion_Item: resolveDescripcionItem(item),
      Codigo_Item: String(item.id || ""),
      Cantidad: Number(item.cantidad || 0),
      Precio_Unitario_UF: precioUnitarioUF,
      Precio_Unitario_CLP: precioUnitarioCLP,
      Subtotal_UF: subtotalUF,
      Subtotal_CLP: subtotalCLP,
      Modalidad: modalidadZoho,
      Es_Recurrente: isItemRecurrente(modalidadZoho),
      Afecto_IVA: true,
      Orden: index + 1,
      Categoria_Item: mapCategoriaToZohoCL(item),
      Unidad: mapUnidadToZoho(modalidadZoho, tipo),
    };
    if (Number(item.descuentoPct) > 0) {
      row.Descuento_Pct = Math.min(100, Number(item.descuentoPct));
    }
    if (zonaTarifa && config?.quoteItemZonaTarifaField) {
      row[config.quoteItemZonaTarifaField] = zonaTarifa;
    }
    if (item.oculto === true) {
      row.Metadata_Item_JSON = JSON.stringify({ oculto: true });
    }
    return row;
  });
}

const redondear2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const redondearEntero = (v) => Math.round(Number(v || 0));

/**
 * PE/CO/MX: una sola forma, cambian los nombres de los campos del agente y el
 * redondeo. `campos` = { precioUnitario, subtotal, afecto }.
 */
function crearBuilderSubformPais({ campos, redondear }) {
  return function buildSubformItemsPais(items) {
    return (Array.isArray(items) ? items : []).map((item, index) => {
      const modalidadZoho = mapModalidadToZoho(item.modalidad);
      const tipo = String(item.tipo || "").toLowerCase();
      const precioUnitario = redondear(item[campos.precioUnitario]);
      const subtotal = redondear(item[campos.subtotal]);
      const row = {
        Nombre_Item: String(item.nombre || ""),
        Descripcion_Item: String(item.descripcion || "").trim(),
        Codigo_Item: String(item.id || ""),
        Cantidad: Number(item.cantidad || 0),
        Precio_Unitario_UF: precioUnitario,
        Precio_Unitario_CLP: precioUnitario,
        Subtotal_UF: subtotal,
        Subtotal_CLP: subtotal,
        Modalidad: modalidadZoho,
        Es_Recurrente: item.esRecurrente === true,
        Afecto_IVA: item[campos.afecto] === true,
        Orden: index + 1,
        Categoria_Item: mapCategoriaToZohoPais(item),
        Unidad: mapUnidadToZoho(modalidadZoho, tipo),
      };
      if (Number(item.descuentoPct) > 0) {
        row.Descuento_Pct = Math.min(100, Number(item.descuentoPct));
      }
      if (item.oculto === true) {
        row.Metadata_Item_JSON = JSON.stringify({ oculto: true });
      }
      return row;
    });
  };
}

const buildSubformItemsPE = crearBuilderSubformPais({
  campos: { precioUnitario: "precioUnitarioPEN", subtotal: "subtotalPEN", afecto: "afectoIgv" },
  redondear: redondear2,
});
const buildSubformItemsCO = crearBuilderSubformPais({
  campos: { precioUnitario: "precioUnitarioCOP", subtotal: "subtotalCOP", afecto: "afectoIva" },
  redondear: redondearEntero,
});
const buildSubformItemsMX = crearBuilderSubformPais({
  campos: { precioUnitario: "precioUnitarioMXN", subtotal: "subtotalMXN", afecto: "afectoIva" },
  redondear: redondear2,
});

// ── Filas especiales de catálogo por país ──
function esItemCapacitacion(item) {
  return /capacitaci/i.test(String(item?.id || "")) || /capacitaci/i.test(String(item?.nombre || ""));
}

/** México: fila "Capacitación online" en $0 si el agente no la mandó (Lalo 12-ago). */
function ensureCapacitacionMX(items) {
  if (items.some(esItemCapacitacion)) return items;
  return [
    ...items,
    {
      tipo: "servicio",
      id: "capacitacion_online",
      nombre: "Capacitación online",
      descripcion: "Capacitación online al equipo administrador — incluida sin costo.",
      modalidad: "Cobro único",
      cantidad: 1,
      precioUnitarioMXN: 0,
      subtotalMXN: 0,
      esRecurrente: false,
      afectoIva: true,
    },
  ];
}

module.exports = {
  HARDWARE_ID_TO_DESCRIPCION,
  resolveDescripcionItem,
  buildSubformItemsCL,
  crearBuilderSubformPais,
  buildSubformItemsPE,
  buildSubformItemsCO,
  buildSubformItemsMX,
  ensureCapacitacionMX,
  redondear2,
  redondearEntero,
};
