/**
 * FICHA DE EMISIÓN POR PAÍS (fase 1 de la emisión única, 28-sep).
 *
 * Todo lo que distingue la emisión de un país de la de otro es DATO: vive
 * acá. El PROCESO es uno solo, el de Chile (`emitir.js`). Los valores salen
 * de las mismas variables de entorno y con los mismos defaults que hoy tienen
 * escritos los cuatro endpoints `create-from-vicky{,-pe,-co,-mx}.js`
 * (tests/emision/fichas.test.js lo verifica leyendo sus fuentes).
 *
 * FICHA_CL reproduce Chile EXACTO: la prueba de identidad
 * (tests/emision/identidad-cl.test.js) corre el handler chileno actual y
 * `emitirCotizacion` con esta ficha y exige las mismas llamadas a Zoho, kv,
 * agente, PDF, correo y Creator.
 *
 * Las fichas se arman con `construirFichas(env)` al cargar el módulo (igual
 * que las constantes de los endpoints, que se leen al cargar).
 */
const { toText } = require("../zoho-crm");
const doc = require("./documentos");
const subform = require("./subform");
const { crearPlantillaCorreoCL } = require("./correo");

const VICKY_USER_ID = "3525045000484500876";
const GEOVICTORIA_ADMIN_ID = "3525045000000200013";
const GORDILLO_ID = "3525045000203758005";
const YAHEL_ID = "3525045000308323003";
const MONICA_ID = "3525045000323383015";

const SECTORES_VALIDOS_CL = new Set([
  "1. Agrícola", "2. Condominio", "3. Construcción", "4. Inmobilaria",
  "5. Consultoria", "6. Banca y Finanzas", "7. Educación", "8. Municipio",
  "9. Gobierno", "10. Mineria", "11. Naviera", "12. Outsourcing Seguridad",
  "12. Outsourcing General", "13. Outsourcing Retail", "14. Planta Productiva",
  "15. Logistica", "16. Retail Enterprise", "17. Retail SMB", "18. Salud",
  "19. Servicios", "20. Transporte", "21. Turismo, Hotelería y Gastronomía",
]);

// SDR por país: su lead se CONVIERTE pero su gestión NO se hereda al deal
// (decisión del dueño 28-sep, los cuatro países): el deal nace con el interino
// (Vicky) y, si Vicky cierra sola, el agente lo reasigna tras el pago a la
// gestora comercial del país (CL Aleydis, PE Cecilia Valverde, CO Gabriela
// Linares, MX Andrea Fuentes). Ids = rosters `sdr` de la ficha operativa del
// agente (lib/paises/ficha-operativa.ts).
const SDR_CL_IDS = [
  "3525045000583802005", // Aleydis Araque
  "3525045000594735052", // Aracelli Sepúlveda
];
// 01-oct: Priscila Quispe pasó a telemarketing (como Mónica) — su lead SÍ
// hereda el deal; SDR de Perú queda solo Ana Fiori.
const SDR_PE_IDS = [
  "3525045000299130001", // Ana Fiori
];
// SDR de Colombia (create-from-vicky-co.js SDR_CO, Lalo 23-sep).
const SDR_CO_IDS = [
  "3525045000613817111", // Eddy Galindo
  "3525045000654443071", // Mauricio Sanabria Torres
  "3525045000639927045", // Jhon Nariño Chavarro
  "3525045000619732095", // Guerrero (histórico)
  "3525045000639899035", // Quiroga (histórico)
];

// Cuenta "-" y compañía placeholder (05-sep, cuenta "-" de 2022).
const ES_CUENTA_BLOQUEADA = /^[-–—\s]*$|^no usar\b|no declarado/i;
const ES_COMPANY_PLACEHOLDER = /^[-–—\s]*$|prospecto whatsapp|por identificar|sin empresa|tu empresa|no identificado|no declarado/i;
// Placeholders que la emisión corrige en cuenta/deal reusados (31-jul, D'amore).
const ES_PLACEHOLDER_REGISTRO = /prospecto whatsapp|por identificar|sin empresa|tu empresa|no identificado/i;

