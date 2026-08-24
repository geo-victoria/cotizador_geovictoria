const { getZohoConfig, zohoApiFetch } = require("./zoho-auth");

function toText(value) {
  return value == null ? "" : String(value).trim();
}

const moduleFieldsCache = new Map();

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function buildPath(moduleApiName, recordId) {
  const moduleName = encodeURIComponent(toText(moduleApiName));
  const id = encodeURIComponent(toText(recordId));
  return `/crm/v3/${moduleName}/${id}`;
}

function buildModulePath(moduleApiName) {
  const moduleName = encodeURIComponent(toText(moduleApiName));
  return `/crm/v3/${moduleName}`;
}

async function getRecord(moduleApiName, recordId) {
  getZohoConfig();
  const response = await zohoApiFetch(buildPath(moduleApiName, recordId), {
    method: "GET",
  });
  const payload = await readJsonSafe(response);
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!response.ok || !row) {
    const msg =
      toText(payload?.message) ||
      toText(payload?.code) ||
      toText(payload?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho getRecord failed: ${msg}`);
  }
  return row;
}

async function updateRecord(moduleApiName, recordId, fieldsMap, triggerWorkflows) {
  getZohoConfig();
  const payload = {
    data: [fieldsMap || {}],
  };
  if (triggerWorkflows) {
    payload.trigger = ["workflow"];
  }

  const response = await zohoApiFetch(buildPath(moduleApiName, recordId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await readJsonSafe(response);
  const row = Array.isArray(result?.data) ? result.data[0] : null;
  const ok = response.ok && row && /SUCCESS/i.test(toText(row.code || row.status || ""));
  if (!ok) {
    const msg =
      toText(row?.message) ||
      toText(result?.message) ||
      toText(result?.code) ||
      toText(result?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho updateRecord failed: ${msg}`);
  }
  return row;
}

async function getRecordWithFields(moduleApiName, recordId, fields) {
  const cleanedFields = Array.isArray(fields)
    ? fields.map((f) => toText(f)).filter(Boolean)
    : [];
  if (cleanedFields.length === 0) {
    return getRecord(moduleApiName, recordId);
  }

  getZohoConfig();
  const path =
    `${buildPath(moduleApiName, recordId)}?fields=${encodeURIComponent(cleanedFields.join(","))}`;
  const response = await zohoApiFetch(path, { method: "GET" });
  const payload = await readJsonSafe(response);
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!response.ok || !row) {
    const msg =
      toText(payload?.message) ||
      toText(payload?.code) ||
      toText(payload?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho getRecordWithFields failed: ${msg}`);
  }
  return row;
}

async function listRecords(moduleApiName, query) {
  const params = [];
  const source = query && typeof query === "object" ? query : {};
  for (const [key, value] of Object.entries(source)) {
    const k = toText(key);
    const v = toText(value);
    if (!k || !v) continue;
    params.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const queryString = params.length > 0 ? `?${params.join("&")}` : "";

  const response = await zohoApiFetch(`${buildModulePath(moduleApiName)}${queryString}`, {
    method: "GET",
  });
  const payload = await readJsonSafe(response);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (!response.ok) {
    const msg =
      toText(payload?.message) ||
      toText(payload?.code) ||
      toText(payload?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho listRecords failed: ${msg}`);
  }
  return rows;
}

