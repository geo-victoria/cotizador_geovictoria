/**
 * POST /api/quote-acceptance/create-from-vicky-co — Cotización formal COLOMBIA.
 *
 * PERFIL de la emisión única (api/_shared/emision-pais.js, 29-sep): acá viven
 * solo los DATOS colombianos — NIT, pesos con IVA 19 % solo en el equipo,
 * dueños, PDF, correo y la nota de Creator en COP. El flujo (lead-first,
 * dedup, deal, cotización, token, PDF, correo) es el compartido.
 *
 * Retirado en esta unificación: el "Camino A" convert-first (kv
 * co_convert_first) — lead-first (23-sep) hace lo mismo para los 4 países.
 *
 * Contrato del agente: {empresa, contacto, contactoEmail?, nit,
 * contactoTelefono, userCount, escalonDescuento?,
 * items[{precioUnitarioCOP, subtotalCOP, afectoIva, …}]}.
 */
const { toText } = require("../_shared/zoho-crm");
const { quitarFilaActivacion } = require("../_shared/quote-pricing");
const { buildProposalHtmlCO } = require("../_shared/proposal-html-builder-co");
const {
  crearHandlerEmision,
  buildSubformItemsPais,
  redondeoEntero,
  ccDesdeEnv,
  OWNER_VICKY_ID,
} = require("../_shared/emision-pais");

const VICKY_CO_TERRITORIO = toText(process.env.VICKY_TERRITORIO_CO) || "Colombia";
const VICKY_CO_MONEDA = toText(process.env.VICKY_MONEDA_CO) || "COP";

// DUEÑO DE LOS REGISTROS QUE CREA LA FORMAL (23-sep, Colombia a las reglas de
// Zoho como Chile y Perú): nacen con el usuario VICKY (interino) y los sortea
// "Deals 2026" al traspasar. La regla vieja del 05-ago (todo a nombre de
// Gordillo, env VICKY_CO_OWNER_ID) sigue disponible con VICKY_CO_OWNER_FIJO=on.
const VICKY_CO_OWNER_ID = toText(process.env.VICKY_CO_OWNER_ID);
const CO_OWNER_FIJO = /^(on|1|true)$/i.test(toText(process.env.VICKY_CO_OWNER_FIJO));
const OWNER_CO = CO_OWNER_FIJO && VICKY_CO_OWNER_ID ? { id: VICKY_CO_OWNER_ID } : { id: OWNER_VICKY_ID };

// SDR_CO = las SDR de Colombia (Lalo 23-sep: Sanabria Torres, Nariño Chavarro y
// Galindo reciben los leads): su lead se convierte pero NO heredan el deal —
// lo sortea la tómbola "Deals 2026" al traspasar, como en Chile y Perú.
const SDR_CO = new Set([
  "3525045000613817111", // Eddy Galindo
  "3525045000654443071", // Mauricio Sanabria Torres
  "3525045000639927045", // Jhon Nariño Chavarro
  "3525045000619732095", // Guerrero (histórico)
  "3525045000639899035", // Quiroga (histórico)
]);
// Dueños cuyo lead huérfano se ADOPTA (bot + interino histórico + SDR CO).
const OWNERS_ADOPTABLES_CO = new Set([
  OWNER_VICKY_ID,
  "3525045000203758005", // Gordillo (interino histórico)
  ...SDR_CO,
]);

// ── Variantes de NIT (mismo generador que el RUT chileno). Para
// "901.367.959-1" genera: tal cual, compacto, cuerpo-DV, con puntos-DV y,
// por la convención COLOMBIA (Ana María 30-jul: las cuentas guardan el NIT
// SIN dígito de verificación), el cuerpo solo y con puntos.
function getNitVariants(nit) {
  if (!nit) return [];
  const raw = String(nit).trim();
  if (!raw) return [];
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  if (compact.length < 2) return [raw];
  const cuerpo = compact.slice(0, -1);
  const dv = compact.slice(-1);
  const cuerpoConPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const variantes = [raw, compact, `${cuerpo}-${dv}`, `${cuerpoConPuntos}-${dv}`, cuerpo, cuerpoConPuntos];
  return Array.from(new Set(variantes)).filter(Boolean);
}

// NIT normalizado para ESCRIBIR en RUT_Empresa según la convención CO: sin
// puntos y sin el dígito de verificación (solo se recorta un "-X" final
// explícito — nunca se adivina si un número pelado trae DV o no).
function nitParaGuardarCO(nit) {
  return String(nit || "").trim().replace(/[.\s]/g, "").replace(/-[0-9kK]$/i, "");
}

