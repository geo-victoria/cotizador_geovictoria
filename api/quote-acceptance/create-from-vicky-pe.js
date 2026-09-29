/**
 * POST /api/quote-acceptance/create-from-vicky-pe — Cotización formal PERÚ.
 *
 * PERFIL de la emisión única (api/_shared/emision-pais.js, 29-sep): acá viven
 * solo los DATOS peruanos — RUC/DNI, soles con IGV 18 %, dueños, PDF, correo
 * y las DOS notas de Creator (plan en PEN + hardware en USD). El flujo
 * (lead-first, dedup, deal, cotización, token, PDF, correo) es el compartido.
 *
 * Contrato del agente: {empresa, contacto, contactoEmail?, ruc|DNI,
 * contactoTelefono, userCount, escalonDescuento?, tipoCambio?,
 * tipoCambioFuente?, items[{precioUnitarioPEN, subtotalPEN, afectoIgv, …}]}.
 */
const { toText, createRecord, getRecordWithFields, updateRecord } = require("../_shared/zoho-crm");
const { buildProposalHtmlPE, IGV_PE } = require("../_shared/proposal-html-builder-pe");
const { emitirCotizacionEnCreator } = require("../_shared/ndv-emitir");
const { ESCALERA_ASISTENCIA_PE } = require("../_shared/escaleras-pais");
const { nombreTratoConRuc } = require("../_shared/nombre-trato-ruc");
const {
  crearHandlerEmision,
  buildSubformItemsPais,
  redondeoCentavos,
  ccDesdeEnv,
  OWNER_VICKY_ID,
} = require("../_shared/emision-pais");

const VICKY_PE_TERRITORIO = toText(process.env.VICKY_TERRITORIO_PE) || "Perú";
const VICKY_PE_MONEDA = toText(process.env.VICKY_MONEDA_PE) || "SOL";
// Mónica Mendoza (única telemarketing PE): dueña ADOPTABLE de leads huérfanos.
const VICKY_PE_OWNER_ID = toText(process.env.VICKY_PE_OWNER_ID) || "3525045000323383015";
// Los registros nacen con el usuario VICKY (interino) y los sortea "Deals
// 2026" al traspasar — misma regla que Chile (15-sep).
const VICKY_PE_OWNER_INTERINO_ID = toText(process.env.VICKY_PE_OWNER_INTERINO_ID) || OWNER_VICKY_ID;
const OWNER_PE = { id: VICKY_PE_OWNER_INTERINO_ID };
const OWNERS_ADOPTABLES_PE = new Set([OWNER_VICKY_ID, VICKY_PE_OWNER_ID]);

// ── RUC (SUNAT): 11 dígitos, prefijos válidos, dígito verificador mod 11.
// Mismo algoritmo que lib/rut.ts del agente (verificado con el RUC real de
// la entidad peruana: 20605842055).
function rucValido(rucRaw) {
  const ruc = String(rucRaw || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(ruc)) return false;
  if (!/^(10|15|16|17|20)/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(ruc[i]), 0);
  const resto = 11 - (suma % 11);
  const dv = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return dv === Number(ruc[10]);
}

// DNI peruano: 8 dígitos exactos (sin dígito verificador público).
function esDniPE(docRaw) {
  return /^\d{8}$/.test(String(docRaw || "").replace(/\D/g, ""));
}

function rucParaGuardar(ruc) {
  return String(ruc || "").replace(/\D/g, "");
}

// El RUC no tiene DV con guion: las variantes son "tal cual" y "solo dígitos".
function getRucVariants(ruc) {
  const raw = String(ruc || "").trim();
  if (!raw) return [];
  const compact = raw.replace(/\D/g, "");
  return Array.from(new Set([raw, compact])).filter(Boolean);
}

function esItemActivacion(item) {
  return (
    String(item?.tipo || "").toLowerCase() === "activacion" ||
    /activaci/i.test(String(item?.id || "")) ||
    /activaci/i.test(String(item?.nombre || ""))
  );
}

/**
 * PATRÓN CHILE (Lalo 21-sep): la cotización NO lleva fila de Activación. El
 * primer mes adelantado lo calcula computeTotalsPE desde las recurrentes. Si
 * un agente viejo todavía manda la fila, se descarta acá.
 */
