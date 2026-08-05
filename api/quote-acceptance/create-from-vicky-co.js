/**
 * POST /api/quote-acceptance/create-from-vicky-co — Cotización formal COLOMBIA.
 *
 * Espejo SIMPLIFICADO de create-from-vicky.js (Chile). Diferencias v1:
 *   - SIN conversión de leads (los leads CO los crea derivar_a_ejecutivo;
 *     enlazar por leadId es fase 2).
 *   - SIN descuentos (escalera CO pendiente de confirmación de negocio).
 *   - SIN correos (v1: el agente entrega el link/PDF por WhatsApp).
 *   - Los items vienen YA calculados por el motor de precios CO del agente
 *     (lib/paises/co/cotizar.ts) — misma confianza que Chile.
 *
 * Auth: header `x-vicky-secret` (mismo esquema que el chileno). Se valida
 * contra VICKY_COTIZADORA_SECRET_CO y, si esa env no existe, contra
 * VICKY_COTIZADORA_SECRET (para no duplicar secretos si se decide compartir).
 *
 * ── CONTRATO DEL BODY (JSON) ────────────────────────────────────────────────
 * {
 *   "empresa":          string  (requerido) — razón social / nombre de la empresa
 *   "contacto":         string  (requerido) — nombre completo del contacto
 *   "contactoEmail":    string  (requerido)
 *   "nit":              string  (requerido) — NIT con o sin puntos/DV, ej "901.367.959-1"
 *   "contactoTelefono": string  (opcional)
 *   "userCount":        number  (opcional) — usuarios que marcan (para el Deal)
 *   "items": [          (requerido, no vacío)
 *     {
 *       "tipo":              "plan" | "modulo" | "hardware" | "servicio" | "activacion",
 *       "id":                string,   // ej "plan_asistencia", "reloj_arriendo", "reloj_venta",
 *                                      //    "envio_reloj", "instalacion_reloj", "activacion"
 *       "nombre":            string,   // como se muestra al cliente
 *       "descripcion":       string?,  // opcional; si viene se muestra en el PDF
 *       "modalidad":         "Por usuario" | "Fijo" | "Arriendo mensual" | "Venta única" | "Cobro único",
 *       "cantidad":          number >= 1,
 *       "precioUnitarioCOP": number,   // COP neto (los afectos suman IVA aparte)
 *       "subtotalCOP":       number,   // COP neto = precioUnitarioCOP * cantidad
 *       "esRecurrente":      boolean,  // true = se factura mes a mes
 *       "afectoIva":         boolean   // true SOLO para hardware (reloj arriendo/
 *                                      // venta): lleva IVA 19%. El resto false
 *                                      // (precio final, decisión 10-jul refinada)
 *     }
 *   ]
 * }
 *
 * Respuesta 200: { ok, quoteId, dealId, accountId, contactId, acceptanceUrl,
 *                  pdfUrl, pdfPendiente, expiresAt }
 *   - Igual que Chile, el PDF se genera EN SEGUNDO PLANO (waitUntil) para
 *     responder rápido: pdfUrl llega "" con pdfPendiente=true y queda escrito
 *     en el campo PDF_URL de la cotización al terminar el render.
 *
 * ── CONVENCIONES ZOHO (decididas en COLOMBIA.md) ───────────────────────────
 *   - Account: dedup por NIT en el campo RUT_Empresa (convención "documento
 *     tributario del país" en el mismo campo). Homónimos con NIT distinto se
 *     crean desambiguados como "Empresa (NIT)".
 *   - Subform Detalle_Items_Cotizacion: Precio_Unitario_UF / Subtotal_UF
 *     guardan el valor en COP (convención "unidad de pricing del país") y
 *     Precio_Unitario_CLP / Subtotal_CLP el MISMO valor COP. Afecto_IVA se
 *     guarda tal cual viene del agente (desde el 10-jul llega SIEMPRE false:
 *     decisión "precios finales" — el tratamiento tributario vive en la
 *     factura electrónica, no en la cotización).
 *   - Fila de "Activación" (= 1 mes del plan, Afecto_IVA false, no recurrente)
 *     se agrega SIEMPRE si no viene en items. El monto es la suma de los
 *     items recurrentes del plan (tipo "plan"); si no hay plan en la
 *     cotización, no se agrega (no hay qué cobrar).
 *   - RUT_Cliente (cabecera) = NIT. Estado "Enviada". Version_PDF 1.
 *     Numero_Cotizacion es el correlativo automático de Zoho.
 *   - El token de aceptación se firma con pais:"co": session.js lo usa para
 *     marcar la sesión como Colombia sin campos nuevos en Zoho (respaldo:
 *     Territorio del Deal = "Colombia").
 *
 * ── AMBIGÜEDADES RESUELTAS (elegido lo más simple, ver COLOMBIA.md) ────────
 *   - Owner de los registros: env VICKY_CO_OWNER_ID si está definida; si no,
 *     se omite (queda el usuario de la API). Con VICKY_CO_OWNER_ID definida
 *     los registros quedan a nombre de Alejandro Gordillo (ejecutivo CO).
 *   - Monda_del_trato (picklist obligatorio del Deal): env VICKY_MONEDA_CO,
 *     default "COP". Si el picklist del org rechazara el valor, ajustar la env.
 *   - Amount del Deal = total de la cotización (suma de subtotalCOP + IVA 19%
 *     de las líneas afectas — hardware).
 */

