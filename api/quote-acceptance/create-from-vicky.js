const { codigoCortoDeCotizacion, linkCortoDeCotizacion } = require("../_shared/codigo-corto");
const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { actualizarPunteroPdf } = require("../_shared/pointer-sync");
const { createRecord, updateRecord, getRecord, getRecordWithFields, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { claveIdempotencia, getIdempotente, setIdempotente, getDealPorFono, setDealPorFono, getLeadCandadoPorFono } = require("../_shared/idempotencia");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");
const { descuentosHasta } = require("../_shared/discount-engine");
const { emitirCotizacionEnCreator } = require("../_shared/ndv-emitir");

// waitUntil: corre trabajo en segundo plano DESPUÉS de responder, dentro de la
// misma invocación (Vercel mantiene viva la función hasta que termine). Se usa
// para generar el PDF + correo sin bloquear la respuesta a Vicky. Si el paquete
// no estuviera disponible, cae a un fallback best-effort (la promesa corre igual).
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch (_e) {
  waitUntil = (p) => {
    Promise.resolve(p).catch(() => {});
  };
}

const VICKY_OWNER_EMAIL = toText(process.env.VICKY_OWNER_EMAIL) || "egomez@geovictoria.com";
const VICKY_FROM_EMAIL = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";
const VICKY_REPLY_TO_EMAIL = toText(process.env.VICKY_REPLY_TO_EMAIL) || "egomez@geovictoria.com";
const VICKY_DEAL_STAGE = toText(process.env.VICKY_DEAL_STAGE_INICIAL) || "4. Propuesta Enviada / En Negociación";
const VICKY_LEAD_SOURCE = toText(process.env.VICKY_LEAD_SOURCE) || "SEO";
const VICKY_EJECUTIVO_NAME = toText(process.env.VICKY_EJECUTIVO_NAME) || "Vicky - Equipo Comercial GeoVictoria";
const VICKY_TERRITORIO = toText(process.env.VICKY_TERRITORIO) || "Chile";
// "Moneda del trato" del deal CL: CLP desde el 20-ago (convención de montos
// de marketing — el recurrente del trato va en pesos; antes decía UF).
const VICKY_MONEDA = toText(process.env.VICKY_MONEDA) || "CLP";
const VICKY_TOMBOLA = toText(process.env.VICKY_TOMBOLA) || "Mantener propietario";
const VICKY_PRODUCTO_DEFAULT = toText(process.env.VICKY_PRODUCTO_DEFAULT) || "Control de Asistencia";
const VICKY_SECTOR_FALLBACK = toText(process.env.VICKY_SECTOR_FALLBACK) || "19. Servicios";
const VICKY_EXPANSION_REGIONAL = toText(process.env.VICKY_EXPANSION_REGIONAL) || "No";

// ── Ejecutivo comercial asignado a las cotizaciones de Vicky ──
// Aparece en el correo y en el PDF, es el reply-to/CC del correo, y queda como
// Owner de los registros (Account/Contact/Deal/Quote) en Zoho.
//
// RELEVO 27-jul (Lalo): todo lo NUEVO va a Eddyluz Mujica
// (emujica@geovictoria.com, usuario activo id 3525045000000211283, verificado
// contra Zoho). Lo ya asignado a Anderson Díaz (3525045000426432190) queda a
// su nombre — cero cambios retroactivos.
// Identidad HUMANA (Rodrigo 27-jul: el PDF y el correo deben mostrar siempre
// el nombre y los datos del ejecutivo humano, no la identidad genérica).
// Las cotizaciones nuevas son de Eddyluz; las regeneraciones de cotizaciones
// existentes resuelven su Owner real en api/_shared/ejecutivo-cl.js.
const EJEC_NOMBRE = "Eddyluz Mujica";
const EJEC_CARGO = "Ejecutiva Comercial";
const EJEC_EMAIL = "emujica@geovictoria.com";

// Copia fija en todo correo de cotización al cliente (Lalo, 31-jul).
// Copias fijas del correo de cotización (lista separada por comas): Lalo
// (pedida 31-jul) + Rodrigo (pedida 03-ago).
const CC_FIJOS = (process.env.QUOTE_EMAIL_CC_FIJO || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const EJEC_TELEFONO = "+56 9 3932 1687";
const EJEC_WHATSAPP = "56939321687";
const EJEC_OWNER_ID = "3525045000000211283";
const EJEC_OWNER = { id: EJEC_OWNER_ID };
// VICKY ES LA INTERINA OFICIAL (Lalo 06-ago): deals, cuentas, contactos y
// cotizaciones nacen con el usuario VICKY y ESPERAN ahí — la emisión ya no
// sortea. La asignación al vendedor y su notificación van de la mano con los
// relojes de traspaso (120/15/10 min hábiles, vic-ptv-cron): recién cuando la
// conversación se traspasa corre la tómbola. Excepciones con dueño inmediato:
// asignación manual admin, herencia de dueño humano real, reunión (host) y
// >50 (deal + tómbola en el acto, sin relojes). EJEC_* queda solo como
// detección de interina histórica en registros viejos.
const VICKY_BOT_OWNER = { id: "3525045000484500876" };

// Regla de tómbola de Deals en Zoho para Chile ("Tómbola Deals 2026 Chile",
// compartida por Lalo el 31-jul). Todo deal creado por Vicky se sortea con
// lar_id y la cotización se asigna al dueño resultante. Override por env.
const TOMBOLA_DEALS_RULE_CL = (process.env.VICKY_TOMBOLA_DEALS_CL || "3525045000595568541").trim();

// Cuentas internas de GeoVictoria que NUNCA deben reusarse al deduplicar por RUT.
// Un RUT basura/de prueba puede chocar con una cuenta interna y terminar asociando
// la cotización de un prospecto a esa cuenta (caso real: el dedup pegó el lead a la
// cuenta interna "GeoVictoria"). Configurable vía env (lista separada por comas).
const INTERNAL_ACCOUNT_NAMES = (process.env.VICKY_INTERNAL_ACCOUNT_NAMES || "GeoVictoria")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Documentos hosteados (URLs permanentes en Supabase) que van como botones de
// descarga en el correo de la cotización.
const DOC_CERTIFICACION = "https://cotizacion.geovictoria.com/pdf/assets/certificacion-dt.pdf";
const DOC_FICHA_RELOJ = "https://cotizacion.geovictoria.com/pdf/assets/ficha-reloj-senseface.pdf";
const DOC_PRESENTACION = "https://cotizacion.geovictoria.com/pdf/assets/presentacion-comercial.pdf";

const SECTORES_VALIDOS = new Set([
  "1. Agrícola", "2. Condominio", "3. Construcción", "4. Inmobilaria",
  "5. Consultoria", "6. Banca y Finanzas", "7. Educación", "8. Municipio",
  "9. Gobierno", "10. Mineria", "11. Naviera", "12. Outsourcing Seguridad",
  "12. Outsourcing General", "13. Outsourcing Retail", "14. Planta Productiva",
  "15. Logistica", "16. Retail Enterprise", "17. Retail SMB", "18. Salud",
  "19. Servicios", "20. Transporte", "21. Turismo, Hotelería y Gastronomía",
]);

function validarSector(valorRecibido) {
  const v = toText(valorRecibido);
  if (v && SECTORES_VALIDOS.has(v)) return v;
  return VICKY_SECTOR_FALLBACK;
}

// ── CORS ──
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

// ── Helper: convertir Lead → Account+Contact+Deal ──
// Si la cuenta/contacto YA existen (dedup por nombre de Zoho), el convert
// devuelve DUPLICATE_DATA con el id del duplicado: se reintenta UNA vez
// apuntando a esos registros existentes (el lead se fusiona en ellos).
async function convertLead(leadId, dealData, existingIds = {}) {
  const path = `/crm/v3/Leads/${encodeURIComponent(leadId)}/actions/convert`;
  // dealData null → conversión SIN deal nuevo (candado cruzado: el deal ya
  // existe, nacido del hito de conversación — solo se necesita Account/Contact).
  const payload = {
    overwrite: true,
    notify_lead_owner: true,
    notify_new_entity_owner: true,
    ...(dealData ? { Deals: dealData } : {}),
  };
  // Zoho espera jsonobject {id} (string pelado → INVALID_DATA, caso real 08-jul).
  if (existingIds.accountId) payload.Accounts = { id: existingIds.accountId };
  if (existingIds.contactId) payload.Contacts = { id: existingIds.contactId };
  const response = await zohoApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [payload] }),
  });
  const text = await response.text();
  if (!response.ok) {
    // Duplicado: reintenta apuntando al registro existente que Zoho reporta.
    let dup = null;
    try { dup = JSON.parse(text)?.data?.[0]; } catch { /* noop */ }
    if (dup?.code === "DUPLICATE_DATA" && dup?.details?.duplicate_record?.id) {
      const dupModule = toText(dup?.details?.duplicate_record?.module?.api_name);
      const dupId = toText(dup.details.duplicate_record.id);
      const puedeReintentar =
        (dupModule === "Contacts" && !existingIds.contactId) ||
        (dupModule !== "Contacts" && !existingIds.accountId);
      if (puedeReintentar) {
        console.warn(`[create-from-vicky] convert duplicado en ${dupModule} (${dupId}); reintento fusionando.`);
        const retryIds =
          dupModule === "Contacts"
            ? { ...existingIds, contactId: dupId }
            : { ...existingIds, accountId: dupId };
        return convertLead(leadId, dealData, retryIds);
      }
    }
    throw new Error(`Zoho convert Lead failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text);
  const result = parsed?.data?.[0];
  if (!result) throw new Error("Respuesta de convert Lead sin data");
  // Zoho v3 devuelve cada entidad como objeto {id, name} (o string en variantes
  // viejas). Parsear solo el string hacía "fallar" conversiones EXITOSAS y el
  // fallback duplicaba cuenta/deal (caso real 08-jul).
  const idFrom = (v) => toText(v && typeof v === "object" ? v.id : v);
  // Zoho también entrega los IDs DENTRO de details (hallazgo 04-ago, mismo
  // bug que dejó sin tómbola a los deals de crm-hitos): mirar ambos lados
  // evita el roundtrip de recuperación por $converted_detail.
  const det = result.details || {};
  const ids = {
    accountId: idFrom(result.Accounts) || idFrom(det.Accounts),
    contactId: idFrom(result.Contacts) || idFrom(det.Contacts),
    dealId: idFrom(result.Deals) || idFrom(det.Deals),
  };
  if (ids.accountId && ids.contactId && (ids.dealId || !dealData)) return ids;
  // La conversión puede COMPLETARSE en Zoho aunque la respuesta venga sin
  // todos los IDs (caso real 17-jul, Parroquia Santa Filomena: convert OK,
  // respuesta incompleta → el fallback duplicó cuenta/contacto/deal). Antes
  // de que el caller lo trate como fallo, se recuperan los IDs desde el
  // propio lead convertido ($converted_detail).
  const recovered = await recoverConvertedIds(leadId);
  return {
    accountId: ids.accountId || recovered.accountId,
    contactId: ids.contactId || recovered.contactId,
    dealId: ids.dealId || recovered.dealId,
  };
}

// LEAD VIVO por teléfono (escenario Lalo 04-ago: "Vicky creó un lead durante
// la conversación y luego otro para convertirlo cuando hubo cotización").
// El agente registra su lead en vic_kv zoho_lead_<fono> (consistencia
// inmediata); fallback a la búsqueda de Zoho (índice ~2 min). El lead SIN
// convertir se adopta como existing.leadId: el deal nace CONVIRTIENDO ese
// lead (regla marketing) en vez de nacer directo dejando el lead huérfano —
// que era la otra mitad del patrón de gemelos hito-vs-cotización.
// Dueños "del bot": el usuario Vicky y los interinos por país. SOLO leads de
// estos dueños se adoptan — un lead de dueño HUMANO (SDR trabajando un
// formulario, típico en outbound) no se toca: su gestión es intocable (regla
// marketing) y la emisión sigue con el camino de siempre para él.
const OWNERS_BOT_LEADS = new Set([
  "3525045000484500876", // usuario Vicky
  "3525045000000211283", // Eddyluz (interina CL)
  "3525045000203758005", // Gordillo (interino CO)
  "3525045000308323003", // Yahel (interina MX)
]);

async function findOpenLeadIdByPhone(telefono) {
  const fono = String(telefono || "").replace(/\D/g, "");
  if (!fono) return "";
  let candidato = "";
  try {
    candidato = await getLeadCandadoPorFono(fono);
  } catch { /* best-effort */ }
  if (!candidato) {
    try {
      const response = await zohoApiFetch(
        `/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=3`,
      );
      if (response.ok && response.status !== 204) {
        const leads = (await response.json())?.data || [];
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
  // Verificación del candidato (venga del kv o de la búsqueda): dueño del
  // bot y sin convertir. Si el GET falla, mejor no adoptar.
  try {
    const g = await zohoApiFetch(`/crm/v3/Leads/${encodeURIComponent(candidato)}?fields=Owner`);
    if (!g.ok) return "";
    const lead = (await g.json())?.data?.[0];
    const ownerId = toText(lead?.Owner?.id);
    if (!OWNERS_BOT_LEADS.has(ownerId)) {
      console.warn(
        `[create-from-vicky] lead ${candidato} tiene dueño humano (${ownerId}) — no se adopta, gestión intocable.`,
      );
      return "";
    }
    return candidato;
  } catch {
    return "";
  }
}

// LEAD-FIRST (Lalo 30-jul, cierre del patrón Odalisca): si el contacto ya
// tiene un lead CONVERTIDO (la sincronización de hitos convierte apenas ve
// el preform), la formal debe COLGARSE de ese deal — no crear otro. Busca el
// lead por teléfono y devuelve los ids de su conversión, descartando deals
// en Cierre Perdido (ahí sí corresponde ciclo nuevo).
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
      accountId: toText(detail.account || lead?.Converted_Account?.id),
      contactId: toText(detail.contact || lead?.Converted_Contact?.id),
      dealId: toText(detail.deal || lead?.Converted_Deal?.id),
    };
    if (ids.dealId) {
      // La dedup es de procesos ABIERTOS (Lalo 31-jul, caso Sasval): un deal
      // en Cierre Perdido (perdido) o 8. Facturando (cliente actual) es OTRA
      // negociación ya cerrada — la cotización nueva abre ciclo nuevo con
      // deal propio (reglas 4 y 6 del Proceso de Gestión de Leads). La
      // cuenta y el contacto sí se reusan: la empresa es la misma.
      const deal = await getRecord("Deals", ids.dealId);
      if (["Cierre Perdido", "8. Facturando"].includes(toText(deal?.Stage))) ids.dealId = "";
    }
    if (ids.accountId || ids.contactId || ids.dealId) {
      console.warn(
        `[create-from-vicky] lead-first: contacto ${fono} ya convertido — se reusa account=${ids.accountId || "-"} contact=${ids.contactId || "-"} deal=${ids.dealId || "-"}`,
      );
    }
    return ids;
  } catch {
    return {};
  }
}

// Recupera los IDs de la conversión desde el lead convertido. Verificado
// contra el API real (17-jul): GET /Leads?ids={id}&converted=true devuelve
// $converted_detail = { account, contact, deal } con los ids planos.
async function recoverConvertedIds(leadId) {
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
        `[create-from-vicky] IDs recuperados de $converted_detail lead=${leadId}: account=${ids.accountId || "-"} contact=${ids.contactId || "-"} deal=${ids.dealId || "-"}`,
      );
    }
    return ids;
  } catch {
    return {};
  }
}

// ── Helper: enviar email via Zoho CRM send_mail ──
/**
 * Sube un archivo a Zoho Files y devuelve su id encriptado, que es lo único
 * que `send_mail` acepta como adjunto. Va a content.zohoapis.com (dominio de
 * archivos, distinto del de la API normal) con el mismo access token.
 * Best-effort: si falla, el correo sale sin adjunto — jamás sin correo.
 */
// Token EXCLUSIVO para Zoho Files (18-ago): el token productivo no tiene el
// scope ZohoFiles y regenerarlo es un riesgo que Lalo no quiere correr. En
// cambio, un SEGUNDO grant del MISMO client (scope ZohoFiles.files.ALL, env
// ZOHO_FILES_REFRESH_TOKEN) convive sin tocar nada: este helper lo acuña y
// cachea; sin el env, se cae al token compartido (que funcionará el día que
// el scope se agregue por el otro camino).
let _filesTokenCache = { token: "", exp: 0 };
async function accessTokenArchivos() {
  const rt = String(process.env.ZOHO_FILES_REFRESH_TOKEN || "").trim();
  if (!rt) return "";
  if (_filesTokenCache.token && _filesTokenCache.exp - Date.now() > 2 * 60 * 1000) return _filesTokenCache.token;
  try {
    const domain = String(process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com").trim().replace(/\/+$/, "");
    const res = await fetch(`${domain}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: rt,
        client_id: String(process.env.ZOHO_CLIENT_ID || "").trim(),
        client_secret: String(process.env.ZOHO_CLIENT_SECRET || "").trim(),
        grant_type: "refresh_token",
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j?.access_token) {
      console.warn(`[send_mail] token de archivos no se pudo acuñar: ${JSON.stringify(j).slice(0, 150)}`);
      return "";
    }
    _filesTokenCache = { token: String(j.access_token), exp: Date.now() + 55 * 60 * 1000 };
    return _filesTokenCache.token;
  } catch (e) {
    console.warn(`[send_mail] token de archivos lanzó: ${e.message}`);
    return "";
  }
}

