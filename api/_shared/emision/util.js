/**
 * EMISIÓN ÚNICA — utilidades puras compartidas (fase 1, 28-sep).
 *
 * Copias LITERALES de las funciones que hoy viven repetidas en los cuatro
 * endpoints `create-from-vicky{,-pe,-co,-mx}.js`. En esta fase los endpoints
 * NO las importan todavía (conservan sus copias: cero cambio de conducta);
 * las usa `emitir.js`, que es el cuerpo del handler chileno parametrizado por
 * la ficha del país. La prueba de identidad (tests/emision) demuestra que el
 * resultado es el mismo que el del handler chileno.
 *
 * Lo único que cambia respecto de las copias originales es la ETIQUETA del
 * log (el nombre del endpoint), que llega como parámetro.
 */
const { getRecord, updateRecord, toText } = require("../zoho-crm");
const { zohoApiFetch } = require("../zoho-auth");

// ── CORS (idéntico en los cuatro endpoints) ──
function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowedList = (process.env.ALLOWED_UPLOAD_ORIGINS || "")
    .split(",").map(v => v.trim()).filter(Boolean);
  const allowedByRule =
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin) ||
    origin === "https://cotizacion.geovictoria.com" ||
    origin === "http://localhost:3000";
  const allowed = !origin || allowedByRule || allowedList.includes(origin);
  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
  return allowed;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return typeof req.body === "object" ? req.body : {};
}

function splitFullName(fullName) {
  const clean = (fullName || "").trim();
  if (!clean) return { firstName: "Cliente", lastName: "Vicky" };
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" "),
  };
}

// waitUntil de Vercel (trabajo en segundo plano después de responder), con el
// mismo respaldo best-effort de los endpoints si el paquete no está.
function cargarWaitUntil() {
  try {
    return require("@vercel/functions").waitUntil;
  } catch (_e) {
    return (p) => {
      Promise.resolve(p).catch(() => {});
    };
  }
}

// ── Errores de Zoho ──
function isInvalidIdError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("id given seems to be invalid") ||
    message.includes("invalid_data") ||
    message.includes("invalid id") ||
    message.includes("the id is invalid") ||
    // Registro BORRADO (papelera): Zoho responde 204 y getRecord lo envuelve
    // como "HTTP 204" (caso 14-ago, COT569/COT577).
    message.includes("http 204") ||
    message.includes("resource_not_found")
  );
}

// "duplicate data" al crear/actualizar (campo UNIQUE ya existente), incluida
// la variante "Multiple errors in the request" (2+ UNIQUE a la vez).
function isDuplicateDataError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("duplicate data") ||
    message.includes("duplicate_data") ||
    message.includes("multiple errors")
  );
}

// ── COQL (solo para la dedup de las capas 3/4) ──
async function executeCoqlQuery(selectQuery) {
  try {
    const response = await zohoApiFetch("/crm/v3/coql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: selectQuery }),
    });
    if (response.status === 204) return [];
    const text = await response.text();
    if (!response.ok) {
      console.warn(`[executeCoqlQuery] error ${response.status}: ${text.slice(0, 150)}`);
      return [];
    }
    const parsed = JSON.parse(text);
    return parsed?.data || [];
  } catch (err) {
    console.warn(`[executeCoqlQuery] excepción: ${err.message?.slice(0, 150)}`);
    return [];
  }
}

async function findContactIdByEmail(email) {
  if (!email) return null;
  const emailNorm = String(email).trim().toLowerCase();
  if (!emailNorm) return null;
  const query = `select id from Contacts where Email = '${emailNorm.replace(/'/g, "''")}' limit 1`;
  const rows = await executeCoqlQuery(query);
  return toText(rows[0]?.id) || null;
}

// ── Update conservador: solo campos vacíos del registro existente ──
function buildConservativePayload(fullPayload, existingRecord) {
  if (!existingRecord) return fullPayload;
  const conservative = {};
  for (const [key, newValue] of Object.entries(fullPayload)) {
    if (newValue === undefined || newValue === null) continue;
    const currentValue = existingRecord[key];
    const isEmpty = currentValue === null || currentValue === undefined || currentValue === "";
    if (isEmpty) {
      conservative[key] = newValue;
    }
  }
  return conservative;
}

/**
 * Reusa un registro con update conservador. ID inválido → {ok:false,
 * invalidId:true} (el caller crea uno nuevo). DUPLICATE_DATA en el update →
 * reintenta sin Email/Phone y el reuso se mantiene (caso Santa Lucía 06-ago).
 */
async function tryReuseRecord(module, recordId, fullPayload, etiqueta = "emision") {
  try {
    const existing = await getRecord(module, recordId);
    if (!existing) {
      console.warn(`[${etiqueta}] ${module}/${recordId} no existe, fallback a crear nuevo`);
      return { ok: false, invalidId: true };
    }
    const conservativePayload = buildConservativePayload(fullPayload, existing);
    if (Object.keys(conservativePayload).length > 0) {
      await updateRecord(module, recordId, conservativePayload, true);
    }
    return { ok: true, recordId };
  } catch (error) {
    if (isInvalidIdError(error)) {
      console.warn(
        `[${etiqueta}] ${module}/${recordId} reportado como inválido por Zoho, fallback a crear nuevo. Detalle: ${error.message?.slice(0, 150)}`
      );
      return { ok: false, invalidId: true };
    }
    if (isDuplicateDataError(error)) {
      try {
        const existing = await getRecord(module, recordId).catch(() => null);
        const retry = existing ? buildConservativePayload(fullPayload, existing) : { ...fullPayload };
        delete retry.Email;
        delete retry.Phone;
        if (Object.keys(retry).length > 0) await updateRecord(module, recordId, retry, true);
        console.warn(
          `[${etiqueta}] ${module}/${recordId}: update conservador chocó con campo UNIQUE (${String(error.message || "").slice(0, 120)}) — reuso mantenido, Email/Phone omitidos`
        );
      } catch (retryErr) {
        console.warn(
          `[${etiqueta}] ${module}/${recordId}: reintento sin campos únicos también falló (${String(retryErr?.message || retryErr).slice(0, 120)}) — reuso mantenido sin update`
        );
      }
      return { ok: true, recordId, uniqueConflict: true };
    }
    throw error;
  }
}

