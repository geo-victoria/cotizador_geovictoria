/**
 * POST /api/quote-acceptance/create-from-vicky-pe — Cotización formal PERÚ.
 *
 * Espejo del endpoint CO (create-from-vicky-co.js) con las reglas peruanas
 * de la Fase 2 (11-ago-2026):
 *   - Moneda: PEN directo (sin UF). Los items vienen YA calculados por el
 *     motor de precios PE del agente (lib/paises/pe/cotizar.ts).
 *   - IGV 18 % EN TODOS los conceptos (afectoIgv por línea; a diferencia de
 *     CO donde solo el hardware es afecto).
 *   - Documento tributario: RUC (11 dígitos, checksum SUNAT). Va en
 *     RUT_Cliente (cabecera) y RUT_Empresa de la cuenta (convención
 *     "documento tributario del país en el mismo campo").
 *   - ACTIVACIÓN = PRIMER MES COMPLETO por adelantado (plan + arriendos,
 *     patrón del pago inicial CL — distinto de CO donde es solo el plan).
 *     Si el agente la manda (p. ej. con el 20 % de cierre aplicado), se
 *     respeta la suya; si no, se agrega a precio de lista.
 *   - Owner: Mónica Mendoza (ejecutiva única del canal PE, sin tómbola) —
 *     env VICKY_PE_OWNER_ID.
 *   - Token de aceptación firmado con pais:"pe" → session/payment cobran
 *     con la app MP Perú (PEN) y muestran RUC/S/ en la página.
 *
 * Auth: header `x-vicky-secret` contra VICKY_COTIZADORA_SECRET_PE y, si esa
 * env no existe, contra VICKY_COTIZADORA_SECRET (mismo esquema que CO).
 *
 * ── CONTRATO DEL BODY (JSON) ────────────────────────────────────────────────
 * {
 *   "empresa":          string  (requerido)
 *   "contacto":         string  (requerido)
 *   "contactoEmail":    string  (requerido)
 *   "ruc":              string  (requerido) — 11 dígitos, se valida checksum
 *   "contactoTelefono": string  (opcional)
 *   "userCount":        number  (opcional)
 *   "items": [          (requerido, no vacío)
 *     { "tipo": "plan"|"hardware"|"servicio"|"activacion", "id", "nombre",
 *       "descripcion"?, "modalidad", "cantidad",
 *       "precioUnitarioPEN": number, "subtotalPEN": number,
 *       "esRecurrente": boolean, "afectoIgv": boolean }
 *   ]
 * }
 *
 * Respuesta 200: { ok, quoteId, dealId, accountId, contactId, acceptanceUrl,
 *                  pdfUrl:"", pdfPendiente:true, expiresAt } — el PDF se
 * genera en segundo plano (waitUntil), igual que CL/CO.
 */

const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { actualizarPunteroPdf } = require("../_shared/pointer-sync");
const { claveIdempotencia, getIdempotente, setIdempotente, getDealPorFono, setDealPorFono } = require("../_shared/idempotencia");
const { sendQuoteEmailViaZoho, buildEmailHtml } = require("./create-from-vicky");
const { createRecord, updateRecord, getRecordWithFields, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtmlPE, IGV_PE } = require("../_shared/proposal-html-builder-pe");

let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch (_e) {
  waitUntil = (p) => {
    Promise.resolve(p).catch(() => {});
  };
}

// ── Defaults PE (Territorio y moneda verificados contra los picklists reales
// del org: deals PE históricos usan Territorio "Perú" y Monda_del_trato "SOL") ──
const VICKY_PE_DEAL_STAGE = toText(process.env.VICKY_DEAL_STAGE_INICIAL) || "4. Propuesta Enviada / En Negociación";
const VICKY_PE_LEAD_SOURCE = toText(process.env.VICKY_LEAD_SOURCE) || "SEO";
const VICKY_PE_TERRITORIO = toText(process.env.VICKY_TERRITORIO_PE) || "Perú";
const VICKY_PE_MONEDA = toText(process.env.VICKY_MONEDA_PE) || "SOL";
const VICKY_PE_TOMBOLA = toText(process.env.VICKY_TOMBOLA) || "Mantener propietario";
const VICKY_PE_PRODUCTO = toText(process.env.VICKY_PRODUCTO_DEFAULT) || "Control de Asistencia";
const VICKY_PE_SECTOR = toText(process.env.VICKY_SECTOR_FALLBACK) || "19. Servicios";
const VICKY_PE_EXPANSION = toText(process.env.VICKY_EXPANSION_REGIONAL) || "No";

