/**
 * País de una cotización + perfil por país para los endpoints que EDITAN una
 * cotización ya emitida (actualizar-cotizacion, aplicar/consultar-siguiente-
 * descuento, regenerate-pdf).
 *
 * POR QUÉ EXISTE (Lalo 21-sep, "pasar las tools de Chile a global y mantener
 * sus reglas"): esos endpoints eran motor UF de punta a punta y GUARDABAN
 * contra CO/MX (422) — y Perú ni siquiera estaba en la guarda, así que una
 * cotización peruana habría entrado a la lógica chilena. Del lado del agente
 * la salida fue re-emitir una cotización nueva por cada cambio o descuento.
 * Con este módulo los endpoints chilenos son los ÚNICOS: el país sale del
 * token de aceptación y el perfil da (a) cómo se leen las filas del subform
 * en la forma que entiende el PDF de ese país, (b) cómo se escriben los
 * ítems que manda el agente, (c) qué PDF se arma, (d) cómo se calcula el
 * pago inicial/mensual para la negociación y (e) si el país tiene escalera
 * de descuento.
 *
 * Chile NO cambia: `paisDeCotizacion` devuelve "cl" y cada endpoint sigue su
 * camino de siempre (UF). El perfil solo se consulta para pe/co. México
 * sigue fuera (no está sobre el núcleo) y responde el 422 de antes.
 *
 * Convención del subform (COLOMBIA.md / create-from-vicky-pe): en PE y CO
 * los campos *_UF y *_CLP guardan el MISMO valor en la moneda del país.
 */

const { toText } = require("./zoho-crm");
const { sanitizeItems, computePaymentAmountsPE, computePaymentAmountsCO,
  quitarFilaActivacion,
} = require("./quote-pricing");

/**
 * País firmado en el token de la URL de aceptación: create-from-vicky-co
 * firma pais:"co", -pe pais:"pe" y -mx pais:"mx"; sin campo pais, la
 * cotización es chilena. Solo se DECODIFICA (no se verifica firma): se usa
 * para elegir motor, nunca para autorizar.
 */
function paisEnToken(acceptanceUrl) {
  try {
    const m = String(acceptanceUrl || "").match(/[?&]token=([^&]+)/);
    if (!m) return "";
    const body = decodeURIComponent(m[1]).split(".")[0];
    const json = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return String(JSON.parse(json)?.pais || "").toLowerCase();
  } catch {
    return "";
  }
}

/** "cl" | "pe" | "co" | "mx" — token primero; respaldo: Territorio del deal si viene expandido. */
function paisDeCotizacion(quote, config) {
  const enToken = paisEnToken(toText(quote?.[config.quoteAcceptanceUrlField]));
  if (enToken === "pe" || enToken === "co" || enToken === "mx") return enToken;
  return "cl";
}

/** Países cuyos endpoints de edición corren sobre este perfil (Chile va por su camino nativo). */
function paisConPerfil(pais) {
  return pais === "pe" || pais === "co";
}

const NOMBRE_PAIS = { cl: "Chile", pe: "Perú", co: "Colombia", mx: "México" };

// ── Lectura del subform → ítems en la forma del país ──────────────────────
function modalidadVickyDesdeZoho(modalidadZoho) {
  switch (String(modalidadZoho || "")) {
    case "Recurrente": return "por usuario";
    case "Único": return "fijo";
    case "Arriendo": return "arriendo";
    case "Venta": return "venta";
    default: return "cobro único";
  }
}

function tipoDesdeFila(row) {
  const codigo = String(row?.Codigo_Item || "").toLowerCase();
  const nombre = String(row?.Nombre_Item || "").toLowerCase();
  if (/activaci/.test(codigo) || /activaci/.test(nombre)) return "activacion";
  const cat = String(row?.Categoria_Item || "");
  if (cat === "Equipos Biometricos") return "hardware";
  if (cat === "Plataforma Asistencia") return "plan";
  if (cat === "Modulos Adicionales") return "modulo";
  const modalidad = String(row?.Modalidad || "");
  if (modalidad === "Arriendo" || modalidad === "Venta") return "hardware";
  if (codigo.startsWith("plan")) return "plan";
  return "servicio";
}

function filaOculta(row) {
  try {
    return JSON.parse(String(row?.Metadata_Item_JSON || "null"))?.oculto === true;
  } catch {
    return false;
  }
}

/**
 * Subform de Zoho → ítems del contrato del país (los mismos que manda el
 * agente al emitir), para que el PDF y el cálculo lean lo que hay en el CRM
 * y no lo que el modelo recuerda.
 */
