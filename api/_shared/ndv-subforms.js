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

/**
 * Términos y condiciones que Creator imprime en el bloque del servicio.
 *
 * OJO: no confundir con PROPOSAL_TYC de proposal-constants.js — ese es el
 * clausulado del PDF que Vicky le manda al cliente. Este es el del documento de
 * Creator, y su redacción la fija el equipo comercial.
 *
 * Las cuatro últimas cláusulas son las que Creator ya imprimía por defecto (se
 * ven en las notas de venta de referencia); la de "Inicio de Facturación" es la
 * que faltaba.
 */
const TYC_CONTROL_ASISTENCIA = [
  "• Inicio de Facturación: La facturación del servicio de asistencia comenzará una vez completada la carga de usuarios en la plataforma GeoVictoria.",
  "Finalizado el primer año de facturación, el servicio pasará automáticamente a facturación mensual, calculada según la cantidad de usuarios activos del mes correspondiente.",
  "La facturación del servicio de asistencia es independiente de la facturación por arriendo o instalación de equipos, las cuales se cobrarán según lo indicado en la propuesta comercial.",
  "• Plazo de Implementación: El plazo estimado de implementación es de 2 a 3 semanas, contado desde la recepción de la planilla de usuarios completa y validada por parte del cliente.",
  "El proceso considera las siguientes etapas:",
  "Dentro de 24 horas hábiles: habilitación del portal GeoVictoria y creación de la empresa en la plataforma.",
  "Dentro de 72 horas hábiles: contacto del equipo de implementación para coordinar inducción y capacitación online.",
  "Entre 5 y 7 días hábiles: envío e instalación de equipos en la Región Metropolitana o regiones, según corresponda.",
  "* Los plazos indicados aplican para empresas con hasta 300 usuarios, sin módulos adicionales ni desarrollos especiales. En caso de empresas con más de 300 usuarios, se le presentará al cliente una carta gantt.",
  "• Mesa de Ayuda: El servicio incluye acceso a la Mesa de Ayuda GeoVictoria, disponible a través de: Chat interno de la plataforma, Atención telefónica, Correo electrónico y WhatsApp.",
  "El horario de atención es de lunes a viernes, de 8:30 a 18:30 horas, en días hábiles.",
  "• Seguridad y Mantenimiento de Datos: La información del cliente es almacenada y administrada en servidores Microsoft Azure, cumpliendo con estándares de seguridad y respaldo de nivel empresarial, y garantizando un uptime mínimo del 99,5%.",
  "• Actualización de Precios: Los precios de los servicios serán revisados y ajustados anualmente, de acuerdo con el Índice de Precios al Consumidor (IPC) o su equivalente en UF, vigente a la fecha de facturación.",
].join("\n");

// Por servicio: cada bloque de la NDV lleva el clausulado que le corresponde.
// Los que no estén acá se crean sin el campo, como hasta ahora.
const TERMINOS_POR_SERVICIO = {
  "Control de Asistencia": TYC_CONTROL_ASISTENCIA,
};

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
    ...(TERMINOS_POR_SERVICIO[serviceName]
      ? { Terminos_y_Condiciones: TERMINOS_POR_SERVICIO[serviceName] }
      : {}),
  };
}

