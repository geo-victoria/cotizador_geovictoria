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

    // ── Modo "cleanupProbe": borra lo que dejó el sondeo ──────────────────────
    // Cada ronda dejó un maestro de prueba en HuelleroCompany y sus bloques.
    // Se borran primero los bloques y después los maestros, para no dejar
    // formularios colgando de un maestro inexistente.
    //   body: { cleanupProbe: true, bloques: [...], maestros: [...] }
    if (body.cleanupProbe === true) {
      const creatorConfig = getCreatorConfig();
      const dataBase = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}`;
      const borrar = async (reporte, ids) => {
        const res = {};
        for (const id of ids || []) {
          try {
            const resp = await creatorApiFetch(
              `${dataBase}/report/${encodeURIComponent(reporte)}/${encodeURIComponent(toText(id))}`,
              { method: "DELETE" }
            );
            const payload = await readJson(resp);
            res[id] = { status: resp.status, code: payload?.code, error: payload?.error };
          } catch (e) {
            res[id] = { excepcion: String((e && e.message) || e) };
          }
        }
        return res;
      };
      out.steps.bloques = await borrar("HARDWARE_ALL_DATA", body.bloques);
      out.steps.maestros = await borrar(creatorConfig.reportLinkName, body.maestros);
      out.ok = true;
      res.statusCode = 200;
      res.end(JSON.stringify(out, null, 2));
      return;
    }

    // ── Modo "probeEquipos": ¿qué forma de Formulario_de_Equipos acepta Creator? ──
    //
    // COT-58566 murió con {"code":3001,"error":["Servicios, Row No : 1, Invalid
    // column value for Items"]}, y el string que mandábamos —"901 - [CHI]
    // Instalación RM"— resultó ser EXACTO: aparece igual en COT-58617, COT-58537
    // y COT-58621. O sea que el rechazo no es del catálogo.
    //
    // Hipótesis principal: Items es un dropdown que scriptLoadDeliveriesItems
    // puebla en runtime; por API ese script no corre, la lista queda vacía y
    // cualquier valor es inválido. La grilla Equipos no depende de ese script y
    // en COT-58621 acepta ESE MISMO artículo con Category="Servicio".
    //
    // En vez de elegir a dedo, se prueban las cuatro formas que aparecen en los
    // registros reales y gana la que Creator acepte. Cada variante que pase deja
    // un registro de prueba; sus IDs van en la respuesta para poder borrarlos.
    if (body.probeEquipos === true) {
      const creatorConfig = getCreatorConfig();
      const dataBase = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}`;

      // Maestro de prueba: HuelleroCompany, la única empresa autorizada para esto.
      let masterId = toText(body.masterId);
      if (!masterId) {
        const now = new Date();
        const creatorDate = `${String(now.getDate()).padStart(2, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${now.getFullYear()}`;
        const master = {
          Formulario: "Cotización", FORM_STATUS: "BEING EDITED", STATUS: "BORRADOR", ESTADO_COT: "Vigente",
          Nombre_del_documento: `PROBE EQUIPOS / ${creatorDate}`,
          CRM_Account: "3525045000208660206", CRM_ACCOUNT_NAME: "HuelleroCompany",
          Identificador_Tributario_Empresa: "76622058-4",
          // Obligatorio: sin él Creator rechaza el alta con code 3002
          // ("Enter a value for Correo Ejecutivo Comercial").
          Correo_Vendedor: toText(body.correoVendedor) || "adiazg@geovictoria.com",
          Pa_s_Facturaci_n: "Chile", Moneda: "UF", Linea_de_Negocio: "Estándar",
          Servicio_Recurrente: "Control de Asistencia", Servicios_Recurrentes: ["Control de Asistencia"],
          // El maestro DECLARA el servicio no recurrente que el bloque va a
          // llevar. En las rondas anteriores no lo hacía, y el bloque quedaba
          // huérfano al revés que en COT-58566: allá la declaración no tenía
          // formulario, acá el formulario no tiene declaración. Si el
          // "EditNextStep ... Null value" se apaga con esto, es la misma familia
          // de scripts fallando por el mismo motivo desde el otro lado.
          Servicios_No_Recurrentes: ["Visitas y Servicios Técnicos"],
          Servicio_No_Recurrente_Configurado: ["Visitas y Servicios Técnicos"],
          N_Empleados_Compometidos: 10, Cantidad_de_Usuarios: 10, Cantidad_de_Usuarios_PDF: 10,
          Plantilla_Tabla_de_Cobro: "Sin Plantilla",
        };
        const mresp = await creatorApiFetch(`${dataBase}/form/${encodeURIComponent("Nota_de_Venta")}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: master }),
        });
        const mpayload = await readJson(mresp);
        masterId = toText(mpayload?.data?.ID);
        out.steps.masterCreate = { status: mresp.status, code: mpayload?.code, masterId, error: mpayload?.error };
        if (!masterId) { res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return; }
      }

      // Artículo de instalación: el que rechazó COT-58566. Su IdItemService sale
      // de los registros reales (COT-58617, COT-58537).
      const INSTALACION = "901 - [CHI] Instalación RM";
      const ID_INSTALACION = "1758661000038441163";

      // Campos que los registros reales SÍ traen y nosotros nunca mandábamos.
      // Hito_de_Facturación va con un valor real ("Término Gestión" en los no
      // recurrentes) y no con el placeholder "Cargando..." que usa el código hoy.
      const base = {
        ID_Formulario: masterId,
        Formulario: "Cotización",
        FORM_STATUS: "CREATED",
        IdDuplicatedMasterForm: 0,
        Linea_de_Negocio: "Estándar",
        Moneda: "UF",
        country: "Chile",
        CAN_UPDATE_FIELDS: true,
        Servicio_Producto: "Visitas y Servicios Técnicos",
        SERVICE_TYPE: "No Recurrente",
        // "Cargando..." y NO un valor real. La ronda 1 probó "Término Gestión"
        // —que es lo que traen los registros hechos a mano— y Creator lo rechazó
        // con "Invalid column value for Hito_de_Facturaci_n" en las cuatro
        // variantes: el picklist también es dinámico y por API solo tolera el
        // placeholder. COT-58566 lo confirma por el otro lado: mandaba
        // "Cargando..." y su único error fue el de Items.
        Hito_de_Facturaci_n: "Cargando...",
        // La ronda 2 los omitió y las TRES altas —incluido el control sin
        // grillas— devolvieron "EditNextStep ... Null value occurred while
        // performing Addition operation". Un script que suma montos contra null
        // da justo eso, y los registros reales siempre los traen.
        MontoHW: 0,
        TOTAL_SERVICIOS_ASOCIADOS: 1.5,
        Monto: 1.5,
      };

      // ── Ronda 1 (descartada) ──────────────────────────────────────────────
      // Las cuatro formas que aparecen en los registros reales —Servicios con
      // precios, Servicios con IdItemService, Equipos con Category, y la fila
      // mínima— fueron TODAS rechazadas con "Invalid column value for Items"
      // (o "for Item" en la grilla Equipos). Es decir: por REST no se puede
      // poblar la columna de artículo en NINGUNA de las dos grillas, ni siquiera
      // con el string exacto que esos mismos registros tienen guardado.
      //
      // ── Ronda 2 ───────────────────────────────────────────────────────────
      // Se busca por dónde sí entra:
      //  - el control, para separar el encabezado de las grillas;
      //  - mandar el ID del artículo en vez del nombre;
      //  - y crear primero y agregar la fila después por PATCH, por si la
      //    validación del dropdown solo corre en el alta.
      // ── Ronda 3 ───────────────────────────────────────────────────────────
      // La ronda 2 dejó dos cosas claras:
      //  - F y G SE CREARON (code 3000 + id). Mandar el ID del artículo en vez
      //    del nombre esquiva el "Invalid column value". H, que hizo PATCH con
      //    el nombre, volvió a fallar: la columna de display no es escribible
      //    por API ni al crear ni al actualizar.
      //  - El error de EditNextStep salía también en el control, o sea que era
      //    del encabezado: faltaban los montos, ya agregados arriba.
      // Queda confirmar que la fila no solo entre, sino que quede BIEN
      // guardada — que Creator resuelva el ID al artículo correcto.
      // ── Ronda 4 ───────────────────────────────────────────────────────────
      // La ronda 3 mostró que el ID entra y persiste, pero Creator NO resuelve
      // el artículo: Items / Item quedan en "". Un bloque así saldría en el PDF
      // como una línea con precio y sin descripción. Y el error de EditNextStep
      // siguió apareciendo CON los montos puestos, así que no era eso.
      //
      // Se prueban las dos cosas que quedan:
      //  - el maestro ahora declara el servicio (arriba), por si el null del
      //    script era el bloque sin declaración;
      //  - Category en la fila, que en los registros reales viene "Servicio" y
      //    podría ser lo que dispara la resolución del artículo.
      const variantes = {
        K_servicios_id_y_categoria: {
          ...base,
          Servicios: [{
            IdItemService: ID_INSTALACION, Category: "Servicio",
            Valor_Unidad: 1.5, Cantidad: 1, Total: 1.5, Descuento: 0,
          }],
        },
        L_equipos_id_y_categoria: {
          ...base,
          MontoHW: 1.5,
          TOTAL_SERVICIOS_ASOCIADOS: 0,
          Equipos: [{ ID_item: ID_INSTALACION, Category: "Servicio", Valor: 1.5, Cantidad: 1, Valor_Final: 1.5 }],
        },
      };

      const resultados = {};
      for (const [nombre, record] of Object.entries(variantes)) {
        try {
          const resp = await creatorApiFetch(`${dataBase}/form/${encodeURIComponent("Formulario_de_Equipos")}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: record }),
          });
          const payload = await readJson(resp);
          const id = toText(payload?.data?.ID);
          // El alta y los workflows posteriores fallan por separado: code 3000 +
          // id significa que la fila entró, aunque el script "On Add - On
          // Success" reviente después. Confundirlos fue lo que me hizo leer mal
          // la ronda 2.
          resultados[nombre] = {
            creado: Boolean(id),
            errorDeScript: payload?.error,
            status: resp.status,
            code: payload?.code,
            id: id || undefined,
          };
        } catch (e) {
          resultados[nombre] = { aceptada: false, excepcion: String((e && e.message) || e) };
        }
      }

      // Releer lo creado: que la fila entre no significa que quedara bien. Acá
      // se ve si Creator resolvió el ID al artículo correcto —o sea si la
      // columna de display se pobló sola— y con qué precios quedó.
      for (const [nombre, r] of Object.entries(resultados)) {
        if (!r.id) continue;
        try {
          const leerPath =
            `${dataBase}/report/${encodeURIComponent("HARDWARE_ALL_DATA")}/${encodeURIComponent(r.id)}?field_config=all`;
          const resp = await creatorApiFetch(leerPath, { method: "GET" });
          const payload = await readJson(resp);
          const rec = payload?.data || {};
          r.releido = {
            status: resp.status,
            // Si Creator resolvió bien el ID, la columna de display debería
            // quedar con este texto sin que nosotros lo hayamos mandado.
            articuloEsperado: INSTALACION,
            Servicio_Producto: rec.Servicio_Producto,
            Hito_de_Facturaci_n: rec.Hito_de_Facturaci_n,
            Monto: rec.Monto,
            MontoHW: rec.MontoHW,
            TOTAL_SERVICIOS_ASOCIADOS: rec.TOTAL_SERVICIOS_ASOCIADOS,
            Equipos: rec.Equipos,
            Servicios: rec.Servicios,
          };
        } catch (e) {
          r.releido = { excepcion: String((e && e.message) || e) };
        }
        console.log(`[probe-equipos] ${nombre} → ${JSON.stringify(r.releido)}`);
      }

      out.ok = true;
      out.steps.masterId = masterId;
      out.steps.variantes = resultados;
      out.reviewHint =
        "aceptada:true = Creator la tomó. Los registros creados quedan colgando del maestro " +
        `${masterId} (HuelleroCompany) y hay que borrarlos a mano.`;
      res.statusCode = 200;
      res.end(JSON.stringify(out, null, 2));
      return;
    }

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
        notasPdf: ndvResult?.notasPdf,
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
