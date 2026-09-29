/**
 * POST /api/quote-acceptance/create-from-vicky-mx — Cotización formal MÉXICO.
 *
 * PERFIL de la emisión única (api/_shared/emision-pais.js, 29-sep): acá viven
 * solo los DATOS mexicanos — RFC, pesos con IVA 16 % en todo, la capacitación
 * de regalo, dueños, PDF, correo propio y la nota de Creator en MXN. El flujo
 * (lead-first, dedup, deal, cotización, token, PDF, correo) es el compartido.
 *
 * Contrato del agente: {empresa, contacto, contactoEmail?, rfc,
 * contactoTelefono, userCount, escalonDescuento?, cc?,
 * items[{precioUnitarioMXN, subtotalMXN, afectoIva, …}]}.
 */
const { toText } = require("../_shared/zoho-crm");
const { buildProposalHtmlMX } = require("../_shared/proposal-html-builder-mx");
const { firmaParaPdf } = require("../_shared/ejecutivo-firma");
const { IVA_RATE_MX } = require("../_shared/quote-pricing");
const {
  crearHandlerEmision,
  buildSubformItemsPais,
  redondeoCentavos,
  OWNER_VICKY_ID,
} = require("../_shared/emision-pais");

// ── Tarifario MX (fuente de verdad del doc de tropicalización) ──
// El agente manda los items ya calculados; esta tabla queda acá como
// referencia canónica para tests de humo y validaciones futuras.
const TARIFAS_MX = {
  // Plan asistencia (recurrente, afecto IVA 16%).
  planFijoHasta10UsuariosMXN: 1000, // tarifa FIJA mensual 1-10 usuarios
  tramosPorUsuario: [
    { min: 11, max: 20, precioMXN: 83 },
    { min: 21, max: 30, precioMXN: 79 },
    { min: 31, max: 50, precioMXN: 75 },
  ],
  relojVentaMXN: 2100, // pago único
  relojArriendoMensualMXN: 350, // recurrente
  envioVentaPorPuntoMXN: 400, // pago único, NO descontable
  envioArriendoPorPuntoMXN: 0,
  instalacionCdmxMetroPorPuntoMXN: 700, // SOLO zona "cdmx_metro"; zona "resto"/auto-instalada: SIN ítem
  capacitacionOnlineMXN: 0, // Lalo 13-ago: el $600 se retiró del discurso — ítem incluido sin costo
  iva: IVA_RATE_MX, // 0.16
  descuentoRecurrenteEscalera: [10, 15], // % — la negocia el agente
};

/**
 * Tarifa del plan de asistencia MX según usuarios (escalera del doc de
 * tropicalización). Devuelve null fuera de rango (>50: canal ejecutivo).
 *  - 1-10:  tarifa FIJA $1,000 MXN/mes (modalidad "Fijo").
 *  - 11-50: tarifa por usuario según tramo (modalidad "Por usuario").
 */
function tarifaPlanAsistenciaMX(usuarios) {
  const n = Math.floor(Number(usuarios) || 0);
  if (n < 1) return null;
  if (n <= 10) {
    return {
      modalidad: "Fijo",
      cantidad: n,
      precioUnitarioMXN: TARIFAS_MX.planFijoHasta10UsuariosMXN,
      subtotalMXN: TARIFAS_MX.planFijoHasta10UsuariosMXN,
    };
  }
  const tramo = TARIFAS_MX.tramosPorUsuario.find((t) => n >= t.min && n <= t.max);
  if (!tramo) return null;
  return {
    modalidad: "Por usuario",
    cantidad: n,
    precioUnitarioMXN: tramo.precioMXN,
    subtotalMXN: Math.round(tramo.precioMXN * n * 100) / 100,
  };
}


const VICKY_MX_TERRITORIO = toText(process.env.VICKY_TERRITORIO_MX) || "México";
const VICKY_MX_MONEDA = toText(process.env.VICKY_MONEDA_MX) || "MXN";

// Owner MX: Yahel Segura (interina histórica). Overrideable por env.
const VICKY_MX_OWNER_ID = toText(process.env.VICKY_MX_OWNER_ID) || "3525045000308323003";
// TÓMBOLA GLOBAL (Lalo 25-sep, entradas México en "Deals 2026"): los registros
// nacen con el usuario VICKY y los sortea el traspaso, igual que Chile, Perú y
// Colombia. El dueño fijo (Yahel) sigue con VICKY_MX_OWNER_FIJO=on.
const MX_OWNER_FIJO = /^(on|1|true)$/i.test(toText(process.env.VICKY_MX_OWNER_FIJO));
const OWNER_MX = MX_OWNER_FIJO ? { id: VICKY_MX_OWNER_ID } : { id: OWNER_VICKY_ID };
// SDR de México (Pablo Rodríguez y Miguel Guzmán): su lead se convierte pero
// su gestión NO se hereda al deal.
const SDR_MX = new Set(
  (process.env.VICKY_SDR_MX_IDS || "3525045000391904256,3525045000434395001").split(",").map((s) => s.trim()).filter(Boolean),
);
// Dueños "del bot" en MX: solo sus leads huérfanos se adoptan.
const OWNERS_BOT_MX = new Set([OWNER_VICKY_ID, "3525045000308323003"]);