function buildFinalizarFormularioRecord({ ndvId, ndvRecord, notasPdf }) {
  return {
    ID_Formulario: ndvId,
    Empresa: "Creada en Plataforma",
    Identificador_Tributario_Empresa: toText(ndvRecord.Identificador_Tributario_Empresa),
    country: toText(ndvRecord.Pa_s_Facturaci_n) || "Chile",
    CAN_UPDATE_FIELDS: true,
    FORM_STATUS: "BEING EDITED",
    NDV_STATUS: toText(ndvRecord.STATUS) || "BORRADOR",
    // ESTE es el que importa para el error de BIGINT. FinalizeForm (workflow
    // "on add" de este formulario) hace:
    //
    //   url = thisapp.nextUrl.CreateNextStep(..., input.IdDuplicatedMasterForm);
    //
    // y la firma es nextUrl.CreateNextStep(..., int duplicateMainFormID). Si el
    // campo va nulo, Deluge revienta con "Mismatch of data type expression.
    // Expected BIGINT but found STRING" — el error que ve el ejecutivo al
    // convertir a Nota de Venta, mucho después de la emisión.
    //
    // 46f87b5 intentó arreglarlo poniéndolo en el registro maestro, pero el
    // formulario Nota_de_Venta no declara ese campo: era un no-op. Va acá.
    IdDuplicatedMasterForm: 0,
    // Ejecutivo, vigencia y valor de la UF. Se arma en ndv-notas.js con el dueño
    // real del deal y la UF del día, no con valores fijos.
    Notas_PDF: toText(notasPdf),
    Solicitar_datos_de_Facturaci_n_al_Cliente: false,
    BillingDataRequested: false,
    BillingDataReceived: false,
    hasAttendance: (ndvRecord.Servicios_Recurrentes || []).includes("Control de Asistencia"),
    hasServices: (ndvRecord.Servicios_Recurrentes || []).length > 0,
  };
}

/**
 * Formulario_de_Equipos: la venta de equipos y los servicios asociados
 * (instalación, envío). Es el bloque que en el PDF sale como "Visitas y
 * Servicios Técnicos".
 *
 * TODAS las columnas de precio van explícitas. En el formulario manual, al
 * elegir el Item de la picklist, un script Deluge autorellena el resto de la
 * fila; ese script es "on user input" y NO corre por API. Si mandáramos solo el
 * Item, el bloque saldría con los precios en cero — peor que no tenerlo, porque
 * el PDF se vería completo y estaría mintiendo.
 *
 * Columnas que a propósito NO se tocan: Stock y DEV_AmmountToRest (inventario),
 * ID_item / IdItemService / Category / SKU (los resuelve el catálogo de Creator)
 * y Valor_Mensual (es del arriendo, que va por su Servicio_Recurrente).
 */