function quitarActivacionPE(items) {
  const sin = items.filter((it) => !esItemActivacion(it));
  if (sin.length !== items.length) {
    console.warn("[create-from-vicky-pe] fila de Activación descartada: el primer mes lo calcula el cotizador (patrón CL).");
  }
  return sin;
}

const ITEMS_PE = {
  claves: { unitario: "precioUnitarioPEN", subtotal: "subtotalPEN", afecto: "afectoIgv" },
  redondeo: redondeoCentavos,
  preparar: quitarActivacionPE,
  // Pago inicial con IGV 18 %: únicos + primer mes. Informativo (Amount del deal).
  total: (items) => items.reduce((acc, it) => {
    const subtotal = Number(it.subtotalPEN || 0);
    return acc + subtotal + (it.afectoIgv === true ? subtotal * IGV_PE : 0);
  }, 0),
  totalTexto: (t) => String(Math.round(t)),
  amountDeal: (t) => Math.round(t) || undefined,
};

/** Subform con la convención PEN en campos UF/CLP (2 decimales). */
function buildSubformItemsPE(items) {
  return buildSubformItemsPais(items, ITEMS_PE);
}

const PERFIL_PE = {
  cc: "pe",
  etiqueta: "create-from-vicky-pe",
  secretEnv: "VICKY_COTIZADORA_SECRET_PE",
  territorio: VICKY_PE_TERRITORIO,
  moneda: "PEN",
  monedaDeal: VICKY_PE_MONEDA,
  owners: { interino: OWNER_PE, adoptables: OWNERS_ADOPTABLES_PE },
  documento: {
    campo: "ruc",
    nombre: "RUC",
    // DNI (Lalo 26-sep): quien no tiene RUC o pide BOLETA cotiza con su DNI de
    // 8 dígitos. Va en los mismos campos; la etiqueta se deduce del largo.
    validar(body, ruc) {
      const tipoDocumento = String(body.tipoDocumento || "").toUpperCase() === "DNI" || esDniPE(ruc) ? "DNI" : "RUC";
      if (tipoDocumento === "DNI" ? !esDniPE(ruc) : !rucValido(ruc)) {
        return {
          error: tipoDocumento === "DNI"
            ? `El DNI '${ruc}' no es válido (8 dígitos). Pídele al cliente confirmarlo.`
            : `El RUC '${ruc}' no es válido (11 dígitos con dígito verificador SUNAT). Pídele al cliente confirmarlo.`,
        };
      }
      return { tipoDocumento };
    },
    paraGuardar: rucParaGuardar,
    paraCotizacion: rucParaGuardar,
    variantes: getRucVariants,
    compactar: (v) => String(v || "").replace(/\D/g, ""),
    descripcionCuenta: (ruc, tipoDocumento) => `Cuenta creada por Vicky PE (WhatsApp). ${tipoDocumento}: ${ruc}`,
    nombreDesambiguado: (empresa, ruc) => `${empresa} (${rucParaGuardar(ruc)})`,
    clientePdf: (ruc) => ({ ruc: rucParaGuardar(ruc) }),
  },
  items: ITEMS_PE,
  deal: {
    // Tramos PE: 1-10 y 11-20 son tarifas fijas; 21-50 por usuario.
    tipoDeCobro: (userCount) => ((Number(userCount) || 1) <= 20 ? "Mensual fijo" : "Por usuario"),
    // RUC en el nombre del trato (convención del equipo de Perú, Lalo 28-sep).
    nombre: (empresa, ruc) => nombreTratoConRuc(`${empresa} - Cotización Vicky`, rucParaGuardar(ruc)),
    // …también para el trato que ya existía (nacido en un hito antes de que
    // el cliente diera el RUC, o adoptado por lead-first). Best-effort.
    async despues({ dealId, doc, etiqueta }) {
      if (!dealId || !doc) return;
      try {
        const deal = await getRecordWithFields("Deals", dealId, ["Deal_Name"]);
        const actual = toText(deal?.Deal_Name);
        const nuevo = nombreTratoConRuc(actual, rucParaGuardar(doc));
        if (actual && nuevo !== actual) {
          await updateRecord("Deals", dealId, { Deal_Name: nuevo });
          console.log(`[${etiqueta}] trato ${dealId} renombrado con RUC: "${nuevo}"`);
        }
      } catch (e) {
        console.warn(`[${etiqueta}] no se pudo poner el RUC en el trato ${dealId}: ${toText(e?.message || e).slice(0, 160)}`);
      }
    },
  },
  // Dólar venta SUNAT con el que el agente convirtió el reloj a soles (viaja a
  // Creator para la nota de venta del hardware, que en Perú va en USD).
  extrasDelBody: (body) => ({
    tipoCambio: Number(body.tipoCambio) > 0 ? Number(body.tipoCambio) : undefined,
    tipoCambioFuente: toText(body.tipoCambioFuente),
  }),
  pdf: { build: buildProposalHtmlPE },
  correo: {
    // CC y reply-to a Mónica para que vea lo que recibió su cliente.
    destinatarios() {
      const CC_PE = ccDesdeEnv("VICKY_PE_QUOTE_CC", "mmendozav@geovictoria.com");
      return { replyToEmail: CC_PE[0], ccEmails: CC_PE };
    },
    html: ({ buildEmailHtml, contacto, empresa, pdfUrl, acceptanceUrl, firmante, ejecutivoParaCorreo }) =>
      buildEmailHtml({ contacto, empresa, pdfUrl, acceptanceUrl, tieneReloj: false, ejecutivo: ejecutivoParaCorreo(firmante) }),
  },
  // DOS NOTAS, como se maneja desde siempre en Perú (Lalo 17-sep): el PLAN en
  // soles y, si hay reloj, el HARDWARE en una nota APARTE en USD con el
  // artículo [PER] 304 (arriendo US$20/mes · venta US$90). La referencia de
  // la cotización apunta a la del plan; la del hardware queda en una nota.
  async creator({ config, quoteId, dealId, docGuardar, userCount, crmIncompleto, hayHardware, extras }) {
    const { tipoCambio, tipoCambioFuente } = extras;
    const emisionPlan = await emitirCotizacionEnCreator({
      config,
      quoteId,
      dealId,
      acceptanceData: { companyRut: docGuardar },
      escalerasPrecio: {
        plan_asistencia: ESCALERA_ASISTENCIA_PE.map((t) => ({ ...t })),
        asistencia: ESCALERA_ASISTENCIA_PE.map((t) => ({ ...t })),
      },
      userCount: Number(userCount) || 0,
      crmIncompleto,
      motivo: "emision-pe",
      creatorOverrides: { moneda: "PEN", pais: "Perú", tipoCambio, tipoCambioFuente, ...(hayHardware ? { filtroLineas: "sin_hardware" } : {}) },
    });
    if (hayHardware && emisionPlan?.status !== "skipped") {
      const emisionHw = await emitirCotizacionEnCreator({
        config,
        quoteId,
        dealId,
        acceptanceData: { companyRut: docGuardar },
        userCount: Number(userCount) || 0,
        crmIncompleto,
        motivo: "emision-pe-hardware-usd",
        forzarNueva: true,
        persistirReferencia: false,
        creatorOverrides: { moneda: "USD", pais: "Perú", filtroLineas: "solo_hardware", tipoCambio, tipoCambioFuente },
      });
      if (emisionHw?.ndvId) {
        await createRecord("Notes", {
          Note_Title: "Cotización en Creator: hardware en USD (nota aparte)",
          Note_Content:
            `Perú emite el plan y el hardware en notas separadas. Plan (PEN): Creator id ${emisionPlan?.ndvId || "?"}. ` +
            `Hardware (USD, artículo 304 - [PER] Reloj Gama Estándar FACIAL LAN WIFI): Creator id ${emisionHw.ndvId}. ` +
            `Al cliente se le cotizó el reloj en soles al dólar SUNAT ${tipoCambio || "?"} (${tipoCambioFuente || "?"}). ` +
            `Convertir AMBAS a Nota de Venta al confirmar el pago.`,
          Parent_Id: quoteId,
          $se_module: config.quoteModule,
        }, true).catch(() => {});
      }
    }
  },
};

module.exports = crearHandlerEmision(PERFIL_PE);
module.exports.PERFIL_PE = PERFIL_PE;
module.exports.buildSubformItemsPE = buildSubformItemsPE;
module.exports.quitarActivacionPE = quitarActivacionPE;
module.exports.rucValido = rucValido;
module.exports.esDniPE = esDniPE;