// Documentos hosteados para el correo (los mismos genéricos del chileno; la
// certificación de la Dirección del Trabajo es SOLO Chile y NO se incluye).
const DOC_FICHA_RELOJ = "https://cotizacion.geovictoria.com/pdf/assets/ficha-reloj-senseface.pdf";
const DOC_PRESENTACION = "https://cotizacion.geovictoria.com/pdf/assets/presentacion-comercial.pdf";

// ── Variantes de RFC ──
// El RFC no lleva dígito verificador con guion (a diferencia del RUT/NIT), así
// que las variantes son el valor tal cual y el compacto en mayúsculas sin
// puntos/espacios/guiones (formatos con separadores tipo "CEC-200528-6R4"
// existen en registros manuales).
function getRfcVariants(rfc) {
  if (!rfc) return [];
  const raw = String(rfc).trim();
  if (!raw) return [];
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  return Array.from(new Set([raw, compact])).filter(Boolean);
}

// RFC bien formado: 3-4 letras (persona moral/física) + fecha AAMMDD + 3 de
// homoclave = 12-13 caracteres. Solo se ADVIERTE si no calza (no se rechaza:
// misma tolerancia que CO con el NIT — el dato manda el agente).
function rfcPareceValido(rfc) {
  const compact = String(rfc || "").replace(/[.\s-]/g, "").toUpperCase();
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(compact);
}


// ¿El item ya es la fila de capacitación? (por id o nombre).
function esItemCapacitacion(item) {
  return (
    /capacitaci/i.test(String(item?.id || "")) ||
    /capacitaci/i.test(String(item?.nombre || ""))
  );
}

/**
 * Garantiza la fila de "Capacitación online" (incluida sin costo).
 * Es el equivalente estructural de ensureActivacion en CO (fila que va SIEMPRE
 * en Zoho, PDF y página de aceptación), pero con la regla MX
 * (Lalo 12-ago): la capacitación va SIN COSTO como gancho — el valor de lista
 * ($600) viaja como unitario para mostrarse TACHADO y el subtotal es $0. Si
 * el agente ya la mandó (con otro
 * precio negociado, por ejemplo), se respeta la suya.
 * afectoIva=true: es un servicio gravado con IVA 16% como el resto en MX.
 */