// Mónica Mendoza — ejecutiva única del canal PE (ficha Zoho verificada).
const VICKY_PE_OWNER_ID = toText(process.env.VICKY_PE_OWNER_ID) || "3525045000323383015";
const OWNER_PE = VICKY_PE_OWNER_ID ? { id: VICKY_PE_OWNER_ID } : undefined;

// Owners cuyo lead vivo se puede cerrar/adoptar (bot + Mónica): un lead de
// otro dueño humano no se toca.
const OWNERS_ADOPTABLES_PE = new Set([
  "3525045000484500876", // Vicky GeoVictoria
  VICKY_PE_OWNER_ID, // Mónica Mendoza
]);

const INTERNAL_ACCOUNT_NAMES = (process.env.VICKY_INTERNAL_ACCOUNT_NAMES || "GeoVictoria")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ── RUC (SUNAT): 11 dígitos, prefijos válidos, dígito verificador mod 11.
// Mismo algoritmo que lib/rut.ts del agente (verificado con el RUC real de
// la entidad peruana: 20605842055).
function rucValido(rucRaw) {
  const ruc = String(rucRaw || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(ruc)) return false;
  if (!/^(10|15|16|17|20)/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(ruc[i]), 0);
  const resto = 11 - (suma % 11);
  const dv = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return dv === Number(ruc[10]);
}

function rucParaGuardar(ruc) {
  return String(ruc || "").replace(/\D/g, "");
}

// ── CORS (espejo CL/CO) ──
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
      console.warn(`[create-from-vicky-pe] coql error ${response.status}: ${text.slice(0, 150)}`);
      return [];
    }
    return JSON.parse(text)?.data || [];
  } catch (err) {
    console.warn(`[create-from-vicky-pe] coql excepción: ${err.message?.slice(0, 150)}`);
    return [];
  }
}

// Dedup de Account por RUC en RUT_Empresa. El RUC no tiene DV con guion: las
// variantes son solo "tal cual" y "solo dígitos".
function getRucVariants(ruc) {
  const raw = String(ruc || "").trim();
  if (!raw) return [];
  const compact = raw.replace(/\D/g, "");
  return Array.from(new Set([raw, compact])).filter(Boolean);
}

async function findAccountIdByRuc(ruc, empresaName) {
  const variants = getRucVariants(ruc);
  if (variants.length === 0) return null;
  const escaped = variants.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const rows = await executeCoqlQuery(
    `select id, Account_Name from Accounts where RUT_Empresa in (${escaped}) limit 10`,
  );
  if (!rows.length) return null;
  const esInterna = (name) =>
    INTERNAL_ACCOUNT_NAMES.includes(String(name || "").trim().toLowerCase());
  const externas = rows.filter((r) => !esInterna(r.Account_Name));
  if (!externas.length) {
    console.warn(`[create-from-vicky-pe] dedup por RUC '${ruc}' solo matcheó cuenta(s) interna(s); se ignora.`);
    return null;
  }
  if (empresaName) {
    const norm = (s) => String(s || "").trim().toLowerCase();
    const byName = externas.find((r) => norm(r.Account_Name) === norm(empresaName));
    if (byName) return toText(byName.id);
  }
  return toText(externas[0]?.id) || null;
}

async function findContactIdByEmail(email) {
  if (!email) return null;
  const emailNorm = String(email).trim().toLowerCase();
  if (!emailNorm) return null;
  const rows = await executeCoqlQuery(
    `select id from Contacts where Email = '${emailNorm.replace(/'/g, "''")}' limit 1`,
  );
  return toText(rows[0]?.id) || null;
}

