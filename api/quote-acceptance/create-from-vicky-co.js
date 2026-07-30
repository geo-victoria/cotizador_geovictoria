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
const { createRecord, updateRecord, getRecordWithFields, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { zohoApiFetch } = require("../_shared/zoho-auth");

// LEAD-FIRST (Lalo 30-jul): si el contacto ya tiene un lead CONVERTIDO (la
// sincronización de hitos convierte al ver el preform), la formal se cuelga
// de ESE deal — no se crea otro (patrón Odalisca). Descarta Cierre Perdido.
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
      if (stageDeal === "Cierre Perdido") ids.dealId = "";
    }
    if (ids.accountId || ids.contactId || ids.dealId) {
      console.warn(`[lead-first] contacto ${fono} ya convertido — se reusa account=${ids.accountId || "-"} contact=${ids.contactId || "-"} deal=${ids.dealId || "-"}`);
    }
    return ids;
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
    }
    } catch (plumbingError) {
      if (String(process.env.CRM_STRICT || "") === "1") throw plumbingError;
      crmIncompleto = true;
      console.error(
        `[create-from-vicky-co] CRM DEGRADADO en stage=${stage}: ${toText(plumbingError?.message || plumbingError).slice(0, 300)}. ` +
          `La cotización continúa (accountId=${accountId || "∅"}, contactId=${contactId || "∅"}, dealId=${dealId || "∅"}).`,
      );
    }
    if (!accountId || !dealId) crmIncompleto = true;

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

    // ── PDF en segundo plano (sin correo en v1) ──
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