async function searchRecords(moduleApiName, criteria, fields) {
  const module = encodeURIComponent(toText(moduleApiName));
  const crit = toText(criteria);
  if (!crit) {
    throw new Error("criteria requerido para searchRecords.");
  }
  const params = [`criteria=${encodeURIComponent(crit)}`];
  const cleanedFields = Array.isArray(fields)
    ? fields.map((f) => toText(f)).filter(Boolean)
    : [];
  if (cleanedFields.length > 0) {
    params.push(`fields=${encodeURIComponent(cleanedFields.join(","))}`);
  }
  const path = `/crm/v3/${module}/search?${params.join("&")}`;
  const response = await zohoApiFetch(path, { method: "GET" });
  const payload = await readJsonSafe(response);
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  if (response.status === 204) return [];
  if (!response.ok) {
    const code = toText(payload?.code);
    if (code === "INVALID_DATA" || code === "INVALID_QUERY") {
      return [];
    }
    const msg =
      toText(payload?.message) ||
      code ||
      toText(payload?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho searchRecords failed: ${msg}`);
  }
  return rows;
}

async function createRecord(moduleApiName, fieldsMap, triggerWorkflows) {
  getZohoConfig();
  const payload = {
    data: [fieldsMap || {}],
  };
  if (triggerWorkflows) {
    payload.trigger = ["workflow"];
  }

  const response = await zohoApiFetch(buildModulePath(moduleApiName), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await readJsonSafe(response);
  const row = Array.isArray(result?.data) ? result.data[0] : null;
  const ok = response.ok && row && /SUCCESS/i.test(toText(row.code || row.status || ""));
  if (!ok) {
    const msg =
      toText(row?.message) ||
      toText(result?.message) ||
      toText(result?.code) ||
      toText(result?.raw) ||
      `HTTP ${response.status}`;
    // El "invalid data" pelado de Zoho es indiagnosticable (caso Anderson
    // 24-ago: 14 reintentos ciegos) — los details traen api_name/index del
    // campo culpable y van al mensaje. Y el payload queda en el log.
    const detalles = row?.details ? ` details=${JSON.stringify(row.details).slice(0, 300)}` : "";
    console.error(
      `[zoho-crm] createRecord ${moduleApiName} falló: ${msg}${detalles} payload=${JSON.stringify(payload).slice(0, 1800)}`,
    );
    throw new Error(`Zoho createRecord failed: ${msg}${detalles}`);
  }

  return {
    id: toText(row?.details?.id),
    row,
  };
}

async function getModuleFields(moduleApiName, forceRefresh) {
  const module = toText(moduleApiName);
  if (!module) {
    throw new Error("moduleApiName requerido para getModuleFields.");
  }
  if (!forceRefresh && moduleFieldsCache.has(module)) {
    return moduleFieldsCache.get(module);
  }

  const path = `/crm/v3/settings/fields?module=${encodeURIComponent(module)}`;
  const response = await zohoApiFetch(path, { method: "GET" });
  const payload = await readJsonSafe(response);
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  if (!response.ok) {
    const msg =
      toText(payload?.message) ||
      toText(payload?.code) ||
      toText(payload?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho getModuleFields failed: ${msg}`);
  }
  moduleFieldsCache.set(module, fields);
  return fields;
}

async function getModuleFieldNames(moduleApiName, forceRefresh) {
  const fields = await getModuleFields(moduleApiName, forceRefresh);
  return new Set(fields.map((field) => toText(field?.api_name)).filter(Boolean));
}

function buildFilteredFieldsMap(fieldsMap, allowedNamesSet) {
  const source = fieldsMap && typeof fieldsMap === "object" ? fieldsMap : {};
  const target = {};
  const skipped = [];
  for (const [key, value] of Object.entries(source)) {
    const apiName = toText(key);
    if (!apiName) continue;
    if (!allowedNamesSet || allowedNamesSet.has(apiName)) {
      target[apiName] = value;
    } else {
      skipped.push(apiName);
    }
  }
  return { filtered: target, skipped };
}

async function updateRecordBestEffort(moduleApiName, recordId, fieldsMap, triggerWorkflows) {
  const allowedNames = await getModuleFieldNames(moduleApiName, false);
  const { filtered, skipped } = buildFilteredFieldsMap(fieldsMap, allowedNames);
  const usedKeys = Object.keys(filtered);
  if (usedKeys.length === 0) {
    return {
      skipped: true,
      usedKeys: [],
      skippedKeys: skipped,
      row: null,
    };
  }
  const row = await updateRecord(moduleApiName, recordId, filtered, triggerWorkflows);
  return {
    skipped: false,
    usedKeys,
    skippedKeys: skipped,
    row,
  };
}

async function getUserById(userId) {
  const id = toText(userId);
  if (!id) return null;

  const response = await zohoApiFetch(`/crm/v3/users/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  const payload = await readJsonSafe(response);
  const user = Array.isArray(payload?.users) ? payload.users[0] : null;
  if (!response.ok || !user) {
    const msg =
      toText(payload?.message) ||
      toText(payload?.code) ||
      toText(payload?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho getUserById failed: ${msg}`);
  }
  return user;
}

module.exports = {
  getRecord,
  getRecordWithFields,
  listRecords,
  searchRecords,
  createRecord,
  updateRecord,
  updateRecordBestEffort,
  getModuleFields,
  getModuleFieldNames,
  getUserById,
  readJsonSafe,
  toText,
};
