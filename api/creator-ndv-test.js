// Endpoint de test: replica lo que hace Vicky POST-PAGO para crear la NDV en
// Zoho Creator, sin pasar por MercadoPago. Corre el mismo handoff + subforms que
// api/_shared/post-payment-finalize.js y devuelve el ID_NDV para revisar en Creator.
//
// Además vuelca Form_Order / FORM_STATUS / JsonPdf del registro creado, para
// confirmar por qué el PDF no se genera.
//
// Uso:
//   POST /api/creator-ndv-test?secret=<QUOTE_ACCEPTANCE_SECRET>
//   body: { "quoteId": "...", "dealId": "..." }   (dealId opcional; se resuelve del quote)
//
// TEMPORAL: borrar tras diagnosticar.
const { getAcceptanceConfig } = require("./_shared/quote-acceptance-config");
const { getRecord, toText } = require("./_shared/zoho-crm");
const { getCreatorConfig, creatorApiFetch } = require("./_shared/zoho-creator-auth");
const { runNdvHandoff } = require("./_shared/ndv-handoff");
const { runNdvSubformSetup } = require("./_shared/ndv-subforms");
const { buildAcceptanceDataFromQuote } = require("./_shared/post-payment-finalize");

function parseBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return typeof req.body === "object" ? req.body : {};
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch (_e) { return { raw: text.slice(0, 500) }; }
}

