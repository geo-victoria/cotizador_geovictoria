// Diagnóstico de la Meta API de Zoho Creator.
// Devuelve la estructura de campos (tipo, obligatorio, valores de picklist) de los
// formularios que emulamos por API, para saber EXACTAMENTE qué aceptar sin adivinar.
//
// Uso:
//   GET /api/creator-meta?secret=<QUOTE_ACCEPTANCE_SECRET>
//   GET /api/creator-meta?secret=...&form=Servicio_Recurrente   (un solo form)
//   GET /api/creator-meta?secret=...&forms=1                    (solo lista de forms)
//   GET /api/creator-meta?secret=...&form=X&full=1              (campos SIN resumir)
//
// Es TEMPORAL: bórralo una vez extraída la estructura.
const { getCreatorConfig, creatorApiFetch } = require("./_shared/zoho-creator-auth");

const DEFAULT_FORMS = ["Nota_de_Venta", "Servicio_Recurrente", "Finalizar_Formulario", "Formulario_de_Equipos"];

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
      const path = `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/report/${encodeURIComponent(report)}/${encodeURIComponent(recId)}`;
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
