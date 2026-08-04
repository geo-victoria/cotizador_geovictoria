// Diagnóstico de la Meta API de Zoho Creator.
// Devuelve la estructura de campos (tipo, obligatorio, valores de picklist) de los
// formularios que emulamos por API, para saber EXACTAMENTE qué aceptar sin adivinar.
//
// Uso:
//   GET /api/creator-meta?secret=<QUOTE_ACCEPTANCE_SECRET>
//   GET /api/creator-meta?secret=...&form=Servicio_Recurrente   (un solo form)
//   GET /api/creator-meta?secret=...&forms=1                    (solo lista de forms)
//   GET /api/creator-meta?secret=...&form=X&full=1              (campos SIN resumir)
//   GET /api/creator-meta?secret=...&record=COT-58504&full=1   (registro ALL_DATA completo)
//   GET /api/creator-meta?secret=...&reports=1                  (reportes de la app)
//   GET /api/creator-meta?secret=...&rows=REPORTE               (registros de cualquier reporte)
//
// Es TEMPORAL: bórralo una vez extraída la estructura.
const { getCreatorConfig, creatorApiFetch } = require("./_shared/zoho-creator-auth");

const DEFAULT_FORMS = ["Nota_de_Venta", "Servicio_Recurrente", "Finalizar_Formulario", "Formulario_de_Equipos"];

// Hasta dónde se muestra un campo de texto largo antes de resumirlo.
const LIMITE_BLOB_POR_DEFECTO = 4000;

function resumirBlob(valor, anticipo) {
  const texto = typeof valor === "string" ? valor : valor ? JSON.stringify(valor) : "";
  if (!texto) return { presente: false, largo: 0 };
  return { presente: true, largo: texto.length, inicio: texto.slice(0, anticipo) };
}

/**
 * Recorta SOLO lo que no entra en el límite, sin lista de campos a mano.
 *
 * Los catálogos que alimentan los dropdowns dinámicos —QuotationServicesList,
 * QuotationDelItemList, QuotationHwItemList— son justamente lo que se viene a
 * leer acá, y cuáles son los pesados cambia según el formulario. Resumir por
 * tamaño y no por nombre evita tener que tocar el código cada vez: si uno queda
 * cortado, se sube el techo con &anticipo=N.
 */
function resumirRegistro(rec, limite) {
  const out = {};
  for (const [clave, valor] of Object.entries(rec || {})) {
    out[clave] = typeof valor === "string" && valor.length > limite ? resumirBlob(valor, limite) : valor;
  }
  return out;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { raw: text.slice(0, 500) };
  }
}

