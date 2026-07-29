/**
 * Crea los sub-formularios de Creator (Servicio_Recurrente + Finalizar_Formulario)
 * para un NDV recién creado via API, replicando el flujo manual del wizard.
 *
 * Flujo:
 *  1. Por cada servicio recurrente → POST Servicio_Recurrente
 *     (Creator auto-dispara UpdatePdfJson1 → construye JsonPdf en el registro)
 *  2. POST Finalizar_Formulario
 *     (Creator auto-dispara GeneratePDF → llama RegeneratePdfJson → llama PDF API → guarda PDF_STRING)
 */

const { getCreatorConfig, creatorApiFetch } = require("./zoho-creator-auth");
const { toText } = require("./zoho-crm");

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatCreatorDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { raw: text };
  }
}

function isCreatorError(payload) {
  if (!payload || typeof payload !== "object") return false;
  const code = Number.parseInt(toText(payload.code), 10);
  // code 3000 = success; a non-empty error array alongside 3000 contains Creator
  // internal workflow errors (e.g. EditNextStep), not record-creation failures.
  // Only treat as error when the HTTP response code is non-3000.
  if (Number.isFinite(code)) return code !== 3000;
  // No numeric code → fall back to checking for an error object (not array)
  if (payload.error && !Array.isArray(payload.error) && typeof payload.error === "object" && Object.keys(payload.error).length > 0) return true;
  return false;
}

function resolveCreatedId(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = toText(payload?.data?.ID || payload?.data?.id || payload?.ID || payload?.id);
  if (direct) return direct;
  for (const row of Array.isArray(payload?.data) ? payload.data : []) {
    const id = toText(row?.ID || row?.id || row?.details?.ID || row?.details?.id);
    if (id) return id;
  }
  return "";
}

function buildFormPath(config, formLinkName) {
  return `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/form/${encodeURIComponent(formLinkName)}`;
}

async function createSubformRecord(creatorConfig, formLinkName, record, timeoutMs = 30000) {
  const path = buildFormPath(creatorConfig, formLinkName);
  const fetchPromise = creatorApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: record }),
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`CREATOR_TIMEOUT_${formLinkName}`)), timeoutMs)
  );

  let response;
  try {
    response = await Promise.race([fetchPromise, timeoutPromise]);
  } catch (err) {
    if (err.message && err.message.startsWith("CREATOR_TIMEOUT_")) {
      // Creator received the request; GeneratePDF workflows run in background.
      console.warn(`[ndv-subforms] ${formLinkName} timed out after ${timeoutMs}ms — Creator processes in background`);
      return "";
    }
    throw err;
  }
  const payload = await readJsonSafe(response);
  if (!response.ok || isCreatorError(payload)) {
    const detail = JSON.stringify(payload).slice(0, 300);
    throw new Error(`Creator ${formLinkName} create failed (${response.status}): ${detail}`);
  }
  return resolveCreatedId(payload);
}

// Receta VERIFICADA (COT-56717, PDF correcto por puro REST). Claves:
//  - FORM_STATUS="CREATED": dispara CreateNextStep, que puebla Form_Order en el
//    maestro. Con "BEING EDITED" caía en UpdateFormOrderId (no-op) → Form_Order vacío.
//  - IdDuplicatedMasterForm=0: CreateNextStep solo appendea la fila si
//    duplicateMainFormID==0; si el campo va null, no appendea.
//  - Tabla_de_Cobro inline (la que cotizó Vicky): SÍ persiste por REST (la lectura
//    REST es lossy y no la muestra, pero queda guardada). UpdatePdfJson1 arma el
//    JsonPdf desde ella.
//  - Hito/Plantilla van con el valor estático (los reales son picklists dinámicos
//    que REST rechaza).
function buildServicioRecurrenteRecord({ ndvId, serviceName, ndvRecord, chargeTable, descuentoPct }) {
  const employees = toNumber(ndvRecord.N_Empleados_Compometidos) || 1;
  const tabla = Array.isArray(chargeTable) && chargeTable.length > 0
    ? chargeTable
    : Array.isArray(ndvRecord.Tabla_de_Cobro)
      ? ndvRecord.Tabla_de_Cobro
      : [];

  return {
    ID_Formulario: ndvId,
    Servicio_Recurrente: serviceName,
    Formulario: "Cotización",
    FORM_STATUS: "CREATED",
    IdDuplicatedMasterForm: 0,
    Linea_de_Negocio: "Estándar",
    Periodicidad_de_Servicio: "Mensual",
    Modalidad_de_Pago: toText(ndvRecord.Modalidad_de_Pago) || "30 días",
    Modalidad_de_Tarifa: "Por Usuario",
    Hito_de_Facturaci_n: "Cargando...",
    Plantilla_Tabla_de_Cobro: "No hay Plantillas",
    Moneda: toText(ndvRecord.Moneda) || "UF",
    country: toText(ndvRecord.Pa_s_Facturaci_n) || "Chile",
    Logo_PDF: "Geovictoria",
    // El descuento va acá, NO incorporado al precio de la tabla: así Creator lo
    // imprime como línea propia ("Descuento 30%") y agrega las columnas
    // "V. con Dcto" a la tabla de cobro, como en las notas de venta bien hechas.
    Descuento_Ejecutivo: toNumber(descuentoPct) || toNumber(ndvRecord.Descuento_Ejecutivo) || 0,
    N_Empleados_Compometidos: employees,
    Cantidad_de_Usuarios: employees,
    Cantidad_de_Usuarios_PDF: employees,
    isSimpleService: false,
    CAN_UPDATE_FIELDS: true,
    Tabla_de_Cobro: tabla,
  };
}