const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { claveIdempotencia, getIdempotente, setIdempotente, getDealPorFono, setDealPorFono, getLeadCandadoPorFono, getKvFlag } = require("../_shared/idempotencia");
const { sendQuoteEmailViaZoho, buildEmailHtml } = require("./create-from-vicky");
const { createRecord, updateRecord, getRecordWithFields, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { zohoApiFetch } = require("../_shared/zoho-auth");

// LEAD-FIRST (Lalo 30-jul): si el contacto ya tiene un lead CONVERTIDO (la
// sincronización de hitos convierte al ver el preform), la formal se cuelga
// de ESE deal — no se crea otro (patrón Odalisca). Descarta Cierre Perdido.
// El cierre de huérfanos usa OWNERS_ADOPTABLES_CO (fix 05-ago): en CO el lead
// sin cotización es del SDR Inbound por diseño, así que el set anterior
// {Vicky, Gordillo} descartaba justo los leads que había que cerrar (caso
// Globe Air Fuel: el lead SDR seguía en la cola con el deal ya en negociación).

/**
 * Cierra el LEAD HUÉRFANO del flujo SDR (caso Globe Air Fuel / Juan 04-ago).
 * PARCHE mientras CO no tenga el flujo convert-first de Chile: la emisión CO
 * crea el deal SIN convertir el lead vivo del contacto, así que ese lead queda
 * en la cola "cliente para contactar" del SDR mientras Vicky ya tiene el deal
 * en negociación — los dos flujos se cruzan. Este helper convierte el lead
 * apuntando a la CUENTA y CONTACTO ya creados (sin deal nuevo): lo marca
 * Converted y lo saca de la cola del SDR, sin duplicar nada. Best-effort.
 */
async function cerrarLeadHuerfanoCO(telefono, accountId, contactId) {
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
        ) && OWNERS_ADOPTABLES_CO.has(toText(l?.Owner?.id)),
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
    console.warn(
      `[create-from-vicky-co] lead huérfano ${vivo.id} convertido a la cuenta/contacto del deal — sale de la cola del SDR.`,
    );
  } catch (e) {
    console.warn(`[create-from-vicky-co] cerrarLeadHuerfano falló: ${toText(e?.message || e).slice(0, 120)}`);
  }
}

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
      // Dedup de procesos ABIERTOS (Lalo 31-jul): Cierre Perdido y
      // 8. Facturando son negociaciones cerradas — ciclo nuevo con deal
      // propio; cuenta y contacto sí se reusan.
      const r = await zohoApiFetch(`/crm/v3/Deals/${ids.dealId}?fields=Stage`);
      const stageDeal = r.ok ? toText((await r.json())?.data?.[0]?.Stage) : "";
      if (["Cierre Perdido", "8. Facturando"].includes(stageDeal)) ids.dealId = "";
    }
    if (ids.accountId || ids.contactId || ids.dealId) {
      console.warn(`[lead-first] contacto ${fono} ya convertido — se reusa account=${ids.accountId || "-"} contact=${ids.contactId || "-"} deal=${ids.dealId || "-"}`);
    }
    return ids;
  } catch {
    return {};
  }
}

// ── FLUJO CONVERT-FIRST (paridad con Chile, Lalo 04-ago) ────────────────────
// Detrás de flag (env VICKY_CO_CONVERT_FIRST=on o kv co_convert_first=on),
// APAGADO por defecto. Igual que Chile: el deal NACE de convertir el lead vivo
// del contacto → cero leads huérfanos por diseño (no un cierre best-effort
// después). Encender, observar una cotización CO real, apagar al instante si
// algo no calza.
async function coConvertFirstOn() {
  if (String(process.env.VICKY_CO_CONVERT_FIRST || "").trim() === "on") return true;
  try {
    return (await getKvFlag("co_convert_first")) === "on";
  } catch {
    return false;
  }
}

// Owners cuyo lead se ADOPTA y convierte (bot + interino + SDR CO): un lead de
// dueño humano REAL no se toca. El deal nace a nombre del ejecutivo (OWNER_CO).
const OWNERS_ADOPTABLES_CO = new Set([
  "3525045000484500876", // Vicky GeoVictoria
  "3525045000203758005", // Gordillo (interino)
  "3525045000613817111", // Eddy Galindo (SDR)
  "3525045000619732095", // Guerrero (SDR)
  "3525045000639899035", // Quiroga (SDR)
]);

// Lead VIVO sin convertir del teléfono (candado kv del agente → búsqueda Zoho),
// solo de dueño adoptable. Igual que findOpenLeadIdByPhone de Chile.
async function findLeadVivoCO(telefono) {
  const fono = toText(telefono).replace(/\D/g, "");
  if (!fono) return "";
  let candidato = "";
  try { candidato = await getLeadCandadoPorFono(fono); } catch { /* best-effort */ }
  if (!candidato) {
    try {
      const r = await zohoApiFetch(
        `/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=3`,
      );
      if (r.ok && r.status !== 204) {
        const leads = (await r.json())?.data || [];
        const abierto = leads.find(
          (l) =>
            !(
              l?.Converted_Deal?.id ||
              l?.Converted_Account?.id ||
              l?.Converted_Contact?.id ||
              l?.["$converted_detail"]?.deal
            ),
        );
        candidato = toText(abierto?.id);
      }
    } catch { /* best-effort */ }
  }
  if (!candidato) return "";
  try {
    const g = await zohoApiFetch(`/crm/v3/Leads/${encodeURIComponent(candidato)}?fields=Owner`);
    if (!g.ok) return "";
    const ownerId = toText((((await g.json())?.data || [])[0] || {}).Owner?.id);
    if (!OWNERS_ADOPTABLES_CO.has(ownerId)) return ""; // dueño humano real: no se toca
    return candidato;
  } catch {
    return "";
  }
}