function isDuplicateDataError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("duplicate data") ||
    message.includes("duplicate_data") ||
    message.includes("multiple errors")
  );
}

// LEAD-FIRST: contacto ya convertido → reusar cuenta/contacto/deal (procesos
// cerrados generan ciclo nuevo con deal propio). Igual que CO.
async function findConvertedIdsByPhone(telefono) {
  const fono = toText(telefono).replace(/\D/g, "");
  if (!fono) return {};
  try {
    const res = await zohoApiFetch(
      `/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=3`,
    );
    if (!res.ok || res.status === 204) return {};
    const lead = ((await res.json())?.data || []).find(
      (l) => l?.["$converted_detail"]?.deal || l?.Converted_Deal?.id || l?.Converted_Account?.id,
    );
    if (!lead) return {};
    const detail = lead["$converted_detail"] || {};
    const ids = {
      accountId: toText(detail.account || (lead.Converted_Account && lead.Converted_Account.id)),
      contactId: toText(detail.contact || (lead.Converted_Contact && lead.Converted_Contact.id)),
      dealId: toText(detail.deal || (lead.Converted_Deal && lead.Converted_Deal.id)),
    };
    if (ids.dealId) {
      const r = await zohoApiFetch(`/crm/v3/Deals/${ids.dealId}?fields=Stage`);
      const stageDeal = r.ok ? toText((await r.json())?.data?.[0]?.Stage) : "";
      if (["Cierre Perdido", "8. Facturando"].includes(stageDeal)) ids.dealId = "";
    }
    if (ids.accountId || ids.contactId || ids.dealId) {
      console.warn(`[lead-first-pe] contacto ${fono} ya convertido — se reusa account=${ids.accountId || "-"} contact=${ids.contactId || "-"} deal=${ids.dealId || "-"}`);
    }
    return ids;
  } catch {
    return {};
  }
}

