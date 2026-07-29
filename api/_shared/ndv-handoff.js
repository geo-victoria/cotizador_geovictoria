const {
  getRecord,
  createRecord,
  updateRecordBestEffort,
  searchRecords,
  getUserById,
  toText,
} = require("./zoho-crm");
const { getCreatorConfig, creatorApiFetch } = require("./zoho-creator-auth");
const { buildChargeTables } = require("./ndv-charge-table");

function toNumberOrNull(value) {
  const n = Number.parseInt(toText(value), 10);
  return Number.isFinite(n) ? n : null;
}

function toPositiveInt(value) {
  const n = Number.parseInt(toText(value), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toPositiveNumber(value) {
  const raw = toText(value).replace(/\./g, "").replace(",", ".");
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toSafeCreatorNumber(value) {
  const text = toText(value);
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return undefined;
  // Evita precision loss en IDs largos de Zoho (19 digitos).
  if (!Number.isSafeInteger(n)) return undefined;
  return n;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeEmail(value) {
  return toText(value).toLowerCase();
}

function normalizeItemName(value) {
  return toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const NDV_CANONICAL_SCHEMA_VERSION = "2026-04-20.1";

// Diccionario único de validación previa (sin depender de Creator para detectar faltantes básicos).
const NDV_CANONICAL_REQUIRED_FIELDS = [
  { key: "CRM_Account", label: "Cuenta asociada (CRM_Account)" },
  { key: "Correo_Vendedor", label: "Correo del ejecutivo comercial (Correo_Vendedor)" },
  { key: "Identificador_Tributario_Empresa", label: "RUT empresa (Identificador_Tributario_Empresa)" },
  { key: "Contact_Name", label: "Nombre de contacto" },
  { key: "Email", label: "Correo de contacto" },
];

const NDV_CANONICAL_ITEM_DICTIONARY = [
  { match: ["asistencia"], recurrente: ["Control de Asistencia"] },
  { match: ["alert"], recurrente: ["Alertas"] },
  { match: ["banco de horas"], recurrente: ["Bolsa de Horas de Desarrollo"] },
  { match: ["documental"], recurrente: ["Gestión Documental"] },
  { match: ["vacaciones", "permiso"], recurrente: ["Vacaciones"] },
  { match: ["calendario", "planificador"], recurrente: ["Calendario Inteligente"] },
  { match: ["connect"], recurrente: ["Integraciones Victoria Connect"] },
  { match: ["dashboard"], recurrente: ["Dashboard BI"] },
  { match: ["sso"], recurrente: ["SSO"] },
  { match: ["casino", "comedor"], recurrente: ["Servicio de Comedor"] },
  { match: ["reporte a medida"], recurrente: ["Reporte a Medida"] },
  { match: ["enrol"], noRecurrente: ["Enrolamiento en Terreno", "Visitas y Servicios Técnicos"] },
  { match: ["instal", "visita", "tecnic"], noRecurrente: ["Visitas y Servicios Técnicos"] },
  { match: ["capacit"], noRecurrenteConfigurado: ["Capacitaciones"] },
  { match: ["consultor"], noRecurrenteConfigurado: ["Consultoría TI"] },
  { match: ["homolog"], noRecurrenteConfigurado: ["Compatibilidad y Homologación"] },
  { match: ["desarrollo"], noRecurrente: ["Desarrollo", "Presupuesto Estimativo de Desarrollo"] },
];

class NdvBusinessError extends Error {
  constructor(userMessage, detail, code = "NDV_BUSINESS_ERROR") {
    super(userMessage);
    this.name = "NdvBusinessError";
    this.userMessage = toText(userMessage) || "No se pudo crear la cotización.";
    this.detail = toText(detail);
    this.code = code;
  }
}

function normalizeCreatorBusinessError(detailText) {
  const detail = toText(detailText);
  const normalized = detail.toLowerCase();
  if (!detail) return "Creator respondió un error sin detalle.";

  if (normalized.includes("cantidad_de_usuarios_pdf")) {
    return "Falta la cantidad de usuarios comprometidos para crear la cotización en Creator.";
  }
  if (normalized.includes("identificador_tributario_empresa")) {
    return "Falta el RUT empresa para crear la cotización en Creator.";
  }
  if (normalized.includes("tabla de cobro") || normalized.includes("tabla_de_cobro")) {
    return "Falta completar la tabla de cobro en Creator.";
  }
  if (normalized.includes("invalid data")) {
    return "Creator rechazó la cotización por datos inválidos. Revisa los campos obligatorios.";
  }
  if (normalized.includes("required")) {
    return "Faltan campos obligatorios para crear la cotización en Creator.";
  }
  return detail;
}

function prevalidateNdvRecord(ndvRecord) {
  const missing = NDV_CANONICAL_REQUIRED_FIELDS.filter((field) => !toText(ndvRecord?.[field.key]));
  if (missing.length > 0) {
    throw new NdvBusinessError(
      `Faltan datos obligatorios para crear la cotización: ${missing.map((m) => m.label).join(", ")}.`,
      `schema_version=${NDV_CANONICAL_SCHEMA_VERSION}; missing=${missing.map((m) => m.key).join(",")}`,
      "NDV_PREVALIDATION_FAILED"
    );
  }

  const employees = toPositiveInt(ndvRecord?.N_Empleados_Compometidos);
  if (employees <= 0) {
    throw new NdvBusinessError(
      "Falta el N° de empleados comprometidos para crear la cotización.",
      `schema_version=${NDV_CANONICAL_SCHEMA_VERSION}; missing=N_Empleados_Compometidos`,
      "NDV_PREVALIDATION_FAILED"
    );
  }

  const table = safeArray(ndvRecord?.Tabla_de_Cobro);
  if (table.length === 0) {
    throw new NdvBusinessError(
      "Falta completar la tabla de cobro para crear la cotización.",
      `schema_version=${NDV_CANONICAL_SCHEMA_VERSION}; missing=Tabla_de_Cobro`,
      "NDV_PREVALIDATION_FAILED"
    );
  }

  const invalidRow = table.find((row) => {
    const modalidad = toText(row?.Modalidad);
    const desde = toPositiveInt(row?.Desde);
    const hasta = toPositiveInt(row?.Hasta);
    const valor = toPositiveNumber(row?.Valor);
    return !modalidad || desde <= 0 || hasta <= 0 || valor <= 0;
  });
  if (invalidRow) {
    throw new NdvBusinessError(
      "La tabla de cobro tiene datos incompletos o inválidos.",
      `schema_version=${NDV_CANONICAL_SCHEMA_VERSION}; invalid_row=${JSON.stringify(invalidRow)}`,
      "NDV_PREVALIDATION_FAILED"
    );
  }
}

function prevalidateDraftInput({ proposalData, deal, account }) {
  const rows = proposalDataToQuoteRows(proposalData);
  if (!rows.length) {
    throw new NdvBusinessError(
      "Agrega al menos un ítem con cantidad mayor a 0 antes de crear la cotización.",
      "No hay items válidos en proposalData.",
      "NDV_PREVALIDATION_FAILED"
    );
  }

  const companyRut = toText(
    proposalData?.rutEmpresa ||
      deal?.RUT_Empresa ||
      deal?.RUT_Cliente ||
      deal?.RUT ||
      deal?.Rut ||
      deal?.Identificador_Tributario_Empresa ||
      account?.RUT_Empresa ||
      account?.RUT_Cliente ||
      account?.RUT ||
      account?.Rut ||
      account?.Identificador_Tributario_Empresa ||
      ""
  );
  if (!companyRut) {
    throw new NdvBusinessError(
      "Debes completar el RUT empresa antes de crear la cotización.",
      "No se resolvió RUT empresa desde deal/account/proposalData.",
      "NDV_PREVALIDATION_FAILED"
    );
  }
}

function resolveCreatorMappingFromDictionary(normalizedItemName) {
  const result = {
    recurrente: new Set(),
    noRecurrente: new Set(),
    noRecurrenteConfigurado: new Set(),
  };
  for (const rule of NDV_CANONICAL_ITEM_DICTIONARY) {
    const keywords = Array.isArray(rule.match) ? rule.match : [];
    if (!keywords.some((keyword) => normalizedItemName.includes(keyword))) continue;
    safeArray(rule.recurrente).forEach((label) => result.recurrente.add(label));
    safeArray(rule.noRecurrente).forEach((label) => result.noRecurrente.add(label));
    safeArray(rule.noRecurrenteConfigurado).forEach((label) => result.noRecurrenteConfigurado.add(label));
  }
  return result;
}

// NDV dictionary mapping (cotizadora -> Creator) lives in this module.

const CREATOR_SERVICIOS_RECURRENTES_ALLOWED = new Set([
  "Control de Asistencia",
  "Control de Acceso",
  "Servicio de Comedor",
  "Dashboard BI",
  "Vacaciones",
  "Gesti\u00f3n Documental",
  "Integraciones Victoria Connect",
  "Reporte a Medida",
  "Calendario Inteligente",
  "SSO",
  "Alertas",
  "Bolsa de Horas de Desarrollo",
]);

// Nombre del servicio con el que Creator titula el bloque de arriendo en la NDV
// ("2º Arriendo de Equipos" en las notas de venta de referencia).
const SERVICIO_ARRIENDO_EQUIPOS = "Arriendo de Equipos";

const CREATOR_SERVICIO_RECURRENTE_CONFIG_ALLOWED = new Set([
  ...Array.from(CREATOR_SERVICIOS_RECURRENTES_ALLOWED),
  "Arriendo de Equipos",
  "Arriendo de Equipos Asistencia",
  "Arriendo de Chip de Datos",
]);

const CREATOR_SERVICIOS_NO_RECURRENTES_ALLOWED = new Set([
  "Venta de Equipos Asistencia",
  "Venta de Equipos Comedor",
  "Venta de Kit de Acceso",
  "Repuestos",
  "Presupuesto Estimativo de Desarrollo",
  "Desarrollo",
  "Visitas y Servicios T\u00e9cnicos",
  "Enrolamiento en Terreno",
]);

const CREATOR_SERVICIO_NO_RECURRENTE_CONFIG_ALLOWED = new Set([
  ...Array.from(CREATOR_SERVICIOS_NO_RECURRENTES_ALLOWED),
  "Visita T\u00e9cnica",
  "Compatibilidad y Homologaci\u00f3n",
  "Capacitaciones",
  "Recursos Adicionales",
  "Consultor\u00eda TI",
]);

// Regla alineada con Creator (BusinessLine = Telemarketing para este MVP):
// para ciertos servicios el hito permitido es "Adelantado"; en el resto, "Otro".
const CREATOR_TELEMARKETING_ADELANTADO_SERVICES = new Set([
  "Control de Asistencia",
  "Control de Acceso",
  "Servicio de Comedor",
  "Dashboard BI",
  "Vacaciones",
  "Gesti\u00f3n Documental",
  "Calendario Inteligente",
  "SSO",
  "Marcaje WhatsApp",
  "App Supervisor",
  "Proyectos y Tareas",
  "Alertas",
  "Plan Starter",
  "Plan Pro",
  "Arriendo de Equipos Asistencia",
  "Arriendo de Chip de Datos",
  "Venta de Equipos Asistencia",
  "Venta de Kit de Acceso",
  "Venta de Equipos Comedor",
]);

function inferBillingMilestoneForTelemarketing(servicioRecurrente) {
  const service = toText(servicioRecurrente);
  if (!service) return "Otro";
  return CREATOR_TELEMARKETING_ADELANTADO_SERVICES.has(service) ? "Adelantado" : "Otro";
}

function addAllowed(targetSet, label, allowedSet) {
  const text = toText(label);
  if (text && allowedSet.has(text)) targetSet.add(text);
}

/**
 * Servicios recurrentes de Creator a los que mapea el nombre de una línea del
 * subform, en orden de precedencia (el primero es el titular del cobro).
 *
 * Fuente única: la usan tanto la lista Servicios_Recurrentes del registro como
 * la Tabla_de_Cobro (ndv-charge-table), para que el servicio que aparece en la
 * NDV y el que lleva el precio no puedan divergir.
 */
function recurrentesDeFilaPorNombre(normalizedItemName) {
  const labels = [];
  const push = (label) => {
    if (label && !labels.includes(label)) labels.push(label);
  };

  resolveCreatorMappingFromDictionary(normalizedItemName).recurrente.forEach((label) => push(label));

  if (normalizedItemName.includes("asistencia")) push("Control de Asistencia");
  else if (normalizedItemName.includes("alert")) push("Alertas");
  else if (normalizedItemName.includes("banco de horas")) push("Bolsa de Horas de Desarrollo");
  else if (normalizedItemName.includes("documental")) push("Gestión Documental");
  else if (normalizedItemName.includes("vacaciones") || normalizedItemName.includes("permiso")) push("Vacaciones");
  else if (normalizedItemName.includes("calendario") || normalizedItemName.includes("planificador"))
    push("Calendario Inteligente");
  else if (normalizedItemName.includes("connect")) push("Integraciones Victoria Connect");
  else if (normalizedItemName.includes("dashboard")) push("Dashboard BI");
  else if (normalizedItemName.includes("sso")) push("SSO");
  else if (normalizedItemName.includes("casino") || normalizedItemName.includes("comedor"))
    push("Servicio de Comedor");
  else if (normalizedItemName.includes("reporte a medida")) push("Reporte a Medida");

  return labels.filter((label) => CREATOR_SERVICIOS_RECURRENTES_ALLOWED.has(label));
}

/**
 * Servicio de Creator que se lleva el cobro de una fila del subform.
 *
 * Se diferencia de recurrentesDeFilaPorNombre en que mira también la modalidad:
 * el arriendo de hardware es un Servicio_Recurrente más en Creator (bloque
 * "Arriendo de Equipos" de la NDV), aunque en el registro maestro viva en
 * Servicio_Recurrente_Configurado y no en la lista Servicios_Recurrentes —
 * ese picklist no lo acepta.
 */
function resolveServiciosRecurrentesDeFila(row) {
  const modalidad = normalizeItemName(row?.Modalidad);
  if (modalidad.includes("arriendo")) return [SERVICIO_ARRIENDO_EQUIPOS];

  const name = normalizeItemName(row?.Nombre_Item);
  if (!name) return [];
  return recurrentesDeFilaPorNombre(name);
}

function inferServiciosCreator(quote, config) {
  const rows = Array.isArray(quote?.[config.quoteItemsSubformField]) ? quote[config.quoteItemsSubformField] : [];
  const recurrentes = new Set();
  const recurrentesConfigurados = new Set();
  const noRecurrentes = new Set();
  const noRecurrentesConfigurados = new Set();

  const addRecurrente = (label) => {
    addAllowed(recurrentes, label, CREATOR_SERVICIOS_RECURRENTES_ALLOWED);
    addAllowed(recurrentesConfigurados, label, CREATOR_SERVICIO_RECURRENTE_CONFIG_ALLOWED);
  };
  const addRecurrenteConfigurado = (label) =>
    addAllowed(recurrentesConfigurados, label, CREATOR_SERVICIO_RECURRENTE_CONFIG_ALLOWED);
  const addNoRecurrente = (label) => {
    addAllowed(noRecurrentes, label, CREATOR_SERVICIOS_NO_RECURRENTES_ALLOWED);
    addAllowed(noRecurrentesConfigurados, label, CREATOR_SERVICIO_NO_RECURRENTE_CONFIG_ALLOWED);
  };
  const addNoRecurrenteConfigurado = (label) =>
    addAllowed(noRecurrentesConfigurados, label, CREATOR_SERVICIO_NO_RECURRENTE_CONFIG_ALLOWED);

  for (const row of rows) {
    const qty = Number(row?.Cantidad || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const name = normalizeItemName(row?.Nombre_Item);
    const modalidad = normalizeItemName(row?.Modalidad);
    if (!name) continue;

    const mapped = resolveCreatorMappingFromDictionary(name);
    mapped.noRecurrente.forEach((label) => addNoRecurrente(label));
    mapped.noRecurrenteConfigurado.forEach((label) => addNoRecurrenteConfigurado(label));

    recurrentesDeFilaPorNombre(name).forEach((label) => addRecurrente(label));

    if (modalidad.includes("arriendo")) {
      addRecurrenteConfigurado("Arriendo de Equipos");
      addRecurrenteConfigurado("Arriendo de Equipos Asistencia");
    } else if (modalidad.includes("venta")) {
      addNoRecurrente("Venta de Equipos Asistencia");
    }

    if (
      name.includes("enrol") ||
      name.includes("instal") ||
      name.includes("visita") ||
      name.includes("tecnic")
    ) {
      addNoRecurrente("Visitas y Servicios T\u00e9cnicos");
      if (name.includes("enrol")) addNoRecurrente("Enrolamiento en Terreno");
    }

    if (name.includes("capacit")) addNoRecurrenteConfigurado("Capacitaciones");
    if (name.includes("consultor")) addNoRecurrenteConfigurado("Consultor\u00eda TI");
    if (name.includes("homolog")) addNoRecurrenteConfigurado("Compatibilidad y Homologaci\u00f3n");
    if (name.includes("desarrollo")) {
      addNoRecurrente("Desarrollo");
      addNoRecurrente("Presupuesto Estimativo de Desarrollo");
    }
  }

  if (recurrentes.size === 0) {
    addRecurrente("Control de Asistencia");
  }

  return {
    serviciosRecurrentes: Array.from(recurrentes),
    servicioRecurrenteConfigurado: Array.from(recurrentesConfigurados),
    serviciosNoRecurrentes: Array.from(noRecurrentes),
    servicioNoRecurrenteConfigurado: Array.from(noRecurrentesConfigurados),
  };
}

function inferServiciosRecurrentes(quote, config) {
  const rows = Array.isArray(quote?.[config.quoteItemsSubformField]) ? quote[config.quoteItemsSubformField] : [];
  const selected = new Set();
  const allowed = new Set([
    "Control de Asistencia",
    "Control de Acceso",
    "Servicio de Comedor",
    "Dashboard BI",
    "Vacaciones",
    "Gestión Documental",
    "Integraciones Victoria Connect",
    "Reporte a Medida",
    "Calendario Inteligente",
    "SSO",
    "Alertas",
    "Bolsa de Horas de Desarrollo",
  ]);

  const pushLabel = (label) => {
    const text = toText(label);
    if (text && allowed.has(text)) selected.add(text);
  };

  for (const row of rows) {
    const qty = Number(row?.Cantidad || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const name = normalizeItemName(row?.Nombre_Item);
    if (!name) continue;

    const mapped = resolveCreatorMappingFromDictionary(name);
    if (mapped.recurrente.size > 0) {
      mapped.recurrente.forEach((label) => pushLabel(label));
    }

    if (name.includes("asistencia")) pushLabel("Control de Asistencia");
    else if (name.includes("alert")) pushLabel("Alertas");
    else if (name.includes("banco de horas")) pushLabel("Bolsa de Horas de Desarrollo");
    else if (name.includes("documental")) pushLabel("Gestión Documental");
    else if (name.includes("vacaciones") || name.includes("permiso")) pushLabel("Vacaciones");
    else if (name.includes("calendario") || name.includes("planificador")) pushLabel("Calendario Inteligente");
    else if (name.includes("connect")) pushLabel("Integraciones Victoria Connect");
    else if (name.includes("dashboard")) pushLabel("Dashboard BI");
    else if (name.includes("sso")) pushLabel("SSO");
    else if (name.includes("casino") || name.includes("comedor")) pushLabel("Servicio de Comedor");
    else if (name.includes("reporte a medida")) pushLabel("Reporte a Medida");
  }

  if (selected.size === 0) {
    // Fallback para cumplir validación mínima de Creator.
    pushLabel("Control de Asistencia");
  }

  return Array.from(selected);
}

function inferCommittedEmployees(quote) {
  const fromFields = [
    quote?.N_Empleados_Compometidos,
    quote?.N_Empleados_Comprometidos,
    quote?.Cantidad_de_Usuarios,
    quote?.N_Empleados_que_marcan,
    quote?.Total_Trabajadores,
  ]
    .map((value) => toPositiveInt(value))
    .find((value) => value > 0);
  if (fromFields) return fromFields;

  const rows = safeArray(quote?.Detalle_Items_Cotizacion).length
    ? safeArray(quote?.Detalle_Items_Cotizacion)
    : safeArray(quote?.items);
  const asistenciaRow = rows.find((row) => normalizeItemName(row?.Nombre_Item).includes("asistencia"));
  const asistenciaQty = toPositiveInt(asistenciaRow?.Cantidad);
  if (asistenciaQty > 0) return asistenciaQty;

  const maxQty = rows.reduce((acc, row) => Math.max(acc, toPositiveInt(row?.Cantidad)), 0);
  return maxQty > 0 ? maxQty : 0;
}

// La Tabla_de_Cobro se arma en ndv-charge-table.js a partir de TODAS las líneas
// del subform, en la moneda del registro y con los descuentos ya aplicados.

function formatCreatorDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
}

function resolveCreatedCreatorId(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = toText(payload?.data?.ID || payload?.data?.id || payload?.ID || payload?.id);
  if (direct) return direct;
  for (const row of safeArray(payload?.data)) {
    const id = toText(row?.ID || row?.id || row?.details?.ID || row?.details?.id);
    if (id) return id;
  }
  return "";
}

function resolveCreatorRecordFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  for (const row of safeArray(payload.data)) {
    if (row && typeof row === "object") {
      if (row.data && typeof row.data === "object") return row.data;
      return row;
    }
  }
  return null;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function isCreatorBusinessError(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.error && typeof payload.error === "object" && Object.keys(payload.error).length > 0) {
    return true;
  }
  const code = Number.parseInt(toText(payload.code), 10);
  if (Number.isFinite(code) && code !== 3000) {
    return true;
  }
  return false;
}

function creatorErrorMessage(payload, fallback) {
  const normalizeErrorValue = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return toText(value);
    if (Array.isArray(value)) {
      return value
        .map((item) => normalizeErrorValue(item))
        .filter(Boolean)
        .join(" / ");
    }
    if (typeof value === "object") {
      const parts = Object.entries(value)
        .map(([k, v]) => `${toText(k)}=${normalizeErrorValue(v)}`)
        .filter(Boolean);
      if (parts.length > 0) return parts.join(", ");
      try {
        return JSON.stringify(value);
      } catch (_error) {
        return String(value);
      }
    }
    return toText(value);
  };

  if (!payload || typeof payload !== "object") return fallback;
  if (payload.error && typeof payload.error === "object") {
    const entries = Object.entries(payload.error)
      .map(([k, v]) => `${k}: ${normalizeErrorValue(v)}`)
      .filter(Boolean);
    if (entries.length > 0) return entries.join(" | ");
  }
  return toText(payload.message || payload.code || payload.raw || fallback);
}

function buildCreatorPath(config) {
  return `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/form/${encodeURIComponent(config.formLinkName)}`;
}

function buildCreatorUpdatePath(config, recordId) {
  return `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/report/${encodeURIComponent(config.reportLinkName)}/${encodeURIComponent(toText(recordId))}`;
}

function candidateFormLinkNames(config, preferredForms) {
  const seen = new Set();
  const push = (value) => {
    const text = toText(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
  };
  safeArray(preferredForms).forEach((value) => push(value));
  push(config?.formLinkName);
  push("Nota_de_Venta");
  push("Servicio_Recurrente");
  push("Formulario");
  return Array.from(seen);
}

function getPreferredCreatorForms(config) {
  return candidateFormLinkNames(config, ["Servicio_Recurrente", config?.formLinkName, "Nota_de_Venta"]);
}

async function createNdvWithFormFallback({
  creatorConfig,
  ndvRecord,
  preferredForms,
  stopOnFirstFailure = false,
}) {
  let lastResponse = null;
  let lastPayload = {};
  const attemptedForms = [];

  for (const formLinkName of candidateFormLinkNames(creatorConfig, preferredForms)) {
    attemptedForms.push(formLinkName);
    const scopedConfig = { ...creatorConfig, formLinkName };
    const createPath = buildCreatorPath(scopedConfig);
    const createResp = await creatorApiFetch(createPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: ndvRecord }),
    });
    const createPayload = await readJsonSafe(createResp);

    lastResponse = createResp;
    lastPayload = createPayload;

    if (createResp.ok && !isCreatorBusinessError(createPayload)) {
      return {
        ok: true,
        response: createResp,
        payload: createPayload,
        usedFormLinkName: formLinkName,
        attemptedForms,
      };
    }

    if (stopOnFirstFailure) {
      break;
    }
  }

  return {
    ok: false,
    response: lastResponse,
    payload: lastPayload,
    usedFormLinkName: "",
    attemptedForms,
  };
}

async function ensureBillingContactId({
  accountId,
  billingEmail,
  billingPhone,
  accountName,
  quoteContactName,
  quoteContactEmail,
}) {
  const normalizedBillingEmail = normalizeEmail(billingEmail);
  if (!normalizedBillingEmail) return "";

  const candidates = await searchRecords("Contacts", `(Email:equals:${normalizedBillingEmail})`, [
    "id",
    "Account_Name",
    "Email",
  ]);
  const accountMatch = safeArray(candidates).find(
    (row) => toText(row?.Account_Name?.id) && toText(row?.Account_Name?.id) === toText(accountId)
  );
  const first = accountMatch || safeArray(candidates)[0];
  if (first?.id) {
    return toText(first.id);
  }

  const labelBase = toText(quoteContactName) || toText(accountName) || "Contacto";
  const clean = labelBase.replace(/\s+/g, " ").trim();
  const pieces = clean.split(" ");
  const firstName = pieces.length > 1 ? pieces.slice(0, -1).join(" ") : "";
  const lastName = pieces.length > 0 ? pieces[pieces.length - 1] : "Facturacion";

  const createMap = {
    First_Name: firstName || undefined,
    Last_Name: lastName || "Facturacion",
    Email: normalizedBillingEmail,
    Phone: toText(billingPhone),
    Mobile: toText(billingPhone),
    Account_Name: accountId ? { id: accountId } : undefined,
    Description: "Creado automaticamente desde aceptacion digital de cotizacion.",
  };
  const created = await createRecord("Contacts", createMap, true);
  const createdId = toText(created?.id);
  if (!createdId) return "";

  // Intenta mantener consistencia del contacto con datos comerciales cuando existan.
  const patchMap = {
    Full_Name: toText(quoteContactName),
    Email_Alt: normalizeEmail(quoteContactEmail) || undefined,
  };
  try {
    await updateRecordBestEffort("Contacts", createdId, patchMap, true);
  } catch (_error) {
    // Best effort.
  }
  return createdId;
}

function buildNdvRecord({
  config,
  quote,
  deal,
  account,
  contact,
  ownerUser,
  billingContactId,
  acceptanceData,
  overrides,
  escalerasPrecio,
}) {
  const creatorOverrides = overrides && typeof overrides === "object" ? overrides : {};
  const creatorFormulario = toText(creatorOverrides.formulario) || "Nota de Venta";
  const creatorStatus =
    toText(creatorOverrides.status) || config.ndvCreatorStatusPending || "PENDIENTE";
  const creatorFormStatus =
    toText(creatorOverrides.formStatus) || config.ndvCreatorFormStatusPending || "CREATED";
  const creatorEstadoCot =
    toText(creatorOverrides.estadoCot) || toText(config.ndvCreatorEstadoCotAccepted);
  const includeCrmDeal = creatorOverrides.includeCrmDeal !== false;
  const forcedBillingMilestone = toText(creatorOverrides.hitoFacturacion);

  const accountId = toText(account?.id || quote?.CRM_Account?.id || deal?.Account_Name?.id);
  const contactId = toText(contact?.id || quote?.CONTACT_ID || quote?.[config.quoteContactLookupField]?.id);
  const dealName = toText(deal?.Deal_Name || quote?.CRM_Deal);
  const accountName = toText(account?.Account_Name || quote?.CRM_ACCOUNT_NAME || deal?.Account_Name?.name);
  const contactName = toText(contact?.Full_Name || quote?.Contact_Name || quote?.Contacto_CRM);
  const contactEmail = normalizeEmail(
    quote?.[config.contactEmailField] || contact?.Email || acceptanceData?.contactEmail
  );
  const contactPhone = toText(quote?.[config.contactPhoneField] || contact?.Phone || contact?.Mobile);
  const sellerEmail = normalizeEmail(
    quote?.Correo_Vendedor ||
      quote?.Email_Ejecutivo ||
      deal?.Correo_Vendedor ||
      ownerUser?.email ||
      ownerUser?.Email
  );
  const servicios = inferServiciosCreator(quote, config);
  const committedEmployees = inferCommittedEmployees(quote);
  const firstServicio = toText(servicios.serviciosRecurrentes[0]) || "Control de Asistencia";
  const moneda = toText(quote?.Moneda) || "UF";

  // La tabla se construye con la MISMA moneda que declara el registro: mandarla
  // en pesos con Moneda=UF es lo que inflaba el PDF ~39.000x.
  const chargeTables = buildChargeTables({
    quote,
    config,
    committedEmployees,
    moneda,
    servicioPrincipal: firstServicio,
    resolveServicios: resolveServiciosRecurrentesDeFila,
    escalerasEnMemoria: escalerasPrecio,
  });
  const chargeTable = chargeTables.master;
  const resolvedBusinessLine = "Estándar";
  const resolvedBillingMilestone = inferBillingMilestoneForTelemarketing(firstServicio);
  const dealsAsociados =
    toText(quote?.Deals_Asociados) ||
    toText(deal?.Deal_Name) ||
    (toText(accountName) ? `${toText(accountName)} (${firstServicio})` : "");

  const record = {
    Formulario: creatorFormulario,
    STATUS: creatorStatus,
    FORM_STATUS: creatorFormStatus,
    ...(creatorEstadoCot ? { ESTADO_COT: creatorEstadoCot } : {}),
    Nombre_del_documento: `${accountName || "Cuenta"} / ${new Date().toISOString().slice(0, 10)}`,
    CRM_Account: accountId || undefined,
    ID_CRM_ACCOUNT: toSafeCreatorNumber(accountId),
    CRM_ACCOUNT_NAME: accountName || undefined,
    Contact_Name: contactName || undefined,
    CONTACT_ID: toSafeCreatorNumber(contactId),
    Email: contactEmail || undefined,
    Tel_fono: contactPhone || undefined,
    Correo_Vendedor: sellerEmail || undefined,
    CRM_Deal: includeCrmDeal ? dealName || undefined : undefined,
    Deals_Asociados: dealsAsociados || undefined,
    CRM_REFERENCE_ID: toSafeCreatorNumber(quote?.id),
    Moneda: moneda,
    Pa_s_Facturaci_n: toText(quote?.Pa_s_Facturaci_n) || "Chile",
    Identificador_Tributario_Empresa:
      toText(acceptanceData?.companyRut || quote?.RUT_Cliente || quote?.RUT || quote?.Identificador_Tributario_Empresa) ||
      undefined,
    Linea_de_Negocio: resolvedBusinessLine,
    Servicio_Recurrente: firstServicio,
    Hito_de_Facturaci_n: forcedBillingMilestone || resolvedBillingMilestone || "Adelantado",
    // Estos picklists se resuelven en Creator por scripts internos y catálogos dinámicos.
    // Si enviamos un valor no compatible, Creator rechaza el alta con INVALID_DATA.
    Modalidad_de_Pago: toText(quote?.Modalidad_de_Pago) || undefined,
    Periodicidad_de_Servicio: toText(quote?.Periodicidad_de_Servicio) || undefined,
    Tipo_de_Facturaci_n: toText(quote?.Tipo_de_Facturaci_n) || undefined,
    N_Empleados_Compometidos: committedEmployees || undefined,
    Cantidad_de_Usuarios_PDF: committedEmployees || undefined,
    Cantidad_de_Usuarios: committedEmployees || undefined,
    Plantilla_Tabla_de_Cobro: "Sin Plantilla",
    Tabla_de_Cobro: chargeTable,
    Servicios_Recurrentes: servicios.serviciosRecurrentes,
    Servicio_Recurrente_Configurado: servicios.servicioRecurrenteConfigurado,
    ...(servicios.serviciosNoRecurrentes.length > 0
      ? { Servicios_No_Recurrentes: servicios.serviciosNoRecurrentes }
      : {}),
    ...(servicios.servicioNoRecurrenteConfigurado.length > 0
      ? { Servicio_No_Recurrente_Configurado: servicios.servicioNoRecurrenteConfigurado }
      : {}),
    Fecha_de_creaci_n: formatCreatorDate(),
    fecha_uf_usd: formatCreatorDate(),
    Email_de_Facturacion:
      normalizeEmail(acceptanceData?.billingEmail || quote?.Email_Facturacion || quote?.Email_de_Facturacion) ||
      undefined,
    Tel_fono_de_Facturaci_n:
      toText(acceptanceData?.billingPhone || quote?.Telefono_Facturacion || quote?.Tel_fono_de_Facturaci_n) ||
      undefined,
  };

  // chargeTables viaja aparte del record: `record` es literalmente el payload
  // que se POSTea a Creator y no admite claves que no sean campos del formulario.
  return { record, chargeTables };
}

function pickFromLookup(value) {
  if (value && typeof value === "object") return value.id || value.ID || "";
  return value || "";
}

/**
 * Guarda en la cotización el ID del registro creado en Creator. Es lo que hace
 * idempotente al handoff: sin esta referencia, un reintento crea un duplicado.
 */
async function persistNdvReferences(config, quoteId, ndvId) {
  const normalizedNdvId = toText(ndvId);
  if (!normalizedNdvId || !quoteId) return;

  if (config.quoteNvdIdTextField) {
    try {
      await updateRecordBestEffort(
        config.quoteModule,
        quoteId,
        { [config.quoteNvdIdTextField]: normalizedNdvId },
        true
      );
    } catch (_error) {
      // best effort
    }
  }

  if (!config.quoteNvdLookupField) return;
  try {
    await updateRecordBestEffort(
      config.quoteModule,
      quoteId,
      { [config.quoteNvdLookupField]: { id: normalizedNdvId } },
      true
    );
  } catch (_firstError) {
    try {
      await updateRecordBestEffort(
        config.quoteModule,
        quoteId,
        { [config.quoteNvdLookupField]: normalizedNdvId },
        true
      );
    } catch (_secondError) {
      // best effort
    }
  }
}

/** ¿La cotización ya tiene un registro de Creator asociado? */
function quoteHasNdvReference(config, quoteRow) {
  const fromText = toText(config?.quoteNvdIdTextField ? quoteRow?.[config.quoteNvdIdTextField] : "");
  if (fromText) return true;

  if (!config?.quoteNvdLookupField) return false;
  const lookupValue = quoteRow?.[config.quoteNvdLookupField];
  if (lookupValue && typeof lookupValue === "object") {
    return Boolean(toText(lookupValue?.id || lookupValue?.ID || lookupValue?.name || lookupValue?.display_value));
  }
  return Boolean(toText(lookupValue));
}

/**
 * @param {object} [escalerasPrecio] Escalera de precios por Codigo_Item, en
 *   memoria. La usa la EMISIÓN (create-from-vicky), donde la escalera viene en
 *   el request y todavía no hace falta haberla persistido en el CRM.
 */
async function runNdvHandoff({ config, quoteId, dealId, acceptanceData, escalerasPrecio }) {
  const creatorConfig = getCreatorConfig();
  if (creatorConfig.missing.length > 0) {
    throw new Error(`Faltan variables de Zoho Creator: ${creatorConfig.missing.join(", ")}`);
  }

  const quote = await getRecord(config.quoteModule, quoteId);
  const resolvedDealId = toText(
    dealId || pickFromLookup(quote?.[config.quoteDealLookupField]) || quote?.CRM_Deal_ID
  );
  if (!resolvedDealId) {
    throw new Error("No se pudo resolver Deal asociado para handoff NDV.");
  }
  const deal = await getRecord("Deals", resolvedDealId);

  const accountId = toText(
    pickFromLookup(deal?.Account_Name) ||
      pickFromLookup(quote?.CRM_Account) ||
      pickFromLookup(quote?.[config.onboardingAccountLookupField])
  );
  if (!accountId) {
    throw new Error("No se pudo resolver Account para handoff NDV.");
  }
  const account = await getRecord("Accounts", accountId);

  const contactId = toText(
    pickFromLookup(deal?.Contact_Name) ||
      pickFromLookup(quote?.[config.quoteContactLookupField]) ||
      toText(quote?.CONTACT_ID)
  );
  const contact = contactId ? await getRecord("Contacts", contactId) : null;
  const ownerId = toText(pickFromLookup(deal?.Owner));
  const ownerUser = ownerId ? await getUserById(ownerId).catch(() => null) : null;

  const billingContactId = await ensureBillingContactId({
    accountId,
    billingEmail: acceptanceData?.billingEmail || quote?.[config.billingEmailField],
    billingPhone: acceptanceData?.billingPhone || quote?.[config.billingPhoneField],
    accountName: account?.Account_Name,
    quoteContactName: toText(contact?.Full_Name || quote?.Contact_Name || quote?.Contacto_CRM),
    quoteContactEmail: toText(contact?.Email || quote?.[config.contactEmailField]),
  });

  if (config.quoteBillingContactLookupField && billingContactId) {
    await updateRecordBestEffort(
      config.quoteModule,
      quoteId,
      { [config.quoteBillingContactLookupField]: { id: billingContactId } },
      true
    );
  }

  const { record: ndvRecord, chargeTables } = buildNdvRecord({
    config,
    quote,
    deal,
    account,
    contact,
    ownerUser,
    billingContactId,
    acceptanceData: acceptanceData || {},
    escalerasPrecio,
    // Vicky deja una COTIZACIÓN (editable). El maestro debe nacer como "Cotización"
    // para que CreateNextStep pueble Form_Order al crear los servicios. La
    // conversión a NDV y el confirmar quedan como paso humano posterior.
    overrides: {
      formulario: "Cotización",
      status: "BORRADOR",
      formStatus: "BEING EDITED",
      estadoCot: "Vigente",
      hitoFacturacion: "Cargando...",
    },
  });

  prevalidateNdvRecord(ndvRecord);

  if (!toText(ndvRecord.CRM_Account)) {
    throw new Error("No se pudo resolver Cuenta CRM (CRM_Account) para crear NDV.");
  }
  if (!toText(ndvRecord.Correo_Vendedor)) {
    throw new Error("No se pudo resolver Correo_Vendedor desde Owner del Deal.");
  }

  const createAttempt = await createNdvWithFormFallback({ creatorConfig, ndvRecord });
  const createResp = createAttempt.response;
  const createPayload = createAttempt.payload;
  if (!createAttempt.ok) {
    const creatorDetail = creatorErrorMessage(createPayload, "respuesta invalida");
    throw new NdvBusinessError(
      normalizeCreatorBusinessError(creatorDetail),
      `Creator create NDV failed (${createResp?.status || 0}) [forms=${createAttempt.attemptedForms.join(", ")}]: ${creatorDetail}`,
      "NDV_CREATOR_CREATE_FAILED"
    );
  }

  const ndvCreatorId = resolveCreatedCreatorId(createPayload);
  if (!ndvCreatorId) {
    return {
      ndvCreated: true,
      ndvId: "",
      reconciled: false,
      createPayload,
      chargeTables,
      message: "NDV creada sin ID devuelto por Creator.",
    };
  }

  const reconcileMap = {
    CRM_Account: ndvRecord.CRM_Account,
    ID_CRM_ACCOUNT: ndvRecord.ID_CRM_ACCOUNT,
    CRM_Deal: ndvRecord.CRM_Deal,
    Deals_Asociados: ndvRecord.Deals_Asociados,
    CRM_REFERENCE_ID: ndvRecord.CRM_REFERENCE_ID,
  };

  const updatePath = buildCreatorUpdatePath(creatorConfig, ndvCreatorId);
  const updateResp = await creatorApiFetch(updatePath, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: reconcileMap }),
  });
  const updatePayload = await readJsonSafe(updateResp);
  const reconciled = updateResp.ok && !isCreatorBusinessError(updatePayload);

  return {
    ndvCreated: true,
    ndvId: toText(ndvCreatorId),
    reconciled,
    schemaVersion: NDV_CANONICAL_SCHEMA_VERSION,
    createPayload,
    updatePayload,
    ndvRecord,
    chargeTables,
    usedIds: {
      accountId: toText(ndvRecord.CRM_Account),
      contactId: toText(contactId),
      billingContactId: toText(billingContactId),
      dealName: toText(ndvRecord.CRM_Deal),
      quoteId: toText(quoteId),
    },
  };
}

