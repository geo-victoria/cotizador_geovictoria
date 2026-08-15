/**
 * CONVERTIR una cotización de Creator en Nota de Venta, POR API.
 *
 * El botón "Convertir a NV" (workflow `CotToNv`) no convierte nada: solo abre
 * el formulario prellenado con `Cotizacion_Origen=<ID>&Formulario=Nota de
 * Venta`. La conversión de verdad la hace el workflow
 * `on user input of Cotizacion_Origen` —condición
 * `Formulario == "Nota de Venta" && FORM_STATUS == "BEING CREATED"`—, que
 * COPIA la cotización entera en el registro nuevo. Y `on user input` solo
 * corre desde la UI.
 *
 * Como sabemos exactamente qué copia (lo leímos en el IDE de la app), acá se
 * hace lo mismo por API: se lee la cotización y se crea la Nota de Venta con
 * esos campos más su `Form_Order`.
 *
 * OJO con lo que ESTO NO HACE: confirmar. `ConfirmNDV` calcula los totales,
 * pasa STATUS a CONFIRMADA y, si hay hardware, genera la orden de venta
 * llamando a `zoho.books.createRecord("SalesOrders", ...)` — el SO-XXXXX que
 * sale en el PDF. Eso es un paso aparte.
 *
 * GET /api/creator/convertir-ndv?cot=<ID interno>&dryRun=1
 */

const { getCreatorConfig, creatorApiFetch } = require("../_shared/zoho-creator-auth");
const { secretoValido } = require("../_shared/secreto-vicky");