// ── Lead convertido: ids desde $converted_detail (verificado 17-jul) ──
async function recoverConvertedIds(leadId, etiqueta = "emision") {
  try {
    const response = await zohoApiFetch(
      `/crm/v3/Leads?ids=${encodeURIComponent(leadId)}&converted=true&fields=id,$converted_detail`,
    );
    if (!response.ok) return {};
    const detail = (await response.json())?.data?.[0]?.["$converted_detail"] || {};
    const ids = {
      accountId: toText(detail.account),
      contactId: toText(detail.contact),
      dealId: toText(detail.deal),
    };
    if (ids.accountId || ids.contactId || ids.dealId) {
      console.warn(
        `[${etiqueta}] IDs recuperados de $converted_detail lead=${leadId}: account=${ids.accountId || "-"} contact=${ids.contactId || "-"} deal=${ids.dealId || "-"}`,
      );
    }
    return ids;
  } catch {
    return {};
  }
}

// Consulta al AGENTE si el contacto está marcado para reactivar un deal
// perdido (vic_kv `reactivar_deal_<fono>` = id del deal). Best-effort.
async function dealAReactivarEnAgente(fono) {
  try {
    const base = toText(process.env.VICKY_AGENT_NOTIFY_URL);
    const secret = toText(process.env.VICKY_AGENT_CRON_SECRET);
    if (!base || !secret || !fono) return "";
    const origin = new URL(base).origin;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${origin}/api/vic-admin-kv?k=reactivar_deal_${encodeURIComponent(fono)}`, {
      headers: { "x-cron-secret": secret },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return "";
    const j = await r.json().catch(() => ({}));
    const v = toText(j?.value);
    return /^\d{6,}$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

// ── Picklists del subform Detalle_Items_Cotizacion (mismos en los 4 países) ──
// "Único" NO es pago único: es el reference_value del display "Fijo" (tarifa
// fija MENSUAL). Los pagos únicos reales van a "Venta".
function mapModalidadToZoho(modalidadVicky) {
  const m = String(modalidadVicky || "").toLowerCase().trim();
  if (m.startsWith("por usuario")) return "Recurrente";
  if (m.startsWith("fijo")) return "Único";
  if (m.startsWith("arriendo")) return "Arriendo";
  if (m.startsWith("venta")) return "Venta";
  if (m.includes("único") || m.includes("unico") || m.includes("única") || m.includes("unica")) {
    return "Venta";
  }
  return "Recurrente";
}

function isItemRecurrente(modalidadZoho) {
  return (
    modalidadZoho === "Recurrente" ||
    modalidadZoho === "Arriendo" ||
    modalidadZoho === "Único"
  );
}

function mapUnidadToZoho(modalidadZoho, tipo) {
  if (tipo === "hardware") return "Dispositivo";
  if (modalidadZoho === "Recurrente") return "Usuario";
  if (modalidadZoho === "Único") return "Servicio";
  return "Unidad";
}

// Categoría en Chile: por tipo + id "asistencia".
function mapCategoriaToZohoCL(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  const id = String(item.id || "").toLowerCase();
  if (tipo === "hardware") return "Equipos Biometricos";
  if (id === "asistencia") return "Plataforma Asistencia";
  if (tipo === "modulo") return "Modulos Adicionales";
  return "Otro";
}

// Categoría en PE/CO/MX: el plan viene con tipo "plan".
function mapCategoriaToZohoPais(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  if (tipo === "hardware") return "Equipos Biometricos";
  if (tipo === "plan") return "Plataforma Asistencia";
  if (tipo === "modulo") return "Modulos Adicionales";
  return "Otro";
}

// Número de cotización del PDF: correlativo de Zoho sin "COT".
function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

/** Escalera de precios que el agente manda por ítem, indexada por Codigo_Item. */
function collectEscalerasPrecio(items) {
  if (!Array.isArray(items)) return {};
  const out = {};
  for (const item of items) {
    const codigo = String(item?.id || "").trim();
    const escalera = Array.isArray(item?.escalera) ? item.escalera : [];
    if (!codigo || escalera.length === 0) continue;
    out[codigo] = escalera.map((tramo) => ({
      desde: Number(tramo?.desde || 0),
      hasta: Number(tramo?.hasta || 0),
      modalidad: String(tramo?.modalidad || ""),
      precioUF: Number(tramo?.precioUF || 0),
    }));
  }
  return out;
}

module.exports = {
  setCors,
  sendJson,
  parseBody,
  splitFullName,
  cargarWaitUntil,
  isInvalidIdError,
  isDuplicateDataError,
  executeCoqlQuery,
  findContactIdByEmail,
  buildConservativePayload,
  tryReuseRecord,
  recoverConvertedIds,
  dealAReactivarEnAgente,
  mapModalidadToZoho,
  isItemRecurrente,
  mapUnidadToZoho,
  mapCategoriaToZohoCL,
  mapCategoriaToZohoPais,
  numeroParaPdf,
  collectEscalerasPrecio,
  toText,
};