function subformAItemsPais(pais, quote, config) {
  const subform = quote?.[config.quoteItemsSubformField];
  if (!Array.isArray(subform)) return [];
  const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
  return subform
    .filter((row) => !filaOculta(row))
    .map((row) => {
      const base = {
        tipo: tipoDesdeFila(row),
        id: String(row?.Codigo_Item || ""),
        nombre: String(row?.Nombre_Item || ""),
        descripcion: String(row?.Descripcion_Item || ""),
        modalidad: modalidadVickyDesdeZoho(row?.Modalidad),
        cantidad: Number(row?.Cantidad || 0),
        esRecurrente: row?.Es_Recurrente === true,
      };
      // Descuento por línea (bonificada = 100): el PDF regenerado lo necesita
      // para tachar la lista en vez de mostrar un S/0 pelado.
      const descuentoPct = Number(row?.Descuento_Pct || 0);
      if (pais === "pe") {
        return {
          ...base,
          precioUnitarioPEN: r2(row?.Precio_Unitario_UF),
          subtotalPEN: r2(row?.Subtotal_UF),
          afectoIgv: row?.Afecto_IVA === true,
          ...(descuentoPct > 0 ? { descuentoPct } : {}),
        };
      }
      return {
        ...base,
        precioUnitarioCOP: Math.round(Number(row?.Precio_Unitario_UF || 0)),
        subtotalCOP: Math.round(Number(row?.Subtotal_UF || 0)),
        afectoIva: row?.Afecto_IVA === true,
        ...(descuentoPct > 0 ? { descuentoPct } : {}),
      };
    });
}

// ── Escritura: ítems del agente → filas del subform ──────────────────────
function validarItemsPais(pais, items) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return "cotizacion.items requerido (configuración COMPLETA nueva, no solo el delta).";
  const pu = pais === "pe" ? "precioUnitarioPEN" : "precioUnitarioCOP";
  const st = pais === "pe" ? "subtotalPEN" : "subtotalCOP";
  const afecto = pais === "pe" ? "afectoIgv" : "afectoIva";
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== "object") return `items[${i}] no es un objeto`;
    if (!toText(it.nombre)) return `items[${i}].nombre requerido`;
    const cantidad = Number(it.cantidad);
    if (!Number.isFinite(cantidad) || cantidad < 1) return `items[${i}].cantidad debe ser >= 1`;
    if (!Number.isFinite(Number(it[pu]))) return `items[${i}].${pu} debe ser numérico`;
    if (!Number.isFinite(Number(it[st]))) return `items[${i}].${st} debe ser numérico`;
    if (typeof it.esRecurrente !== "boolean") return `items[${i}].esRecurrente debe ser boolean`;
    if (typeof it[afecto] !== "boolean") return `items[${i}].${afecto} debe ser boolean`;
  }
  return null;
}

function buildSubformItemsPais(pais, items) {
  // Sin fila de Activación en NINGÚN país (patrón CL): el primer mes lo
  // calcula computeTotalsPais desde los recurrentes.
  const sinActivacion = quitarFilaActivacion(items, `pais-cotizacion:${pais}`);
  if (pais === "pe") {
    const { buildSubformItemsPE } = require("../quote-acceptance/create-from-vicky-pe.js");
    return buildSubformItemsPE(sinActivacion);
  }
  const { buildSubformItemsCO } = require("../quote-acceptance/create-from-vicky-co.js");
  return buildSubformItemsCO(sinActivacion);
}

// ── PDF del país ─────────────────────────────────────────────────────────
function renderHtmlPais(pais, { cliente, items, acceptanceUrl, cotizacionId, validezHasta, version, descuentos, mesesDescuento }) {
  if (pais === "pe") {
    const { buildProposalHtmlPE } = require("./proposal-html-builder-pe");
    return buildProposalHtmlPE({
      cliente: { empresa: cliente.empresa, contacto: cliente.contacto, ruc: cliente.documento },
      items, acceptanceUrl, cotizacionId, validezHasta, version,
      descuentos: descuentos || { recurrentePct: 0 },
      mesesDescuento,
    });
  }
  const { buildProposalHtmlCO } = require("./proposal-html-builder-co");
  return buildProposalHtmlCO({
    cliente: { empresa: cliente.empresa, contacto: cliente.contacto, nit: cliente.documento },
    items, acceptanceUrl, cotizacionId, validezHasta, version,
    descuentos: descuentos || { recurrentePct: 0 },
    mesesDescuento,
  });
}

// ── Negociación: montos y mensaje ────────────────────────────────────────
/** Escalera de descuento de cara al cliente por país (CL, PE y CO — Lalo 21-sep "permitamos descuento en Colombia igual que en Chile"). MX: fuera del núcleo todavía. */
function descuentoDisponible(pais) {
  return pais === "cl" || pais === "pe" || pais === "co";
}

function errorDescuentoNoDisponible(pais) {
  return {
    ok: false,
    error: `DESCUENTO_NO_DISPONIBLE_${String(pais).toUpperCase()}`,
    detail: `En ${NOMBRE_PAIS[pais] || pais} no hay escalera de descuento de cara al cliente: no afirmes rebajas.`,
    tope_alcanzado: true,
  };
}

/** Mismo shape que previewAmounts (discount-engine) — los campos *Clp llevan la moneda del país. */
function previewAmountsPais(pais, quote, config, descuentos) {
  const items = sanitizeItems(quote?.[config.quoteItemsSubformField]);
  if (pais === "pe") return computePaymentAmountsPE(items, descuentos);
  return computePaymentAmountsCO(items, descuentos);
}