function ensureCapacitacion(items) {
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


// Redondeo MX: a centavos (2 decimales). El MXN usa centavos y el redondeo a
// peso entero de CL/CO descontaría el IVA exacto (ej: $1,540.48).
const round2 = redondeoCentavos;

const ITEMS_MX = {
  claves: { unitario: "precioUnitarioMXN", subtotal: "subtotalMXN", afecto: "afectoIva" },
  redondeo: round2,
  // La fila de Capacitación online (de regalo) va SIEMPRE: Zoho, PDF y
  // aceptación muestran los mismos números.
  preparar: ensureCapacitacion,
  // Total: netos + IVA 16 % de las líneas afectas.
  total: (items) => round2(items.reduce((acc, it) => {
    const subtotal = Number(it.subtotalMXN || 0);
    return acc + subtotal + (it.afectoIva === true ? subtotal * IVA_RATE_MX : 0);
  }, 0)),
  totalTexto: (t) => String(t),
  // México no informa Amount en el deal (convención del 24-sep).
};

/** Subform con la convención MXN en campos UF/CLP (centavos). */
function buildSubformItemsMX(items) {
  return buildSubformItemsPais(items, ITEMS_MX);
}

// ── Correo al cliente MX ──
// Espejo del diseño del correo chileno (tuteo cálido/comercial), adaptado:
//   - SIN regalos falsos: la capacitación se cobra, así que NO se promete
//     "capacitación incluida sin costo" en ninguna parte.
//   - SIN Certificación de la Dirección del Trabajo (documento SOLO Chile).
//   - Ejecutivo: Yahel Segura; el teléfono/WhatsApp se omite si no está
//     configurado (pendiente de confirmación).
function buildDocFila(href, label, nota) {
  const notaHtml = nota ? ` <span style="color:#a0aec0;font-size:12px;">${nota}</span>` : "";
  return `<tr><td style="padding:11px 16px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;">
    <a href="${href}" style="color:#1a73e8;text-decoration:none;font-size:14px;font-weight:600;">${label}</a>${notaHtml}
  </td></tr><tr><td style="height:8px;"></td></tr>`;
}

function buildEmailHtmlMX({ contacto, empresa, pdfUrl, tieneReloj, ejecutivo }) {
  // Firmante (29-sep): el dueño humano del trato; con Vicky el bloque dice
  // "Sigo aquí contigo", como el correo chileno.
  const EJEC_MX = firmaParaPdf(ejecutivo, "mx");
  const esVicky = Boolean(EJEC_MX.esVicky);
  const tituloEjecutivo = esVicky ? "Sigo aquí contigo 💬" : "Te presento a tu ejecutivo 🤝";
  const textoEjecutivo = esVicky
    ? `Cualquier duda o ajuste que necesites, <strong>responde este correo o escríbeme por WhatsApp</strong> — sigo acompañándote hasta dejarlo andando. 😊`
    : `De aquí en adelante, <strong>${EJEC_MX.nombre}</strong> te acompaña en todo el proceso. Cualquier duda o ajuste que necesites, <strong>responde este correo</strong> — está para ayudarte. 😊`;
  const primerNombre = String(contacto || "").trim().split(/\s+/)[0] || "";
  const saludo = primerNombre ? `Hola ${primerNombre} 👋` : "Hola 👋";
  const fichaFila = tieneReloj
    ? buildDocFila(DOC_FICHA_RELOJ, "🕐 Ficha Técnica del Reloj Checador", "(tu cotización lleva reloj)")
    : "";
  const contactoEjecutivo = EJEC_MX.telefono
    ? `✉️ <a href="mailto:${EJEC_MX.email}" style="color:#1a73e8;text-decoration:none;">${EJEC_MX.email}</a> &nbsp;·&nbsp; 📱 ${EJEC_MX.telefono}`
    : `✉️ <a href="mailto:${EJEC_MX.email}" style="color:#1a73e8;text-decoration:none;">${EJEC_MX.email}</a>`;
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Tu cotización GeoVictoria</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(13,71,161,0.08);">
    <tr><td style="background:linear-gradient(135deg,#0d47a1 0%,#1a73e8 100%);padding:28px 32px;">
      <table role="presentation" width="100%"><tr><td style="color:#ffffff;font-size:22px;font-weight:700;">GeoVictoria</td><td align="right" style="color:#bbdefb;font-size:12px;">Control de Asistencia</td></tr></table>
    </td></tr>
    <tr><td style="padding:36px 32px 8px 32px;">
      <p style="margin:0 0 6px 0;font-size:14px;color:#1a73e8;font-weight:600;">${saludo}</p>
      <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.3;color:#1a202c;">Tu cotización para <span style="color:#0d47a1;">${empresa}</span> está lista</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">Preparé tu propuesta de Control de Asistencia. Ábrela en el PDF y, desde ahí mismo, puedes aceptarla en línea cuando quieras.</p>
    </td></tr>
    <tr><td align="center" style="padding:28px 32px 8px 32px;">
      <a href="${pdfUrl}" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:14px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">📄 Ver tu cotización (PDF)</a>
      <p style="margin:12px 0 0 0;font-size:12px;color:#a0aec0;">Dentro del PDF encuentras el botón para aceptarla en línea.</p>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 14px 0;font-size:15px;color:#1a202c;">Cómo seguimos 🚀</h3>
      <table role="presentation" width="100%">
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">1.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Abres el PDF y revisas tu cotización.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">2.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Desde el mismo PDF la aceptas en línea y coordinamos el pago inicial.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">3.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;">Iniciamos tu onboarding y activamos tu servicio en 24 horas hábiles.</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 12px 0;font-size:15px;color:#1a202c;">Documentos para ti 📎</h3>
      <table role="presentation" width="100%">
        ${fichaFila}
        ${buildDocFila(DOC_PRESENTACION, "📊 Presentación Comercial GeoVictoria", "")}
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 8px 0;font-size:15px;color:#1a202c;">${tituloEjecutivo}</h3>
      <p style="margin:0 0 16px 0;font-size:14px;color:#4a5568;line-height:1.6;">${textoEjecutivo}</p>
      <table role="presentation" width="100%" style="background:#f7f9fc;border:1px solid #e2e8f0;border-radius:10px;"><tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px 0;font-size:14px;color:#1a202c;font-weight:600;">${EJEC_MX.nombre}</p>
        <p style="margin:0 0 8px 0;font-size:13px;color:#718096;">${EJEC_MX.cargo} · GeoVictoria</p>
        <p style="margin:0;font-size:13px;color:#718096;">${contactoEjecutivo}</p>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:28px 32px 30px 32px;">
      <p style="margin:0;font-size:11px;color:#a0aec0;line-height:1.5;">GeoVictoria — Especialistas en Control de Asistencia y Accesos, presentes en 40+ países.<br><a href="https://geovictoria.com" style="color:#a0aec0;">geovictoria.com</a></p>
    </td></tr>
  </table>
  <p style="font-size:11px;color:#b8c0cc;margin:16px 0 0 0;">Este es un correo automático de tu cotización. Si no la solicitaste, ignóralo.</p>
</td></tr></table>
</body></html>`;
}


const PERFIL_MX = {
  cc: "mx",
  etiqueta: "create-from-vicky-mx",
  secretEnv: "VICKY_COTIZADORA_SECRET_MX",
  territorio: VICKY_MX_TERRITORIO,
  moneda: "MXN",
  monedaDeal: VICKY_MX_MONEDA,
  owners: { interino: OWNER_MX, adoptables: OWNERS_BOT_MX, noHeredables: SDR_MX },
  documento: {
    campo: "rfc",
    nombre: "RFC",
    // Solo advertencia si el formato no calza (misma tolerancia que CO): el flujo sigue.
    validar(body, rfc) {
      if (!rfcPareceValido(rfc)) console.warn(`[create-from-vicky-mx] RFC con formato inusual: '${rfc}' (se acepta igual).`);
      return { tipoDocumento: "RFC" };
    },
    paraGuardar: (rfc) => rfc,
    paraCotizacion: (rfc) => rfc,
    variantes: getRfcVariants,
    compactar: (v) => String(v || "").replace(/[.\s-]/g, "").toUpperCase(),
    descripcionCuenta: (rfc) => `Cuenta creada por Vicky MX (WhatsApp). RFC: ${rfc}`,
    nombreDesambiguado: (empresa, rfc) => `${empresa} (${rfc})`,
    clientePdf: (rfc) => ({ rfc }),
  },
  items: ITEMS_MX,
  deal: {
    tipoDeCobro: () => "Mensual fijo",
    nombre: (empresa) => `${empresa} - Cotización Vicky`,
  },
  respuestaExtra: ({ descuentoPlanPct }) => ({ descuentoPlanPct }),
  pdf: { build: buildProposalHtmlMX },
  correo: {
    // Reply-to y copia: el dueño humano si lo hay; si firma Vicky, la copia
    // del país (VICKY_MX_QUOTE_CC, default Yahel). Copias fijas: Lalo (31-jul)
    // + Rodrigo (03-ago) + las del body.
    destinatarios({ firmante, body }) {
      const ccPais = (process.env.VICKY_MX_QUOTE_CC || "ysegura@geovictoria.com").split(",")[0].trim();
      return {
        replyToEmail: firmante.esVicky ? ccPais : firmante.email,
        ccEmail: firmante.esVicky ? ccPais : firmante.email,
        ccEmails: [
          ...(process.env.QUOTE_EMAIL_CC_FIJO || "egomez@geovictoria.com,rlewit@geovictoria.com").split(",").map((s) => s.trim()),
          ...(Array.isArray(body.cc) ? body.cc : []),
        ].filter(Boolean),
      };
    },
    html: ({ contacto, empresa, pdfUrl, hayHardware, firmante }) =>
      buildEmailHtmlMX({ contacto, empresa, pdfUrl, tieneReloj: hayHardware, ejecutivo: firmante }),
  },
  // UNA sola nota (plan + equipo en pesos), como Colombia.
  async creator({ config, quoteId, dealId, doc, userCount, crmIncompleto }) {
    const { emitirCotizacionEnCreator } = require("../_shared/ndv-emitir");
    const { ESCALERA_ASISTENCIA_MX } = require("../_shared/escaleras-pais");
    await emitirCotizacionEnCreator({
      config,
      quoteId,
      dealId,
      acceptanceData: { companyRut: doc },
      escalerasPrecio: {
        plan_asistencia: ESCALERA_ASISTENCIA_MX.map((t) => ({ ...t })),
        asistencia: ESCALERA_ASISTENCIA_MX.map((t) => ({ ...t })),
      },
      userCount: Number(userCount) || 0,
      crmIncompleto,
      motivo: "emision-mx",
      creatorOverrides: { moneda: "MXN", pais: "México" },
    });
  },
};

module.exports = crearHandlerEmision(PERFIL_MX);
module.exports.PERFIL_MX = PERFIL_MX;
module.exports.buildSubformItemsMX = buildSubformItemsMX;
module.exports.ensureCapacitacion = ensureCapacitacion;
module.exports.buildEmailHtmlMX = buildEmailHtmlMX;
module.exports.TARIFAS_MX = TARIFAS_MX;
module.exports.tarifaPlanAsistenciaMX = tarifaPlanAsistenciaMX;