function buildFormularioEquiposRecord({ ndvId, ndvRecord, lineasEquipos, lineasServicios }) {
  const equipos = (lineasEquipos || []).map((l) => ({
    Item: l.item,
    Modelo: l.modelo,
    Valor: toNumber(l.valorUnitario),
    Cantidad: toNumber(l.cantidad) || 1,
    Valor_Final: toNumber(l.total),
    Sobrecargo: 0,
  }));

  const servicios = (lineasServicios || []).map((l) => ({
    Items: l.item,
    Valor_Unidad: toNumber(l.valorUnitario),
    Cantidad: toNumber(l.cantidad) || 1,
    Total: toNumber(l.total),
    // El precio ya viaja descontado, así que la columna va en 0: no sabemos si
    // Creator la interpreta como porcentaje o como monto, y equivocarse ahí
    // cobraría de menos. El descuento negociado sigue reflejado en el total.
    Descuento: 0,
  }));

  const montoHw = equipos.reduce((acc, e) => acc + toNumber(e.Valor_Final), 0);
  const montoServicios = servicios.reduce((acc, s) => acc + toNumber(s.Total), 0);

  return {
    ID_Formulario: ndvId,
    Formulario: "Cotización",
    // "BEING CREATED" y no "CREATED", a diferencia de Servicio_Recurrente. Los
    // dos formularios ramifican distinto en su workflow "on add":
    //
    //   Servicio_Recurrente   → if (FORM_STATUS.contains("CREATED"))
    //   Formulario_de_Equipos → if (FORM_STATUS.contains("BEING CREATED"))
    //
    // Con "CREATED" este cae al else, que llama EditNextStep(..., currentEditIndex,
    // maxIndex) — campos que no mandamos — y falla con "Null value occurred while
    // performing Addition operation" en su primera línea (nextIndex = currentIndex + 1).
    // Todos los registros hechos a mano traen "BEING CREATED".
    FORM_STATUS: "BEING CREATED",
    IdDuplicatedMasterForm: 0,
    Linea_de_Negocio: "Estándar",
    Moneda: toText(ndvRecord.Moneda) || "UF",
    country: toText(ndvRecord.Pa_s_Facturaci_n) || "Chile",
    Hito_de_Facturaci_n: "Cargando...",
    CAN_UPDATE_FIELDS: true,
    ...(equipos.length > 0 ? { Equipos: equipos } : {}),
    ...(servicios.length > 0 ? { Servicios: servicios } : {}),
    MontoHW: Number(montoHw.toFixed(5)),
    TOTAL_SERVICIOS_ASOCIADOS: Number(montoServicios.toFixed(5)),
    Monto: Number((montoHw + montoServicios).toFixed(5)),
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
async function runNdvSubformSetup({ ndvId, ndvRecord, chargeTables, notasPdf }) {
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
      let serviceId;
      try {
        serviceId = await createSubformRecord(creatorConfig, "Servicio_Recurrente", record);
      } catch (errConTyc) {
        // Terminos_y_Condiciones se confirmó en Formulario_de_Equipos, no en
        // este formulario. Si Creator lo rechaza, se reintenta sin él: perder
        // el clausulado es molesto, perder el bloque del servicio —y con él la
        // sección principal del PDF— no es aceptable.
        if (!record.Terminos_y_Condiciones) throw errConTyc;
        console.warn(
          `[ndv-subforms] ${serviceName} falló con Terminos_y_Condiciones (${errConTyc.message}); se reintenta sin el campo.`
        );
        const sinTyc = { ...record };
        delete sinTyc.Terminos_y_Condiciones;
        serviceId = await createSubformRecord(creatorConfig, "Servicio_Recurrente", sinTyc);
        errors.push(`Terminos_y_Condiciones rechazado por Creator en ${serviceName}: ${errConTyc.message}`);
      }
      console.log(
        `[ndv-subforms] Servicio_Recurrente(${serviceName}) → id=${serviceId} ` +
          `dcto=${record.Descuento_Ejecutivo}% tyc=${record.Terminos_y_Condiciones ? "sí" : "no"} ` +
          `tabla=${JSON.stringify(record.Tabla_de_Cobro)}`
      );
      if (serviceId) serviceCount++;
    } catch (err) {
      console.warn(`[ndv-subforms] Servicio_Recurrente(${serviceName}) ERROR: ${err.message}`);
      errors.push(`Servicio_Recurrente(${serviceName}): ${err.message}`);
    }
  }

  // 2. Formulario_de_Equipos: venta de equipos + servicios asociados. Va ANTES
  //    de Finalizar_Formulario, porque ese dispara GeneratePDF y para entonces
  //    todos los bloques tienen que existir.
  let equiposId = "";
  let equiposRechazado = false;
  const lineasEquipos = chargeTables?.lineasEquipos || [];
  const lineasServicios = chargeTables?.lineasServicios || [];
  if (lineasEquipos.length > 0 || lineasServicios.length > 0) {
    try {
      const equiposRecord = buildFormularioEquiposRecord({
        ndvId,
        ndvRecord,
        lineasEquipos,
        lineasServicios,
      });
      equiposId = await createSubformRecord(creatorConfig, "Formulario_de_Equipos", equiposRecord);
      console.log(
        `[ndv-subforms] Formulario_de_Equipos → id=${equiposId} ` +
          `equipos=${JSON.stringify(equiposRecord.Equipos || [])} ` +
          `servicios=${JSON.stringify(equiposRecord.Servicios || [])}`
      );
    } catch (err) {
      // Solo un RECHAZO cuenta como fallo. createSubformRecord también devuelve
      // "" por timeout, y ahí Creator sí recibió el registro y lo crea en
      // background: limpiar en ese caso borraría la declaración de un bloque que
      // sí va a existir.
      equiposRechazado = true;
      console.warn(`[ndv-subforms] Formulario_de_Equipos ERROR: ${err.message}`);
      errors.push(`Formulario_de_Equipos: ${err.message}`);
    }
  }

  // 2.b Si Creator rechazó el bloque de equipos, el maestro quedó declarando
  //     servicios no recurrentes que no tienen formulario detrás. Al convertir a
  //     Nota de Venta, los scripts de Creator recorren lo declarado buscando el
  //     Form_ID (BIGINT) de cada uno y encuentran vacío:
  //       "Error at line : 7, Mismatch of data type expression.
  //        Expected BIGINT but found STRING"  (caso COT-58566)
  //     El error no aparece al emitir sino mucho después, en el paso humano de
  //     conversión, con la cotización ya en manos del cliente.
  //
  //     Se retiran las declaraciones huérfanas ANTES de Finalizar_Formulario,
  //     que es el que dispara GeneratePDF. La cotización sale sin el bloque de
  //     equipos —degradada, y el error queda en errors[]— pero convertible.
  //     Abortar la emisión entera dejaría al cliente sin cotización y sin PDF
  //     por un bloque accesorio.
  if (equiposRechazado) {
    const sinRespaldo = {
      Servicios_No_Recurrentes: [],
      Servicio_No_Recurrente_Configurado: [],
    };
    try {
      const path =
        `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}` +
        `/report/${encodeURIComponent(creatorConfig.reportLinkName)}/${encodeURIComponent(toText(ndvId))}`;
      const resp = await creatorApiFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: sinRespaldo }),
      });
      const payload = await readJsonSafe(resp);
      if (!resp.ok || isCreatorError(payload)) {
        throw new Error(`(${resp.status}): ${JSON.stringify(payload).slice(0, 300)}`);
      }
      console.warn(
        `[ndv-subforms] Formulario_de_Equipos rechazado; se retiran las declaraciones sin respaldo ` +
          `del maestro ${ndvId} para que la NDV siga siendo convertible ` +
          `(retirado: ${JSON.stringify(ndvRecord.Servicios_No_Recurrentes || [])}).`
      );
    } catch (err) {
      // Si ni la limpieza se pudo hacer, la NDV queda inconvertible igual. Se
      // deja constancia explícita para que se note al emitir y no en Zoho.
      console.error(`[ndv-subforms] LIMPIEZA FALLÓ en el maestro ${ndvId}: ${err.message}`);
      errors.push(
        `Declaraciones sin respaldo NO retiradas del maestro (la NDV puede fallar al convertirse): ${err.message}`
      );
    }
  }

  // 3. Crear Finalizar_Formulario (Form_Order ya poblado por CreateNextStep).
  //    Dispara FinalizeForm (→ FORM_STATUS=CREATED) y GeneratePDF
  //    (→ RegeneratePdfJson → PDF_STRING).
  let finalizarId = "";
  try {
    const finalizarRecord = buildFinalizarFormularioRecord({ ndvId, ndvRecord, notasPdf });
    finalizarId = await createSubformRecord(creatorConfig, "Finalizar_Formulario", finalizarRecord);
    console.log(`[ndv-subforms] Finalizar_Formulario → id=${finalizarId}`);
  } catch (err) {
    console.warn(`[ndv-subforms] Finalizar_Formulario ERROR: ${err.message}`);
    errors.push(`Finalizar_Formulario: ${err.message}`);
  }

  console.log(
    `[ndv-subforms] done serviceCount=${serviceCount} equiposId=${equiposId || "∅"} ` +
      `finalizarId=${finalizarId} errors=${JSON.stringify(errors)}`
  );
  return {
    serviceCount,
    equiposId,
    finalizarId,
    errors,
  };
}

module.exports = {
  runNdvSubformSetup,
  // Expuestos para el modo de reparación de creator-ndv-test.js: crear un
  // Finalizar_Formulario nuevo sobre una NDV ya emitida y rota (BIGINT), sin
  // reimplementar el armado del registro ni la llamada a Creator por separado.
  buildFinalizarFormularioRecord,
  createSubformRecord,
};