// Reduce cada campo a lo esencial para decidir qué enviar.
function summarizeField(f) {
  const out = {
    link_name: f.link_name || f.field_link_name || f.api_name,
    display: f.display_name,
    type: f.type,
    required: f.required === true || f.mandatory === true || undefined,
    max: f.max_char || undefined,
  };
  // Valores de picklist / dropdown / multiselect
  const choices = f.choices || f.picklist_values || f.values;
  if (Array.isArray(choices) && choices.length > 0) {
    out.choices = choices.map((c) => (typeof c === "string" ? c : c.display_value || c.value || c)).slice(0, 60);
  }
  // Subformularios (type 21): sin esto solo se veía "es un grid" y había que
  // adivinar sus columnas. Se arrastran tanto el formulario hijo como sus
  // campos, según cómo los devuelva la Meta API en este tenant.
  const sub = f.subform || f.sub_form || f.child_form || f.lookup;
  if (sub && typeof sub === "object") {
    out.subform = {
      form_link_name: sub.form_link_name || sub.link_name || sub.form || undefined,
      display: sub.display_name || undefined,
      columnas: Array.isArray(sub.fields) ? sub.fields.map((c) => c.link_name || c.api_name) : undefined,
    };
  }
  if (Array.isArray(f.fields) && f.fields.length > 0) {
    out.columnas = f.fields.map((c) => c.link_name || c.api_name || c.display_name);
  }
  return out;
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

  const config = getCreatorConfig();
  const out = { ok: false, owner: config.ownerName, app: config.appLinkName, missing: config.missing };
  if (config.missing.length > 0) {
    res.statusCode = 500;
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  const base = `/creator/v2.1/meta/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}`;

  // Búsqueda por criterio: ?search=REPORT:FIELD:VALUE → cuenta + resumen
  if (req.query?.search) {
    try {
      const [report, field, value] = String(req.query.search).split(":");
      const criteria = encodeURIComponent(`${field}=="${value}"`);
      const path = `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/report/${encodeURIComponent(report)}?criteria=${criteria}&max_records=200`;
      const resp = await creatorApiFetch(path, { method: "GET" });
      const payload = await readJson(resp);
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      out.ok = true;
      out.search = {
        report, field, value, status: resp.status, count: rows.length,
        rows: rows.map((r) => ({
          ID: r.ID,
          Servicio_Recurrente: r.Servicio_Recurrente,
          FORM_STATUS: r.FORM_STATUS,
          Tabla_len: Array.isArray(r.Tabla_de_Cobro) ? r.Tabla_de_Cobro.length : 0,
          JsonPdf_present: Boolean(r.JsonPdf),
          Fecha_de_Inicio: r.Fecha_de_Inicio,
        })),
      };
      res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return;
    } catch (e) {
      out.error = String((e && e.stack) || (e && e.message) || e);
      res.statusCode = 500; res.end(JSON.stringify(out, null, 2)); return;
    }
  }

  // Lectura cruda de un registro por ID en cualquier reporte: ?raw=REPORT:ID
  // Ej: ?raw=SERVICES_ALL_DATA:3783684000024667176  (ver JsonPdf del sub-registro)
  if (req.query?.raw) {
    try {
      const [report, recId] = String(req.query.raw).split(":");
      // field_config=all: sin esto Creator devuelve SOLO las columnas del layout
      // del reporte, y los subformularios (Servicios, Equipos) casi nunca están
      // ahí — HARDWARE_ALL_DATA y Formulario_de_Equipos_Report devuelven ambos
      // una proyección de ~10 campos sin la grilla Servicios.
      const path =
        `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}` +
        `/report/${encodeURIComponent(report)}/${encodeURIComponent(recId)}?field_config=all`;
      const resp = await creatorApiFetch(path, { method: "GET" });
      const payload = await readJson(resp);
      const data = payload?.data || {};
      out.ok = true;
      if (req.query?.full) {
        out.rawFull = { report, recId, status: resp.status, data };
        res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return;
      }
      out.raw = {
        report, recId, status: resp.status,
        Servicio_Recurrente: data.Servicio_Recurrente,
        FORM_STATUS: data.FORM_STATUS,
        JsonPdf_present: Boolean(data.JsonPdf),
        JsonPdf: data.JsonPdf,
        Tabla_de_Cobro_len: Array.isArray(data.Tabla_de_Cobro) ? data.Tabla_de_Cobro.length : 0,
        N_Empleados_Compometidos: data.N_Empleados_Compometidos,
        ID_Formulario: data.ID_Formulario,
      };
      res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return;
    } catch (e) {
      out.error = String((e && e.stack) || (e && e.message) || e);
      res.statusCode = 500; res.end(JSON.stringify(out, null, 2)); return;
    }
  }

  // Búsqueda de un registro real por ID_NDV → vuelca Form_Order / FORM_STATUS / PDF.
  if (req.query?.record) {
    try {
      const idNdv = String(req.query.record);
      const dataBase = `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/report/${encodeURIComponent(config.reportLinkName)}`;
      const criteria = encodeURIComponent(`ID_NDV=="${idNdv}"`);
      const resp = await creatorApiFetch(`${dataBase}?criteria=${criteria}&max_records=200`, { method: "GET" });
      const payload = await readJson(resp);
      const rec = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
      if (!rec) {
        out.ok = true;
        out.record = { status: resp.status, found: false, raw: payload };
      } else if (req.query?.full) {
        // Volcado completo del registro de ALL_DATA (el mismo reporte que se ve
        // en la app de Creator), para diagnosticar sin ir campo por campo.
        // PDF_STRING y JsonPdf se resumen: son base64 y JSON de varios MB que
        // harían la respuesta inmanejable. Se informa su tamaño y un anticipo.
        const completo = { ...rec };
        completo.PDF_STRING = resumirBlob(rec.PDF_STRING, 120);
        completo.JsonPdf = resumirBlob(rec.JsonPdf, 4000);
        out.ok = true;
        out.record = { status: resp.status, found: true, full: true, data: completo };
        res.statusCode = 200;
        res.end(JSON.stringify(out, null, 2));
        return;
      } else {
        out.ok = true;
        out.record = {
          status: resp.status,
          found: true,
          ID: rec.ID,
          ID_NDV: rec.ID_NDV,
          CRM_REFERENCE_ID: rec.CRM_REFERENCE_ID,
          CRM_Deal: rec.CRM_Deal,
          CRM_Account: rec.CRM_Account,
          Formulario: rec.Formulario,
          FORM_STATUS: rec.FORM_STATUS,
          STATUS: rec.STATUS,
          ESTADO_COT: rec.ESTADO_COT,
          Servicios_Recurrentes: rec.Servicios_Recurrentes,
          Servicios_No_Recurrentes: rec.Servicios_No_Recurrentes,
          Servicio_Recurrente_Configurado: rec.Servicio_Recurrente_Configurado,
          Form_Order_len: Array.isArray(rec.Form_Order) ? rec.Form_Order.length : 0,
          Form_Order: rec.Form_Order,
          JsonPdf_present: Boolean(rec.JsonPdf),
          PDF_STRING_present: Boolean(rec.PDF_STRING),
          PDF_URL: rec.PDF_URL,
          N_Empleados_Compometidos: rec.N_Empleados_Compometidos,
          Tabla_de_Cobro_len: Array.isArray(rec.Tabla_de_Cobro) ? rec.Tabla_de_Cobro.length : 0,
        };
      }
      res.statusCode = 200;
      res.end(JSON.stringify(out, null, 2));
      return;
    } catch (e) {
      out.error = String((e && e.stack) || (e && e.message) || e);
      res.statusCode = 500;
      res.end(JSON.stringify(out, null, 2));
      return;
    }
  }

  // Reportes de la app: ?reports=1
  // Los registros de un formulario solo se leen a través de SU reporte, y el
  // link name del reporte no tiene por qué parecerse al del formulario. Sin esta
  // lista había que adivinarlo.
  if (req.query?.reports) {
    try {
      const resp = await creatorApiFetch(`${base}/reports`, { method: "GET" });
      const payload = await readJson(resp);
      const reports = payload?.reports || payload?.data;
      out.ok = true;
      out.reportsList = {
        status: resp.status,
        reports: Array.isArray(reports)
          ? reports.map((r) => ({
              link_name: r.link_name || r.report_link_name,
              display: r.display_name,
              form: r.form_link_name || undefined,
              type: r.type || undefined,
            }))
          : payload,
      };
      res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return;
    } catch (e) {
      out.error = String((e && e.stack) || (e && e.message) || e);
      res.statusCode = 500; res.end(JSON.stringify(out, null, 2)); return;
    }
  }

  // Volcado de registros de CUALQUIER reporte:
  //   ?rows=REPORTE[&criteria=...][&max=N][&anticipo=N][&full=1]
  //
  // Nace para leer Formulario_de_Equipos. La columna Items de la grilla
  // "Servicios Asociados" es un dropdown DINÁMICO: lo arma scriptLoadDeliveriesItems
  // en runtime desde QuotationDelItemList / QuotationServicesList, así que la Meta
  // API devuelve el campo sin choices y la única fuente de verdad sobre qué valor
  // acepta es un registro REAL —creado a mano o por el widget— junto al catálogo
  // que ese registro trae adentro.
  //
  // Para encontrar uno con servicios asociados:
  //   ?rows=<reporte>&criteria=TOTAL_SERVICIOS_ASOCIADOS>0&max=3
  if (req.query?.rows) {
    try {
      const report = String(req.query.rows);
      // Creator solo acepta max_records ∈ {200, 500, 1000}; cualquier otro valor
      // es un 400 (code 9250). Se pide siempre el tramo más chico y se recorta
      // acá: &max es cuántos registros quiero LEER, no cuántos traer.
      const max = Math.min(Math.max(Number(req.query.max) || 3, 1), 200);
      const anticipo = Math.min(Math.max(Number(req.query.anticipo) || LIMITE_BLOB_POR_DEFECTO, 200), 60000);
      const criteria = String(req.query.criteria || "").trim();
      // field_config=all por el mismo motivo que en el modo raw: sin esto vuelve
      // solo el layout del reporte, sin los subformularios.
      const params = ["max_records=200", "field_config=all"];
      if (criteria) params.push(`criteria=${encodeURIComponent(criteria)}`);
      const path =
        `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}` +
        `/report/${encodeURIComponent(report)}?${params.join("&")}`;
      const resp = await creatorApiFetch(path, { method: "GET" });
      const payload = await readJson(resp);
      const todas = Array.isArray(payload?.data) ? payload.data : [];
      const rows = todas.slice(0, max);
      out.ok = true;
      out.rows = {
        report,
        criteria: criteria || undefined,
        status: resp.status,
        count: rows.length,
        // Cuántos cumplían el criterio, más allá de los que se devuelven.
        disponibles: todas.length,
        // Sin registros la respuesta de Creator trae el motivo (reporte
        // inexistente, criterio inválido); se devuelve cruda para no perderlo.
        data: rows.length === 0 ? payload : rows.map((r) => (req.query?.full ? r : resumirRegistro(r, anticipo))),
      };
      res.statusCode = 200; res.end(JSON.stringify(out, null, 2)); return;
    } catch (e) {
      out.error = String((e && e.stack) || (e && e.message) || e);
      res.statusCode = 500; res.end(JSON.stringify(out, null, 2)); return;
    }
  }

  try {
    // Lista de formularios de la app
    const formsResp = await creatorApiFetch(`${base}/forms`, { method: "GET" });
    const formsPayload = await readJson(formsResp);
    out.formsList = {
      status: formsResp.status,
      forms: Array.isArray(formsPayload?.forms)
        ? formsPayload.forms.map((f) => f.link_name || f.form_link_name || f.display_name)
        : formsPayload,
    };

    if (req.query?.forms) {
      out.ok = true;
      res.statusCode = 200;
      res.end(JSON.stringify(out, null, 2));
      return;
    }

    // Campos de cada formulario objetivo
    const targetForms = req.query?.form ? [String(req.query.form)] : DEFAULT_FORMS;
    out.fields = {};
    for (const form of targetForms) {
      const resp = await creatorApiFetch(`${base}/form/${encodeURIComponent(form)}/fields`, { method: "GET" });
      const payload = await readJson(resp);
      const rawFields = payload?.fields || payload?.data || [];
      out.fields[form] = {
        status: resp.status,
        count: Array.isArray(rawFields) ? rawFields.length : 0,
        // ?full=1 devuelve el objeto crudo de cada campo, sin resumir. Es el
        // último recurso cuando el resumen no alcanza (p. ej. las columnas de
        // un subformulario si este tenant las expone con otra forma).
        fields: req.query?.full
          ? rawFields
          : Array.isArray(rawFields)
            ? rawFields.map(summarizeField)
            : payload,
      };
    }

    out.ok = true;
    res.statusCode = 200;
    res.end(JSON.stringify(out, null, 2));
  } catch (e) {
    out.error = String((e && e.stack) || (e && e.message) || e);
    res.statusCode = 500;
    res.end(JSON.stringify(out, null, 2));
  }
};