function texto(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return String(v.display_value || v.zc_display_value || v.ID || "");
  return String(v).trim();
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/** Campos que el workflow copia de la cotización, tal cual los lee el Deluge. */
const COPIAR_DIRECTO = [
  "Moneda",
  "Contact_Name",
  "Email",
  "Tel_fono",
  "Cargo_del_contacto",
  "Identificador_Tributario_Empresa",
  "Account_Owner",
  "Rubro",
  "Pa_s_Facturaci_n",
  "Linea_de_Negocio",
  "CRM_ACCOUNT_NAME",
  "Correo_Vendedor",
  "Es_agente_de_retencion",
  "RequireUpdateCrmRUT",
  "JsonTradeNamesZoho",
  "Razones_Sociales_Account",
  "MESES_PERIODO",
  // Empresa en GeoVictoria: en la UI los llena LoadCrmData al elegir la
  // cuenta. Si la cotización ya los trae, la nota los hereda.
  "ID_Empresa_GeoVictoria",
  "GeoCompanyIdCRM",
];

module.exports = async function handler(req, res) {
  if (!secretoValido(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });

  let config;
  try {
    config = getCreatorConfig();
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `config Creator: ${e.message}` });
  }

  const cotId = String(req.query?.cot || "").trim();
  if (!cotId) return sendJson(res, 400, { ok: false, error: "falta ?cot=<ID interno>" });
  const dryRun = String(req.query?.dryRun || "") === "1";

  const base = `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(
    config.appLinkName
  )}`;
  const reporte = `${base}/report/${encodeURIComponent(config.reportLinkName)}`;

  // 1. La cotización de origen.
  const rCot = await creatorApiFetch(`${reporte}/${encodeURIComponent(cotId)}?field_config=all`, {
    method: "GET",
  });
  const jCot = await rCot.json().catch(() => ({}));
  const cot = jCot?.data || {};
  if (!rCot.ok || !cot || !Object.keys(cot).length) {
    return sendJson(res, 200, {
      ok: false,
      error: `no se pudo leer la cotización ${cotId}`,
      status: rCot.status,
      detalle: JSON.stringify(jCot).slice(0, 300),
    });
  }
  if (texto(cot.Formulario) !== "Cotización") {
    return sendJson(res, 200, { ok: false, error: `${cotId} no es una Cotización (${texto(cot.Formulario)})` });
  }

  // 2. El payload de la Nota de Venta, replicando el workflow de la UI.
  const hoy = new Date().toLocaleDateString("es-CL", { timeZone: "America/Santiago" });
  const registro = {
    Formulario: "Nota de Venta",
    // La condición del workflow original. Los registros hechos a mano nacen así.
    FORM_STATUS: "BEING CREATED",
    STATUS: "BORRADOR",
    Cotizacion_Origen: cotId,
    Nombre_del_documento: `${texto(cot.CRM_Account) || texto(cot.CRM_ACCOUNT_NAME)} / ${hoy}`,
  };
  for (const campo of COPIAR_DIRECTO) {
    const v = cot[campo];
    const t = texto(v);
    if (t) registro[campo] = Array.isArray(v) ? v : t;
  }
  // La CUENTA va por id, no por nombre.
  const cuentaId = typeof cot.CRM_Account === "object" ? texto(cot.CRM_Account?.ID) : "";
  if (cuentaId) registro.CRM_Account = cuentaId;
  // Servicios: los picklists que la nota debe traer seleccionados.
  for (const campo of [
    "Servicios_Recurrentes",
    "Servicios_No_Recurrentes",
    "Servicio_Recurrente_Configurado",
    "Servicio_No_Recurrente_Configurado",
  ]) {
    if (Array.isArray(cot[campo]) && cot[campo].length) registro[campo] = cot[campo];
  }
  // Form_Order: el workflow recorre la tabla fila por fila y la reinserta.
  const filas = Array.isArray(cot.Form_Order) ? cot.Form_Order : [];
  const formOrder = filas
    .map((f) => ({
      Form_ID: texto(f.Form_ID) || texto(f.ID),
      Product_Type: texto(f.Product_Type),
      Product_Name: texto(f.Product_Name),
      Selected: f.Selected === true || texto(f.Selected) === "true",
      FormName: texto(f.FormName),
      Form_ID_NDV: texto(f.FormName) === "Finalizar_Formulario" ? "" : texto(f.Form_ID) || texto(f.ID),
    }))
    .filter((f) => f.Form_ID);
  if (formOrder.length) registro.Form_Order = formOrder;

  if (dryRun) {
    return sendJson(res, 200, {
      ok: true,
      dryRun: true,
      cotizacion: { id: cotId, ID_NDV: texto(cot.ID_NDV), cuenta: texto(cot.CRM_ACCOUNT_NAME) },
      filas_form_order: formOrder.length,
      registro,
    });
  }

  // 3. Crear la Nota de Venta.
  const rPost = await creatorApiFetch(`${base}/form/Nota_de_Venta`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: registro }),
  });
  const jPost = await rPost.json().catch(() => ({}));
  const creado = jPost?.data || {};
  const ndvId = texto(creado.ID);

  // 4. Releer lo creado: un 200 no prueba que el registro haya quedado bien.
  let despues = null;
  if (ndvId) {
    await new Promise((r) => setTimeout(r, 3000));
    const rr = await creatorApiFetch(`${reporte}/${encodeURIComponent(ndvId)}?field_config=all`, {
      method: "GET",
    });
    const jj = await rr.json().catch(() => ({}));
    const d = jj?.data || {};
    despues = {
      ID: texto(d.ID),
      ID_NDV: texto(d.ID_NDV),
      Formulario: texto(d.Formulario),
      STATUS: texto(d.STATUS),
      FORM_STATUS: texto(d.FORM_STATUS),
      Cotizacion_Origen: texto(d.Cotizacion_Origen),
      ID_Empresa_GeoVictoria: texto(d.ID_Empresa_GeoVictoria),
      CRM_ACCOUNT_NAME: texto(d.CRM_ACCOUNT_NAME),
      filas_form_order: Array.isArray(d.Form_Order) ? d.Form_Order.length : 0,
      PDF_STRING: texto(d.PDF_STRING) ? "presente" : "vacío",
    };
  }

  // 5. FINALIZAR. La nota recién creada queda en FORM_STATUS "BEING CREATED",
  //    sin PDF y sin totales — la brecha exacta contra las notas confirmadas a
  //    mano. Ese salto lo da `FinalizeForm`, el workflow "on add" de
  //    Finalizar_Formulario, que además dispara GeneratePDF. Es el mismo
  //    mecanismo que ya usa la emisión para que la COTIZACIÓN tenga su PDF.
  let finalizar = null;
  if (ndvId && String(req.query?.finalizar || "1") === "1") {
    try {
      // SOLO el cierre: los servicios ya viajaron en el Form_Order copiado
      // desde la cotización; recrearlos duplicaría el cobro.
      const { finalizarFormulario } = require("../_shared/ndv-subforms");
      finalizar = await finalizarFormulario({ ndvId, ndvRecord: registro }).catch((e) => ({
        error: e.message,
      }));
    } catch (e) {
      finalizar = { error: e.message };
    }
    await new Promise((r) => setTimeout(r, 4000));
    const rr = await creatorApiFetch(`${reporte}/${encodeURIComponent(ndvId)}?field_config=all`, {
      method: "GET",
    });
    const jj = await rr.json().catch(() => ({}));
    const d = jj?.data || {};
    despues = {
      ...despues,
      STATUS: texto(d.STATUS),
      FORM_STATUS: texto(d.FORM_STATUS),
      PDF_STRING: texto(d.PDF_STRING) ? "presente" : "vacío",
      TOTAL_SERVICIOS_MENSUALES: texto(d.TOTAL_SERVICIOS_MENSUALES),
      MESES_PERIODO: texto(d.MESES_PERIODO),
    };
  }

  return sendJson(res, 200, {
    ok: rPost.ok,
    status: rPost.status,
    respuesta: JSON.stringify(jPost).slice(0, 600),
    ndvId,
    finalizar,
    despues,
  });
};