/**
 * PATRÓN CHILE (Lalo 23-sep, caso Rodrigo): la cotización colombiana NO lleva
 * fila de Activación; el primer mes lo calcula computeTotalsCO.
 */
function quitarActivacionCO(items) {
  return quitarFilaActivacion(items, "create-from-vicky-co");
}

const ITEMS_CO = {
  claves: { unitario: "precioUnitarioCOP", subtotal: "subtotalCOP", afecto: "afectoIva" },
  redondeo: redondeoEntero,
  preparar: quitarActivacionCO,
  // Total (informativo): netos + IVA 19 % de las líneas afectas (solo equipo).
  total: (items) => items.reduce((acc, it) => {
    const subtotal = Number(it.subtotalCOP || 0);
    return acc + subtotal + (it.afectoIva === true ? subtotal * 0.19 : 0);
  }, 0),
  totalTexto: (t) => String(t),
  amountDeal: (t) => t || undefined,
};

/** Subform con la convención COP en campos UF/CLP (pesos enteros). */
function buildSubformItemsCO(items) {
  return buildSubformItemsPais(items, ITEMS_CO);
}

const PERFIL_CO = {
  cc: "co",
  etiqueta: "create-from-vicky-co",
  secretEnv: "VICKY_COTIZADORA_SECRET_CO",
  territorio: VICKY_CO_TERRITORIO,
  moneda: "COP",
  monedaDeal: VICKY_CO_MONEDA,
  owners: { interino: OWNER_CO, adoptables: OWNERS_ADOPTABLES_CO, noHeredables: SDR_CO },
  documento: {
    campo: "nit",
    nombre: "NIT",
    // Sin validación de forma (misma tolerancia de siempre: el dato lo manda el agente).
    validar: () => ({ tipoDocumento: "NIT" }),
    paraGuardar: nitParaGuardarCO,
    paraCotizacion: (nit) => nit,
    variantes: getNitVariants,
    compactar: (v) => String(v || "").replace(/[.\s-]/g, "").toUpperCase(),
    descripcionCuenta: (nit) => `Cuenta creada por Vicky CO (WhatsApp). NIT: ${nit}`,
    nombreDesambiguado: (empresa, nit) => `${empresa} (${nit})`,
    clientePdf: (nit) => ({ nit }),
  },
  items: ITEMS_CO,
  deal: {
    tipoDeCobro: (userCount) => ((Number(userCount) || 1) <= 10 ? "Mensual fijo" : "Por usuario"),
    nombre: (empresa) => `${empresa} - Cotización Vicky`,
  },
  pdf: { build: buildProposalHtmlCO },
  correo: {
    // CC y reply-to al ejecutivo CO para que vea lo que recibió su cliente.
    destinatarios() {
      const CC_CO = ccDesdeEnv("VICKY_CO_QUOTE_CC", "agordillo@geovictoria.com");
      return { replyToEmail: CC_CO[0], ccEmails: CC_CO };
    },
    html: ({ buildEmailHtml, contacto, empresa, pdfUrl, acceptanceUrl, firmante, ejecutivoParaCorreo }) =>
      buildEmailHtml({ contacto, empresa, pdfUrl, acceptanceUrl, tieneReloj: false, ejecutivo: ejecutivoParaCorreo(firmante) }),
  },
  // UNA sola nota (plan + equipo en COP): en Colombia el hardware se factura
  // en pesos, no en una nota USD aparte como en Perú.
  async creator({ config, quoteId, dealId, doc, userCount, crmIncompleto, items }) {
    const { emitirCotizacionEnCreator } = require("../_shared/ndv-emitir");
    const { escaleraCOPara } = require("../_shared/escaleras-pais");
    // Tabla vigente o la anterior si esta cotización salió con ella (cliente
    // al que ya le dimos precio, Lalo 28-sep).
    const escaleraCO = escaleraCOPara(buildSubformItemsCO(items));
    await emitirCotizacionEnCreator({
      config,
      quoteId,
      dealId,
      acceptanceData: { companyRut: doc },
      escalerasPrecio: {
        plan_asistencia: escaleraCO,
        asistencia: escaleraCO.map((t) => ({ ...t })),
      },
      userCount: Number(userCount) || 0,
      crmIncompleto,
      motivo: "emision-co",
      creatorOverrides: { moneda: "COP", pais: "Colombia" },
    });
  },
};

module.exports = crearHandlerEmision(PERFIL_CO);
module.exports.PERFIL_CO = PERFIL_CO;
module.exports.buildSubformItemsCO = buildSubformItemsCO;
module.exports.quitarActivacionCO = quitarActivacionCO;