// convertLeadCO: idéntico a convertLead de Chile (dedup DUPLICATE_DATA con
// reintento fusionando, IDs en raíz o dentro de details). dealData null =
// conversión SIN deal nuevo (reusa un deal ya creado por el hito).
async function convertLeadCO(leadId, dealData, existingIds = {}) {
  const path = `/crm/v3/Leads/${encodeURIComponent(leadId)}/actions/convert`;
  const payload = {
    overwrite: true,
    notify_lead_owner: true,
    notify_new_entity_owner: true,
    ...(dealData ? { Deals: dealData } : {}),
  };
  if (existingIds.accountId) payload.Accounts = { id: existingIds.accountId };
  if (existingIds.contactId) payload.Contacts = { id: existingIds.contactId };
  const response = await zohoApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [payload] }),
  });
  const text = await response.text();
  if (!response.ok) {
    let dup = null;
    try { dup = JSON.parse(text)?.data?.[0]; } catch { /* noop */ }
    if (dup?.code === "DUPLICATE_DATA" && dup?.details?.duplicate_record?.id) {
      const dupModule = toText(dup?.details?.duplicate_record?.module?.api_name);
      const dupId = toText(dup.details.duplicate_record.id);
      const puedeReintentar =
        (dupModule === "Contacts" && !existingIds.contactId) ||
        (dupModule !== "Contacts" && !existingIds.accountId);
      if (puedeReintentar) {
        const retryIds =
          dupModule === "Contacts"
            ? { ...existingIds, contactId: dupId }
            : { ...existingIds, accountId: dupId };
        return convertLeadCO(leadId, dealData, retryIds);
      }
    }
    throw new Error(`Zoho convert Lead CO failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const result = JSON.parse(text)?.data?.[0];
  if (!result) throw new Error("Respuesta de convert Lead CO sin data");
  const idFrom = (v) => toText(v && typeof v === "object" ? v.id : v);
  const det = result.details || {};
  return {
    accountId: idFrom(result.Accounts) || idFrom(det.Accounts),
    contactId: idFrom(result.Contacts) || idFrom(det.Contacts),
    dealId: idFrom(result.Deals) || idFrom(det.Deals),
  };
}

// Recupera los IDs de una conversión previa desde $converted_detail (el lead
// ya estaba convertido por el hito). Igual que recoverConvertedIds de Chile.
async function recoverConvertedIdsCO(leadId) {
  try {
    const r = await zohoApiFetch(
      `/crm/v3/Leads?ids=${encodeURIComponent(leadId)}&converted=true&fields=id,$converted_detail`,
    );
    const detail = (await r.json())?.data?.[0]?.["$converted_detail"] || {};
    return {
      accountId: toText(detail.account),
      contactId: toText(detail.contact),
      dealId: toText(detail.deal),
    };
  } catch {
    return {};
  }
}

const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtmlCO } = require("../_shared/proposal-html-builder-co");

// waitUntil: corre trabajo en segundo plano DESPUÉS de responder (mismo patrón
// que el endpoint chileno): el PDF (Chromium headless, lo pesado) no bloquea la
// respuesta al agente. Fallback best-effort si el paquete no está disponible.
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch (_e) {
  waitUntil = (p) => {
    Promise.resolve(p).catch(() => {});
  };
}

// Defaults CO (mismos nombres de env que Chile con sufijo _CO donde difieren).
const VICKY_CO_DEAL_STAGE = toText(process.env.VICKY_DEAL_STAGE_INICIAL) || "4. Propuesta Enviada / En Negociación";
const VICKY_CO_LEAD_SOURCE = toText(process.env.VICKY_LEAD_SOURCE) || "SEO";
const VICKY_CO_TERRITORIO = toText(process.env.VICKY_TERRITORIO_CO) || "Colombia";
const VICKY_CO_MONEDA = toText(process.env.VICKY_MONEDA_CO) || "COP";
const VICKY_CO_TOMBOLA = toText(process.env.VICKY_TOMBOLA) || "Mantener propietario";
const VICKY_CO_PRODUCTO = toText(process.env.VICKY_PRODUCTO_DEFAULT) || "Control de Asistencia";
const VICKY_CO_SECTOR = toText(process.env.VICKY_SECTOR_FALLBACK) || "19. Servicios";
const VICKY_CO_EXPANSION = toText(process.env.VICKY_EXPANSION_REGIONAL) || "No";

// Owner opcional de los registros CO (ver header). {id} solo si está definido.
const VICKY_CO_OWNER_ID = toText(process.env.VICKY_CO_OWNER_ID);
const OWNER_CO = VICKY_CO_OWNER_ID ? { id: VICKY_CO_OWNER_ID } : undefined;

// Cuentas internas que NUNCA deben reusarse al deduplicar por NIT (mismo
// riesgo real que en Chile: un NIT de prueba puede colisionar con una cuenta
// interna y pegarle la cotización de un prospecto).
const INTERNAL_ACCOUNT_NAMES = (process.env.VICKY_INTERNAL_ACCOUNT_NAMES || "GeoVictoria")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ── CORS (espejo del chileno) ──
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

// ── Variantes de NIT (mismo generador que el RUT chileno: funciona igual
// porque el NIT también termina en dígito verificador tras guion) ──
// Para "901.367.959-1" genera: ["901.367.959-1", "9013679591", "901367959-1",
// "901.367.959-1"]. Distintos registros en Zoho pueden tener distintos formatos.
function getNitVariants(nit) {
  if (!nit) return [];
  const raw = String(nit).trim();
  if (!raw) return [];
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  if (compact.length < 2) return [raw];
  const cuerpo = compact.slice(0, -1);
  const dv = compact.slice(-1);
  const cuerpoConPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const variantes = [
    raw,
    compact,
    `${cuerpo}-${dv}`,
    `${cuerpoConPuntos}-${dv}`,
    // Convención COLOMBIA (Ana María, 30-jul): las cuentas CO guardan el NIT
    // SIN dígito de verificación. Sin estas variantes el dedup no encontraba
    // las cuentas existentes y se duplicaban (caso Odalisca: cuenta nueva
    // "900624654-1" pese a la convención sin DV).
    cuerpo,
    cuerpoConPuntos,
  ];
  return Array.from(new Set(variantes)).filter(Boolean);
}

// NIT normalizado para ESCRIBIR en RUT_Empresa según la convención CO: sin
// puntos y sin el dígito de verificación (solo se recorta un "-X" final
// explícito — nunca se adivina si un número pelado trae DV o no).
function nitParaGuardarCO(nit) {
  return String(nit || "").trim().replace(/[.\s]/g, "").replace(/-[0-9kK]$/i, "");
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
      console.warn(`[create-from-vicky-co] coql error ${response.status}: ${text.slice(0, 150)}`);
      return [];
    }
    const parsed = JSON.parse(text);
    return parsed?.data || [];
  } catch (err) {
    console.warn(`[create-from-vicky-co] coql excepción: ${err.message?.slice(0, 150)}`);
    return [];
  }
}

// Dedup de Account por NIT en RUT_Empresa (convención "documento tributario
// del país"). Descarta cuentas internas; con NIT repetido en varias cuentas
// (dato sucio) prefiere la que coincide en nombre.
async function findAccountIdByNit(nit, empresaName) {
  const variants = getNitVariants(nit);
  if (variants.length === 0) return null;
  const escaped = variants.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const query = `select id, Account_Name from Accounts where RUT_Empresa in (${escaped}) limit 10`;
  const rows = await executeCoqlQuery(query);
  if (!rows.length) return null;
  const esInterna = (name) =>
    INTERNAL_ACCOUNT_NAMES.includes(String(name || "").trim().toLowerCase());
  const externas = rows.filter((r) => !esInterna(r.Account_Name));
  if (!externas.length) {
    console.warn(
      `[create-from-vicky-co] dedup por NIT '${nit}' solo matcheó cuenta(s) interna(s); se ignora.`,
    );
    return null;
  }
  if (empresaName) {
    const norm = (s) => String(s || "").trim().toLowerCase();
    const target = norm(empresaName);
    const byName = externas.find((r) => norm(r.Account_Name) === target);
    if (byName) return toText(byName.id);
  }
  return toText(externas[0]?.id) || null;
}

async function findContactIdByEmail(email) {
  if (!email) return null;
  const emailNorm = String(email).trim().toLowerCase();
  if (!emailNorm) return null;
  const query = `select id from Contacts where Email = '${emailNorm.replace(/'/g, "''")}' limit 1`;
  const rows = await executeCoqlQuery(query);
  return toText(rows[0]?.id) || null;
}