async function subirArchivoZohoParaAdjunto(buffer, filename) {
  try {
    // OJO: el endpoint de archivos vive en el MISMO api domain que el resto
    // (www.zohoapis.com/crm/v3/files). El primer intento fue contra
    // content.zohoapis.com y devolvió 404 (17-ago, prueba de Rodrigo) — ese
    // dominio es de otra API. zohoApiFetch pone el token y no fuerza
    // Content-Type, así que el FormData define su propio boundary.
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "application/pdf" }), filename);
    const tokenArchivos = await accessTokenArchivos();
    let r;
    if (tokenArchivos) {
      const api = String(process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim().replace(/\/+$/, "");
      r = await fetch(`${api}/crm/v3/files`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${tokenArchivos}` },
        body: form,
      });
    } else {
      const { zohoApiFetch } = require("../_shared/zoho-auth");
      r = await zohoApiFetch("/crm/v3/files", {
        method: "POST",
        body: form,
      });
    }
    const j = await r.json().catch(() => ({}));
    const id = j?.data?.[0]?.details?.id || j?.data?.[0]?.id || "";
    if (!r.ok || !id) {
      console.warn(`[send_mail] subida de adjunto falló (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
      return "";
    }
    return String(id);
  } catch (e) {
    console.warn(`[send_mail] subida de adjunto lanzó: ${e.message}`);
    return "";
  }
}

async function sendQuoteEmailViaZoho({
  quoteModule, quoteId, fromEmail, replyToEmail, toEmail, toName, subject, htmlBody, ccEmail, ccEmails, attachmentId,
}) {
  const path = `/crm/v3/${encodeURIComponent(quoteModule)}/${encodeURIComponent(quoteId)}/actions/send_mail`;
  const dataPayload = {
    from: { email: fromEmail },
    to: [{ user_name: toName || toEmail, email: toEmail }],
    subject,
    content: htmlBody,
    mail_format: "html",
  };
  // PDF adjunto (Eduardo 17-ago): el respaldo viaja EN el correo; el botón
  // del cuerpo lleva a la aceptación online, no al PDF.
  if (attachmentId) {
    dataPayload.attachments = [{ id: attachmentId }];
  }
  if (replyToEmail && replyToEmail !== fromEmail) {
    dataPayload.reply_to = { email: replyToEmail };
  }
  // CC: combina ccEmail (legado, 1 correo) + ccEmails (lista). Normaliza,
  // excluye el destinatario principal y deduplica (case-insensitive).
  const toLower = String(toEmail || "").trim().toLowerCase();
  const seen = new Set();
  const ccList = [];
  for (const raw of [ccEmail, ...(Array.isArray(ccEmails) ? ccEmails : [])]) {
    const email = String(raw || "").trim();
    const low = email.toLowerCase();
    if (!email || low === toLower || seen.has(low)) continue;
    seen.add(low);
    ccList.push(email);
  }
  if (ccList.length) {
    dataPayload.cc = ccList.map((email) => ({ email }));
  }
  const enviar = async (payload) => {
    const response = await zohoApiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [payload] }),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  };

  let r = await enviar(dataPayload);
  // Un destinatario en COPIA rechazado no puede matar el correo del CLIENTE.
  //
  // CASO REAL (27-jul, descubierto por Lalo con 6 clientes reclamando): el CC
  // institucional apuntaba a un buzón @geovictoria.com que Microsoft 365
  // rechaza ("5.4.1 Recipient address rejected: Access denied"), Zoho aborta
  // el envío COMPLETO con 400 NOT_ALLOWED, y el cliente se queda sin su
  // cotización — en silencio, porque esto corre en segundo plano. El correo
  // al cliente ES el envío; la copia interna es cortesía: si la copia rompe,
  // se reintenta UNA vez sin CC y se deja el grito en el log.
  if (!r.ok && dataPayload.cc && /NOT_ALLOWED|Recipient address rejected|5\.4\.1/i.test(r.text)) {
    console.error(
      `[send_mail] CC rechazado por el servidor de correo (${r.text.slice(0, 160)}). Reintentando SIN copia para no dejar al cliente sin su cotización.`,
    );
    const sinCc = { ...dataPayload };
    delete sinCc.cc;
    r = await enviar(sinCc);
  }
  if (!r.ok) {
    throw new Error(`Zoho send_mail failed (${r.status}): ${r.text.slice(0, 200)}`);
  }
  return r.text;
}

// Número de cotización a mostrar en el PDF: el correlativo de Zoho
// (Numero_Cotizacion, ej. "COT151") SIN el prefijo "COT" → "151". Si por algún
// motivo no está disponible, cae a los últimos 8 dígitos del id interno.
function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

function buildDocFila(href, label, nota) {
  const notaHtml = nota ? ` <span style="color:#a0aec0;font-size:12px;">${nota}</span>` : "";
  return `<tr><td style="padding:11px 16px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;">
    <a href="${href}" style="color:#1a73e8;text-decoration:none;font-size:14px;font-weight:600;">${label}</a>${notaHtml}
  </td></tr><tr><td style="height:8px;"></td></tr>`;
}