const DOC_CERTIFICACION = "https://cotizacion.geovictoria.com/pdf/assets/certificacion-dt.pdf";
const DOC_FICHA_RELOJ = "https://cotizacion.geovictoria.com/pdf/assets/ficha-reloj-senseface.pdf";
const DOC_PRESENTACION = "https://cotizacion.geovictoria.com/pdf/assets/presentacion-comercial.pdf";

function listaDeEnv(valor) {
  return String(valor || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Validación de un ítem del contrato de país (mismos mensajes que los endpoints). */
function crearValidarItemPais({ precioUnitario, subtotal, afecto }) {
  return function validarItem(item, index) {
    if (!item || typeof item !== "object") return `items[${index}] no es un objeto`;
    if (!toText(item.nombre)) return `items[${index}].nombre requerido`;
    const cantidad = Number(item.cantidad);
    if (!Number.isFinite(cantidad) || cantidad < 1) return `items[${index}].cantidad debe ser >= 1`;
    if (!Number.isFinite(Number(item[precioUnitario]))) return `items[${index}].${precioUnitario} debe ser numérico`;
    if (!Number.isFinite(Number(item[subtotal]))) return `items[${index}].${subtotal} debe ser numérico`;
    if (typeof item.esRecurrente !== "boolean") return `items[${index}].esRecurrente debe ser boolean`;
    if (typeof item[afecto] !== "boolean") return `items[${index}].${afecto} debe ser boolean`;
    return null;
  };
}

function construirFichas(env = process.env) {
  const e = (k) => toText(env[k]);
  // ── Comunes (hoy repetidos en los 4 archivos) ──
  const comun = {
    etapaInicial: e("VICKY_DEAL_STAGE_INICIAL") || "4. Propuesta Enviada / En Negociación",
    leadSourceDefault: e("VICKY_LEAD_SOURCE") || "SEO",
    tombola: e("VICKY_TOMBOLA") || "Mantener propietario",
    producto: e("VICKY_PRODUCTO_DEFAULT") || "Control de Asistencia",
    sectorFallback: e("VICKY_SECTOR_FALLBACK") || "19. Servicios",
    expansionRegional: e("VICKY_EXPANSION_REGIONAL") || "No",
    fromEmail: e("VICKY_FROM_EMAIL") || "vicky@geovictoria.com",
    internas: (env.VICKY_INTERNAL_ACCOUNT_NAMES || "GeoVictoria")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    ccFijos: (env.QUOTE_EMAIL_CC_FIJO || "egomez@geovictoria.com,rlewit@geovictoria.com")
      .split(",").map((s) => s.trim()).filter(Boolean),
  };
  const esCuentaNoAdoptableCL = (name) => {
    const n = String(name || "").trim();
    return !n || comun.internas.includes(n.toLowerCase()) || ES_CUENTA_BLOQUEADA.test(n);
  };
  const esCuentaInterna = (name) => comun.internas.includes(String(name || "").trim().toLowerCase());

  const base = (pais) => ({
    pais,
    deal: {
      etapaInicial: comun.etapaInicial,
      leadSourceDefault: comun.leadSourceDefault,
      tombola: comun.tombola,
      producto: comun.producto,
      pipeline: "Standard (Standard)",
      // Firma en las descripciones de deal y cuenta ("Deal creado por Vicky PE…").
      firma: { cl: "Vicky", pe: "Vicky PE", co: "Vicky CO", mx: "Vicky MX" }[pais],
      nombre: (empresa) => `${empresa} - Cotización Vicky`,
      nombreDesdePlaceholder: (empresa) => `${empresa} (Control de Asistencia)`,
    },
    sector: { validos: null, fallback: comun.sectorFallback, expansionRegional: comun.expansionRegional },
    cuentas: {
      internas: comun.internas,
      esNoAdoptable: esCuentaNoAdoptableCL,
      esCompanyPlaceholder: ES_COMPANY_PLACEHOLDER,
      esPlaceholderRegistro: ES_PLACEHOLDER_REGISTRO,
    },
    owners: {
      interino: { id: VICKY_USER_ID },
      interinosLectura: [VICKY_USER_ID, GEOVICTORIA_ADMIN_ID],
      noHeredables: null,
    },
    correo: {
      fromEmail: comun.fromEmail,
      ccFijos: comun.ccFijos,
      ccPais: [],
      incluirBodyCc: true,
      adjuntoPdf: true,
      tolerarFallo: false,
      asunto: (empresa) => `Tu cotización GeoVictoria — ${empresa}`,
    },
    notaEnCuenta: true,
    cotizacion: { marcarIntervencionHumana: true },
    flags: { convertFirst: true },
  });

  // ────────────────────────────────── CHILE ──
  const cl = base("cl");
  Object.assign(cl, {
    etiquetaLog: "create-from-vicky",
    secretEnvs: ["VICKY_COTIZADORA_SECRET"],
    territorio: e("VICKY_TERRITORIO") || "Chile",
    // Chile en UF (Lalo 25-sep); override solo con VICKY_MONEDA_CL.
    monedaDeal: e("VICKY_MONEDA_CL") || "UF",
    documento: {
      etiqueta: "RUT",
      validar: null,
      variantes: doc.getRutVariants,
      paraCuenta: doc.identidad,
      paraCotizacion: doc.identidad,
      paraLead: doc.identidad,
      paraCreator: (d) => toText(d),
      enDeal: true,
      clave: doc.claveSoloDigitosK,
      claveCapa4: doc.claveSinSeparadores,
    },
    moneda: {
      campos: { total: "totalUF", totalRef: "totalCLP", precioUnitario: "precioUnitarioUF", subtotal: "subtotalUF" },
      validarItem: null,
      ufCongelada: true,
      unidad: "UF",
    },
  });
  cl.deal.amount = (cot) => cot.totalCLP || undefined;
  cl.deal.descripcionTotal = (cot) => `${cot.totalUF} UF / ${cot.totalCLP} CLP`;
  cl.sector.validos = SECTORES_VALIDOS_CL;
  cl.owners.adoptables = new Set([VICKY_USER_ID, GORDILLO_ID, YAHEL_ID]);
  cl.owners.noHeredables = new Set(listaDeEnv(env.VICKY_SDR_CL_IDS || SDR_CL_IDS.join(",")));
  cl.subform = {
    prepararItems: null,
    construir: (items, { ufActual, config }) => subform.buildSubformItemsCL(items, ufActual, config),
  };
  cl.descuento = { motor: "cl", escribirSiempre: true };
  cl.pdf = {
    opciones: { format: "Letter", margin: "0" },
    construir: ({ cliente, cotizacion, acceptanceUrl, cotizacionId, validezHasta, descuentos, condicionDiscursiva, ejecutivo }) =>
      require("../proposal-html-builder").buildProposalHtml({
        cliente: {
          ...cliente,
          ejecutivo: ejecutivo.nombre,
          ejecutivoEmail: ejecutivo.email,
          ejecutivoTelefono: ejecutivo.telefono,
        },
        cotizacion,
        acceptanceUrl,
        cotizacionId,
        validezHasta,
        descuentos,
        condicionDiscursiva,
      }),
  };
  cl.correo.plantilla = crearPlantillaCorreoCL({
    fromEmail: comun.fromEmail,
    docs: { certificacion: DOC_CERTIFICACION, fichaReloj: DOC_FICHA_RELOJ, presentacion: DOC_PRESENTACION },
  });
  cl.creator = { overrides: null, escaleras: null, motivo: "emision", notaHardwareUsd: false };
  cl.token = { pais: null };
  cl.mensajes = {
    faltanCampos: "Faltan campos en cliente: empresa, contacto, rutEmpresa",
    itemsRequerido: "cotizacion.items requerido (no vacío)",
  };
  cl.respuesta = { linkCortoEnReintento: false, extras: null };

  // ────────────────────────────────── PERÚ ──
  const monicaId = e("VICKY_PE_OWNER_ID") || MONICA_ID;
  const pe = base("pe");
  Object.assign(pe, {
    etiquetaLog: "create-from-vicky-pe",
    secretEnvs: ["VICKY_COTIZADORA_SECRET_PE", "VICKY_COTIZADORA_SECRET"],
    territorio: e("VICKY_TERRITORIO_PE") || "Perú",
    monedaDeal: e("VICKY_MONEDA_PE") || "SOL",
    documento: {
      etiqueta: "RUC",
      // RUC con DV SUNAT o DNI de 8 dígitos (Lalo 26-sep).
      validar: (d, cliente) => {
        const tipo = String(cliente?.tipoDocumento || "").toUpperCase() === "DNI" || doc.esDniPE(d) ? "DNI" : "RUC";
        const ok = tipo === "DNI" ? doc.esDniPE(d) : doc.rucValido(d);
        if (ok) return { ok: true, tipo };
        return {
          ok: false,
          tipo,
          error: tipo === "DNI"
            ? `El DNI '${d}' no es válido (8 dígitos). Pídele al cliente confirmarlo.`
            : `El RUC '${d}' no es válido (11 dígitos con dígito verificador SUNAT). Pídele al cliente confirmarlo.`,
        };
      },
      variantes: doc.getRucVariants,
      paraCuenta: doc.rucParaGuardar,
      paraCotizacion: doc.rucParaGuardar,
      paraLead: doc.rucParaGuardar,
      paraCreator: doc.rucParaGuardar,
      enDeal: false,
      clave: doc.claveSoloDigitosK,
      claveCapa4: doc.claveSinSeparadores,
    },
    moneda: {
      campos: { total: "totalPEN", totalRef: null, precioUnitario: "precioUnitarioPEN", subtotal: "subtotalPEN" },
      validarItem: crearValidarItemPais({ precioUnitario: "precioUnitarioPEN", subtotal: "subtotalPEN", afecto: "afectoIgv" }),
      ufCongelada: false,
      unidad: "PEN",
      impuesto: 0.18,
      afecto: "afectoIgv",
    },
  });
  pe.deal.amount = (cot) => Math.round(cot.totalPEN) || undefined;
  pe.deal.descripcionTotal = (cot) => `${Math.round(cot.totalPEN)} PEN`;
  pe.cuentas.esNoAdoptable = esCuentaInterna;
  pe.owners.interino = { id: e("VICKY_PE_OWNER_INTERINO_ID") || VICKY_USER_ID };
  pe.owners.adoptables = new Set([VICKY_USER_ID, monicaId]);
  pe.owners.noHeredables = new Set(listaDeEnv(env.VICKY_SDR_PE_IDS || SDR_PE_IDS.join(",")));
  pe.subform = {
    prepararItems: (items) => require("../quote-pricing").quitarFilaActivacion(items, "create-from-vicky-pe"),
    construir: (items) => subform.buildSubformItemsPE(items),
  };
  pe.descuento = { motor: "escalera_simple", escribirSiempre: false };
  pe.pdf = {
    opciones: { format: "Letter", margin: "0" },
    construir: ({ cliente, items, acceptanceUrl, cotizacionId, validezHasta, descuentos }) =>
      require("../proposal-html-builder-pe").buildProposalHtmlPE({
        cliente: { empresa: cliente.empresa, contacto: cliente.contacto, ruc: doc.rucParaGuardar(cliente.rutEmpresa) },
        items, acceptanceUrl, cotizacionId, validezHasta, descuentos,
        mesesDescuento: require("../proposal-constants").MESES_DESCUENTO_PLAN,
      }),
  };
  pe.correo.ccFijos = [];
  pe.correo.ccPais = listaDeEnv(env.VICKY_PE_QUOTE_CC || "mmendozav@geovictoria.com");
  pe.correo.incluirBodyCc = false;
  pe.correo.adjuntoPdf = false;
  pe.correo.tolerarFallo = true;
  // Hoy PE/CO usan la plantilla chilena CON la certificación de la DT y sin
  // la ficha del reloj (tieneReloj:false fijo). Se conserva (decisión abierta).
  pe.correo.plantilla = crearPlantillaCorreoCL({
    fromEmail: comun.fromEmail,
    docs: { certificacion: DOC_CERTIFICACION, fichaReloj: "", presentacion: DOC_PRESENTACION },
  });
  pe.correo.ejecutivoFijo = { nombre: "Mónica Mendoza", email: "mmendozav@geovictoria.com" };
  pe.creator = {
    overrides: { moneda: "PEN", pais: "Perú" },
    escaleras: () => require("../escaleras-pais").ESCALERA_ASISTENCIA_PE,
    motivo: "emision-pe",
    // Perú: plan en PEN y hardware en una nota APARTE en USD (Lalo 17-sep).
    notaHardwareUsd: true,
  };
  pe.token = { pais: "pe" };
  pe.mensajes = { faltanCampos: "Faltan campos: empresa, contacto, ruc", itemsRequerido: "items requerido (no vacío)" };
  pe.respuesta = { linkCortoEnReintento: true, extras: ({ reuse }) => ({ accountReused: Boolean(reuse.accountReused) }) };

  // ────────────────────────────────── COLOMBIA ──
  const coOwnerFijo = /^(on|1|true)$/i.test(e("VICKY_CO_OWNER_FIJO"));
  const coOwnerId = e("VICKY_CO_OWNER_ID");
  const co = base("co");
  Object.assign(co, {
    etiquetaLog: "create-from-vicky-co",
    secretEnvs: ["VICKY_COTIZADORA_SECRET_CO", "VICKY_COTIZADORA_SECRET"],
    territorio: e("VICKY_TERRITORIO_CO") || "Colombia",
    monedaDeal: e("VICKY_MONEDA_CO") || "COP",
    documento: {
      etiqueta: "NIT",
      validar: null,
      variantes: doc.getNitVariants,
      // Convención CO: la CUENTA guarda el NIT sin DV; la cotización, crudo.
      paraCuenta: doc.nitParaGuardarCO,
      paraCotizacion: doc.identidad,
      paraLead: doc.nitParaGuardarCO,
      paraCreator: (d) => toText(d),
      enDeal: false,
      clave: doc.claveSoloDigitosK,
      claveCapa4: doc.claveSinSeparadores,
    },
    moneda: {
      campos: { total: "totalCOP", totalRef: null, precioUnitario: "precioUnitarioCOP", subtotal: "subtotalCOP" },
      validarItem: crearValidarItemPais({ precioUnitario: "precioUnitarioCOP", subtotal: "subtotalCOP", afecto: "afectoIva" }),
      ufCongelada: false,
      unidad: "COP",
      impuesto: 0.19,
      afecto: "afectoIva",
    },
  });
  co.deal.amount = (cot) => cot.totalCOP || undefined;
  co.deal.descripcionTotal = (cot) => `${cot.totalCOP} COP`;
  co.cuentas.esNoAdoptable = esCuentaInterna;
  co.owners.interino = coOwnerFijo && coOwnerId ? { id: coOwnerId } : { id: VICKY_USER_ID };
  co.owners.noHeredables = new Set(SDR_CO_IDS);
  co.owners.adoptables = new Set([VICKY_USER_ID, GORDILLO_ID, ...SDR_CO_IDS]);
  co.subform = {
    prepararItems: (items) => require("../quote-pricing").quitarFilaActivacion(items, "create-from-vicky-co"),
    construir: (items) => subform.buildSubformItemsCO(items),
  };
  co.descuento = { motor: "escalera_simple", escribirSiempre: false };
  co.pdf = {
    opciones: { format: "Letter", margin: "0" },
    construir: ({ cliente, items, acceptanceUrl, cotizacionId, validezHasta, descuentos }) =>
      require("../proposal-html-builder-co").buildProposalHtmlCO({
        cliente: { empresa: cliente.empresa, contacto: cliente.contacto, nit: cliente.rutEmpresa },
        items, acceptanceUrl, cotizacionId, validezHasta, descuentos,
        mesesDescuento: require("../proposal-constants").MESES_DESCUENTO_PLAN,
      }),
  };
  co.correo.ccFijos = [];
  co.correo.ccPais = listaDeEnv(env.VICKY_CO_QUOTE_CC || "agordillo@geovictoria.com");
  co.correo.incluirBodyCc = false;
  co.correo.adjuntoPdf = false;
  co.correo.tolerarFallo = true;
  co.correo.plantilla = crearPlantillaCorreoCL({
    fromEmail: comun.fromEmail,
    docs: { certificacion: DOC_CERTIFICACION, fichaReloj: "", presentacion: DOC_PRESENTACION },
  });
  co.correo.ejecutivoFijo = { nombre: "Alejandro Gordillo", email: "agordillo@geovictoria.com" };
  co.creator = {
    overrides: { moneda: "COP", pais: "Colombia" },
    escaleras: () => require("../escaleras-pais").ESCALERA_ASISTENCIA_CO,
    motivo: "emision-co",
    notaHardwareUsd: false,
  };
  co.token = { pais: "co" };
  co.mensajes = { faltanCampos: "Faltan campos: empresa, contacto, nit", itemsRequerido: "items requerido (no vacío)" };
  co.respuesta = { linkCortoEnReintento: true, extras: ({ reuse }) => ({ accountReused: Boolean(reuse.accountReused) }) };
  // Camino A (convertir el lead vivo primero) GATEADO en CO: env o kv
  // co_convert_first=on (apagado por defecto).
  co.flags.convertFirst = async () => {
    if (String(env.VICKY_CO_CONVERT_FIRST || "").trim() === "on") return true;
    try {
      return (await require("../idempotencia").getKvFlag("co_convert_first")) === "on";
    } catch {
      return false;
    }
  };

  // ────────────────────────────────── MÉXICO ──
  const mxOwnerFijo = /^(on|1|true)$/i.test(e("VICKY_MX_OWNER_FIJO"));
  const mxOwnerId = e("VICKY_MX_OWNER_ID") || YAHEL_ID;
  const mx = base("mx");
  Object.assign(mx, {
    etiquetaLog: "create-from-vicky-mx",
    secretEnvs: ["VICKY_COTIZADORA_SECRET_MX", "VICKY_COTIZADORA_SECRET"],
    territorio: e("VICKY_TERRITORIO_MX") || "México",
    monedaDeal: e("VICKY_MONEDA_MX") || "MXN",
    documento: {
      etiqueta: "RFC",
      // Solo advierte (misma tolerancia que CO con el NIT).
      validar: (d) => ({ ok: true, advertencia: doc.rfcPareceValido(d) ? "" : `RFC con formato inusual: '${d}'` }),
      variantes: doc.getRfcVariants,
      paraCuenta: doc.identidad,
      paraCotizacion: doc.identidad,
      paraLead: doc.identidad,
      paraCreator: (d) => toText(d),
      enDeal: false,
      clave: doc.claveSinSeparadores,
      claveCapa4: doc.claveSinSeparadores,
    },
    moneda: {
      campos: { total: "totalMXN", totalRef: null, precioUnitario: "precioUnitarioMXN", subtotal: "subtotalMXN" },
      validarItem: crearValidarItemPais({ precioUnitario: "precioUnitarioMXN", subtotal: "subtotalMXN", afecto: "afectoIva" }),
      ufCongelada: false,
      unidad: "MXN",
      impuesto: 0.16,
      afecto: "afectoIva",
    },
  });
  mx.deal.amount = () => undefined; // MX no escribe Amount
  mx.deal.descripcionTotal = (cot) => `${cot.totalMXN} MXN`;
  mx.cuentas.esNoAdoptable = esCuentaInterna;
  mx.owners.interino = mxOwnerFijo ? { id: mxOwnerId } : { id: VICKY_USER_ID };
  mx.owners.noHeredables = new Set(listaDeEnv(env.VICKY_SDR_MX_IDS || "3525045000391904256,3525045000434395001"));
  mx.owners.adoptables = new Set([VICKY_USER_ID, YAHEL_ID]);
  mx.subform = {
    prepararItems: (items) => subform.ensureCapacitacionMX(items),
    construir: (items) => subform.buildSubformItemsMX(items),
  };
  mx.descuento = { motor: "escalera_simple", escribirSiempre: false };
  mx.pdf = {
    opciones: { format: "Letter", margin: "0" },
    construir: ({ cliente, items, acceptanceUrl, cotizacionId, validezHasta, descuentos }) =>
      require("../proposal-html-builder-mx").buildProposalHtmlMX({
        cliente: { empresa: cliente.empresa, contacto: cliente.contacto, rfc: cliente.rutEmpresa },
        items, acceptanceUrl, cotizacionId, validezHasta, descuentos,
        mesesDescuento: require("../proposal-constants").MESES_DESCUENTO_PLAN,
      }),
  };
  // MX: plantilla PROPIA (botón al PDF, ejecutivo fijo EJEC_MX) — hoy vive en
  // el endpoint MX; se carga perezosa para no acoplar la ficha al endpoint.
  mx.correo.plantilla = (args) =>
    require("../../quote-acceptance/create-from-vicky-mx").buildEmailHtmlMX({
      contacto: args.contacto, empresa: args.empresa, pdfUrl: args.pdfUrl, tieneReloj: args.tieneReloj,
    });
  // CC y reply-to al ejecutivo MX (EJEC_MX del builder MX) + copias fijas + body.cc.
  const ejecMxEmail = e("VICKY_EJECUTIVO_EMAIL_MX") || "ysegura@geovictoria.com";
  mx.correo.ccPais = [ejecMxEmail];
  mx.correo.adjuntoPdf = false;
  mx.correo.tolerarFallo = true;
  mx.correo.ejecutivoFijo = { nombre: e("VICKY_EJECUTIVO_NOMBRE_MX") || "Yahel Segura", email: ejecMxEmail };
  mx.creator = {
    overrides: { moneda: "MXN", pais: "México" },
    escaleras: () => require("../escaleras-pais").ESCALERA_ASISTENCIA_MX,
    motivo: "emision-mx",
    notaHardwareUsd: false,
  };
  mx.token = { pais: "mx" };
  mx.mensajes = { faltanCampos: "Faltan campos: empresa, contacto, rfc", itemsRequerido: "items requerido (no vacío)" };
  mx.respuesta = {
    linkCortoEnReintento: true,
    extras: ({ descuentos, reuse }) => ({ accountReused: Boolean(reuse.accountReused), descuentoPlanPct: descuentos.recurrentePct }),
  };

  return { cl, pe, co, mx };
}

const FICHAS = construirFichas(process.env);

function fichaDePais(pais) {
  const f = FICHAS[String(pais || "").toLowerCase()];
  if (!f) throw new Error(`Sin ficha de emisión para el país '${pais}'`);
  return f;
}

module.exports = {
  construirFichas,
  fichaDePais,
  FICHA_CL: FICHAS.cl,
  FICHA_PE: FICHAS.pe,
  FICHA_CO: FICHAS.co,
  FICHA_MX: FICHAS.mx,
  IDS: { VICKY_USER_ID, GEOVICTORIA_ADMIN_ID, GORDILLO_ID, YAHEL_ID, MONICA_ID, SDR_CL_IDS, SDR_PE_IDS, SDR_CO_IDS },
  DOCS: { DOC_CERTIFICACION, DOC_FICHA_RELOJ, DOC_PRESENTACION },
};