function fmtMonto(pais, n) {
  const v = Number(n) || 0;
  if (pais === "pe") {
    const r = Math.round(v * 100) / 100;
    const opts = Number.isInteger(r) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return "S/" + r.toLocaleString("es-PE", opts);
  }
  return "$" + Math.round(v).toLocaleString("en-US").replace(/,/g, ".");
}

/**
 * Mensaje de negociación (lo copia Vicky). PERÚ habla en NETO "+ IGV" (Lalo
 * 21-sep: "todos + IGV", nunca aritmética del impuesto ni "IGV incluido"),
 * así que usa el breakdown neto de computePaymentAmountsPE.
 */
function buildMensajeNegociacionPais(pais, escalon, amounts, esUltimo, opts = {}) {
  const conciso = opts.conciso === true;
  const esPrimerDescuentoPlan = opts.esPrimerDescuentoPlan !== false;
  const meses = Number(opts.mesesPlan) > 0 ? Number(opts.mesesPlan) : 6;
  const neto = amounts?.breakdown || {};
  // Pago inicial NETO = únicos + primer mes (el breakdown trae los dos por
  // separado: oneShotNetClp son SOLO los únicos — sin sumar el primer mes
  // salía "pago inicial S/0" en un plan solo-software).
  // COLOMBIA habla en precios FINALES (decisión 10-jul: el IVA solo existe en
  // el hardware y ya viene sumado en los totales), así que el mensaje usa los
  // totales con IVA y no dice "+ IVA".
  const esCO = pais === "co";
  const pagoInicialNeto = esCO
    ? Number(amounts?.co?.pagoInicialCop ?? amounts?.oneShotClp ?? 0)
    : amounts?.pe?.pagoInicialNetoPen ?? Number(neto.oneShotNetClp || 0) + Number(neto.firstMonthNetClp || 0);
  const mensualNeto = esCO ? Number(amounts?.co?.mensualidadCop ?? amounts?.recurringClp ?? 0) : neto.recurringNetClp ?? amounts.recurringClp;
  const pagoInicial = fmtMonto(pais, pagoInicialNeto);
  const mensual = fmtMonto(pais, mensualNeto);
  const impuesto = pais === "pe" ? " + IGV" : esCO ? "" : " + IVA";
  const hayCargoInicial = Math.round(Number(pagoInicialNeto) * 100) !== Math.round(Number(mensualNeto) * 100);
  const partes = [`Puedo ofrecerte un ${escalon.pct}% de descuento sobre el plan mensual.`];
  if (!hayCargoInicial) partes.push(`Con eso queda en ${mensual}${impuesto} al mes.`);
  else if (conciso) partes.push(`Con eso queda en ${mensual}${impuesto} al mes (pago inicial ${pagoInicial}${impuesto}).`);
  else partes.push(`Con eso el pago inicial queda en ${pagoInicial}${impuesto} (incluye el primer mes) y luego ${mensual}${impuesto} al mes.`);
  const tieneDescPlan = Number(amounts?.descuentos?.recurrentePct || 0) > 0;
  if (tieneDescPlan && esPrimerDescuentoPlan) {
    partes.push(`Ese precio con descuento en el plan aplica los primeros ${meses} meses; desde el mes ${meses + 1} el plan vuelve a su tarifa normal.`);
  }
  if (escalon.condicionDiscursiva) partes.push(escalon.condicionDiscursiva);
  partes.push(esUltimo ? "De verdad es el mejor precio que te puedo dejar. ¿Lo cerramos?" : "¿Lo cerramos?");
  return partes.join(" ");
}

// ── Correo del país (misma plantilla que la emisión) ─────────────────────
function copiasCorreoPais(pais) {
  const raw = pais === "pe"
    ? toText(process.env.VICKY_PE_QUOTE_CC || "mmendozav@geovictoria.com")
    : toText(process.env.VICKY_CO_QUOTE_CC || "agordillo@geovictoria.com");
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function ejecutivoCorreoPais(pais) {
  return pais === "pe"
    ? { nombre: "Mónica Mendoza", email: "mmendozav@geovictoria.com" }
    : { nombre: "Alejandro Gordillo", email: "agordillo@geovictoria.com" };
}

/** Empresa / contacto / documento tributario leídos del quote (sin llamadas extra). */
function clienteDesdeQuote(quote, config) {
  const empresa =
    toText(quote?.Cuenta_Asociada?.name) ||
    toText(quote?.Name).replace(/^Cotización\s+/, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "") ||
    "Empresa";
  return {
    empresa,
    contacto: toText(quote?.[config.quoteContactLookupField]?.name) || "",
    contactoEmail: toText(quote?.[config.contactEmailField]),
    documento: toText(quote?.[config.companyRutField]),
  };
}

module.exports = {
  paisEnToken,
  paisDeCotizacion,
  paisConPerfil,
  NOMBRE_PAIS,
  subformAItemsPais,
  validarItemsPais,
  buildSubformItemsPais,
  renderHtmlPais,
  descuentoDisponible,
  errorDescuentoNoDisponible,
  previewAmountsPais,
  fmtMonto,
  buildMensajeNegociacionPais,
  copiasCorreoPais,
  ejecutivoCorreoPais,
  clienteDesdeQuote,
};