// Correo de la cotización (estilo cálido/comercial). El botón principal va al
// PDF de la cotización (desde ahí se llega a la aceptación online); los
// documentos van como botones de descarga a archivos hosteados. La ficha del
// reloj solo se incluye si la cotización tiene hardware.
function buildEmailHtml({ contacto, empresa, pdfUrl, acceptanceUrl, tieneReloj, ejecutivo, pdfAdjunto }) {
  // El bloque "Te presento a tu ejecutivo" usa al DUEÑO REAL sorteado por la
  // tómbola (caso Grey, 31-jul: el correo decía Eddyluz fija mientras el deal
  // era de Grey). Sin dato, cae al ejecutivo por defecto de siempre.
  // Sin dueño humano real (deal esperando en Vicky, modelo 06-ago) el correo
  // lo firma VICKY — nunca una ejecutiva fija (caso Grey 31-jul): el vendedor
  // se presenta recién cuando el traspaso lo asigna de verdad.
  const esVicky = !(ejecutivo && toText(ejecutivo.email));
  const ej = esVicky
    ? { nombre: "Vicky", cargo: "Asistente Comercial", email: VICKY_FROM_EMAIL, telefono: "" }
    : {
        nombre: toText(ejecutivo.nombre) || toText(ejecutivo.email).split("@")[0],
        cargo: toText(ejecutivo.cargo) || "Ejecutivo Comercial",
        email: toText(ejecutivo.email),
        // Sin teléfono conocido NO se hereda el de otra persona: el bloque
        // sale solo con nombre y correo.
        telefono: toText(ejecutivo.telefono),
      };
  ej.whatsapp = ej.telefono.replace(/\D/g, "");
  const telHtml = ej.telefono
    ? ` &nbsp;·&nbsp; 📱 <a href="https://wa.me/${ej.whatsapp}" style="color:#1a73e8;text-decoration:none;">${ej.telefono}</a>`
    : "";
  const tituloEjecutivo = esVicky ? "Sigo aquí contigo 💬" : "Te presento a tu ejecutivo 🤝";
  const textoEjecutivo = esVicky
    ? `Cualquier duda o ajuste que necesites, <strong>responde este correo</strong> o escríbeme por el mismo WhatsApp donde ya estamos conversando — te acompaño en todo el proceso. 😊`
    : `De aquí en adelante, <strong>__EJ_NOMBRE__</strong> te acompaña en todo el proceso. Cualquier duda o ajuste que necesites, <strong>responde este correo</strong> o escríbele directo por WhatsApp — está para ayudarte. 😊`.replace("__EJ_NOMBRE__", ej.nombre);
  const primerNombre = String(contacto || "").trim().split(/\s+/)[0] || "";
  const saludo = primerNombre ? `Hola ${primerNombre} 👋` : "Hola 👋";
  const fichaFila = tieneReloj
    ? buildDocFila(DOC_FICHA_RELOJ, "🕐 Ficha Técnica del Reloj", "(tu cotización lleva reloj)")
    : "";
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Tu cotización GeoVictoria</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(13,71,161,0.08);">
    <tr><td style="background:linear-gradient(135deg,#0d47a1 0%,#1a73e8 100%);padding:28px 32px;">
      <table role="presentation" width="100%"><tr><td style="color:#ffffff;font-size:22px;font-weight:700;">GeoVictoria</td><td align="right" style="color:#bbdefb;font-size:12px;">Control de Asistencia</td></tr></table>
    </td></tr>
    <tr><td style="padding:36px 32px 8px 32px;">
      <p style="margin:0 0 6px 0;font-size:14px;color:#1a73e8;font-weight:600;">${saludo}</p>
      <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.3;color:#1a202c;">Tu cotización para <span style="color:#0d47a1;">${empresa}</span> está lista</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">Preparé tu propuesta de Control de Asistencia. Revísala, acéptala y págala en línea con el botón${pdfAdjunto ? " — el PDF de respaldo va adjunto" : ""}.</p>
    </td></tr>
    <tr><td align="center" style="padding:28px 32px 8px 32px;">
      <a href="${acceptanceUrl || pdfUrl}" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:14px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">✅ Acepta y paga aquí</a>
      <br>
      <a href="${pdfUrl}" style="display:inline-block;margin-top:12px;background:#ffffff;color:#1a73e8;border:2px solid #1a73e8;padding:10px 24px;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">📄 Descargar PDF</a>
      ${pdfAdjunto ? '<p style="margin:12px 0 0 0;font-size:12px;color:#a0aec0;">El PDF también va adjunto en este correo.</p>' : ""}
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 14px 0;font-size:15px;color:#1a202c;">Cómo seguimos 🚀</h3>
      <table role="presentation" width="100%">
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">1.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Revisas tu cotización con el botón de arriba.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">2.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">La aceptas en línea y pagas el primer mes de forma segura.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">3.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;">Coordinamos la instalación e iniciamos tu onboarding en 24 horas hábiles.</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 12px 0;font-size:15px;color:#1a202c;">Documentos para ti 📎</h3>
      <table role="presentation" width="100%">
        ${buildDocFila(DOC_CERTIFICACION, "📄 Certificación Dirección del Trabajo", "")}
        ${fichaFila}
        ${buildDocFila(DOC_PRESENTACION, "📊 Presentación Comercial GeoVictoria", "")}
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 8px 0;font-size:15px;color:#1a202c;">${tituloEjecutivo}</h3>
      <p style="margin:0 0 16px 0;font-size:14px;color:#4a5568;line-height:1.6;">${textoEjecutivo}</p>
      <table role="presentation" width="100%" style="background:#f7f9fc;border:1px solid #e2e8f0;border-radius:10px;"><tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px 0;font-size:14px;color:#1a202c;font-weight:600;">${ej.nombre}</p>
        <p style="margin:0 0 8px 0;font-size:13px;color:#718096;">${ej.cargo} · GeoVictoria</p>
        <p style="margin:0;font-size:13px;color:#718096;">✉️ <a href="mailto:${ej.email}" style="color:#1a73e8;text-decoration:none;">${ej.email}</a>${telHtml}</p>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:28px 32px 30px 32px;">
      <p style="margin:0;font-size:11px;color:#a0aec0;line-height:1.5;">GeoVictoria — Especialistas en Control de Asistencia y Accesos, presentes en 40+ países.<br><a href="https://geovictoria.com" style="color:#a0aec0;">geovictoria.com</a></p>
    </td></tr>
  </table>
  <p style="font-size:11px;color:#b8c0cc;margin:16px 0 0 0;">Este es un correo automático de tu cotización. Si no la solicitaste, ignóralo.</p>
</td></tr></table>
</body></html>`;
}

// ── Constructores de payloads de update ──
//
// IMPORTANTE: Cuando reusamos un Account/Contact existente (porque buscar_prospect
// encontró match), aplicamos "update conservador": NO sobrescribimos campos que
// ya tienen valor en Zoho. Solo llenamos campos null/vacíos.
//
// Razón: un Account consolidado (sobre todo si match fue por RUT máxima) tiene
// datos legítimos del equipo comercial. Que Vicky cambie el RUT a un formato
// diferente, o el Industry, o el Account_Name, es destructivo.
//
// El payload completo se construye igual que antes; el filtrado se hace en
// `applyConservativeUpdate()` que consulta el registro actual y omite los
// campos donde Zoho ya tiene valor.

function buildAccountFullPayload(cliente, sectorParaZoho) {
  return {
    Phone: cliente.contactoTelefono || undefined,
    Industry: sectorParaZoho,
    Territorio: VICKY_TERRITORIO,
    N_Empleados_dependientes: cliente.userCount,
    Tiene_potencial_de_expansi_n_Regional: VICKY_EXPANSION_REGIONAL,
    RUT_Empresa: cliente.rutEmpresa,
    Billing_Street: cliente.direccionEmpresa || undefined,
    Billing_City: cliente.comunaEmpresa || undefined,
    Billing_State: cliente.regionEmpresa || undefined,
  };
}

function buildContactFullPayload(cliente) {
  const { firstName, lastName } = splitFullName(cliente.contacto);
  return {
    First_Name: firstName,
    Last_Name: lastName,
    Email: cliente.contactoEmail,
    Phone: cliente.contactoTelefono || undefined,
    Lead_Source: VICKY_LEAD_SOURCE,
    Territorio: VICKY_TERRITORIO,
  };
}

/**
 * Aplica update conservador: solo sobrescribe campos que están vacíos/null
 * en el registro existente. Mantiene intactos los campos ya consolidados.
 */
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
 * Detecta si un error de Zoho es por ID inválido. Esos errores deberían
 * ser tratados como "no existe" en lugar de errores fatales, para hacer
 * fallback a crear un registro nuevo.
 */
function isInvalidIdError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("id given seems to be invalid") ||
    message.includes("invalid_data") ||
    message.includes("invalid id") ||
    message.includes("the id is invalid") ||
    // Registro BORRADO (papelera): Zoho responde 204 con cuerpo vacío y
    // getRecord lo envuelve como "HTTP 204". Sin esta rama, un contacto
    // convertido cuyo registro fue eliminado abortaba TODO el plumbing CRM
    // (caso 14-ago: COT569/COT577 nacieron sin contacto ni deal porque el
    // $converted_detail apuntaba a un contacto borrado; el fallback a crear
    // uno nuevo existía pero nunca se alcanzaba).
    message.includes("http 204") ||
    message.includes("resource_not_found")
  );
}

/**
 * Detecta si un error de Zoho es por "duplicate data". Esto pasa cuando el
 * createRecord falla porque ya existe un registro con un campo único
 * (típicamente RUT_Empresa en Accounts).
 *
 * Cuando esto ocurre, intentamos encontrar el registro existente y reusarlo
 * con update conservador (Capa 3).
 *
 * Nota sobre "multiple errors": cuando un Account nuevo tiene 2+ campos
 * UNIQUE duplicados a la vez (típicamente Account_Name + RUT_Empresa
 * para el mismo cliente que ya cotizó antes), Zoho agrupa los errores y
 * devuelve "Multiple errors in the request" en lugar de "duplicate data".
 * Lo tratamos igual: intentamos dedup por RUT y, si no encontramos match,
 * el código aguas abajo lanza un error claro.
 */
function isDuplicateDataError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("duplicate data") ||
    message.includes("duplicate_data") ||
    message.includes("multiple errors")
  );
}

// ── Generador de variantes RUT (espejo de lib/zoho-search.ts en Vicky) ──
//
// Para "18.435.922-7" genera: ["18.435.922-7", "184359227", "18435922-7"].
// Necesitamos múltiples variantes porque distintos registros en Zoho pueden
// tener distintos formatos del mismo RUT.
function getRutVariants(rut) {
  if (!rut) return [];
  const raw = String(rut).trim();
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
  ];
  // DV "K": agrega variantes en minúscula por si quedó guardado como "k".
  if (dv === "K") {
    variantes.push(`${cuerpo}k`, `${cuerpo}-k`, `${cuerpoConPuntos}-k`);
  }
  return Array.from(new Set(variantes)).filter(Boolean);
}

// ── Búsqueda en Zoho (sólo para Capa 3, no para flujo normal) ──
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

async function findAccountIdByRut(rutEmpresa, empresaName) {
  const variants = getRutVariants(rutEmpresa);
  if (variants.length === 0) return null;
  const escaped = variants.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const query = `select id, Account_Name from Accounts where RUT_Empresa in (${escaped}) limit 10`;
  const rows = await executeCoqlQuery(query);
  if (!rows.length) return null;
  // Guardia anti-cuenta-interna: descarta cuentas internas de GeoVictoria para no
  // asociar la cotización de un prospecto a una cuenta interna por una colisión de
  // RUT (típicamente un RUT de prueba/basura). Si solo matchearon internas, se
  // trata como "sin match" (el caller lanzará un error claro en vez de pegarse a
  // la cuenta interna).
  const esInterna = (name) =>
    INTERNAL_ACCOUNT_NAMES.includes(String(name || "").trim().toLowerCase());
  const externas = rows.filter((r) => !esInterna(r.Account_Name));
  if (!externas.length) {
    console.warn(
      `[create-from-vicky] dedup por RUT '${rutEmpresa}' solo matcheó cuenta(s) interna(s); se ignora para no asociar la cotización a una cuenta interna de GeoVictoria.`,
    );
    return null;
  }
  // Si el RUT está en varias cuentas (dato sucio / colisión), preferimos la que
  // coincide con el nombre cotizado, para no asociar a otra empresa distinta.
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

// ── Mapeos para el subform Detalle_Items_Cotizacion ──
//
// El picklist Modalidad en Zoho tiene `display_value` distinto del `reference_value`
// que espera la API. Mapeamos lo que Vicky envía a lo que Zoho acepta.
//
// Vicky envía:                   Zoho espera (reference_value):
//   "Por usuario"           →     "Recurrente"   (display "Por usuario")
//   "Fijo"                  →     "Único"        (display "Fijo")
//   "Arriendo mensual"      →     "Arriendo"
//   "Venta única"           →     "Venta"
//   "Cobro único"           →     "Venta"        (instalación y otros servicios no recurrentes)
//
// IMPORTANTE sobre el picklist "Único" en Zoho: NO significa "pago único". Es el
// reference_value que corresponde al display "Fijo" (tarifa fija mensual). Por
// eso los servicios de pago único (como instalación) van a "Venta", que es el
// único picklist no recurrente disponible.
function mapModalidadToZoho(modalidadVicky) {
  const m = String(modalidadVicky || "").toLowerCase().trim();
  if (m.startsWith("por usuario")) return "Recurrente";
  if (m.startsWith("fijo")) return "Único";
  if (m.startsWith("arriendo")) return "Arriendo";
  if (m.startsWith("venta")) return "Venta";
  // Cualquier variante de pago único (cobro único, pago único, etc.) que no
  // sea explícitamente una venta de equipos: mapea a "Venta" para que quede
  // clasificada como no recurrente.
  if (m.includes("único") || m.includes("unico") || m.includes("única") || m.includes("unica")) {
    return "Venta";
  }
  return "Recurrente"; // fallback razonable para módulos
}

function isItemRecurrente(modalidadZoho) {
  // "Único" es el reference_value del display "Fijo" (tarifa fija MENSUAL), por
  // eso cuenta como recurrente. Los pagos únicos reales van a "Venta".
  return (
    modalidadZoho === "Recurrente" ||
    modalidadZoho === "Arriendo" ||
    modalidadZoho === "Único"
  );
}

// Mapea tipo + id del item al picklist Categoria_Item
function mapCategoriaToZoho(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  const id = String(item.id || "").toLowerCase();
  if (tipo === "hardware") return "Equipos Biometricos";
  if (id === "asistencia") return "Plataforma Asistencia";
  // Resto de módulos (vacaciones, banco_horas, alertas, etc.)
  if (tipo === "modulo") return "Modulos Adicionales";
  return "Otro";
}

// Mapea modalidad al picklist Unidad
function mapUnidadToZoho(modalidadZoho, tipo) {
  if (tipo === "hardware") return "Dispositivo";
  if (modalidadZoho === "Recurrente") return "Usuario";
  if (modalidadZoho === "Único") return "Servicio";
  return "Unidad";
}

// Mapeo de id de hardware (catálogo de Vicky) → modelo real para mostrar
// en el PDF de la cotización formal.
//
// El catálogo de Vicky usa nombres genéricos ("Reloj control físico") para no
// exponer marcas/modelos en la conversación. Pero el PDF formal sí debe
// reflejar el modelo concreto. Este diccionario traduce el `id` del item de
// hardware al string que se escribe en el campo `Descripcion_Item` del
// subform Detalle_Items_Cotizacion.
//
// Cuando se agregue un hardware nuevo al catálogo de Vicky, agregarlo también
// aquí. Si falta el mapeo, `Descripcion_Item` queda vacío para ese item.
const HARDWARE_ID_TO_DESCRIPCION = {
  senseface_2a: "Sense Face 2A",
  armorpad: "ARMORPAD",
  ct58: "CT58",
  in01a_4glan: "IN01-A (4G/LAN)",
  in01a_lan: "IN01-A (LAN)",
  in01a_lanwifi: "IN01-A (LAN/WIFI)",
  mb10vl: "MB10-VL",
  mb560vl: "MB560-vl",
  s922: "S922",
  senseface_3a: "Sense Face 3A",
  senseface_4a: "Sense Face 4A",
  senseface_7a: "Sense Face 7A",
  speedface_v4l: "SpeedFace V4L",
  speedface_v5l: "SpeedFace V5L",
  uru4500: "URU4500",
  x628c: "X628-C",
};

// Resuelve el contenido de Descripcion_Item para un item del subform.
// - hardware: modelo real desde el diccionario (vacío si no está mapeado).
// - módulo:   vacío (el PDF ya muestra Nombre_Item).
function resolveDescripcionItem(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  if (tipo !== "hardware") return "";
  const id = String(item.id || "").toLowerCase();
  return HARDWARE_ID_TO_DESCRIPCION[id] || "";
}

/**
 * Recolecta la escalera de precios que el agente mandó por ítem, indexada por
 * Codigo_Item. Va a un campo JSON de la cotización porque la NDV de Creator
 * imprime la tabla de cobro COMPLETA (todos los tramos, con el aplicable
 * resaltado): con un solo tramo el PDF sale pobre y Creator no puede redactar
 * la descripción del ítem.
 *
 * Se persiste en vez de recalcularse al aceptar para que la NDV muestre los
 * precios vigentes AL MOMENTO DE COTIZAR: si el catálogo cambia entre la
 * cotización y el pago, el cliente firma lo que vio.
 */
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

/**
 * Convierte los items que recibimos de Vicky en el formato que espera el
 * subform Detalle_Items_Cotizacion de Zoho.
 *
 * Cada item de Vicky tiene: {tipo, id, nombre, modalidad, cantidad, precioUnitarioUF, subtotalUF}
 *
 * El subform de Zoho espera campos: Nombre_Item, Cantidad, Precio_Unitario_UF,
 * Precio_Unitario_CLP, Subtotal_UF, Subtotal_CLP, Modalidad, Es_Recurrente,
 * Afecto_IVA, Orden, Codigo_Item, Categoria_Item, Unidad.
 */
function buildSubformItems(items, ufActual, config) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((item, index) => {
    const modalidadZoho = mapModalidadToZoho(item.modalidad);
    const tipo = String(item.tipo || "").toLowerCase();
    // Precisión de los campos double del subform en Zoho: Precio_Unitario_UF y
    // Subtotal_UF aceptan 3 decimales; un cuarto decimal tumba el createRecord
    // completo con INVALID_DATA (caso VADIBA 11-ago: 0,090 UF con 25% dcto =
    // 0,0675). El cobro real usa Subtotal_UF, así que redondear el unitario es
    // solo cosmético — igual que la calculadora, que muestra 0,068/u y cobra
    // el subtotal exacto.
    const precioUnitarioUF = Number((Number(item.precioUnitarioUF) || 0).toFixed(3));
    const subtotalUF = Number((Number(item.subtotalUF) || 0).toFixed(3));
    const precioUnitarioCLP = ufActual > 0 ? Math.round(precioUnitarioUF * ufActual) : 0;
    const subtotalCLP = ufActual > 0 ? Math.round(subtotalUF * ufActual) : 0;
    // Zona tarifa: solo para items de servicio que la traen explícita. Se usa
    // server-side para decidir descuentos de instalación.
    const zonaRaw = String(item.zonaTarifa || "").toLowerCase().trim();
    const zonaTarifa = zonaRaw === "rm" ? "RM" : zonaRaw === "regiones" ? "regiones" : "";
    const row = {
      Nombre_Item: String(item.nombre || ""),
      Descripcion_Item: resolveDescripcionItem(item),
      Codigo_Item: String(item.id || ""),
      Cantidad: Number(item.cantidad || 0),
      Precio_Unitario_UF: precioUnitarioUF,
      Precio_Unitario_CLP: precioUnitarioCLP,
      Subtotal_UF: subtotalUF,
      Subtotal_CLP: subtotalCLP,
      Modalidad: modalidadZoho,
      Es_Recurrente: isItemRecurrente(modalidadZoho),
      Afecto_IVA: true,
      Orden: index + 1,
      Categoria_Item: mapCategoriaToZoho(item),
      Unidad: mapUnidadToZoho(modalidadZoho, tipo),
    };
    // Bonificación por línea (envío arriendo 0,5 UF → $0, Lalo 24-ago): se
    // persiste para que el PDF tache el precio de lista y las regeneraciones
    // (regenerate-pdf/descuentos) conserven la línea en $0.
    if (Number(item.descuentoPct) > 0) {
      row.Descuento_Pct = Math.min(100, Number(item.descuentoPct));
    }
    if (zonaTarifa && config?.quoteItemZonaTarifaField) {
      row[config.quoteItemZonaTarifaField] = zonaTarifa;
    }
    return row;
  });
}

/**
 * Intenta reusar un Account/Contact existente con update conservador.
 * Si el ID resulta inválido (transcripción errónea, registro borrado, etc.),
 * retorna { ok: false, invalidId: true } para que el caller haga fallback
 * a crear un registro nuevo. Cualquier otro error se propaga.
 */
async function tryReuseRecord(module, recordId, fullPayload) {
  try {
    const existing = await getRecord(module, recordId);
    if (!existing) {
      console.warn(`[create-from-vicky] ${module}/${recordId} no existe, fallback a crear nuevo`);
      return { ok: false, invalidId: true };
    }
    const conservativePayload = buildConservativePayload(fullPayload, existing);
    // Si no hay nada que actualizar, no llamamos updateRecord (evita PUT vacío)
    if (Object.keys(conservativePayload).length > 0) {
      await updateRecord(module, recordId, conservativePayload, true);
    }
    return { ok: true, recordId };
  } catch (error) {
    if (isInvalidIdError(error)) {
      console.warn(
        `[create-from-vicky] ${module}/${recordId} reportado como inválido por Zoho, fallback a crear nuevo. Detalle: ${error.message?.slice(0, 150)}`
      );
      return { ok: false, invalidId: true };
    }
    // DUPLICATE_DATA en el update conservador (caso Santa Lucía 06-ago): el
    // Email/Phone que se intenta escribir ya vive en OTRO registro de Zoho
    // (son campos UNIQUE). Antes esto EXPLOTABA todo el plumbing y el registro
    // reusado quedaba a medias con un solo warn perdido. Ahora: se reintenta
    // el update SIN los campos únicos conflictivos y el reuso sigue en pie.
    if (isDuplicateDataError(error)) {
      try {
        const existing = await getRecord(module, recordId).catch(() => null);
        const retry = existing ? buildConservativePayload(fullPayload, existing) : { ...fullPayload };
        delete retry.Email;
        delete retry.Phone;
        if (Object.keys(retry).length > 0) await updateRecord(module, recordId, retry, true);
        console.warn(
          `[create-from-vicky] ${module}/${recordId}: update conservador chocó con campo UNIQUE (${String(error.message || "").slice(0, 120)}) — reuso mantenido, Email/Phone omitidos`
        );
      } catch (retryErr) {
        console.warn(
          `[create-from-vicky] ${module}/${recordId}: reintento sin campos únicos también falló (${String(retryErr?.message || retryErr).slice(0, 120)}) — reuso mantenido sin update`
        );
      }
      return { ok: true, recordId, uniqueConflict: true };
    }
    // Errores no relacionados a ID inválido sí se propagan
    throw error;
  }
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

  // Auth
  const expectedSecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  const providedSecret = toText(req.headers["x-vicky-secret"]);
  if (expectedSecret && expectedSecret !== providedSecret) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  let stage = "init";
  try {
    const body = parseBody(req);
    const cliente = body.cliente || {};
    const cotizacion = body.cotizacion || {};
    const existing = body.existing || {};
    // CANAL EJECUTIVO (Lalo 11-ago, principio 4 de la cotizadora): la emisión
    // desde el agente de ejecutivos NO toca al cliente por ningún canal — el
    // correo con el PDF queda suprimido y la entrega es siempre un botón
    // humano (WhatsApp del ejecutivo, Vicky o correo desde el editor).
    const sinCorreoCliente = body.sinCorreoCliente === true;
    // Descuento negociado en el preform (forma "siguiente índice" = escalón+1).
    // 0 = sin descuento. Si > 0, la cotización nace ya con ese descuento y el
    // PDF v1 refleja el precio acordado (un solo PDF, sin regenerar).
    const escalonDescuento = Math.max(0, Number(body.escalonDescuento || 0));
    // Modo Borrador: crea/actualiza la cotización en estado "Borrador" con el
    // escalón negociado y se detiene ANTES de generar PDF, subirlo y enviar el
    // correo. Lo usa consultar_descuento_referencial para que el escalón viva en
    // Zoho (con quote_id) durante la negociación del preform. La finalización
    // (PDF + correo + "Enviada") ocurre después, al llamar sin draft reusando
    // existing.quoteId/existing.dealId.
    const draft = body.draft === true;

    // Validaciones. contactoEmail es OPCIONAL (Lalo 03-ago): sin correo la
    // cotización se emite igual (PDF + link) y la entrega corre por WhatsApp;
    // simplemente no se envía el correo con el PDF.
    if (!cliente.empresa || !cliente.contacto || !cliente.rutEmpresa) {
      return sendJson(res, 400, {
        ok: false,
        error: "Faltan campos en cliente: empresa, contacto, rutEmpresa",
      });
    }
    if (!cotizacion.items || !Array.isArray(cotizacion.items) || cotizacion.items.length === 0) {
      return sendJson(res, 400, { ok: false, error: "cotizacion.items requerido (no vacío)" });
    }
    if (typeof cotizacion.totalUF !== "number") {
      return sendJson(res, 400, { ok: false, error: "cotizacion.totalUF requerido" });
    }

    // Validación lógica: leadId no compatible con accountId/contactId
    if (existing.leadId && (existing.accountId || existing.contactId)) {
      return sendJson(res, 400, {
        ok: false,
        error: "existing.leadId no puede venir junto con existing.accountId o existing.contactId",
      });
    }

    const config = getAcceptanceConfig(req);
    const sectorParaZoho = validarSector(cliente.sectorEmpresa);

    // ── IDEMPOTENCIA (caso Inversiones Automatic, 04-ago) ──
    // El tool reintenta con el MISMO body; si un intento anterior ya creó los
    // registros (aunque su respuesta haya muerto después), acá se devuelven
    // ESOS ids en vez de crear un segundo deal. Solo aplica a la emisión real
    // (el modo draft itera legítimamente con cuerpos distintos por escalón).
    const idemClave = claveIdempotencia(body);
    if (!draft) {
      const previo = await getIdempotente(idemClave);
      if (previo && previo.quoteId) {
        console.warn(
          `[create-from-vicky] reintento idempotente: mismo body ya creó quote ${previo.quoteId} / deal ${previo.dealId || "-"} — no se duplica.`,
        );
        const expMsIdem = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
        const tokenIdem = signAcceptancePayload({
          quoteId: previo.quoteId, dealId: previo.dealId || "",
          iat: Date.now(), exp: expMsIdem,
          nonce: crypto.randomBytes(8).toString("hex"),
          v: 1,
        });
        const acceptanceUrlIdem = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(tokenIdem)}`;
        // El paso que pudo haber quedado a medias en el intento anterior.
        await updateRecord(config.quoteModule, previo.quoteId, {
          [config.quoteAcceptanceUrlField]: acceptanceUrlIdem,
          [config.quoteStatusField]: "Enviada",
        }, true).catch(() => {});
        return sendJson(res, 200, {
          ok: true,
          quoteId: previo.quoteId,
          dealId: previo.dealId || "",
          accountId: previo.accountId || "",
          contactId: previo.contactId || "",
          acceptanceUrl: acceptanceUrlIdem,
          pdfUrl: "",
          pdfPendiente: true,
          reuse: { retryIdempotente: true },
          expiresAt: new Date(expMsIdem).toISOString(),
        });
      }
    }

    let accountId, contactId, dealId;
    const reuse = {
      accountReused: false,
      contactReused: false,
      leadConverted: false,
      dealReused: false,
      quoteReused: false,
    };

    // Candado cruzado hito↔cotización: si crm-hitos (agente) acaba de crear
    // un deal para este teléfono, la búsqueda de Zoho aún no lo ve — el
    // candado en vic_kv sí. Se reusa ese deal en vez de parir un gemelo.
    stage = "check_deal_kv";
    let dealCruzado = null;
    try {
      dealCruzado = await getDealPorFono(cliente.contactoTelefono);
      if (dealCruzado) {
        console.warn(
          `[create-from-vicky] candado kv: deal ${dealCruzado.dealId} recién creado (origen=${dealCruzado.origen || "?"}) para ${cliente.contactoTelefono} — se reusa, no se crea gemelo.`,
        );
      }
    } catch { /* best-effort */ }

    // Adopción del lead vivo: el agente normalmente NO pasa leadId (solo en
    // outbound con formulario), pero casi siempre existe un lead de la
    // conversación (hito, callback, reunión). Adoptarlo garantiza que el deal
    // nazca de SU conversión — cero leads huérfanos, cero deals gemelos. Si
    // el candado apunta a un lead ya convertido, el convert falla y la
    // recuperación de $converted_detail reusa todo, como siempre.
    if (!existing.leadId && !existing.accountId && !existing.contactId && !existing.dealId) {
      stage = "adopt_lead_by_phone";
      const leadVivo = await findOpenLeadIdByPhone(cliente.contactoTelefono).catch(() => "");
      if (leadVivo) {
        existing.leadId = leadVivo;
        console.warn(`[create-from-vicky] lead vivo ${leadVivo} adoptado por teléfono ${cliente.contactoTelefono} — el deal nace de su conversión.`);
      }
    }

    // ── CAMINO A: Convertir Lead existente ──
    // Best-effort: si la conversión falla por cualquier motivo (blueprint,
    // permisos, datos), NO se pierde la venta — se loguea fuerte y se cae al
    // CAMINO B (creación directa con dedup por RUT). El lead queda huérfano
    // para revisión manual, pero el cliente recibe su cotización igual.
    if (existing.leadId) {
      stage = "convert_lead";
      try {
        const dealDataForConvert = {
          Deal_Name: `${cliente.empresa} - Cotización Vicky`,
          // RUT también en el DEAL (Lalo 10-ago): la cuenta lo llevaba en
          // RUT_Empresa pero el deal quedaba sin Rut/ID Account — el equipo
          // comercial lo necesita en ambos registros.
          ...(cliente.rutEmpresa ? { Rut_ID_Account: cliente.rutEmpresa } : {}),
          Stage: VICKY_DEAL_STAGE,
          Pipeline: "Standard (Standard)",
          Closing_Date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          Amount: cotizacion.totalCLP || undefined,
          // Obligatorios del layout de Deals del org: sin ellos el convert
          // devuelve MANDATORY_NOT_FOUND (caso real: Territorio, 08-jul-2026).
          Territorio: VICKY_TERRITORIO,
          Tombola: VICKY_TOMBOLA,
          Monda_del_trato: VICKY_MONEDA,
          Sector: sectorParaZoho,
          N_Empleados_que_marcan: cliente.userCount,
          // Tarifa plana hasta 10 usuarios, por usuario desde 11 (regla del
          // catálogo, misma en CL/CO/MX). Antes nacía vacío y lo llenaba el
          // ejecutivo a mano (backfill 30-jul lo rellenó retroactivamente).
          Tipo_de_Cobro: (Number(cliente.userCount) || 1) <= 10 ? "Mensual fijo" : "Por usuario",
          Producto_Soluci_n: VICKY_PRODUCTO_DEFAULT,
          Lead_Source: VICKY_LEAD_SOURCE,
          // El deal nace en Vicky y la tómbola de abajo lo sortea al tiro
          // (Lalo 04-ago). Si el sorteo falla, "dueño=Vicky" es la señal.
          Owner: VICKY_BOT_OWNER,
        };
        // Con deal cruzado el lead se convierte IGUAL (regla marketing: todo
        // deal nace de lead convertido — acá el deal existente ya nació así)
        // pero SIN parir otro deal: solo Account/Contact.
        const convertResult = await convertLead(existing.leadId, dealCruzado ? null : dealDataForConvert);
        accountId = convertResult.accountId;
        contactId = convertResult.contactId;
        dealId = convertResult.dealId || (dealCruzado ? dealCruzado.dealId : undefined);
        if (dealCruzado && dealId === dealCruzado.dealId) reuse.dealReused = true;

        if (!accountId || !contactId || !dealId) {
          throw new Error("Conversión de Lead no devolvió todos los IDs");
        }
        reuse.leadConverted = true;

        // Datos nuevos ganan: actualizar Account, Contact y Deal con los datos del prospect.
        // En este camino (conversión de Lead) sí queremos que los datos nuevos ganen
        // porque el Lead era una primera intención desactualizada.
        // Estos dos updates NO tumban el convert si fallan (caso Santa Lucía
        // 06-ago: un Email duplicado en Zoho hacía explotar TODO el camino A,
        // se descartaban los ids buenos del convert y el contacto quedaba sin
        // datos). El convert ya está hecho; un update cosmético fallido se
        // loguea y se sigue — el parche de placeholders de más abajo rellena
        // lo que falte campo a campo.
        stage = "update_account_after_convert";
        await updateRecord("Accounts", accountId, buildAccountFullPayload(cliente, sectorParaZoho), true).catch((e) =>
          console.warn(`[create-from-vicky] update Account post-convert falló (no tumba el convert): ${toText(e?.message || e).slice(0, 150)}`)
        );

        stage = "update_contact_after_convert";
        await updateRecord("Contacts", contactId, buildContactFullPayload(cliente), true).catch((e) =>
          console.warn(`[create-from-vicky] update Contact post-convert falló (no tumba el convert): ${toText(e?.message || e).slice(0, 150)}`)
        );

        stage = "update_deal_after_convert";
        if (!reuse.dealReused) {
          await updateRecord("Deals", dealId, {
            Owner: VICKY_BOT_OWNER,
            // GARANTÍA DE CADENA (casos MACROSS/CGO/Ciberlabs/Bien Limpio,
            // 21→23-ago): cuando el convert se reintenta fusionando contra
            // una CUENTA PREEXISTENTE (DUPLICATE_DATA → Accounts:{id}), Zoho
            // crea el deal pero NO le asocia esa cuenta — llegaba a los
            // ejecutivos sin "Nombre de Cuenta". La asociación se estampa
            // SIEMPRE acá, venga de donde venga el convert.
            Account_Name: { id: accountId },
            Contact_Name: { id: contactId },
            Territorio: VICKY_TERRITORIO,
            Tombola: VICKY_TOMBOLA,
            Monda_del_trato: VICKY_MONEDA,
            Sector: sectorParaZoho,
            N_Empleados_que_marcan: cliente.userCount,
            Producto_Soluci_n: VICKY_PRODUCTO_DEFAULT,
            Lead_Source: VICKY_LEAD_SOURCE,
            Description: `Deal creado por Vicky desde Lead convertido.\nUsuarios: ${cliente.userCount}\nTotal: ${cotizacion.totalUF} UF / ${cotizacion.totalCLP} CLP\nSector: ${sectorParaZoho}`,
          }, true);
        } else {
          // Deal preexistente (candado cruzado): conserva su dueño — puede
          // venir sorteado por la tómbola de deals. Solo datos de la venta.
          await updateRecord("Deals", dealId, {
            Amount: cotizacion.totalCLP || undefined,
            N_Empleados_que_marcan: cliente.userCount,
          }, true);
        }
      } catch (convErr) {
        console.error(
          `[create-from-vicky] CONVERT FALLÓ lead=${existing.leadId} (${toText(convErr?.message || convErr).slice(0, 250)})`,
        );
        accountId = undefined;
        contactId = undefined;
        dealId = undefined;
        reuse.leadConverted = false;
        // CAUSA Nº1 del deal GEMELO (03-ago: Veterinaria, Curacautín,
        // Consistorial, Contadores): el convert falla porque el flujo del
        // agente YA convirtió este lead en el hito del preform. Antes se caía
        // a creación directa y nacía un deal paralelo; ahora se RECUPERAN los
        // ids de la conversión previa ($converted_detail) y se reusa todo.
        try {
          const recovered = await recoverConvertedIds(existing.leadId);
          if (recovered.dealId) {
            // Misma convención que el lead-first: los ids van a existing.*
            // para que el Camino B los REUSE y actualice (no los cree).
            if (recovered.accountId && !existing.accountId) existing.accountId = recovered.accountId;
            if (recovered.contactId && !existing.contactId) existing.contactId = recovered.contactId;
            dealId = recovered.dealId;
            reuse.dealReused = true;
            console.warn(
              `[create-from-vicky] lead=${existing.leadId} ya estaba convertido — se reusa su deal=${dealId} (adiós gemelo).`,
            );
          }
        } catch (recErr) {
          console.warn(`[create-from-vicky] recuperación post-convert falló: ${toText(recErr?.message || recErr).slice(0, 120)}`);
        }
      }
    }

    // Principio (16-jul): LA COTIZACIÓN SIEMPRE SE ENTREGA. El plumbing CRM
    // (Cuenta/Contacto/Deal) es soporte interno: si falla de forma
    // irrecuperable, se registra, se marca CRM_Incompleto y el flujo SIGUE
    // hasta el PDF + link. Kill-switch: CRM_STRICT=1 restaura el comportamiento
    // anterior (morir con excepción).
    let crmIncompleto = false;
    try {
    if (!reuse.leadConverted) {
      // LEAD-FIRST: si el contacto ya tiene un lead convertido (hito
      // preform), reusar SU cuenta/contacto/deal — la cotización se asocia
      // al deal existente en vez de duplicarlo. Corre también cuando VINO
      // leadId pero el convert falló y la recuperación no trajo ids (causa
      // gemelos 03-ago): la búsqueda por teléfono es la última red.
      if (!accountId && !contactId && !dealId) {
        stage = "find_converted_by_phone";
        const convertidos = await findConvertedIdsByPhone(cliente.contactoTelefono);
        if (convertidos.accountId && !existing.accountId) existing.accountId = convertidos.accountId;
        if (convertidos.contactId && !existing.contactId) existing.contactId = convertidos.contactId;
        if (convertidos.dealId) {
          dealId = convertidos.dealId;
          // Deal preexistente: conserva su dueño (no se re-sortea).
          reuse.dealReused = true;
        }
        // La búsqueda no vio nada pero el candado kv sí: deal de hace
        // segundos (índice de Zoho atrasado). Se reusa y se traen su
        // cuenta/contacto para no crear duplicados de esos tampoco.
        if (!dealId && dealCruzado) {
          const dealKv = await getRecord("Deals", dealCruzado.dealId).catch(() => null);
          if (dealKv) {
            dealId = dealCruzado.dealId;
            reuse.dealReused = true;
            const accKv = toText(dealKv?.Account_Name?.id);
            const ctKv = toText(dealKv?.Contact_Name?.id);
            if (accKv && !existing.accountId) existing.accountId = accKv;
            if (ctKv && !existing.contactId) existing.contactId = ctKv;
          }
        }
      }
      // GUARDA DE RUT (caso Safeclin/Santa Lucía 06-ago): la cuenta adoptada
      // por teléfono/kv puede ser de OTRA empresa — la misma persona cotizando
      // para otra razón social. Si el cliente declaró RUT y la cuenta adoptada
      // tiene OTRO RUT, NO se reusa: se suelta el id y aguas abajo la cuenta
      // correcta se encuentra o se crea por RUT (Capa 3/4). Cuenta sin RUT
      // (placeholder de la misma conversación) sí se conserva.
      if (existing.accountId && toText(cliente.rutEmpresa)) {
        const soloRut = (v) => String(v || "").replace(/[^0-9kK]/g, "").toLowerCase();
        const accAdoptada = await getRecord("Accounts", existing.accountId).catch(() => null);
        const rutAcc = soloRut(accAdoptada?.RUT_Empresa);
        const rutCli = soloRut(cliente.rutEmpresa);
        if (accAdoptada && rutAcc && rutCli && rutAcc !== rutCli) {
          console.warn(
            `[create-from-vicky] cuenta adoptada ${existing.accountId} ("${toText(accAdoptada.Account_Name)}", RUT ${toText(accAdoptada.RUT_Empresa)}) ≠ RUT declarado ${cliente.rutEmpresa} — no se reusa, se busca/crea la cuenta correcta`
          );
          existing.accountId = "";
        }
      }
      // ── CAMINO B: Crear Account o reusar existente ──
      let needCreateAccount = !existing.accountId;

      if (existing.accountId) {
        stage = "update_existing_account";
        const accountPayload = buildAccountFullPayload(cliente, sectorParaZoho);
        const reuseResult = await tryReuseRecord("Accounts", existing.accountId, accountPayload);
        if (reuseResult.ok) {
          accountId = reuseResult.recordId;
          reuse.accountReused = true;
        } else if (reuseResult.invalidId) {
          // Fallback: el ID no era válido (transcripción errónea o registro borrado).
          // Creamos un Account nuevo como si no hubiera venido existing.accountId.
          needCreateAccount = true;
        }
      }

      if (needCreateAccount) {
        stage = "create_account";
        const createAccountPayload = {
          Account_Name: cliente.empresa,
          RUT_Empresa: cliente.rutEmpresa,
          Phone: cliente.contactoTelefono || undefined,
          Billing_Street: cliente.direccionEmpresa || undefined,
          Billing_City: cliente.comunaEmpresa || undefined,
          Billing_State: cliente.regionEmpresa || undefined,
          Description: `Cuenta creada por Vicky (WhatsApp). RUT: ${cliente.rutEmpresa}`,
          Industry: sectorParaZoho,
          Territorio: VICKY_TERRITORIO,
          N_Empleados_dependientes: cliente.userCount,
          Tiene_potencial_de_expansi_n_Regional: VICKY_EXPANSION_REGIONAL,
          Owner: VICKY_BOT_OWNER,
        };
        try {
          const accountResult = await createRecord("Accounts", createAccountPayload, true);
          accountId = toText(accountResult?.id);
          if (!accountId) throw new Error("No se obtuvo accountId");
        } catch (createError) {
          if (!isDuplicateDataError(createError)) throw createError;
          // ── Capa 3: dedupe por RUT ──
          // El LLM olvidó pasar accountId, pero el Account ya existe en Zoho.
          // Buscamos por RUT y reusamos con update conservador.
          console.warn(
            `[create-from-vicky] Capa 3 Account: createRecord falló por duplicate data. Buscando Account existente con RUT="${cliente.rutEmpresa}"...`,
          );
          stage = "dedupe_account_by_rut";
          const existingAccountId = await findAccountIdByRut(cliente.rutEmpresa, cliente.empresa);
          // Homónima con RUT VACÍO: casi seguro es la MISMA empresa registrada
          // sin RUT (conversión de lead, carga manual de un SDR). Adoptarla y
          // completarle el RUT es lo que haría un humano — crear la
          // desambiguada duplica la cuenta (caso real 17-jul, Parroquia).
          let adoptadaSinRut = false;
          if (!existingAccountId) {
            const homonimas = await executeCoqlQuery(
              `select id, RUT_Empresa, Account_Name from Accounts where Account_Name = '${cliente.empresa.replace(/'/g, "''")}' limit 5`,
            ).catch(() => []);
            const esInterna = (name) =>
              INTERNAL_ACCOUNT_NAMES.includes(String(name || "").trim().toLowerCase());
            const sinRut = (homonimas || []).find(
              (r) => !String(r.RUT_Empresa || "").trim() && !esInterna(r.Account_Name),
            );
            if (sinRut) {
              accountId = toText(sinRut.id);
              reuse.accountReused = true;
              adoptadaSinRut = true;
              console.warn(
                `[create-from-vicky] Capa 3 Account: homónima con RUT vacío id=${accountId}; se adopta y se completa RUT=${cliente.rutEmpresa}.`,
              );
              await tryReuseRecord("Accounts", accountId, buildAccountFullPayload(cliente, sectorParaZoho)).catch(
                () => ({ ok: false }),
              );
            }
          }
          if (!existingAccountId && !adoptadaSinRut) {
            // Duplicado por NOMBRE con RUT distinto: son empresas homónimas, NO
            // la misma. Antes esto botaba la cotización completa (bug real desde
            // may-2026); ahora se crea la cuenta desambiguando el nombre con el
            // RUT, que es lo que haría un humano.
            console.warn(
              `[create-from-vicky] Capa 3 Account: duplicado por nombre con RUT distinto (${cliente.rutEmpresa}); creando cuenta desambiguada.`,
            );
            stage = "create_account_disambiguated";
            const nombreDesambiguado = `${cliente.empresa} (${cliente.rutEmpresa})`;
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
              // ── Capa 4: hasta la desambiguada duplica (unicidad por RUT_Empresa
              // o cuenta desambiguada preexistente). Reusar SOLO si el RUT también
              // coincide — asociar mal es peor que no asociar. Si no, la cotización
              // sigue SIN cuenta (el reconciliador la cose después).
              stage = "reuse_account_capa4";
              const porNombre = await executeCoqlQuery(
                `select id, RUT_Empresa from Accounts where Account_Name = '${nombreDesambiguado.replace(/'/g, "''")}' limit 5`,
              ).catch(() => []);
              const compactar = (v) => String(v || "").replace(/[.\s-]/g, "").toUpperCase();
              const rutNorm = compactar(cliente.rutEmpresa);
              const matchRut = (porNombre || []).find((r) => compactar(r.RUT_Empresa) === rutNorm);
              if (matchRut) {
                accountId = toText(matchRut.id);
                reuse.accountReused = true;
                console.warn(`[create-from-vicky] Capa 4 Account: reusada por nombre desambiguado + RUT id=${accountId}.`);
              } else {
                accountId = undefined;
                console.error(
                  `[create-from-vicky] Capa 4 Account: sin salida de dedupe (RUT=${cliente.rutEmpresa}). La cotización continúa SIN cuenta (CRM incompleto).`,
                );
              }
            }
          } else if (existingAccountId) {
          console.warn(
            `[create-from-vicky] Capa 3 Account: encontrado existente id=${existingAccountId}. Aplicando update conservador.`,
          );
          const fullPayload = buildAccountFullPayload(cliente, sectorParaZoho);
          const reuseResult = await tryReuseRecord("Accounts", existingAccountId, fullPayload);
          if (!reuseResult.ok) {
            // No tirar 500: ya tenemos un accountId válido por RUT. Seguimos sin
            // el update conservador (solo se omiten campos; la cuenta es correcta).
            console.warn(
              `[create-from-vicky] Capa 3 Account: tryReuseRecord falló para id=${existingAccountId}; se usa la cuenta sin actualizar campos.`,
            );
          }
          accountId = existingAccountId;
          reuse.accountReused = true;
          }
        }
      }

      // Crear Contact o reusar existente
      let needCreateContact = !existing.contactId;

      if (existing.contactId) {
        stage = "update_existing_contact";
        const contactPayload = buildContactFullPayload(cliente);
        const reuseResult = await tryReuseRecord("Contacts", existing.contactId, contactPayload);
        if (reuseResult.ok) {
          contactId = reuseResult.recordId;
          reuse.contactReused = true;
        } else if (reuseResult.invalidId) {
          needCreateContact = true;
        }
      }

      if (needCreateContact) {
        stage = "create_contact";
        const { firstName, lastName } = splitFullName(cliente.contacto);
        const createContactPayload = {
          First_Name: firstName,
          Last_Name: lastName,
          Email: cliente.contactoEmail,
          Phone: cliente.contactoTelefono || undefined,
          Account_Name: { id: accountId },
          Lead_Source: VICKY_LEAD_SOURCE,
          Territorio: VICKY_TERRITORIO,
          Owner: VICKY_BOT_OWNER,
        };
        try {
          const contactResult = await createRecord("Contacts", createContactPayload, true);
          contactId = toText(contactResult?.id);
          if (!contactId) throw new Error("No se obtuvo contactId");
        } catch (createError) {
          if (!isDuplicateDataError(createError)) throw createError;
          // ── Capa 3: dedupe por Email ──
          console.warn(
            `[create-from-vicky] Capa 3 Contact: createRecord falló por duplicate data. Buscando Contact existente con Email="${cliente.contactoEmail}"...`,
          );
          stage = "dedupe_contact_by_email";
          const existingContactId = await findContactIdByEmail(cliente.contactoEmail);
          if (!existingContactId) {
            throw new Error(
              `Zoho reportó duplicate data pero no se encontró Contact con Email ${cliente.contactoEmail}`,
            );
          }
          console.warn(
            `[create-from-vicky] Capa 3 Contact: encontrado existente id=${existingContactId}. Aplicando update conservador.`,
          );
          const fullPayload = buildContactFullPayload(cliente);
          const reuseResult = await tryReuseRecord("Contacts", existingContactId, fullPayload);
          if (!reuseResult.ok) {
            console.warn(
              `[create-from-vicky] Capa 3 Contact: tryReuseRecord falló para id=${existingContactId}; se usa el contacto sin actualizar campos.`,
            );
          }
          contactId = existingContactId;
          reuse.contactReused = true;
        }
      }

      // Deal: reusar el del Borrador en curso (negociación del preform) si ya
      // existe, o crear uno nuevo. Así un mismo Borrador conserva su Deal entre
      // turnos, en vez de generar un Deal por cada actualización del escalón.
      // Si el id resulta inválido, tryReuseRecord cae a crear uno nuevo.
      if (existing.dealId) {
        stage = "reuse_existing_deal";
        const reuseDeal = await tryReuseRecord("Deals", existing.dealId, {});
        if (reuseDeal.ok) {
          dealId = reuseDeal.recordId;
          reuse.dealReused = true;
        }
      }

      if (!dealId) {
        stage = "create_deal";
        const dealResult = await createRecord("Deals", {
          Deal_Name: `${cliente.empresa} - Cotización Vicky`,
          // RUT en el deal, no solo en la cuenta (Lalo 10-ago).
          ...(cliente.rutEmpresa ? { Rut_ID_Account: cliente.rutEmpresa } : {}),
          ...(accountId ? { Account_Name: { id: accountId } } : {}),
          ...(contactId ? { Contact_Name: { id: contactId } } : {}),
          Stage: VICKY_DEAL_STAGE,
          Pipeline: "Standard (Standard)",
          Lead_Source: VICKY_LEAD_SOURCE,
          Amount: cotizacion.totalCLP || undefined,
          Description: `Deal creado por Vicky para cotización WhatsApp.\nUsuarios: ${cliente.userCount}\nTotal: ${cotizacion.totalUF} UF / ${cotizacion.totalCLP} CLP\nSector: ${sectorParaZoho}`,
          Territorio: VICKY_TERRITORIO,
          Tombola: VICKY_TOMBOLA,
          Monda_del_trato: VICKY_MONEDA,
          Sector: sectorParaZoho,
          N_Empleados_que_marcan: cliente.userCount,
          Tipo_de_Cobro: (Number(cliente.userCount) || 1) <= 10 ? "Mensual fijo" : "Por usuario",
          Producto_Soluci_n: VICKY_PRODUCTO_DEFAULT,
          Owner: VICKY_BOT_OWNER,
        }, true);
        dealId = toText(dealResult?.id);
        if (!dealId) throw new Error("No se obtuvo dealId");
      }
    }
    } catch (plumbingError) {
      if (String(process.env.CRM_STRICT || "") === "1") throw plumbingError;
      crmIncompleto = true;
      console.error(
        `[create-from-vicky] CRM DEGRADADO en stage=${stage}: ${toText(plumbingError?.message || plumbingError).slice(0, 300)}. ` +
          `La cotización continúa (accountId=${accountId || "∅"}, contactId=${contactId || "∅"}, dealId=${dealId || "∅"}).`,
      );
    }
    // Candado cruzado: registrar el deal APENAS existe, para que crm-hitos
    // (agente) lo reuse en vez de crear un gemelo por hito de conversación.
    if (dealId) await setDealPorFono(cliente.contactoTelefono, dealId, "cotizacion").catch(() => {});
    // (fix 06-ago: faltaba !contactId en la asignación — una cotización sin
    // contacto quedaba con CRM_Incompleto=false y nadie la revisaba)
    if (!accountId || !contactId || !dealId) crmIncompleto = true;

    // ── DATOS REALES pisan PLACEHOLDERS (Lalo 31-jul, caso D'amore) ────────
    // La cuenta, el contacto y el deal reusados pueden venir de un hito
    // temprano de la conversación, cuando la empresa aún no se conocía
    // ("Prospecto WhatsApp", "Por identificar..."). Al llegar la formal con
    // los datos reales, esos provisorios se corrigen — SOLO los provisorios:
    // un nombre real existente jamás se pisa (update conservador de siempre).
    stage = "corregir_placeholders";
    const ES_PLACEHOLDER = /prospecto whatsapp|por identificar|sin empresa|tu empresa|no identificado/i;
    try {
      if (accountId && cliente.empresa && !ES_PLACEHOLDER.test(cliente.empresa)) {
        const acc = await getRecord("Accounts", accountId).catch(() => null);
        if (acc && ES_PLACEHOLDER.test(toText(acc.Account_Name))) {
          await updateRecord("Accounts", accountId, {
            Account_Name: cliente.empresa,
            ...(cliente.rutEmpresa ? { RUT_Empresa: cliente.rutEmpresa } : {}),
          }, true);
        }
      }
      // Deal REUSADO (nacido de un hito temprano): se completa lo que en ese
      // momento no existía. El RUT es el caso típico (Lalo 10-ago, Embajada
      // de Bélgica): el hito convierte el lead ANTES de que el cliente dé su
      // RUT, así que Rut/ID Account queda vacío aunque la cuenta sí lo tenga.
      // La emisión formal SIEMPRE trae RUT → se rellena si falta.
      if (dealId) {
        const dl = await getRecord("Deals", dealId).catch(() => null);
        const patchDeal = {};
        // GARANTÍA DE CADENA TRANSVERSAL (caso Vista Kennedy 24-ago): el
        // convert de Zoho puede parir el deal SIN cuenta (lead sin Company
        // utilizable → $converted_detail account=-); el caller lo trata como
        // fallo, la recuperación reusa el deal y la cuenta nace después en el
        // Camino B — sin que nadie la asocie. El estampado del convert (fix
        // ef742bb) no corre en ese camino. Acá se cose SIEMPRE, venga de
        // donde venga el deal: solo se RELLENA lo vacío, una asociación
        // existente jamás se pisa (dos empresas del mismo fono comparten
        // deal por el candado — la primera cuenta asociada manda).
        if (dl && accountId && !toText(dl.Account_Name?.id)) {
          patchDeal.Account_Name = { id: accountId };
        }
        if (dl && contactId && !toText(dl.Contact_Name?.id)) {
          patchDeal.Contact_Name = { id: contactId };
        }
        if (
          dl &&
          cliente.empresa &&
          !ES_PLACEHOLDER.test(cliente.empresa) &&
          ES_PLACEHOLDER.test(toText(dl.Deal_Name))
        ) {
          patchDeal.Deal_Name = `${cliente.empresa} (Control de Asistencia)`;
          if (cliente.userCount) patchDeal.N_Empleados_que_marcan = cliente.userCount;
        }
        if (dl && cliente.rutEmpresa && !toText(dl.Rut_ID_Account)) {
          patchDeal.Rut_ID_Account = cliente.rutEmpresa;
        }
        if (Object.keys(patchDeal).length) {
          await updateRecord("Deals", dealId, patchDeal, true);
        }
      }
      if (contactId && (cliente.contactoEmail || cliente.contacto)) {
        const ct = await getRecord("Contacts", contactId).catch(() => null);
        if (ct) {
          const patch = {};
          if (!toText(ct.Email) && cliente.contactoEmail) patch.Email = cliente.contactoEmail;
          if (!toText(ct.Phone) && cliente.contactoTelefono) patch.Phone = cliente.contactoTelefono;
          if (/prospecto/i.test(toText(ct.Last_Name)) && cliente.contacto) {
            const partes = splitFullName(cliente.contacto);
            if (partes.lastName && !/prospecto/i.test(partes.lastName)) {
              patch.First_Name = partes.firstName;
              patch.Last_Name = partes.lastName;
            }
          }
          if (Object.keys(patch).length) await updateRecord("Contacts", contactId, patch, true);
        }
      }
    } catch (phErr) {
      console.warn(
        `[create-from-vicky] corrección de placeholders falló (no bloquea): ${toText(phErr?.message || phErr).slice(0, 150)}`,
      );
    }

    // ── REGLA DE ASIGNACIÓN (Lalo, 06-ago — reemplaza el sorteo del 31-jul) ─
    // La emisión NO sortea: el deal ESPERA con el usuario VICKY (la interina
    // oficial). La asignación al vendedor y su notificación van DE LA MANO con
    // los relojes de traspaso (120/15/10 min hábiles en vic-ptv-cron): recién
    // cuando la conversación se traspasa, la tómbola corre y el vendedor se
    // entera (caso Rodrigo/Neumasport: el sorteo en caliente lo alertaba
    // apenas el cliente veía el precio). Sí conservan asignación inmediata:
    // el dueño humano REAL de un deal reusado (herencia/ptv) y la asignación
    // MANUAL de un admin. Si el dueño es interino, el correo al cliente lo
    // firma Vicky — nunca una ejecutiva fija.
    stage = "tombola_deal";
    let quoteOwner = VICKY_BOT_OWNER;
    let quoteOwnerEmail = "";
    let quoteOwnerNombre = "";
    let quoteOwnerTelefono = "";
    // Asignación MANUAL (admin, sin sorteo): un ejecutivo con gestión previa
    // pidió la cotización a su nombre (teléfono/presencial antes de la formal).
    // Viene en existing.ownerId — solo lo inyectan los flujos admin, nunca el
    // modelo. El deal se asigna directo a ese dueño (skip assignment_rules,
    // convención 31-jul) y el correo/PDF lo presentan a él.
    const ownerManualId = toText(existing.ownerId);
    if (dealId) {
      try {
        // Interinos = marcadores de "sin dueño real": el usuario Vicky y la
        // ejecutiva interina histórica. Un deal cuyo dueño es interino se
        // queda ESPERANDO en Vicky (el cron de traspaso lo sorteará con los
        // relojes); un dueño humano REAL (herencia, ptv, sorteo previo) se
        // respeta y el correo/PDF lo presentan a él.
        const DUENOS_INTERINOS = new Set([
          EJEC_OWNER_ID,
          "3525045000484500876", // Vicky
          "3525045000000200013", // GeoVictoria Admin (info@) — dueño fantasma
          // de leads del formulario; no es gestión humana (Lalo 07-ago).
        ]);
        // CANAL EJECUTIVO (Lalo 11-ago, caso COT476/V&D): cuando el flujo
        // admin/editor ancla la emisión a un deal (existing.ownerId), la
        // cotización SIGUE al dueño del deal aunque sea Eddyluz — la marca de
        // "interina histórica" es del canal autónomo de WhatsApp, no del
        // trabajo real del roster en la app. Vicky y el admin fantasma siguen
        // siendo interinos siempre.
        if (
          ownerManualId &&
          ownerManualId !== "3525045000484500876" &&
          ownerManualId !== "3525045000000200013"
        ) {
          DUENOS_INTERINOS.delete(ownerManualId);
        }
        if (ownerManualId) {
          await zohoApiFetch(`/crm/v3/Deals`, {
            method: "PUT",
            body: JSON.stringify({
              data: [{ id: dealId, Owner: { id: ownerManualId } }],
              skip_feature_execution: [{ name: "assignment_rules" }],
            }),
          });
        }
        const rOwner = await zohoApiFetch(`/crm/v3/Deals/${dealId}?fields=Owner`);
        if (rOwner.ok) {
          const ownerDeal = (((await rOwner.json())?.data || [])[0] || {}).Owner;
          if (ownerDeal && ownerDeal.id && !DUENOS_INTERINOS.has(toText(ownerDeal.id))) {
            quoteOwner = { id: toText(ownerDeal.id) };
            if (ownerDeal.email) quoteOwnerEmail = toText(ownerDeal.email);
            if (ownerDeal.name) quoteOwnerNombre = toText(ownerDeal.name);
            // Teléfono desde su ficha de usuario (best-effort; sin él, el
            // correo muestra solo nombre y correo del dueño).
            try {
              const rU = await zohoApiFetch(`/crm/v3/users/${toText(ownerDeal.id)}`);
              if (rU.ok) {
                const u = (((await rU.json())?.users || [])[0] || {});
                const tel = toText(u.phone) || toText(u.mobile);
                quoteOwnerTelefono = tel || "";
              }
            } catch (_e) { /* best-effort */ }
          }
          // Dueño interino: sin sorteo y SIN notificación — el vendedor se
          // entera recién en el traspaso (relojes del cron), no en caliente.
        }
      } catch (tombolaErr) {
        console.warn(
          `[create-from-vicky] lectura de owner falló para deal=${dealId}: ${toText(tombolaErr?.message || tombolaErr).slice(0, 150)} — cotización queda con Vicky (interina).`,
        );
      }
      // La cuenta y el contacto CREADOS en este request siguen al dueño del
      // deal (residuo 31-jul: nacían con Owner Eddyluz aunque el deal fuera de
      // la tómbola — deal de Tamara colgando de una cuenta de Eddyluz). Los
      // REUSADOS no se tocan: pueden traer gestión de un SDR. Con skip de
      // assignment_rules (convención: los updates de owner que no pasan por la
      // regla no la disparan). Best-effort.
      // (Eddyluz cuenta como dueña real solo si el canal admin la ancló —
      // misma excepción del bloque de arriba.)
      if (
        toText(quoteOwner.id) &&
        quoteOwner.id !== VICKY_BOT_OWNER.id &&
        (quoteOwner.id !== EJEC_OWNER_ID || ownerManualId === EJEC_OWNER_ID)
      ) {
        const seguirDueno = async (mod, id) => {
          try {
            await zohoApiFetch(`/crm/v3/${mod}`, {
              method: "PUT",
              body: JSON.stringify({
                data: [{ id, Owner: quoteOwner }],
                skip_feature_execution: [{ name: "assignment_rules" }],
              }),
            });
          } catch (e) {
            console.warn(`[create-from-vicky] owner de ${mod} no siguió al deal: ${toText(e?.message || e).slice(0, 100)}`);
          }
        };
        if (accountId && !reuse.accountReused) await seguirDueno("Accounts", accountId);
        if (contactId && !reuse.contactReused) await seguirDueno("Contacts", contactId);
      }
    }

    // ── Cotización: crear nueva o reusar el Borrador en curso ──
    const ufActual = Number(cotizacion.ufActual || 0);
    const subformItems = buildSubformItems(cotizacion.items, ufActual, config);
    const escalerasPrecio = collectEscalerasPrecio(cotizacion.items);

    // Si la cotización nace con descuento negociado en el preform, calculamos
    // el descuento acumulado con el MISMO motor que usa el commit (mismos ítems
    // → mismos números). El PDF v1 ya sale con el precio acordado.
    let descIniciales = { recurrentePct: 0, instalacionRMPct: 0, instalacionRegionPct: 0 };
    let condicionDiscursivaInicial = null;
    if (escalonDescuento > 0) {
      const pseudoQuote = { [config.quoteItemsSubformField]: subformItems };
      const acum = descuentosHasta(pseudoQuote, config, escalonDescuento - 1);
      descIniciales = acum.descuentos;
      condicionDiscursivaInicial = acum.lastEscalon ? acum.lastEscalon.condicionDiscursiva : null;
    }

    // Campos del escalón/descuento. Son los únicos que cambian entre turnos de
    // la negociación, así que en el reuse del Borrador actualizamos SOLO esto
    // (no el subform: los ítems no cambian y reenviarlos duplicaría las filas).
    const quoteDiscountFields = {
      [config.quoteEscalonField]: escalonDescuento,
      [config.quoteEscalonNegociacionField]: escalonDescuento,
      [config.quoteDiscountUnlockedField]: escalonDescuento > 0,
      [config.quoteDiscountPctField]: descIniciales.recurrentePct,
      [config.quoteDiscountInstRMPctField]: descIniciales.instalacionRMPct,
      [config.quoteDiscountInstRegionPctField]: descIniciales.instalacionRegionPct,
    };

    let quoteId;
    if (existing.quoteId) {
      // Reusar el Borrador negociado: actualizamos el escalón en sitio. Si el id
      // resultó inválido (transcripción/registro borrado), caemos a crear nuevo.
      stage = "update_existing_quote";
      try {
        const existingQuote = await getRecord(config.quoteModule, existing.quoteId);
        if (existingQuote) {
          // Monotonicidad: el escalón del Borrador NUNCA retrocede. Si esta
          // llamada llega con un escalón menor al ya guardado (modelo reiniciado
          // tras un loop), conservamos el mayor — así un 30% aceptado no queda
          // pisado por un 20% viejo.
          const escalonExistente = Math.max(0, Number(existingQuote[config.quoteEscalonField] || 0));
          let fieldsToUpdate = quoteDiscountFields;
          if (escalonExistente > escalonDescuento) {
            const pseudoQuote = { [config.quoteItemsSubformField]: subformItems };
            const acum = descuentosHasta(pseudoQuote, config, escalonExistente - 1);
            fieldsToUpdate = {
              [config.quoteEscalonField]: escalonExistente,
              [config.quoteEscalonNegociacionField]: escalonExistente,
              [config.quoteDiscountUnlockedField]: escalonExistente > 0,
              [config.quoteDiscountPctField]: acum.descuentos.recurrentePct,
              [config.quoteDiscountInstRMPctField]: acum.descuentos.instalacionRMPct,
              [config.quoteDiscountInstRegionPctField]: acum.descuentos.instalacionRegionPct,
            };
            console.warn(
              `[create-from-vicky] Monotonicidad escalón: Borrador ${existing.quoteId} ya estaba en ${escalonExistente}, llegó ${escalonDescuento}; se conserva ${escalonExistente}.`,
            );
          }
          await updateRecord(config.quoteModule, existing.quoteId, fieldsToUpdate, true);
          quoteId = existing.quoteId;
          reuse.quoteReused = true;
        }
      } catch (quoteErr) {
        if (!isInvalidIdError(quoteErr)) throw quoteErr;
        console.warn(
          `[create-from-vicky] Borrador ${existing.quoteId} inválido, se crea cotización nueva. Detalle: ${quoteErr.message?.slice(0, 150)}`,
        );
      }
    }

    if (!quoteId) {
      stage = "create_quote";
      const quoteFields = {
        Name: `Cotización ${cliente.empresa} - ${new Date().toISOString().slice(0, 10)}`,
        // La cotización sigue al dueño del deal (tómbola de Zoho, Lalo 31-jul).
        Owner: quoteOwner,
        ...(dealId ? { [config.quoteDealLookupField]: { id: dealId } } : {}),
        ...(contactId ? { [config.quoteContactLookupField]: { id: contactId } } : {}),
        ...(accountId ? { Cuenta_Asociada: { id: accountId } } : {}),
        CRM_Incompleto: crmIncompleto,
        // CANAL DE ORIGEN (Lalo 19-ago): quién inició la venta. Discriminador
        // determinista: TODA emisión del canal ejecutivo (editor, Cotizadora
        // de Ejecutivos, calculadora) pasa sinCorreoCliente desde el 11-ago;
        // las de Vicky con clientes jamás lo pasan. Los correos internos de
        // ACEPTADA/PAGADA leen este campo para el asunto y el cuerpo.
        Intervenci_n_Humana: sinCorreoCliente ? "Con intervención humana" : "100% Vicky",
        [config.quoteDateField]: new Date().toISOString().slice(0, 10),
        [config.quoteStatusField]: "Borrador",
        [config.contactEmailField]: cliente.contactoEmail,
        [config.contactPhoneField]: cliente.contactoTelefono || undefined,
        [config.companyRutField]: cliente.rutEmpresa,
        // Subform con el detalle de items. La página de aceptación (session.js)
        // lee de aquí y calcula los totales en runtime. Si está vacío, todos los
        // valores se muestran como "-".
        [config.quoteItemsSubformField]: subformItems,
        // Estado inicial de descuentos y versionado (aplicar_siguiente_descuento
        // los actualiza después).
        [config.quoteVersionPdfField]: 1,
        // UF congelada de la emisión (Lalo 06-ago): visible y EDITABLE en
        // Zoho — regeneraciones y descuentos la respetan en vez de la UF del
        // día. Si la ejecutiva la cambia + Regenerar PDF, esa UF manda.
        // Solo los dos campos seguros (number + date). UF_Fuente y
        // UF_Fecha_Hora_Captura quedaron FUERA: el datetime ISO con "Z" y un
        // posible picklist tumbaron la emisión completa el 06-ago (caso
        // Bernardo/Clínica Dental Del Valle, 12:44) — un metadato jamás puede
        // costar una cotización.
        ...(ufActual > 0
          ? {
              UF_Valor: ufActual,
              UF_Fecha: new Date().toISOString().slice(0, 10),
            }
          : {}),
        ...quoteDiscountFields,
        ...(config.quotePriceLadderField && Object.keys(escalerasPrecio).length > 0
          ? { [config.quotePriceLadderField]: JSON.stringify(escalerasPrecio) }
          : {}),
      };
      const quoteResult = await createRecord(config.quoteModule, quoteFields, true);
      quoteId = toText(quoteResult?.id);
      if (!quoteId) throw new Error("No se obtuvo quoteId");
    }

    // Marcador de idempotencia APENAS existen los registros: si el resto del
    // request muere (update a Enviada, red, timeout), el reintento del tool
    // recibirá estos MISMOS ids en vez de crear un segundo deal.
    if (!draft) await setIdempotente(idemClave, { quoteId, dealId, accountId, contactId });

    // ── Modo Borrador: detenerse aquí (sin PDF/correo) ──
    // El escalón ya quedó en Zoho con su quote_id. La finalización ocurre
    // después, en la llamada de generar_link_cotizadora (sin draft), reusando
    // este quoteId/dealId.
    if (draft) {
      return sendJson(res, 200, {
        ok: true,
        draft: true,
        quoteId, dealId, accountId, contactId,
        sectorAplicado: sectorParaZoho,
        reuse,
      });
    }

    // ── acceptanceUrl ──
    stage = "build_acceptance_url";
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const token = signAcceptancePayload({
      quoteId, dealId: dealId || "",
      iat: Date.now(), exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

    // El link de aceptación es por token y NO necesita el PDF. Marcamos la
    // cotización como "Enviada" con su link y le respondemos a Vicky de
    // INMEDIATO; el PDF (Chromium headless, lo pesado) + el correo se generan en
    // segundo plano con waitUntil. Así la respuesta baja de ~40-60s a un par de
    // segundos y el link llega siempre (antes el render del PDF la timeouteaba).
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
          body: JSON.stringify({ evento: "crm_incompleto", empresa: cliente.empresa, numero: quoteId, monto: "" }),
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
      // Código corto firmado: es lo que viaja como `params.codigo` en la
      // plantilla de WhatsApp con botón (el token largo no cabe en un botón).
      codigoCorto: codigoCortoDeCotizacion(quoteId),
      linkCorto: linkCortoDeCotizacion(quoteId, config.baseUrl),
      pdfUrl: "",
      pdfPendiente: true,
      sectorAplicado: sectorParaZoho,
      reuse,
      // Dueño real (tómbola/deal) para que Vicky sepa quién da seguimiento.
      ejecutivo: { nombre: quoteOwnerNombre, email: quoteOwnerEmail },
      expiresAt: new Date(expMs).toISOString(),
    });

    // ── PDF + correo en segundo plano (no bloquea la respuesta a Vicky) ──
    waitUntil(
      (async () => {
        // El correlativo Numero_Cotizacion (auto-número de Zoho) se genera al
        // crear el registro; lo leemos para mostrarlo en el PDF (sin "COT").
        const numeroCotizacion = await getRecordWithFields(config.quoteModule, quoteId, ["Numero_Cotizacion"])
          .then((r) => toText(r?.Numero_Cotizacion))
          .catch(() => "");

        // VISIBILIDAD INTER-CANAL (caso Ingesub, 20-jul): nota en la CUENTA
        // para que cualquier ejecutivo que abra el registro vea al instante
        // que el canal digital está activo con este cliente. Best-effort.
        if (accountId) {
          createRecord("Notes", {
            Note_Title: "Vicky emitió cotización formal — canal digital activo",
            Note_Content:
              `Vicky generó la cotización formal ${numeroCotizacion || quoteId} para este cliente el ` +
              new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" }) +
              ". Si estás trabajando esta cuenta por otro canal, coordinar antes de avanzar (evita ventas en paralelo).",
            Parent_Id: accountId,
            $se_module: "Accounts",
          }).catch(() => {});
        }
        const html = buildProposalHtml({
          cliente: {
            ...cliente,
            // Dueño real del deal (tómbola) — el PDF presenta al mismo
            // ejecutivo que el correo y el pie (residuo Eddyluz fija, 31-jul).
            ejecutivo: quoteOwnerNombre,
            ejecutivoEmail: quoteOwnerEmail,
            ejecutivoTelefono: quoteOwnerTelefono,
          },
          cotizacion,
          acceptanceUrl,
          cotizacionId: numeroParaPdf(numeroCotizacion, quoteId),
          validezHasta: new Date(expMs).toISOString(),
          descuentos: descIniciales,
          condicionDiscursiva: condicionDiscursivaInicial,
        });
        const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
        const { pdfUrl } = await uploadPdfToSupabase({
          pdfBuffer,
          quoteId,
          empresa: cliente.empresa,
        });
        await updateRecord(config.quoteModule, quoteId, {
          [config.quotePdfUrlField]: pdfUrl,
        }, true);
        // Propaga al puntero de Supabase (principio Lalo 07-ago: el PDF nuevo en TODOS lados)
        await actualizarPunteroPdf(quoteId, pdfUrl);
        const tieneReloj = (cotizacion.items || []).some(
          (it) => it && it.tipo === "hardware",
        );
        // Sin correo del contacto no hay envío: la entrega corre por WhatsApp
        // (PDF adjunto + link). El respaldo por correo se ofrece en el chat y
        // recién ahí se pide la dirección.
        if (sinCorreoCliente) {
          console.log(`[create-from-vicky] correo al cliente SUPRIMIDO (canal ejecutivo) quote=${quoteId}`);
        }
        // PDF ADJUNTO (Eduardo 17-ago): se sube a Zoho Files para que viaje
        // dentro del correo. Best-effort — sin adjunto el correo sale igual,
        // con el link del PDF en la sección de documentos.
        const adjuntoId = cliente.contactoEmail && !sinCorreoCliente
          ? await subirArchivoZohoParaAdjunto(pdfBuffer, `cotizacion_${numeroParaPdf(numeroCotizacion, quoteId)}.pdf`)
          : "";
        if (cliente.contactoEmail && !sinCorreoCliente) await sendQuoteEmailViaZoho({
          quoteModule: config.quoteModule,
          quoteId,
          fromEmail: VICKY_FROM_EMAIL,
          // Reply-to y CC al EJECUTIVO ASIGNADO por la tómbola (Lalo 31-jul):
          // él ve el correo que recibió su cliente, y una respuesta del
          // cliente le llega directo. Fallback: ejecutivo por defecto.
          replyToEmail: quoteOwnerEmail,
          ccEmail: quoteOwnerEmail,
          // Copias fijas (Lalo + Rodrigo) + las copias que traiga el body.
          ccEmails: [...CC_FIJOS, ...(Array.isArray(body.cc) ? body.cc : [])].filter(Boolean),
          toEmail: cliente.contactoEmail,
          toName: cliente.contacto,
          subject: `Tu cotización GeoVictoria — ${cliente.empresa}`,
          attachmentId: adjuntoId,
          htmlBody: buildEmailHtml({
            contacto: cliente.contacto,
            empresa: cliente.empresa,
            pdfUrl,
            acceptanceUrl,
            tieneReloj,
            // El dueño sorteado por la tómbola es quien se presenta (Grey 31-jul).
            ejecutivo: { nombre: quoteOwnerNombre, email: quoteOwnerEmail, telefono: quoteOwnerTelefono },
            // El correo solo promete el adjunto cuando la subida REALMENTE
            // funcionó (18-ago: con el scope de Files pendiente decía "va
            // adjunto" y no iba nada — el respaldo queda como link al PDF).
            pdfAdjunto: Boolean(adjuntoId),
          }),
        });

        // ── Cotización en Zoho Creator ──
        // Nace ACÁ, en la emisión, no al aceptar/pagar: lo que Creator crea es
        // una COTIZACIÓN (Formulario="Cotización", STATUS="BORRADOR"), así que
        // su momento natural es cuando Vicky cotiza. Además la escalera de
        // precios está en memoria en este request.
        //
        // Va ÚLTIMO a propósito: el link, el PDF y el correo son la ruta
        // crítica del cliente y no deben esperar a Creator. Si acá nos
        // quedamos sin tiempo de función, la aceptación y el post-pago siguen
        // creando el registro si no existe (red de seguridad), porque ambos
        // consultan la referencia antes de crear.
        //
        // La conversión Cotización → Nota de Venta y el confirmar siguen
        // siendo el paso humano del ejecutivo en Creator.
        await emitirCotizacionEnCreator({
          config,
          quoteId,
          dealId,
          // En la emisión todavía no hay datos de facturación: el cliente los
          // entrega recién en la página de aceptación. El RUT ya está en la
          // cotización, que es lo que exige la prevalidación.
          acceptanceData: { companyRut: toText(cliente?.rutEmpresa) },
          escalerasPrecio,
          // La dotación que pidió el cliente, de primera mano. En un tramo de
          // tarifa fija la línea va con cantidad 1, así que deducirla del
          // subform daría "1 usuario" y Creator cobraría el tramo equivocado.
          userCount: Number(cliente?.userCount) || 0,
          crmIncompleto,
          motivo: "emision",
        });
      })().catch((bgErr) =>
        console.error(
          "[create-from-vicky] PDF/correo en segundo plano falló:",
          bgErr?.message || bgErr,
        ),
      ),
    );
    return;

  } catch (error) {
    console.error(`[create-from-vicky] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: `Falla en stage='${stage}'`,
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};

// Exponemos buildSubformItems para que consultar-descuento-referencial reuse la
// MISMA construcción de subform (así el preview del preform y la cotización
// formal usan idéntica conversión de modalidad/zona → mismos números).
module.exports.buildSubformItems = buildSubformItems;

// Exponemos buildEmailHtml para que el preview reuse EXACTAMENTE el mismo correo
// que producción (sin mantener dos copias del diseño).
module.exports.buildEmailHtml = buildEmailHtml;

// Exponemos el envío del correo de cotización (vía Zoho send_mail) para que el
// cron de respaldo del PDF (backfill-pdf.js) reenvíe el MISMO correo cuando el
// render en segundo plano falló y el cliente nunca lo recibió.
module.exports.sendQuoteEmailViaZoho = sendQuoteEmailViaZoho;