// Cierra el lead huérfano del contacto (creado por derivar_a_ejecutivo o el
// reloj de calificación) convirtiéndolo a la cuenta/contacto del deal recién
// creado — sale de la cola de Mónica sin duplicar nada. Best-effort.
async function cerrarLeadHuerfanoPE(telefono, accountId, contactId) {
  const fono = String(telefono || "").replace(/\D/g, "");
  if (!fono || (!accountId && !contactId)) return;
  try {
    const r = await zohoApiFetch(
      `/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=3`,
    );
    if (!r.ok || r.status === 204) return;
    const leads = (await r.json())?.data || [];
    const vivo = leads.find(
      (l) =>
        !(
          l?.Converted_Deal?.id ||
          l?.Converted_Account?.id ||
          l?.Converted_Contact?.id ||
          l?.["$converted_detail"]?.deal
        ) && OWNERS_ADOPTABLES_PE.has(toText(l?.Owner?.id)),
    );
    if (!vivo?.id) return;
    const payload = { overwrite: false, notify_lead_owner: false, notify_new_entity_owner: false };
    if (accountId) payload.Accounts = { id: accountId };
    if (contactId) payload.Contacts = { id: contactId };
    await zohoApiFetch(`/crm/v3/Leads/${encodeURIComponent(vivo.id)}/actions/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [payload] }),
    });
    console.warn(`[create-from-vicky-pe] lead huérfano ${vivo.id} convertido a la cuenta/contacto del deal.`);
  } catch (e) {
    console.warn(`[create-from-vicky-pe] cerrarLeadHuerfano falló: ${toText(e?.message || e).slice(0, 120)}`);
  }
}

// ── Mapeos al subform (mismos picklists que CL/CO) ──
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

function mapCategoriaToZoho(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  if (tipo === "hardware") return "Equipos Biometricos";
  if (tipo === "plan") return "Plataforma Asistencia";
  if (tipo === "modulo") return "Modulos Adicionales";
  return "Otro";
}

function mapUnidadToZoho(modalidadZoho, tipo) {
  if (tipo === "hardware") return "Dispositivo";
  if (modalidadZoho === "Recurrente") return "Usuario";
  if (modalidadZoho === "Único") return "Servicio";
  return "Unidad";
}

function esItemActivacion(item) {
  return (
    String(item?.tipo || "").toLowerCase() === "activacion" ||
    /activaci/i.test(String(item?.id || "")) ||
    /activaci/i.test(String(item?.nombre || ""))
  );
}

/**
 * Garantiza la fila de "Activación" = PRIMER MES COMPLETO por adelantado
 * (plan + arriendos: TODOS los recurrentes — patrón del pago inicial CL/PE,
 * distinto de CO donde es solo el plan). afectoIgv=true (en Perú el IGV
 * aplica a todo). Si el agente ya la mandó (p. ej. con el 20 % de cierre
 * aplicado desde el motor), se respeta la suya.
 */
function ensureActivacionPE(items) {
  if (items.some(esItemActivacion)) return items;
  const primerMesPEN = items.reduce((acc, it) => {
    if (it.esRecurrente === true) return acc + Number(it.subtotalPEN || 0);
    return acc;
  }, 0);
  if (!(primerMesPEN > 0)) {
    console.warn("[create-from-vicky-pe] cotización sin recurrentes: no se agrega fila de Activación.");
    return items;
  }
  const monto = Math.round(primerMesPEN * 100) / 100;
  return [
    ...items,
    {
      tipo: "activacion",
      id: "activacion",
      nombre: "Activación",
      modalidad: "Cobro único",
      cantidad: 1,
      precioUnitarioPEN: monto,
      subtotalPEN: monto,
      esRecurrente: false,
      afectoIgv: true,
    },
  ];
}

/** Subform Detalle_Items_Cotizacion — convención "unidad de pricing del país":
 * los campos *_UF y *_CLP guardan el MISMO valor en PEN (2 decimales). */
function buildSubformItemsPE(items) {
  return items.map((item, index) => {
    const modalidadZoho = mapModalidadToZoho(item.modalidad);
    const tipo = String(item.tipo || "").toLowerCase();
    const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
    const precioUnitario = r2(item.precioUnitarioPEN);
    const subtotal = r2(item.subtotalPEN);
    return {
      Nombre_Item: String(item.nombre || ""),
      Descripcion_Item: String(item.descripcion || "").trim(),
      Codigo_Item: String(item.id || ""),
      Cantidad: Number(item.cantidad || 0),
      Precio_Unitario_UF: precioUnitario,
      Precio_Unitario_CLP: precioUnitario,
      Subtotal_UF: subtotal,
      Subtotal_CLP: subtotal,
      Modalidad: modalidadZoho,
      Es_Recurrente: item.esRecurrente === true,
      Afecto_IVA: item.afectoIgv === true,
      Orden: index + 1,
      Categoria_Item: mapCategoriaToZoho(item),
      Unidad: mapUnidadToZoho(modalidadZoho, tipo),
    };
  });
}

function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

function validarItem(item, index) {
  if (!item || typeof item !== "object") return `items[${index}] no es un objeto`;
  if (!toText(item.nombre)) return `items[${index}].nombre requerido`;
  const cantidad = Number(item.cantidad);
  if (!Number.isFinite(cantidad) || cantidad < 1) return `items[${index}].cantidad debe ser >= 1`;
  if (!Number.isFinite(Number(item.precioUnitarioPEN))) return `items[${index}].precioUnitarioPEN debe ser numérico`;
  if (!Number.isFinite(Number(item.subtotalPEN))) return `items[${index}].subtotalPEN debe ser numérico`;
  if (typeof item.esRecurrente !== "boolean") return `items[${index}].esRecurrente debe ser boolean`;
  if (typeof item.afectoIgv !== "boolean") return `items[${index}].afectoIgv debe ser boolean`;
  return null;
}

// ── Handler principal ──
module.exports = async function handler(req, res) {
  const corsAllowed = setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = corsAllowed ? 204 : 403; res.end(); return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Método no permitido" });
  }

  const expectedSecret =
    toText(process.env.VICKY_COTIZADORA_SECRET_PE) || toText(process.env.VICKY_COTIZADORA_SECRET);
  const providedSecret = toText(req.headers["x-vicky-secret"]);
  if (expectedSecret && expectedSecret !== providedSecret) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  let stage = "init";
  try {
    const body = parseBody(req);
    const empresa = toText(body.empresa);
    const contacto = toText(body.contacto);
    const contactoEmail = toText(body.contactoEmail);
    const ruc = toText(body.ruc);
    const contactoTelefono = toText(body.contactoTelefono);
    const userCount = Number(body.userCount) > 0 ? Number(body.userCount) : undefined;

    if (!empresa || !contacto || !contactoEmail || !ruc) {
      return sendJson(res, 400, {
        ok: false,
        error: "Faltan campos: empresa, contacto, contactoEmail, ruc",
      });
    }
    if (!rucValido(ruc)) {
      return sendJson(res, 400, {
        ok: false,
        error: `El RUC '${ruc}' no es válido (11 dígitos con dígito verificador SUNAT). Pídele al cliente confirmarlo.`,
      });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return sendJson(res, 400, { ok: false, error: "items requerido (no vacío)" });
    }
    for (let i = 0; i < body.items.length; i++) {
      const err = validarItem(body.items[i], i);
      if (err) return sendJson(res, 400, { ok: false, error: err });
    }

    const config = getAcceptanceConfig(req);

    // ── IDEMPOTENCIA (mismo candado que CL/CO): reintento con el MISMO body
    // devuelve los ids ya creados en vez de duplicar. ──
    const idemClave = claveIdempotencia(body);
    const previoIdem = await getIdempotente(idemClave);
    if (previoIdem && previoIdem.quoteId) {
      console.warn(
        `[create-from-vicky-pe] reintento idempotente: mismo body ya creó quote ${previoIdem.quoteId} / deal ${previoIdem.dealId || "-"} — no se duplica.`,
      );
      const expMsIdem = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
      const tokenIdem = signAcceptancePayload({
        quoteId: previoIdem.quoteId, dealId: previoIdem.dealId || "",
        pais: "pe",
        iat: Date.now(), exp: expMsIdem,
        nonce: crypto.randomBytes(8).toString("hex"),
        v: 1,
      });
      const acceptanceUrlIdem = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(tokenIdem)}`;
      await updateRecord(config.quoteModule, previoIdem.quoteId, {
        [config.quoteAcceptanceUrlField]: acceptanceUrlIdem,
        [config.quoteStatusField]: "Enviada",
      }, true).catch(() => {});
      return sendJson(res, 200, {
        ok: true,
        quoteId: previoIdem.quoteId, dealId: previoIdem.dealId || "",
        accountId: previoIdem.accountId || "", contactId: previoIdem.contactId || "",
        acceptanceUrl: acceptanceUrlIdem,
        pdfUrl: "", pdfPendiente: true,
        reuse: { retryIdempotente: true },
        expiresAt: new Date(expMsIdem).toISOString(),
      });
    }

    // Activación (primer mes completo adelantado) SIEMPRE presente: en Zoho,
    // en el PDF y en la página de aceptación los números calzan.
    const items = ensureActivacionPE(body.items);
    // Total con IGV 18 % en las líneas afectas (en PE: todas).
    const totalPEN = items.reduce((acc, it) => {
      const subtotal = Number(it.subtotalPEN || 0);
      return acc + subtotal + (it.afectoIgv === true ? subtotal * IGV_PE : 0);
    }, 0);

    // Principio (16-jul): LA COTIZACIÓN SIEMPRE SE ENTREGA. El plumbing CRM es
    // soporte: si falla, CRM_Incompleto=true y se sigue. CRM_STRICT=1 restaura
    // el modo estricto.
    let crmIncompleto = false;
    let accountId;
    let accountReused = false;
    let contactId;
    let dealId;
    try {
      // LEAD-FIRST: contacto ya convertido → reusar su cuenta/contacto/deal.
      stage = "find_converted_by_phone";
      const convertidosPrevios = await findConvertedIdsByPhone(contactoTelefono);
      if (convertidosPrevios.accountId) { accountId = convertidosPrevios.accountId; accountReused = true; }
      if (convertidosPrevios.contactId) contactId = convertidosPrevios.contactId;
      if (convertidosPrevios.dealId) dealId = convertidosPrevios.dealId;

      // Candado cruzado hito↔cotización (kv compartida con el agente).
      if (!dealId) {
        const dealCruzado = await getDealPorFono(contactoTelefono).catch(() => null);
        if (dealCruzado && dealCruzado.dealId) {
          dealId = dealCruzado.dealId;
          console.warn(`[create-from-vicky-pe] candado kv: se reusa deal ${dealId} (origen=${dealCruzado.origen || "?"}).`);
        }
      }

      // ── Account: dedup por RUC antes de crear ──
      if (!accountId) {
        stage = "find_account_by_ruc";
        accountId = await findAccountIdByRuc(ruc, empresa);
        accountReused = Boolean(accountId);
      }

      if (!accountId) {
        stage = "create_account";
        const createAccountPayload = {
          Account_Name: empresa,
          RUT_Empresa: rucParaGuardar(ruc),
          Phone: contactoTelefono || undefined,
          Description: `Cuenta creada por Vicky PE (WhatsApp). RUC: ${ruc}`,
          Industry: VICKY_PE_SECTOR,
          Territorio: VICKY_PE_TERRITORIO,
          N_Empleados_dependientes: userCount,
          Tiene_potencial_de_expansi_n_Regional: VICKY_PE_EXPANSION,
          Owner: OWNER_PE,
        };
        try {
          const accountResult = await createRecord("Accounts", createAccountPayload, true);
          accountId = toText(accountResult?.id);
          if (!accountId) throw new Error("No se obtuvo accountId");
        } catch (createError) {
          if (!isDuplicateDataError(createError)) throw createError;
          stage = "dedupe_account_by_ruc";
          const existingAccountId = await findAccountIdByRuc(ruc, empresa);
          if (existingAccountId) {
            accountId = existingAccountId;
            accountReused = true;
          } else {
            // Homónimo con RUC distinto → cuenta desambiguada "Empresa (RUC)".
            stage = "create_account_disambiguated";
            const nombreDesambiguado = `${empresa} (${rucParaGuardar(ruc)})`;
            try {
              const retryResult = await createRecord(
                "Accounts",
                { ...createAccountPayload, Account_Name: nombreDesambiguado },
                true,
              );
              accountId = toText(retryResult?.id);
              if (!accountId) throw new Error("No se obtuvo accountId (cuenta desambiguada)");
            } catch (retryError) {
              if (!isDuplicateDataError(retryError)) throw retryError;
              stage = "reuse_account_capa4";
              const compactar = (v) => String(v || "").replace(/\D/g, "");
              const porNombre = await executeCoqlQuery(
                `select id, RUT_Empresa from Accounts where Account_Name = '${nombreDesambiguado.replace(/'/g, "''")}' limit 5`,
              ).catch(() => []);
              const matchRuc = (porNombre || []).find((r) => compactar(r.RUT_Empresa) === compactar(ruc));
              if (matchRuc) {
                accountId = toText(matchRuc.id);
                accountReused = true;
              } else {
                accountId = undefined;
                console.error(`[create-from-vicky-pe] Capa 4: sin salida de dedupe (RUC=${ruc}); cotización SIN cuenta.`);
              }
            }
          }
        }
      }

      // ── Contact ──
      if (!contactId) {
        stage = "create_contact";
        const { firstName, lastName } = splitFullName(contacto);
        try {
          const contactResult = await createRecord("Contacts", {
            First_Name: firstName,
            Last_Name: lastName,
            Email: contactoEmail,
            Phone: contactoTelefono || undefined,
            ...(accountId ? { Account_Name: { id: accountId } } : {}),
            Lead_Source: VICKY_PE_LEAD_SOURCE,
            Territorio: VICKY_PE_TERRITORIO,
            Owner: OWNER_PE,
          }, true);
          contactId = toText(contactResult?.id);
          if (!contactId) throw new Error("No se obtuvo contactId");
        } catch (createError) {
          if (!isDuplicateDataError(createError)) throw createError;
          stage = "dedupe_contact_by_email";
          const existingContactId = await findContactIdByEmail(contactoEmail);
          if (!existingContactId) {
            throw new Error(`Zoho reportó duplicate data pero no se encontró Contact con Email ${contactoEmail}`);
          }
          contactId = existingContactId;
        }
      }

      // ── Deal (Territorio Perú + obligatorios del layout) ──
      stage = "create_deal";
      if (!dealId) {
        const dealResult = await createRecord("Deals", {
          Deal_Name: `${empresa} - Cotización Vicky`,
          ...(accountId ? { Account_Name: { id: accountId } } : {}),
          ...(contactId ? { Contact_Name: { id: contactId } } : {}),
          Stage: VICKY_PE_DEAL_STAGE,
          Pipeline: "Standard (Standard)",
          Lead_Source: VICKY_PE_LEAD_SOURCE,
          Amount: Math.round(totalPEN) || undefined,
          Description: `Deal creado por Vicky PE para cotización WhatsApp.\nUsuarios: ${userCount || "-"}\nTotal: ${Math.round(totalPEN)} PEN`,
          Territorio: VICKY_PE_TERRITORIO,
          Tombola: VICKY_PE_TOMBOLA,
          Monda_del_trato: VICKY_PE_MONEDA,
          Sector: VICKY_PE_SECTOR,
          N_Empleados_que_marcan: userCount,
          // Tramos PE: 1-10 y 11-20 son tarifas fijas; 21-50 por usuario.
          Tipo_de_Cobro: (Number(userCount) || 1) <= 20 ? "Mensual fijo" : "Por usuario",
          Producto_Soluci_n: VICKY_PE_PRODUCTO,
          Owner: OWNER_PE,
        }, true);
        dealId = toText(dealResult?.id);
        if (!dealId) throw new Error("No se obtuvo dealId");
        await setDealPorFono(contactoTelefono, dealId, "cotizacion").catch(() => {});
      }
    } catch (plumbingError) {
      if (String(process.env.CRM_STRICT || "") === "1") throw plumbingError;
      crmIncompleto = true;
      console.error(
        `[create-from-vicky-pe] CRM DEGRADADO en stage=${stage}: ${toText(plumbingError?.message || plumbingError).slice(0, 300)}. ` +
          `La cotización continúa (accountId=${accountId || "∅"}, contactId=${contactId || "∅"}, dealId=${dealId || "∅"}).`,
      );
    }
    if (!accountId || !dealId) crmIncompleto = true;

    // El lead vivo del contacto (derivación/calificación) sale de la cola de
    // Mónica convirtiéndose a la cuenta/contacto del deal. Best-effort.
    if (contactId || accountId) {
      await cerrarLeadHuerfanoPE(contactoTelefono, accountId, contactId).catch(() => {});
    }

    // ── Cotización con subform (convención PEN en campos UF/CLP) ──
    stage = "create_quote";
    const subformItems = buildSubformItemsPE(items);
    const quoteResult = await createRecord(config.quoteModule, {
      Name: `Cotización ${empresa} - ${new Date().toISOString().slice(0, 10)}`,
      Owner: OWNER_PE,
      ...(dealId ? { [config.quoteDealLookupField]: { id: dealId } } : {}),
      ...(contactId ? { [config.quoteContactLookupField]: { id: contactId } } : {}),
      ...(accountId ? { Cuenta_Asociada: { id: accountId } } : {}),
      CRM_Incompleto: crmIncompleto,
      [config.quoteDateField]: new Date().toISOString().slice(0, 10),
      [config.quoteStatusField]: "Borrador",
      [config.contactEmailField]: contactoEmail,
      [config.contactPhoneField]: contactoTelefono || undefined,
      [config.companyRutField]: rucParaGuardar(ruc),
      [config.quoteItemsSubformField]: subformItems,
      [config.quoteVersionPdfField]: 1,
    }, true);
    const quoteId = toText(quoteResult?.id);
    if (!quoteId) throw new Error("No se obtuvo quoteId");
    await setIdempotente(idemClave, { quoteId, dealId, accountId, contactId });

    // ── acceptanceUrl (token con pais:"pe") ──
    stage = "build_acceptance_url";
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const token = signAcceptancePayload({
      quoteId, dealId,
      pais: "pe",
      iat: Date.now(), exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

    if (crmIncompleto) {
      const notifyUrl = toText(process.env.VICKY_AGENT_NOTIFY_URL);
      const notifySecret = toText(process.env.VICKY_AGENT_CRON_SECRET);
      if (notifyUrl && notifySecret) {
        fetch(notifyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": notifySecret },
          body: JSON.stringify({ evento: "crm_incompleto", empresa: empresa, numero: quoteId, monto: "" }),
        }).catch(() => {});
      }
    }
    stage = "update_quote_acceptance";
    await updateRecord(config.quoteModule, quoteId, {
      [config.quoteAcceptanceUrlField]: acceptanceUrl,
      [config.quoteStatusField]: "Enviada",
    }, true);

    sendJson(res, 200, {
      ok: true,
      quoteId, dealId, accountId, contactId,
      acceptanceUrl,
      pdfUrl: "",
      pdfPendiente: true,
      accountReused,
      expiresAt: new Date(expMs).toISOString(),
    });

    // ── PDF + correo en segundo plano ──
    waitUntil(
      (async () => {
        const numeroCotizacion = await getRecordWithFields(config.quoteModule, quoteId, ["Numero_Cotizacion"])
          .then((r) => toText(r?.Numero_Cotizacion))
          .catch(() => "");
        const html = buildProposalHtmlPE({
          cliente: { empresa, contacto, ruc: rucParaGuardar(ruc) },
          items,
          acceptanceUrl,
          cotizacionId: numeroParaPdf(numeroCotizacion, quoteId),
          validezHasta: new Date(expMs).toISOString(),
        });
        const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
        const { pdfUrl } = await uploadPdfToSupabase({ pdfBuffer, quoteId, empresa });
        await updateRecord(config.quoteModule, quoteId, {
          [config.quotePdfUrlField]: pdfUrl,
        }, true);
        await actualizarPunteroPdf(quoteId, pdfUrl);
        // Correo con el PDF: mismo helper y plantilla que CL/CO; CC y
        // reply-to a Mónica para que vea lo que recibió su cliente.
        if (contactoEmail) {
          const CC_PE = toText(process.env.VICKY_PE_QUOTE_CC || "mmendozav@geovictoria.com")
            .split(",").map((s) => s.trim()).filter(Boolean);
          await sendQuoteEmailViaZoho({
            quoteModule: config.quoteModule,
            quoteId,
            fromEmail: toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com",
            replyToEmail: CC_PE[0],
            ccEmails: CC_PE,
            toEmail: contactoEmail,
            toName: contacto,
            subject: `Tu cotización GeoVictoria — ${empresa}`,
            htmlBody: buildEmailHtml({
              contacto,
              empresa,
              pdfUrl,
              tieneReloj: false,
              ejecutivo: { nombre: "Mónica Mendoza", email: "mmendozav@geovictoria.com" },
            }),
          }).catch((mailErr) =>
            console.error("[create-from-vicky-pe] correo de cotización falló:", mailErr?.message || mailErr),
          );
        }
      })().catch((bgErr) =>
        console.error("[create-from-vicky-pe] PDF en segundo plano falló:", bgErr?.message || bgErr),
      ),
    );
    return;

  } catch (error) {
    console.error(`[create-from-vicky-pe] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: `Falla en stage='${stage}'`,
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};

module.exports.buildSubformItemsPE = buildSubformItemsPE;
module.exports.ensureActivacionPE = ensureActivacionPE;
module.exports.rucValido = rucValido;