function proposalDataToQuoteRows(proposalData) {
  const toRows = (items) =>
    safeArray(items).map((item) => ({
      Nombre_Item: toText(item?.nombre),
      Cantidad: Number(item?.cantidad || 0),
      Modalidad: toText(item?.tipo || "Por usuario"),
    }));

  return [
    ...toRows(proposalData?.servicios),
    ...toRows(proposalData?.equipos),
    ...toRows(proposalData?.accesorios),
    ...toRows(proposalData?.serviciosAsoc),
  ].filter((row) => row.Nombre_Item && Number(row.Cantidad) > 0);
}

async function runNdvHandoffFromDraft({
  config,
  dealId,
  proposalData,
  contactEmail,
  contactPhone,
}) {
  const creatorConfig = getCreatorConfig();
  if (creatorConfig.missing.length > 0) {
    throw new Error(`Faltan variables de Zoho Creator: ${creatorConfig.missing.join(", ")}`);
  }

  const resolvedDealId = toText(dealId);
  if (!resolvedDealId) {
    throw new Error("Falta dealId para crear NDV desde cotizadora.");
  }

  const deal = await getRecord("Deals", resolvedDealId);
  const accountId = toText(pickFromLookup(deal?.Account_Name));
  if (!accountId) {
    throw new Error("No se pudo resolver Account desde el Deal.");
  }
  const account = await getRecord("Accounts", accountId);

  const contactId = toText(pickFromLookup(deal?.Contact_Name));
  const contact = contactId ? await getRecord("Contacts", contactId) : null;
  const ownerId = toText(pickFromLookup(deal?.Owner));
  const ownerUser = ownerId ? await getUserById(ownerId).catch(() => null) : null;

  prevalidateDraftInput({ proposalData, deal, account });

  const rows = proposalDataToQuoteRows(proposalData);
  if (!rows.length) {
    throw new NdvBusinessError(
      "Agrega al menos un ítem con cantidad mayor a 0 antes de crear la cotización.",
      "No hay items válidos en la cotización para crear NDV.",
      "NDV_PREVALIDATION_FAILED"
    );
  }

  const pseudoQuote = {
    [config.quoteItemsSubformField]: rows,
    Contact_Name: toText(contact?.Full_Name || proposalData?.contacto || ""),
    [config.contactEmailField]: normalizeEmail(contactEmail || contact?.Email || ""),
    [config.contactPhoneField]: toText(contactPhone || contact?.Phone || contact?.Mobile || ""),
    Moneda: "UF",
    Pa_s_Facturaci_n: "Chile",
    RUT_Cliente: toText(
      proposalData?.rutEmpresa ||
        deal?.RUT_Empresa ||
        deal?.RUT_Cliente ||
        deal?.RUT ||
        deal?.Rut ||
        deal?.Identificador_Tributario_Empresa ||
        account?.RUT_Empresa ||
        account?.RUT_Cliente ||
        account?.RUT ||
        account?.Rut ||
        account?.Identificador_Tributario_Empresa ||
        ""
    ),
    Linea_de_Negocio: "Telemarketing",
    Servicio_Recurrente: "Control de Asistencia",
    Hito_de_Facturaci_n: "",
    Modalidad_de_Pago: "",
    Periodicidad_de_Servicio: "",
    Tipo_de_Facturaci_n: "",
    N_Empleados_Compometidos: toPositiveInt(
      deal?.N_Empleados_que_marcan ||
        deal?.N_Empleados_Compometidos ||
        deal?.N_Empleados_Comprometidos
    ),
  };

  const { record: ndvRecord, chargeTables } = buildNdvRecord({
    config,
    quote: pseudoQuote,
    deal,
    account,
    contact,
    ownerUser,
    billingContactId: "",
    acceptanceData: {},
    overrides: {
      // Desde el botón de cotizadora en CRM debe nacer como Cotización.
      formulario: "Cotización",
      status: "BORRADOR",
      formStatus: "BEING EDITED",
      estadoCot: "Vigente",
      includeCrmDeal: false,
      // En Creator este picklist nace con "Cargando..." y luego se completa por scripts UI.
      // Para insercion por API, iniciar con ese valor evita INVALID_DATA en varios tenants.
      hitoFacturacion: "Cargando...",
    },
  });

  // Evita mismatch de tipo en scripts On Success de Creator:
  // ese parámetro se consume como BIGINT en nextUrl.CreateNextStep.
  ndvRecord.IdDuplicatedMasterForm = 0;

  prevalidateNdvRecord(ndvRecord);

  const createAttempt = await createNdvWithFormFallback({
    creatorConfig,
    ndvRecord,
    // Crear por Formulario alinea con el flujo nativo de Creator (COT),
    // evita depender de scripts de Servicio_Recurrente sin ID_Formulario previo.
    preferredForms: getPreferredCreatorForms(creatorConfig),
    stopOnFirstFailure: false,
  });
  let finalAttempt = createAttempt;
  const attemptedDraftStrategies = ["base"];
  if (!finalAttempt.ok) {
    const creatorDetail = creatorErrorMessage(finalAttempt.payload, "respuesta invalida");
    const normalizedCreatorDetail = toText(creatorDetail).toLowerCase();
    const billingMilestoneError =
      normalizedCreatorDetail.includes("hito_de_facturaci_n") ||
      normalizedCreatorDetail.includes("hito de facturacion") ||
      normalizedCreatorDetail.includes("hito de facturación");

    if (billingMilestoneError) {
      // 1) Reintento con valor alternativo permitido por catálogos en algunos tenants.
      const retryWithCargando = { ...ndvRecord, Hito_de_Facturaci_n: "Cargando..." };
      attemptedDraftStrategies.push("hito=Cargando...");
          finalAttempt = await createNdvWithFormFallback({
            creatorConfig,
            ndvRecord: retryWithCargando,
            preferredForms: getPreferredCreatorForms(creatorConfig),
            stopOnFirstFailure: false,
          });

      // 2) Si sigue fallando por hito, se omite el campo para que lo resuelva Creator.
      if (!finalAttempt.ok) {
        const secondDetail = creatorErrorMessage(finalAttempt.payload, "respuesta invalida");
        const normalizedSecondDetail = toText(secondDetail).toLowerCase();
        const stillBillingMilestoneError =
          normalizedSecondDetail.includes("hito_de_facturaci_n") ||
          normalizedSecondDetail.includes("hito de facturacion") ||
          normalizedSecondDetail.includes("hito de facturación");
        if (stillBillingMilestoneError) {
          const retryWithoutBillingMilestone = { ...ndvRecord };
          delete retryWithoutBillingMilestone.Hito_de_Facturaci_n;
          attemptedDraftStrategies.push("omit_hito");
          finalAttempt = await createNdvWithFormFallback({
            creatorConfig,
            ndvRecord: retryWithoutBillingMilestone,
            preferredForms: getPreferredCreatorForms(creatorConfig),
            stopOnFirstFailure: false,
          });
        }
      }

      if (!finalAttempt.ok) {
        const thirdDetail = creatorErrorMessage(finalAttempt.payload, "respuesta invalida");
        const normalizedThirdDetail = toText(thirdDetail).toLowerCase();
        const stillBillingMilestoneError =
          normalizedThirdDetail.includes("hito_de_facturaci_n") ||
          normalizedThirdDetail.includes("hito de facturacion") ||
          normalizedThirdDetail.includes("hito de facturaciÃ³n");
        if (stillBillingMilestoneError) {
          const minimalDraftRecord = { ...ndvRecord };
          delete minimalDraftRecord.Linea_de_Negocio;
          delete minimalDraftRecord.Servicio_Recurrente;
          delete minimalDraftRecord.Servicios_Recurrentes;
          delete minimalDraftRecord.Servicio_Recurrente_Configurado;
          delete minimalDraftRecord.Servicios_No_Recurrentes;
          delete minimalDraftRecord.Servicio_No_Recurrente_Configurado;
          delete minimalDraftRecord.Modalidad_de_Pago;
          delete minimalDraftRecord.Periodicidad_de_Servicio;
          delete minimalDraftRecord.Tipo_de_Facturaci_n;
          minimalDraftRecord.Hito_de_Facturaci_n = "Cargando...";

          attemptedDraftStrategies.push("minimal+hito=Cargando...");
          finalAttempt = await createNdvWithFormFallback({
            creatorConfig,
            ndvRecord: minimalDraftRecord,
            preferredForms: getPreferredCreatorForms(creatorConfig),
            stopOnFirstFailure: false,
          });

          if (!finalAttempt.ok) {
            attemptedDraftStrategies.push("minimal+hito=omit");
            const retryMinimalWithoutBillingMilestone = { ...minimalDraftRecord };
            delete retryMinimalWithoutBillingMilestone.Hito_de_Facturaci_n;
            finalAttempt = await createNdvWithFormFallback({
              creatorConfig,
              ndvRecord: retryMinimalWithoutBillingMilestone,
              preferredForms: getPreferredCreatorForms(creatorConfig),
              stopOnFirstFailure: false,
            });
          }
        }
      }
    }
  }

  const createResp = finalAttempt.response;
  const createPayload = finalAttempt.payload;
  if (!finalAttempt.ok) {
    const creatorDetail = creatorErrorMessage(createPayload, "respuesta invalida");
    throw new NdvBusinessError(
      normalizeCreatorBusinessError(creatorDetail),
      `Creator create NDV failed (${createResp?.status || 0}) [forms=${finalAttempt.attemptedForms.join(", ")}] [strategies=${attemptedDraftStrategies.join(" -> ")}]: ${creatorDetail}`,
      "NDV_CREATOR_CREATE_FAILED"
    );
  }

  const ndvCreatorId = resolveCreatedCreatorId(createPayload);
  if (!ndvCreatorId) {
    return {
      ndvCreated: true,
      ndvId: "",
      reconciled: false,
      createPayload,
      chargeTables,
      message: "NDV creada sin ID devuelto por Creator.",
    };
  }

  // Refuerza campos críticos post-alta para evitar cotizaciones incompletas en Creator.
  const draftRepairMap = {
    N_Empleados_Compometidos: ndvRecord.N_Empleados_Compometidos,
    Cantidad_de_Usuarios_PDF: ndvRecord.Cantidad_de_Usuarios_PDF,
    Cantidad_de_Usuarios: ndvRecord.Cantidad_de_Usuarios,
    Plantilla_Tabla_de_Cobro: ndvRecord.Plantilla_Tabla_de_Cobro,
    Tabla_de_Cobro: ndvRecord.Tabla_de_Cobro,
  };
  const draftUpdatePath = buildCreatorUpdatePath(creatorConfig, ndvCreatorId);
  const draftUpdateResp = await creatorApiFetch(draftUpdatePath, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: draftRepairMap }),
  });
  const draftUpdatePayload = await readJsonSafe(draftUpdateResp);
  if (!draftUpdateResp.ok || isCreatorBusinessError(draftUpdatePayload)) {
    const creatorDetail = creatorErrorMessage(draftUpdatePayload, "respuesta invalida");
    throw new NdvBusinessError(
      normalizeCreatorBusinessError(creatorDetail),
      `Creator patch draft failed (${draftUpdateResp?.status || 0}) [id=${toText(ndvCreatorId)}]: ${creatorDetail}`,
      "NDV_CREATOR_PATCH_FAILED"
    );
  }

  let verifiedRecord = resolveCreatorRecordFromPayload(draftUpdatePayload);
  if (!verifiedRecord) {
    const draftFetchResp = await creatorApiFetch(draftUpdatePath, { method: "GET" });
    const draftFetchPayload = await readJsonSafe(draftFetchResp);
    if (draftFetchResp.ok && !isCreatorBusinessError(draftFetchPayload)) {
      verifiedRecord = resolveCreatorRecordFromPayload(draftFetchPayload);
    }
  }

  if (verifiedRecord) {
    const employeesAfterCreate = toPositiveInt(
      verifiedRecord?.N_Empleados_Compometidos ||
        verifiedRecord?.Cantidad_de_Usuarios_PDF ||
        verifiedRecord?.Cantidad_de_Usuarios
    );
    const tableAfterCreate = safeArray(verifiedRecord?.Tabla_de_Cobro);
    if (employeesAfterCreate <= 0 || tableAfterCreate.length === 0) {
      throw new NdvBusinessError(
        "Creator creó la cotización sin empleados comprometidos o sin tabla de cobro.",
        `id=${toText(ndvCreatorId)}; employees=${employeesAfterCreate}; tabla_len=${tableAfterCreate.length}`,
        "NDV_CREATOR_INCOMPLETE_RECORD"
      );
    }
  }

  return {
    ndvCreated: true,
    ndvId: toText(ndvCreatorId),
    reconciled: true,
    schemaVersion: NDV_CANONICAL_SCHEMA_VERSION,
    usedFormLinkName: finalAttempt.usedFormLinkName,
    createPayload,
    ndvRecord,
    chargeTables,
  };
}

module.exports = {
  NDV_CANONICAL_SCHEMA_VERSION,
  NDV_CANONICAL_REQUIRED_FIELDS,
  NDV_CANONICAL_ITEM_DICTIONARY,
  NdvBusinessError,
  normalizeCreatorBusinessError,
  runNdvHandoff,
  runNdvHandoffFromDraft,
  resolveServiciosRecurrentesDeFila,
  persistNdvReferences,
  quoteHasNdvReference,
};