// "duplicate data" de Zoho al crear (campo UNIQUE ya existente). Mismo
// tratamiento que Chile, incluida la variante "multiple errors".
function isDuplicateDataError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("duplicate data") ||
    message.includes("duplicate_data") ||
    message.includes("multiple errors")
  );
}

// ── Mapeos al subform (mismos picklists de Zoho que Chile) ──
// "Único" en Zoho NO significa "pago único": es el reference_value del display
// "Fijo" (tarifa fija mensual). Los pagos únicos reales van a "Venta".
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

// ¿El item ya es la fila de Activación? (por tipo, id o nombre).
function esItemActivacion(item) {
  return (
    String(item?.tipo || "").toLowerCase() === "activacion" ||
    /activaci/i.test(String(item?.id || "")) ||
    /activaci/i.test(String(item?.nombre || ""))
  );
}

/**
 * Garantiza la fila de "Activación" (= 1 mes del plan, pago único).
 * Es el "pago inicial" CO — NO existe el esquema chileno de primer mes con
 * descuento. Si el agente ya la mandó, se respeta la suya. El monto es la suma
 * de los recurrentes del PLAN (tipo "plan"); los arriendos de equipos son
 * recurrentes pero no forman parte del plan.
 *
 * La fila se crea con afectoIva=false (la Activación es un mes del plan, y el
 * IVA solo aplica al hardware). El plan se identifica por TIPO, no por su flag
 * de IVA: el arriendo de reloj también es recurrente pero es hardware afecto.
 */
function ensureActivacion(items) {
  if (items.some(esItemActivacion)) return items;
  const planMensualCOP = items.reduce((acc, it) => {
    if (it.esRecurrente === true && String(it.tipo || "").toLowerCase() === "plan") {
      return acc + Number(it.subtotalCOP || 0);
    }
    return acc;
  }, 0);
  if (!(planMensualCOP > 0)) {
    // Sin plan mensual no hay activación que cobrar (edge: cotización solo de
    // equipos). Se loguea para detectarlo si llegara a pasar.
    console.warn("[create-from-vicky-co] cotización sin plan mensual: no se agrega fila de Activación.");
    return items;
  }
  const monto = Math.round(planMensualCOP);
  return [
    ...items,
    {
      tipo: "activacion",
      id: "activacion",
      nombre: "Activación",
      modalidad: "Cobro único",
      cantidad: 1,
      precioUnitarioCOP: monto,
      subtotalCOP: monto,
      esRecurrente: false,
      // La Activación es un mes del plan: precio final, sin IVA (el IVA solo
      // aplica al hardware).
      afectoIva: false,
    },
  ];
}