// Trae el registro maestro ALL_DATA por su ID numérico para inspeccionar Form_Order.
async function fetchNdvRecord(creatorConfig, ndvId) {
  const path = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}/report/${encodeURIComponent(creatorConfig.reportLinkName)}/${encodeURIComponent(toText(ndvId))}`;
  const resp = await creatorApiFetch(path, { method: "GET" });
  const payload = await readJson(resp);
  const data = payload?.data || {};
  return {
    status: resp.status,
    ID_NDV: data.ID_NDV,
    FORM_STATUS: data.FORM_STATUS,
    STATUS: data.STATUS,
    Form_Order: data.Form_Order,
    Form_Order_len: Array.isArray(data.Form_Order) ? data.Form_Order.length : 0,
    JsonPdf_present: Boolean(data.JsonPdf),
    PDF_STRING_present: Boolean(data.PDF_STRING),
    Servicios_Recurrentes: data.Servicios_Recurrentes,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const expected = String(process.env.QUOTE_ACCEPTANCE_SECRET || "");
  const provided = String(req.query?.secret || req.headers["x-diag-secret"] || "");
  if (!expected || expected !== provided) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Usa POST con { quoteId, dealId }" }));
    return;
  }

  const out = { ok: false, steps: {} };
  try {
    const body = parseBody(req);

    // ── Modo "fresh": crea un NDV maestro directo (sin CRM quote) y corre el
    //    código REAL de runNdvSubformSetup para validar el fix de Form_Order. ──
    if (body.fresh === true) {
      const creatorConfig = getCreatorConfig();
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, "0");
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const yyyy = String(now.getFullYear());
      const creatorDate = `${dd}-${mm}-${yyyy}`;

      // ndvRecord mínimo que consumen buildServicioRecurrenteRecord/Finalizar y
      // que reproduce lo que produciría runNdvHandoff para Huellero (caso simple).
      const ndvRecord = {
        Formulario: "Nota de Venta",
        FORM_STATUS: "CREATED",
        STATUS: "PENDIENTE",
        Nombre_del_documento: `TEST Form_Order fix / ${yyyy}-${mm}-${dd}`,
        CRM_Account: "3525045000633660939",
        CRM_ACCOUNT_NAME: "Huellero company",
        Correo_Vendedor: "adiazg@geovictoria.com",
        Pa_s_Facturaci_n: "Chile",
        Identificador_Tributario_Empresa: "20.788.061-2",
        Moneda: "UF",
        Linea_de_Negocio: "Telemarketing",
        Servicio_Recurrente: "Control de Asistencia",
        Servicios_Recurrentes: ["Control de Asistencia"],
        Hito_de_Facturaci_n: "Cargando...",
        N_Empleados_Compometidos: 10,
        Cantidad_de_Usuarios: 10,
        Cantidad_de_Usuarios_PDF: 10,
        Plantilla_Tabla_de_Cobro: "Sin Plantilla",
        Tabla_de_Cobro: [
          { Modalidad: "Rango Fijo", Desde: 1, Hasta: 10, Valor: 1.39, Valor_Usuario_Adicional: 0.139 },
        ],
        Fecha_de_creaci_n: creatorDate,
        fecha_uf_usd: creatorDate,
      };

      // Crear el maestro (form Nota_de_Venta → report ALL_DATA)
      const createPath = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}/form/${encodeURIComponent("Nota_de_Venta")}`;
      const createResp = await creatorApiFetch(createPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: ndvRecord }),
      });
      const createPayload = await readJson(createResp);
      const ndvId = toText(createPayload?.data?.ID || createPayload?.data?.id);
      out.steps.createMaster = { status: createResp.status, ndvId, payload: ndvId ? undefined : createPayload };

      if (!ndvId) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ...out, error: "No se obtuvo ndvId del maestro" }, null, 2));
        return;
      }

      // Correr el código REAL que estamos probando
      const subformSetup = await runNdvSubformSetup({ ndvId, ndvRecord });
      out.steps.subforms = subformSetup;

      // Estado del registro tras el fix
      out.steps.ndvRecordAfter = await fetchNdvRecord(creatorConfig, ndvId);
      out.ok = true;
      out.reviewHint = `Revisa en Creator → Reporte NDV el ID_NDV=${out.steps.ndvRecordAfter?.ID_NDV || "(ver arriba)"}`;
      res.statusCode = 200;
      res.end(JSON.stringify(out, null, 2));
      return;
    }

    // ── Modo "restCreateService": crea un Servicio_Recurrente por REST con la tabla
    //    completa (formato correcto). Devuelve el ID para leerlo por Deluge (DumpSvc)
    //    y confirmar si el grid persiste por REST (la lectura REST es lossy). ──
    if (body.restCreateService === true) {
      const creatorConfig = getCreatorConfig();
      // Crear un maestro FRESCO y limpio por REST (para que CreateNextStep no reviente).
      let masterId = toText(body.masterId);
      if (!masterId) {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, "0");
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const yyyy = String(now.getFullYear());
        const master = {
          Formulario: "Cotización", FORM_STATUS: "BEING EDITED", STATUS: "BORRADOR", ESTADO_COT: "Vigente",
          Nombre_del_documento: `RESTGRIDTEST / ${yyyy}-${mm}-${dd}`,
          CRM_Account: "3525045000208660206", CRM_ACCOUNT_NAME: "HuelleroCompany",
          Correo_Vendedor: "adiazg@geovictoria.com", Pa_s_Facturaci_n: "Chile",
          Identificador_Tributario_Empresa: "76622058-4", Moneda: "UF", Linea_de_Negocio: "Estándar",
          Servicio_Recurrente: "Control de Asistencia", Servicios_Recurrentes: ["Control de Asistencia"],
          N_Empleados_Compometidos: 10, Cantidad_de_Usuarios: 10, Cantidad_de_Usuarios_PDF: 10,
          Plantilla_Tabla_de_Cobro: "Sin Plantilla",
        };
        const mpath = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}/form/${encodeURIComponent("Nota_de_Venta")}`;
        const mresp = await creatorApiFetch(mpath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: master }) });
        const mpayload = await readJson(mresp);
        masterId = toText(mpayload?.data?.ID);
        out.steps.masterCreate = { status: mresp.status, code: mpayload?.code, masterId, error: mpayload?.error };
        if (!masterId) { res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return; }
      }
      const tabla = [
        { Modalidad: "Rango Fijo", Desde: 1, Hasta: 10, Valor: 0.75, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 11, Hasta: 20, Valor: 0.09, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 21, Hasta: 30, Valor: 0.08, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 31, Hasta: 50, Valor: 0.07, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 51, Hasta: 100, Valor: 0.065, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 101, Hasta: 200, Valor: 0.06, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 201, Hasta: 500, Valor: 0.055, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 501, Hasta: 1000, Valor: 0.05, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 1001, Hasta: 3000, Valor: 0.045, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 3001, Hasta: 5000, Valor: 0.04, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 5001, Hasta: 8000, Valor: 0.035, Valor_Usuario_Adicional: 0 },
        { Modalidad: "Rango por Usuario", Desde: 8001, Hasta: 9999, Valor: 0.03, Valor_Usuario_Adicional: 0.03 },
      ];
      const rec = {
        ID_Formulario: masterId,
        Servicio_Recurrente: "Control de Asistencia",
        Formulario: "Cotización",
        FORM_STATUS: "CREATED",
        Linea_de_Negocio: "Estándar",
        Periodicidad_de_Servicio: "Mensual",
        Modalidad_de_Pago: "30 días",
        Modalidad_de_Tarifa: "Por Usuario",
        Hito_de_Facturaci_n: "Cargando...",
        Plantilla_Tabla_de_Cobro: "No hay Plantillas",
        Moneda: "UF",
        country: "Chile",
        Logo_PDF: "Geovictoria",
        Descuento_Ejecutivo: 0,
        N_Empleados_Compometidos: 10,
        Cantidad_de_Usuarios: 10,
        Cantidad_de_Usuarios_PDF: 10,
        isSimpleService: false,
        IdDuplicatedMasterForm: 0,
        Tabla_de_Cobro: tabla,
      };
      const creatorConfig2 = creatorConfig;
      const path = `/creator/v2.1/data/${encodeURIComponent(creatorConfig2.ownerName)}/${encodeURIComponent(creatorConfig2.appLinkName)}/form/${encodeURIComponent("Servicio_Recurrente")}`;
      const resp = await creatorApiFetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: rec }),
      });
      const payload = await readJson(resp);
      const newId = toText(payload?.data?.ID);
      out.steps.create = { status: resp.status, code: payload?.code, newServiceId: newId, error: payload?.error };
      if (newId) {
        const rpath = `/creator/v2.1/data/${encodeURIComponent(creatorConfig2.ownerName)}/${encodeURIComponent(creatorConfig2.appLinkName)}/report/SERVICES_ALL_DATA/${encodeURIComponent(newId)}`;
        const rr = await creatorApiFetch(rpath, { method: "GET" });
        const rp = await readJson(rr);
        out.steps.restReadBack_Tabla_len = Array.isArray(rp?.data?.Tabla_de_Cobro) ? rp.data.Tabla_de_Cobro.length : 0;
      }
      // Crear Finalizar_Formulario por REST → dispara GeneratePDF
      const finRec = {
        ID_Formulario: masterId,
        Empresa: "Creada en Plataforma",
        Identificador_Tributario_Empresa: "76622058-4",
        country: "Chile",
        FORM_STATUS: "BEING EDITED",
        hasAttendance: true,
        hasServices: true,
      };
      const fpath = `/creator/v2.1/data/${encodeURIComponent(creatorConfig2.ownerName)}/${encodeURIComponent(creatorConfig2.appLinkName)}/form/${encodeURIComponent("Finalizar_Formulario")}`;
      const fresp = await creatorApiFetch(fpath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: finRec }) });
      const fpayload = await readJson(fresp);
      out.steps.finalizar = { status: fresp.status, code: fpayload?.code, id: toText(fpayload?.data?.ID), error: fpayload?.error };

      out.ok = true;
      out.masterId = masterId;
      out.dumpHint = `Corre DumpMaster (Deluge) con masterId ${masterId} para ver Form_Order + PDF_STRING`;
      res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return;
    }

    // ── Modo "gridTest": PATCH de Tabla_de_Cobro a un sub-registro y relee, para
    //    determinar si las escrituras de grid por REST persisten. ──
    if (body.gridTest === true) {
      const creatorConfig = getCreatorConfig();
      const report = toText(body.report) || "SERVICES_ALL_DATA";
      const recId = toText(body.recordId);
      if (!recId) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "falta recordId" })); return; }
      const path = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}/report/${encodeURIComponent(report)}/${encodeURIComponent(recId)}`;
      const tabla = [
        { Modalidad: "Rango Fijo", Desde: 1, Hasta: 10, Valor: 1.39, Valor_Usuario_Adicional: 0.139 },
      ];
      const patchResp = await creatorApiFetch(path, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { Tabla_de_Cobro: tabla } }),
      });
      out.steps.patch = { status: patchResp.status, payload: await readJson(patchResp) };
      // releer
      const readResp = await creatorApiFetch(path, { method: "GET" });
      const readPayload = await readJson(readResp);
      out.steps.afterRead = {
        status: readResp.status,
        Tabla_de_Cobro_len: Array.isArray(readPayload?.data?.Tabla_de_Cobro) ? readPayload.data.Tabla_de_Cobro.length : 0,
        Tabla_de_Cobro: readPayload?.data?.Tabla_de_Cobro,
        JsonPdf_present: Boolean(readPayload?.data?.JsonPdf),
      };
      out.ok = true;
      res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return;
    }

    // ── Modo "freshCot": crea master como COTIZACIÓN (editable) y deja que el
    //    workflow CreateNextStep arme Form_Order internamente al crear el
    //    Servicio_Recurrente con FORM_STATUS=CREATED. SIN PATCH externo. ──
    if (body.freshCot === true) {
      const creatorConfig = getCreatorConfig();
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, "0");
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const yyyy = String(now.getFullYear());
      const creatorDate = `${dd}-${mm}-${yyyy}`;
      const dataBase = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}`;

      // 1) Master como Cotización
      const masterRecord = {
        Formulario: "Cotización",
        FORM_STATUS: "BEING EDITED",
        STATUS: "BORRADOR",
        ESTADO_COT: "Vigente",
        Nombre_del_documento: `TEST freshCot / ${yyyy}-${mm}-${dd}`,
        CRM_Account: "3525045000633660939",
        CRM_ACCOUNT_NAME: "Huellero company",
        Correo_Vendedor: "adiazg@geovictoria.com",
        Pa_s_Facturaci_n: "Chile",
        Identificador_Tributario_Empresa: "20.788.061-2",
        Moneda: "UF",
        Linea_de_Negocio: "Telemarketing",
        Servicio_Recurrente: "Control de Asistencia",
        Servicios_Recurrentes: ["Control de Asistencia"],
        Hito_de_Facturaci_n: "Cargando...",
        N_Empleados_Compometidos: 10,
        Cantidad_de_Usuarios: 10,
        Cantidad_de_Usuarios_PDF: 10,
        Plantilla_Tabla_de_Cobro: "Sin Plantilla",
        Tabla_de_Cobro: [
          { Modalidad: "Rango Fijo", Desde: 1, Hasta: 10, Valor: 1.39, Valor_Usuario_Adicional: 0.139 },
        ],
        IdDuplicatedMasterForm: 0,
        Fecha_de_creaci_n: creatorDate,
        fecha_uf_usd: creatorDate,
      };
      const mResp = await creatorApiFetch(`${dataBase}/form/${encodeURIComponent("Nota_de_Venta")}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: masterRecord }),
      });
      const mPayload = await readJson(mResp);
      const ndvId = toText(mPayload?.data?.ID || mPayload?.data?.id);
      out.steps.createMaster = { status: mResp.status, ndvId, payload: ndvId ? undefined : mPayload };
      if (!ndvId) { res.statusCode = 500; res.end(JSON.stringify({ ...out, error: "sin ndvId" }, null, 2)); return; }

      // 2) Servicio_Recurrente con FORM_STATUS=CREATED → dispara CreateNextStep (append interno de Form_Order)
      const servicioRecord = {
        ID_Formulario: ndvId,
        Formulario: "Cotización",
        Servicio_Recurrente: "Control de Asistencia",
        FORM_STATUS: "CREATED",
        N_Empleados_Compometidos: 10,
        Cantidad_de_Usuarios: 10,
        Cantidad_de_Usuarios_PDF: 10,
        Tabla_de_Cobro: [
          { Modalidad: "Rango Fijo", Desde: 1, Hasta: 10, Valor: 1.39, Valor_Usuario_Adicional: 0.139 },
        ],
        Moneda: "UF",
        Periodicidad_de_Servicio: "Mensual",
        Hito_de_Facturaci_n: "Cargando...",
        Plantilla_Tabla_de_Cobro: "No hay Plantillas",
        Descuento_Ejecutivo: 0,
        Fecha_de_Inicio: creatorDate,
        Linea_de_Negocio: "Telemarketing",
        country: "Chile",
        CAN_UPDATE_FIELDS: true,
        isSimpleService: false,
        NDV_STATUS: "BORRADOR",
        IdDuplicatedMasterForm: 0,
      };
      const sResp = await creatorApiFetch(`${dataBase}/form/${encodeURIComponent("Servicio_Recurrente")}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: servicioRecord }),
      });
      const sPayload = await readJson(sResp);
      out.steps.createServicio = { status: sResp.status, id: toText(sPayload?.data?.ID), code: sPayload?.code };

      // 3) Ver si Form_Order se pobló solo (por CreateNextStep)
      out.steps.ndvRecordAfter = await fetchNdvRecord(creatorConfig, ndvId);

      // 4) Crear Finalizar_Formulario → dispara GeneratePDF (Form_Order ya poblado).
      //    Con timeout de 25s: Creator termina el PDF en background igual.
      const finalizarRecord = {
        ID_Formulario: ndvId,
        Empresa: "Creada en Plataforma",
        Identificador_Tributario_Empresa: "20.788.061-2",
        country: "Chile",
        CAN_UPDATE_FIELDS: true,
        FORM_STATUS: "BEING EDITED",
        NDV_STATUS: "BORRADOR",
        Notas_PDF: "",
        Solicitar_datos_de_Facturaci_n_al_Cliente: false,
        BillingDataRequested: false,
        BillingDataReceived: false,
        hasAttendance: true,
        hasServices: true,
      };
      const finPromise = creatorApiFetch(`${dataBase}/form/${encodeURIComponent("Finalizar_Formulario")}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: finalizarRecord }),
      }).then(async (r) => ({ status: r.status, code: (await readJson(r))?.code })).catch((e) => ({ error: String(e).slice(0, 120) }));
      const finTimeout = new Promise((resolve) => setTimeout(() => resolve({ status: "timeout-25s (Creator sigue en background)" }), 25000));
      out.steps.createFinalizar = await Promise.race([finPromise, finTimeout]);

      out.ok = true;
      out.ndvId = ndvId;
      out.reviewHint = `ID_NDV=${out.steps.ndvRecordAfter?.ID_NDV}; Form_Order_len=${out.steps.ndvRecordAfter?.Form_Order_len}. Reconsulta el registro en ~60s para ver PDF_STRING.`;
      res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return;
    }

    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "Falta quoteId en el body" }));
      return;
    }

    const config = getAcceptanceConfig(req);
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: `No se encontró la cotización ${quoteId}` }));
      return;
    }
    const dealId = toText(
      body.dealId || quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]
    );
    const acceptanceData = buildAcceptanceDataFromQuote(config, quote);
    out.steps.resolved = { quoteId, dealId };

    // 1) Handoff NDV (crea el registro maestro en Creator)
    const ndvResult = await runNdvHandoff({ config, quoteId, dealId, acceptanceData });
    const ndvId = toText(ndvResult?.ndvId);
    out.steps.handoff = {
      ndvId,
      reconciled: ndvResult?.reconciled === true,
      servicios: ndvResult?.ndvRecord?.Servicios_Recurrentes,
    };

    // 2) Subforms (Servicio_Recurrente x N + Finalizar_Formulario → dispara GeneratePDF)
    if (ndvId) {
      const subformSetup = await runNdvSubformSetup({
        ndvId,
        ndvRecord: ndvResult?.ndvRecord || {},
        chargeTables: ndvResult?.chargeTables,
      });
      out.steps.subforms = subformSetup;

      // 3) Estado del registro tras crear subforms — confirma Form_Order / PDF
      const creatorConfig = getCreatorConfig();
      out.steps.ndvRecordAfter = await fetchNdvRecord(creatorConfig, ndvId);
    }

    out.ok = true;
    out.reviewHint = out.steps.handoff.ndvId
      ? `Revisa en Creator → Reporte NDV el ID_NDV=${out.steps.ndvRecordAfter?.ID_NDV || "(ver arriba)"}`
      : "No se obtuvo ndvId";
    res.statusCode = 200;
    res.end(JSON.stringify(out, null, 2));
  } catch (e) {
    out.error = String((e && e.stack) || (e && e.message) || e);
    out.errorDetail = e?.detail || e?.code || undefined;
    res.statusCode = 500;
    res.end(JSON.stringify(out, null, 2));
  }
};