function buildFinalizarFormularioRecord({ ndvId, ndvRecord }) {
  return {
    ID_Formulario: ndvId,
    Empresa: "Creada en Plataforma",
    Identificador_Tributario_Empresa: toText(ndvRecord.Identificador_Tributario_Empresa),
    country: toText(ndvRecord.Pa_s_Facturaci_n) || "Chile",
    CAN_UPDATE_FIELDS: true,
    FORM_STATUS: "BEING EDITED",
    NDV_STATUS: toText(ndvRecord.STATUS) || "BORRADOR",
    Notas_PDF: "",
    Solicitar_datos_de_Facturaci_n_al_Cliente: false,
    BillingDataRequested: false,
    BillingDataReceived: false,
    hasAttendance: (ndvRecord.Servicios_Recurrentes || []).includes("Control de Asistencia"),
    hasServices: (ndvRecord.Servicios_Recurrentes || []).length > 0,
  };
}

/**
 * Orquesta la creación de sub-formularios para un NDV recién creado.
 *
 * @param {string} ndvId  - ID numérico del registro ALL_DATA en Creator
 * @param {object} ndvRecord - El objeto enviado a Creator al crear el NDV (buildNdvRecord output)
 * @param {object} [chargeTables] - Tablas de cobro por servicio (ndv-charge-table).
 *   Cada Servicio_Recurrente lleva SU precio; sin esto todos heredaban la tabla
 *   del maestro, o sea el precio del servicio titular repetido en el PDF.
 * @returns {{ serviceCount, finalizarId, errors }}
 */
async function runNdvSubformSetup({ ndvId, ndvRecord, chargeTables }) {
  const creatorConfig = getCreatorConfig();
  if (creatorConfig.missing.length > 0) {
    throw new Error(`Faltan variables de Zoho Creator para sub-formularios: ${creatorConfig.missing.join(", ")}`);
  }

  const errors = [];
  // Un bloque de la NDV por cada servicio CON DINERO, no solo por los de la
  // lista Servicios_Recurrentes del maestro. El arriendo de equipos es un
  // Servicio_Recurrente en Creator ("2º Arriendo de Equipos" en las notas de
  // venta de referencia), pero en el maestro vive en
  // Servicio_Recurrente_Configurado, así que iterando solo esa lista su bloque
  // nunca se creaba y el reloj no aparecía en el PDF.
  const recurringServices = Array.from(
    new Set([
      ...(Array.isArray(ndvRecord.Servicios_Recurrentes) ? ndvRecord.Servicios_Recurrentes : []),
      ...Object.keys(chargeTables?.porServicio || {}),
    ])
  ).filter(Boolean);

  console.log(`[ndv-subforms] ndvId=${ndvId} servicios=${JSON.stringify(recurringServices)}`);

  // 1. Crear un Servicio_Recurrente por cada servicio recurrente.
  //    Con FORM_STATUS="CREATED" + IdDuplicatedMasterForm=0, Creator dispara:
  //      - UpdatePdfJson1 → arma JsonPdf desde la Tabla_de_Cobro (que persiste)
  //      - CreateGoToNextStep→CreateNextStep → puebla Form_Order en el maestro
  //    (Nota: la Tabla_de_Cobro sí persiste por REST; la lectura REST no la
  //    muestra pero queda guardada — verificado por Deluge en COT-56717.)
  let serviceCount = 0;
  for (const serviceName of recurringServices) {
    try {
      const chargeTable = chargeTables?.porServicio?.[serviceName];
      if (!chargeTable) {
        console.warn(
          `[ndv-subforms] ${serviceName} sin tabla propia; hereda la del maestro (precio posiblemente incorrecto en el PDF).`
        );
      }
      const record = buildServicioRecurrenteRecord({
        ndvId,
        serviceName,
        ndvRecord,
        chargeTable,
        descuentoPct: chargeTables?.descuentoPorServicio?.[serviceName],
      });
      const serviceId = await createSubformRecord(creatorConfig, "Servicio_Recurrente", record);
      console.log(
        `[ndv-subforms] Servicio_Recurrente(${serviceName}) → id=${serviceId} ` +
          `dcto=${record.Descuento_Ejecutivo}% tabla=${JSON.stringify(record.Tabla_de_Cobro)}`
      );
      if (serviceId) serviceCount++;
    } catch (err) {
      console.warn(`[ndv-subforms] Servicio_Recurrente(${serviceName}) ERROR: ${err.message}`);
      errors.push(`Servicio_Recurrente(${serviceName}): ${err.message}`);
    }
  }

  // 2. Crear Finalizar_Formulario (Form_Order ya poblado por CreateNextStep).
  //    Dispara FinalizeForm (→ FORM_STATUS=CREATED) y GeneratePDF
  //    (→ RegeneratePdfJson → PDF_STRING).
  let finalizarId = "";
  try {
    const finalizarRecord = buildFinalizarFormularioRecord({ ndvId, ndvRecord });
    finalizarId = await createSubformRecord(creatorConfig, "Finalizar_Formulario", finalizarRecord);
    console.log(`[ndv-subforms] Finalizar_Formulario → id=${finalizarId}`);
  } catch (err) {
    console.warn(`[ndv-subforms] Finalizar_Formulario ERROR: ${err.message}`);
    errors.push(`Finalizar_Formulario: ${err.message}`);
  }

  console.log(`[ndv-subforms] done serviceCount=${serviceCount} finalizarId=${finalizarId} errors=${JSON.stringify(errors)}`);
  return {
    serviceCount,
    finalizarId,
    errors,
  };
}

module.exports = { runNdvSubformSetup };