/**
 * Convierte los items del contrato CO al subform Detalle_Items_Cotizacion.
 * Convención COLOMBIA.md: los campos *_UF guardan el valor en COP ("unidad de
 * pricing del país") y los *_CLP el MISMO valor COP. Afecto_IVA por línea.
 */
function buildSubformItemsCO(items) {
  return items.map((item, index) => {
    const modalidadZoho = mapModalidadToZoho(item.modalidad);
    const tipo = String(item.tipo || "").toLowerCase();
    const precioUnitario = Math.round(Number(item.precioUnitarioCOP || 0));
    const subtotal = Math.round(Number(item.subtotalCOP || 0));
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
      Afecto_IVA: item.afectoIva === true,
      Orden: index + 1,
      Categoria_Item: mapCategoriaToZoho(item),
      Unidad: mapUnidadToZoho(modalidadZoho, tipo),
    };
  });
}

// Número de cotización a mostrar en el PDF: correlativo de Zoho sin el
// prefijo "COT" (espejo del chileno).
function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

// Valida un item del contrato. Devuelve un string de error o null.
function validarItem(item, index) {
  if (!item || typeof item !== "object") return `items[${index}] no es un objeto`;
  if (!toText(item.nombre)) return `items[${index}].nombre requerido`;
  const cantidad = Number(item.cantidad);
  if (!Number.isFinite(cantidad) || cantidad < 1) return `items[${index}].cantidad debe ser >= 1`;
  if (!Number.isFinite(Number(item.precioUnitarioCOP))) return `items[${index}].precioUnitarioCOP debe ser numérico`;
  if (!Number.isFinite(Number(item.subtotalCOP))) return `items[${index}].subtotalCOP debe ser numérico`;
  if (typeof item.esRecurrente !== "boolean") return `items[${index}].esRecurrente debe ser boolean`;
  if (typeof item.afectoIva !== "boolean") return `items[${index}].afectoIva debe ser boolean`;
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

  // Auth: secreto CO dedicado con fallback al secreto compartido de Vicky.
  const expectedSecret =
    toText(process.env.VICKY_COTIZADORA_SECRET_CO) || toText(process.env.VICKY_COTIZADORA_SECRET);
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
    const nit = toText(body.nit);
    const contactoTelefono = toText(body.contactoTelefono);
    const userCount = Number(body.userCount) > 0 ? Number(body.userCount) : undefined;

    // Validaciones del contrato
    if (!empresa || !contacto || !contactoEmail || !nit) {
      return sendJson(res, 400, {
        ok: false,
        error: "Faltan campos: empresa, contacto, contactoEmail, nit",
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

    // ── IDEMPOTENCIA (réplica del fix CL 04-ago, caso Inversiones Automatic) ──
    // El tool reintenta con el MISMO body; si un intento anterior ya creó los
    // registros (aunque su respuesta haya muerto después), acá se devuelven
    // ESOS ids en vez de crear un segundo deal.
    const idemClave = claveIdempotencia(body);
    const previoIdem = await getIdempotente(idemClave);
    if (previoIdem && previoIdem.quoteId) {
      console.warn(
        `[create-from-vicky-co] reintento idempotente: mismo body ya creó quote ${previoIdem.quoteId} / deal ${previoIdem.dealId || "-"} — no se duplica.`,
      );
      const expMsIdem = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
      const tokenIdem = signAcceptancePayload({
        quoteId: previoIdem.quoteId, dealId: previoIdem.dealId || "",
        pais: "co",
        iat: Date.now(), exp: expMsIdem,
        nonce: crypto.randomBytes(8).toString("hex"),
        v: 1,
      });
      const acceptanceUrlIdem = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(tokenIdem)}`;
      // El paso que pudo quedar a medias en el intento anterior.
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

    // La fila de Activación va SIEMPRE (pago inicial CO): en Zoho, en el PDF y
    // en la página de aceptación, así los tres muestran los mismos números.
    const items = ensureActivacion(body.items);
    // Total a pagar: netos + IVA 19% de las líneas afectas (solo hardware).
    const totalCOP = items.reduce((acc, it) => {
      const subtotal = Number(it.subtotalCOP || 0);
      return acc + subtotal + (it.afectoIva === true ? subtotal * 0.19 : 0);
    }, 0);

    // Principio (16-jul, igual que Chile): LA COTIZACIÓN SIEMPRE SE ENTREGA.
    // El plumbing CRM es soporte: si falla, se marca CRM_Incompleto y se sigue.
    // Kill-switch: CRM_STRICT=1 restaura el comportamiento estricto.
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

    // Candado cruzado hito↔cotización (mismo fix CL 04-ago): si crm-hitos
    // acaba de crear un deal para este teléfono (invisible aún para la
    // búsqueda de Zoho por el lag del índice), se reusa en vez de crear un
    // gemelo. Conserva su dueño.
    if (!dealId) {
      const dealCruzado = await getDealPorFono(contactoTelefono).catch(() => null);
      if (dealCruzado && dealCruzado.dealId) {
        dealId = dealCruzado.dealId;
        console.warn(`[create-from-vicky-co] candado kv: se reusa deal ${dealId} (origen=${dealCruzado.origen || "?"}) — no se crea gemelo.`);
      }
    }

    // ── CAMINO A (convert-first, paridad Chile — GATEADO) ──────────────────
    // Adopta el lead vivo del contacto y lo convierte: el deal NACE del lead →
    // cero huérfanos por diseño. Si el convert falla, recupera por
    // $converted_detail; si aun así no hay ids, cae al Camino B (creación
    // fresca) de siempre. Flag apagado por defecto.
    let leadConverted = false;
    if (!dealId && !accountId && !contactId && (await coConvertFirstOn())) {
      const leadVivo = await findLeadVivoCO(contactoTelefono).catch(() => "");
      if (leadVivo) {
        stage = "convert_lead_co";
        try {
          const dealDataCO = {
            Deal_Name: `${empresa} - Cotización Vicky`,
            Stage: VICKY_CO_DEAL_STAGE,
            Pipeline: "Standard (Standard)",
            Lead_Source: VICKY_CO_LEAD_SOURCE,
            Amount: totalCOP || undefined,
            Territorio: VICKY_CO_TERRITORIO,
            Tombola: VICKY_CO_TOMBOLA,
            Monda_del_trato: VICKY_CO_MONEDA,
            Sector: VICKY_CO_SECTOR,
            N_Empleados_que_marcan: userCount,
            Tipo_de_Cobro: (Number(userCount) || 1) <= 10 ? "Mensual fijo" : "Por usuario",
            Producto_Soluci_n: VICKY_CO_PRODUCTO,
            Owner: OWNER_CO, // deal → ejecutivo CO (Gordillo)
          };
          const conv = await convertLeadCO(leadVivo, dealDataCO);
          accountId = conv.accountId;
          contactId = conv.contactId;
          dealId = conv.dealId;
          // Convert OK pero respuesta PARCIAL (Zoho a veces omite Deals/ids en
          // el body aunque la conversión completó — caso Parroquia Santa
          // Filomena en CL): recuperar por $converted_detail ANTES de darlo
          // por fallido. Sin esto, leadConverted quedaba false y el Camino B
          // creaba un deal GEMELO del que la conversión ya había creado.
          if (!accountId || !contactId || !dealId) {
            const rec = await recoverConvertedIdsCO(leadVivo).catch(() => ({}));
            accountId = accountId || rec.accountId;
            contactId = contactId || rec.contactId;
            dealId = dealId || rec.dealId;
            if (rec.accountId || rec.contactId || rec.dealId) {
              console.warn(
                `[create-from-vicky-co] convert parcial recuperado por $converted_detail: account=${accountId || "∅"} contact=${contactId || "∅"} deal=${dealId || "∅"}`,
              );
            }
          }
          if (accountId && contactId && dealId) {
            leadConverted = true;
            accountReused = true;
            // Datos nuevos ganan sobre el lead viejo (cuenta/contacto).
            await updateRecord("Accounts", accountId, {
              Account_Name: empresa,
              RUT_Empresa: nitParaGuardarCO(nit),
              Territorio: VICKY_CO_TERRITORIO,
              N_Empleados_dependientes: userCount,
              Owner: OWNER_CO,
            }, true).catch(() => {});
            await updateRecord("Contacts", contactId, {
              Email: contactoEmail,
              Phone: contactoTelefono || undefined,
              Owner: OWNER_CO,
            }, true).catch(() => {});
            await setDealPorFono(contactoTelefono, dealId, "cotizacion").catch(() => {});
            console.warn(`[create-from-vicky-co] convert-first: lead ${leadVivo} → account=${accountId} contact=${contactId} deal=${dealId}`);
          }
        } catch (convErr) {
          console.error(`[create-from-vicky-co] convert-first falló (${toText(convErr?.message || convErr).slice(0, 200)}) — recupero/creo fresco.`);
          try {
            const rec = await recoverConvertedIdsCO(leadVivo);
            if (rec.dealId) {
              accountId = rec.accountId || accountId;
              contactId = rec.contactId || contactId;
              dealId = rec.dealId;
              leadConverted = Boolean(accountId && contactId && dealId);
            }
          } catch { /* cae a Camino B */ }
        }
      }
    }

    // ── CAMINO B (creación fresca con dedup) — solo si NO se convirtió ──
    if (!leadConverted) {
    // ── Account: dedup por NIT antes de crear ──
    stage = "find_account_by_nit";
    accountId = await findAccountIdByNit(nit, empresa);
    accountReused = Boolean(accountId);

    if (!accountId) {
      stage = "create_account";
      const createAccountPayload = {
        Account_Name: empresa,
        RUT_Empresa: nitParaGuardarCO(nit),
        Phone: contactoTelefono || undefined,
        Description: `Cuenta creada por Vicky CO (WhatsApp). NIT: ${nit}`,
        Industry: VICKY_CO_SECTOR,
        Territorio: VICKY_CO_TERRITORIO,
        N_Empleados_dependientes: userCount,
        Tiene_potencial_de_expansi_n_Regional: VICKY_CO_EXPANSION,
        Owner: OWNER_CO,
      };
      try {
        const accountResult = await createRecord("Accounts", createAccountPayload, true);
        accountId = toText(accountResult?.id);
        if (!accountId) throw new Error("No se obtuvo accountId");
      } catch (createError) {
        if (!isDuplicateDataError(createError)) throw createError;
        // Duplicado: puede ser por NIT (carrera con la búsqueda previa) o por
        // NOMBRE homónimo con NIT distinto. Re-buscamos por NIT y, si no hay
        // match, creamos la cuenta desambiguada "Empresa (NIT)" — son empresas
        // distintas con el mismo nombre, no la misma (regla del spec).
        stage = "dedupe_account_by_nit";
        const existingAccountId = await findAccountIdByNit(nit, empresa);
        if (existingAccountId) {
          accountId = existingAccountId;
          accountReused = true;
        } else {
          console.warn(
            `[create-from-vicky-co] duplicado por nombre con NIT distinto (${nit}); creando cuenta desambiguada.`,
          );
          stage = "create_account_disambiguated";
          const nombreDesambiguado = `${empresa} (${nit})`;
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
            // Capa 4: reusar SOLO si el NIT coincide; si no, seguir sin cuenta.
            stage = "reuse_account_capa4";
            const compactar = (v) => String(v || "").replace(/[.\s-]/g, "").toUpperCase();
            const porNombre = await executeCoqlQuery(
              `select id, RUT_Empresa from Accounts where Account_Name = '${nombreDesambiguado.replace(/'/g, "''")}' limit 5`,
            ).catch(() => []);
            const matchNit = (porNombre || []).find((r) => compactar(r.RUT_Empresa) === compactar(nit));
            if (matchNit) {
              accountId = toText(matchNit.id);
              accountReused = true;
            } else {
              accountId = undefined;
              console.error(`[create-from-vicky-co] Capa 4: sin salida de dedupe (NIT=${nit}); cotización SIN cuenta.`);
            }
          }
        }
      }
    }

    // ── Contact ──
    stage = "create_contact";
    const { firstName, lastName } = splitFullName(contacto);
    try {
      const contactResult = await createRecord("Contacts", {
        First_Name: firstName,
        Last_Name: lastName,
        Email: contactoEmail,
        Phone: contactoTelefono || undefined,
        ...(accountId ? { Account_Name: { id: accountId } } : {}),
        Lead_Source: VICKY_CO_LEAD_SOURCE,
        Territorio: VICKY_CO_TERRITORIO,
        Owner: OWNER_CO,
      }, true);
      contactId = toText(contactResult?.id);
      if (!contactId) throw new Error("No se obtuvo contactId");
    } catch (createError) {
      if (!isDuplicateDataError(createError)) throw createError;
      stage = "dedupe_contact_by_email";
      const existingContactId = await findContactIdByEmail(contactoEmail);
      if (!existingContactId) {
        throw new Error(
          `Zoho reportó duplicate data pero no se encontró Contact con Email ${contactoEmail}`,
        );
      }
      contactId = existingContactId;
    }

    // ── Deal (Territorio Colombia + obligatorios del layout, ver Chile) ──
    stage = "create_deal";
    if (!dealId) {
    const dealResult = await createRecord("Deals", {
      Deal_Name: `${empresa} - Cotización Vicky`,
      ...(accountId ? { Account_Name: { id: accountId } } : {}),
      ...(contactId ? { Contact_Name: { id: contactId } } : {}),
      Stage: VICKY_CO_DEAL_STAGE,
      Pipeline: "Standard (Standard)",
      Lead_Source: VICKY_CO_LEAD_SOURCE,
      Amount: totalCOP || undefined,
      Description: `Deal creado por Vicky CO para cotización WhatsApp.\nUsuarios: ${userCount || "-"}\nTotal: ${totalCOP} COP`,
      // Obligatorios del layout de Deals del org (mismo set que Chile: sin
      // ellos el create devuelve MANDATORY_NOT_FOUND).
      Territorio: VICKY_CO_TERRITORIO,
      Tombola: VICKY_CO_TOMBOLA,
      Monda_del_trato: VICKY_CO_MONEDA,
      Sector: VICKY_CO_SECTOR,
      N_Empleados_que_marcan: userCount,
      Tipo_de_Cobro: (Number(userCount) || 1) <= 10 ? "Mensual fijo" : "Por usuario",
      Producto_Soluci_n: VICKY_CO_PRODUCTO,
      Owner: OWNER_CO,
    }, true);
    dealId = toText(dealResult?.id);
    if (!dealId) throw new Error("No se obtuvo dealId");
    // Candado cruzado: registrar el deal apenas existe para que crm-hitos lo
    // reuse en vez de crear un gemelo por hito de conversación.
    await setDealPorFono(contactoTelefono, dealId, "cotizacion").catch(() => {});
    }
    } // fin Camino B (if !leadConverted)
    } catch (plumbingError) {
      if (String(process.env.CRM_STRICT || "") === "1") throw plumbingError;
      crmIncompleto = true;
      console.error(
        `[create-from-vicky-co] CRM DEGRADADO en stage=${stage}: ${toText(plumbingError?.message || plumbingError).slice(0, 300)}. ` +
          `La cotización continúa (accountId=${accountId || "∅"}, contactId=${contactId || "∅"}, dealId=${dealId || "∅"}).`,
      );
    }
    if (!accountId || !dealId) crmIncompleto = true;

    // Cierra el lead huérfano del flujo SDR (caso Globe Air Fuel): el lead vivo
    // del contacto sale de la cola "cliente para contactar" convirtiéndose a la
    // cuenta/contacto del deal recién creado. Best-effort, jamás bloquea.
    if (contactId || accountId) {
      await cerrarLeadHuerfanoCO(contactoTelefono, accountId, contactId).catch(() => {});
    }

    // REGLA EQUIPO CO (Lalo 05-ago): hitos no-formales → Eddy Galindo (SDR
    // fijo); la COTIZACIÓN FORMAL y TODOS sus registros (deal, cotización,
    // cuenta, contacto) → Alejandro Gordillo. Los registros CREADOS acá ya
    // nacen con OWNER_CO; los REUSADOS (deal del hito, cuenta/contacto de una
    // conversión previa) pueden venir del SDR — la formal los traspasa a
    // Gordillo. Un dueño humano real (fuera del set bot/SDR) NO se toca.
    // Best-effort: jamás bloquea la emisión.
    for (const [mod, id] of [["Deals", dealId], ["Accounts", accountId], ["Contacts", contactId]]) {
      if (!id || !OWNER_CO || !OWNER_CO.id) continue;
      try {
        const g = await zohoApiFetch(`/crm/v3/${mod}/${id}?fields=Owner`);
        if (!g.ok) continue;
        const ownerActual = toText((((await g.json())?.data || [])[0] || {}).Owner?.id);
        if (!ownerActual || ownerActual === toText(OWNER_CO.id)) continue;
        if (!OWNERS_ADOPTABLES_CO.has(ownerActual)) continue; // humano real: no se toca
        await updateRecord(mod, id, { Owner: { id: toText(OWNER_CO.id) } }, true);
        console.warn(`[create-from-vicky-co] formal: ${mod} ${id} traspasado del SDR ${ownerActual} a Gordillo (regla equipo CO).`);
      } catch { /* best-effort */ }
    }

    // ── Cotización con subform (convención COP en campos UF/CLP) ──
    stage = "create_quote";
    const subformItems = buildSubformItemsCO(items);
    const quoteResult = await createRecord(config.quoteModule, {
      Name: `Cotización ${empresa} - ${new Date().toISOString().slice(0, 10)}`,
      Owner: OWNER_CO,
      ...(dealId ? { [config.quoteDealLookupField]: { id: dealId } } : {}),
      ...(contactId ? { [config.quoteContactLookupField]: { id: contactId } } : {}),
      ...(accountId ? { Cuenta_Asociada: { id: accountId } } : {}),
      CRM_Incompleto: crmIncompleto,
      [config.quoteDateField]: new Date().toISOString().slice(0, 10),
      [config.quoteStatusField]: "Borrador",
      [config.contactEmailField]: contactoEmail,
      [config.contactPhoneField]: contactoTelefono || undefined,
      [config.companyRutField]: nit,
      [config.quoteItemsSubformField]: subformItems,
      [config.quoteVersionPdfField]: 1,
    }, true);
    const quoteId = toText(quoteResult?.id);
    if (!quoteId) throw new Error("No se obtuvo quoteId");
    // Marcador de idempotencia APENAS existen los registros: si el resto del
    // flujo muere, el reintento devuelve estos ids en vez de duplicar.
    await setIdempotente(idemClave, { quoteId, dealId, accountId, contactId });

    // ── acceptanceUrl (token firmado con pais:"co" — así session.js marca la
    // sesión como Colombia sin necesitar campos nuevos en Zoho) ──
    stage = "build_acceptance_url";
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const token = signAcceptancePayload({
      quoteId, dealId,
      pais: "co",
      iat: Date.now(), exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

    // Alerta interna best-effort si la entrega fue en modo degradado (sin
    // Cuenta/Deal): el equipo se entera al instante y el reconciliador ya
    // está en camino. El cliente jamás ve nada de esto.
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
        const html = buildProposalHtmlCO({
          cliente: { empresa, contacto, nit },
          items,
          acceptanceUrl,
          cotizacionId: numeroParaPdf(numeroCotizacion, quoteId),
          validezHasta: new Date(expMs).toISOString(),
        });
        const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
        const { pdfUrl } = await uploadPdfToSupabase({
          pdfBuffer,
          quoteId,
          empresa,
        });
        await updateRecord(config.quoteModule, quoteId, {
          [config.quotePdfUrlField]: pdfUrl,
        }, true);
        // Correo con el PDF (v2 — caso Globe Air Fuel, 04-ago: Vicky le
        // prometía al cliente un correo que este flujo jamás enviaba, la v1
        // era "PDF sin correo"). Mismo helper y plantilla que Chile; CC y
        // reply-to al ejecutivo CO para que vea lo que recibió su cliente.
        if (contactoEmail) {
          const CC_CO = toText(process.env.VICKY_CO_QUOTE_CC || "agordillo@geovictoria.com")
            .split(",").map((s) => s.trim()).filter(Boolean);
          await sendQuoteEmailViaZoho({
            quoteModule: config.quoteModule,
            quoteId,
            fromEmail: toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com",
            replyToEmail: CC_CO[0],
            ccEmails: CC_CO,
            toEmail: contactoEmail,
            toName: contacto,
            subject: `Tu cotización GeoVictoria — ${empresa}`,
            htmlBody: buildEmailHtml({
              contacto,
              empresa,
              pdfUrl,
              tieneReloj: false,
              ejecutivo: { nombre: "Alejandro Gordillo", email: "agordillo@geovictoria.com" },
            }),
          }).catch((mailErr) =>
            console.error("[create-from-vicky-co] correo de cotización falló:", mailErr?.message || mailErr),
          );
        }
      })().catch((bgErr) =>
        console.error(
          "[create-from-vicky-co] PDF en segundo plano falló:",
          bgErr?.message || bgErr,
        ),
      ),
    );
    return;

  } catch (error) {
    console.error(`[create-from-vicky-co] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: `Falla en stage='${stage}'`,
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};

// Se exponen para tests/reuso (misma convención que el endpoint chileno).
module.exports.buildSubformItemsCO = buildSubformItemsCO;
module.exports.ensureActivacion = ensureActivacion;
