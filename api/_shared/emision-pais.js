"use strict";
/**
 * EMISIÓN ÚNICA create-from-vicky parametrizada por país (paso 3 del plan,
 * 29-sep; Lalo 23-sep "el proceso es solo uno, no un proceso por país").
 *
 * Hasta hoy PE, CO y MX eran tres copias del mismo flujo (~1.000 líneas cada
 * una) y cada corrección había que hacerla tres veces: lead-first, dedup de
 * cuenta por documento, deal, cotización con subform, token, PDF, correo,
 * Creator. Acá vive UNA vez; el país aporta solo DATOS y textos en un
 * `perfil` (documento tributario, claves de los ítems, moneda, impuesto,
 * dueños, plantilla de PDF, correo y notas de Creator).
 *
 * IDENTIDAD: tests/emision-golden compara cada país contra los goldens que se
 * congelaron con los handlers viejos ANTES de este módulo (respuesta HTTP +
 * secuencia de llamadas hacia afuera). Dos unificaciones deliberadas, ambas
 * fuera de los goldens: la cuenta y el contacto que ya vienen resueltos por
 * una conversión previa se REUSAN en los tres países (antes CO y MX volvían a
 * buscar y a crear), y el "Camino A" de Colombia (kv co_convert_first) se
 * retira porque lead-first lo reemplazó el 23-sep.
 *
 * Chile (create-from-vicky.js) sigue con su handler propio en esta fase: trae
 * capacidades CL-only (SII, escalera de instalación, Sign) y entra en la fase
 * siguiente con el mismo arnés de identidad.
 */
const crypto = require("crypto");
const { signAcceptancePayload } = require("./acceptance-token");
const { actualizarPunteroPdf } = require("./pointer-sync");
const { claveIdempotencia, getIdempotente, setIdempotente, getDealPorFono, setDealPorFono } = require("./idempotencia");
const { sendQuoteEmailViaZoho, buildEmailHtml } = require("../quote-acceptance/create-from-vicky");
const { createRecord, updateRecord, getRecordWithFields, toText } = require("./zoho-crm");
const { linkCortoDeCotizacion } = require("./codigo-corto");
const { getAcceptanceConfig } = require("./quote-acceptance-config");
const { zohoApiFetch } = require("./zoho-auth");
const { htmlToPdfBuffer } = require("./pdfshift-client");
const { uploadPdfToSupabase } = require("./supabase-pdf-upload");
const { DISCOUNT_LADDER, MESES_DESCUENTO_PLAN } = require("./proposal-constants");
const { nacerDealDesdeLead, leadsDelPaisDeFono } = require("./lead-first");

// waitUntil: trabajo en segundo plano DESPUÉS de responder. Fallback
// best-effort si el paquete no está disponible (tests, local).
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch (_e) {
  waitUntil = (p) => {
    Promise.resolve(p).catch(() => {});
  };
}

const OWNER_VICKY_ID = "3525045000484500876";

// Defaults compartidos (mismos nombres de env que Chile).
const DEFAULTS = {
  dealStage: () => toText(process.env.VICKY_DEAL_STAGE_INICIAL) || "4. Propuesta Enviada / En Negociación",
  leadSource: () => toText(process.env.VICKY_LEAD_SOURCE) || "SEO",
  tombola: () => toText(process.env.VICKY_TOMBOLA) || "Mantener propietario",
  producto: () => toText(process.env.VICKY_PRODUCTO_DEFAULT) || "Control de Asistencia",
  sector: () => toText(process.env.VICKY_SECTOR_FALLBACK) || "19. Servicios",
  expansion: () => toText(process.env.VICKY_EXPANSION_REGIONAL) || "No",
  fromEmail: () => toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com",
};

// Cuentas internas que NUNCA se reusan al deduplicar por documento (un
// documento de prueba puede colisionar con una cuenta interna y pegarle la
// cotización de un prospecto).
function cuentasInternas() {
  return (process.env.VICKY_INTERNAL_ACCOUNT_NAMES || "GeoVictoria")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ── HTTP ──
function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowedList = (process.env.ALLOWED_UPLOAD_ORIGINS || "")
    .split(",").map((v) => v.trim()).filter(Boolean);
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

// ── Zoho: lecturas compartidas ──
async function executeCoqlQuery(etiqueta, selectQuery) {
  try {
    const response = await zohoApiFetch("/crm/v3/coql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: selectQuery }),
    });
    if (response.status === 204) return [];
    const text = await response.text();
    if (!response.ok) {
      console.warn(`[${etiqueta}] coql error ${response.status}: ${text.slice(0, 150)}`);
      return [];
    }
    return JSON.parse(text)?.data || [];
  } catch (err) {
    console.warn(`[${etiqueta}] coql excepción: ${err.message?.slice(0, 150)}`);
    return [];
  }
}

// Dedup de Account por el documento tributario del país en RUT_Empresa.
// Descarta cuentas internas; con documento repetido (dato sucio) prefiere la
// que coincide en nombre.
async function findAccountIdByDocumento(perfil, doc, empresaName) {
  const variants = perfil.documento.variantes(doc);
  if (variants.length === 0) return null;
  const escaped = variants.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const rows = await executeCoqlQuery(
    perfil.etiqueta,
    `select id, Account_Name from Accounts where RUT_Empresa in (${escaped}) limit 10`,
  );
  if (!rows.length) return null;
  const internas = cuentasInternas();
  const esInterna = (name) => internas.includes(String(name || "").trim().toLowerCase());
  const externas = rows.filter((r) => !esInterna(r.Account_Name));
  if (!externas.length) {
    console.warn(`[${perfil.etiqueta}] dedup por ${perfil.documento.nombre} '${doc}' solo matcheó cuenta(s) interna(s); se ignora.`);
    return null;
  }
  if (empresaName) {
    const norm = (s) => String(s || "").trim().toLowerCase();
    const byName = externas.find((r) => norm(r.Account_Name) === norm(empresaName));
    if (byName) return toText(byName.id);
  }
  return toText(externas[0]?.id) || null;
}

async function findContactIdByEmail(etiqueta, email) {
  if (!email) return null;
  const emailNorm = String(email).trim().toLowerCase();
  if (!emailNorm) return null;
  const rows = await executeCoqlQuery(
    etiqueta,
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

// LEAD-FIRST: contacto ya convertido → reusar cuenta/contacto/deal. Los
// procesos CERRADOS (Cierre Perdido, 8. Facturando) generan ciclo nuevo con
// deal propio; cuenta y contacto sí se reusan (Lalo 31-jul).
async function findConvertedIdsByPhone(etiqueta, telefono) {
  const fono = toText(telefono).replace(/\D/g, "");
  if (!fono) return {};
  try {
    const res = await zohoApiFetch(
      `/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=3`,
    );
    if (!res.ok || res.status === 204) return {};
    // Solo leads del PAÍS del número (29-sep): la búsqueda de Zoho compara los
    // últimos dígitos y un chileno y un peruano pueden compartirlos.
    const lead = leadsDelPaisDeFono(fono, (await res.json())?.data || []).find(
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
      console.warn(`[lead-first:${etiqueta}] contacto ${fono} ya convertido — se reusa account=${ids.accountId || "-"} contact=${ids.contactId || "-"} deal=${ids.dealId || "-"}`);
    }
    return ids;
  } catch {
    return {};
  }
}

// Cierra el LEAD HUÉRFANO del contacto (derivación, reloj de calificación, SDR)
// convirtiéndolo a la cuenta/contacto del deal recién creado: sale de la cola
// sin duplicar nada. Solo leads de dueños adoptables (bot/interino/SDR del
// país): uno de dueño humano real no se toca. Best-effort.
async function cerrarLeadHuerfano(perfil, telefono, accountId, contactId) {
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
        ) && perfil.owners.adoptables.has(toText(l?.Owner?.id)),
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
    console.warn(`[${perfil.etiqueta}] lead huérfano ${vivo.id} convertido a la cuenta/contacto del deal.`);
  } catch (e) {
    console.warn(`[${perfil.etiqueta}] cerrarLeadHuerfano falló: ${toText(e?.message || e).slice(0, 120)}`);
  }
}

// ── Subform Detalle_Items_Cotizacion (mismos picklists de Zoho en los 4 países) ──
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

/**
 * Filas del subform desde los ítems del agente. Convención "unidad de pricing
 * del país": los campos *_UF guardan el valor en la moneda del país y los
 * *_CLP el MISMO valor. `claves` = {unitario, subtotal, afecto} del contrato
 * del país; `redondeo` = a centavos (PE/MX) o a entero (CO).
 */
function buildSubformItemsPais(items, { claves, redondeo }) {
  return items.map((item, index) => {
    const modalidadZoho = mapModalidadToZoho(item.modalidad);
    const tipo = String(item.tipo || "").toLowerCase();
    const precioUnitario = redondeo(item[claves.unitario]);
    const subtotal = redondeo(item[claves.subtotal]);
    const row = {
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
      Afecto_IVA: item[claves.afecto] === true,
      Orden: index + 1,
      Categoria_Item: mapCategoriaToZoho(item),
      Unidad: mapUnidadToZoho(modalidadZoho, tipo),
    };
    // Bonificación por línea (mismo contrato que Chile): el PDF tacha la
    // lista y las regeneraciones conservan la línea en 0.
    if (Number(item.descuentoPct) > 0) {
      row.Descuento_Pct = Math.min(100, Number(item.descuentoPct));
    }
    // Zona tarifaria del punto (base | intermedia | resto, 29-sep): con ella
    // la nota de venta elige el artículo de servicio del país.
    const zonaTarifa = String(item.zonaTarifa || "").trim().toLowerCase();
    if (/^(base|intermedia|resto)$/.test(zonaTarifa)) row.Zona_Tarifa = zonaTarifa;
    // Ítem OCULTO (anualidad): queda en el subform en 0 y ni el PDF ni la
    // aceptación lo pintan.
    if (item.oculto === true) {
      row.Metadata_Item_JSON = JSON.stringify({ oculto: true });
    }
    return row;
  });
}

function validarItemPais(item, index, claves) {
  if (!item || typeof item !== "object") return `items[${index}] no es un objeto`;
  if (!toText(item.nombre)) return `items[${index}].nombre requerido`;
  const cantidad = Number(item.cantidad);
  if (!Number.isFinite(cantidad) || cantidad < 1) return `items[${index}].cantidad debe ser >= 1`;
  if (!Number.isFinite(Number(item[claves.unitario]))) return `items[${index}].${claves.unitario} debe ser numérico`;
  if (!Number.isFinite(Number(item[claves.subtotal]))) return `items[${index}].${claves.subtotal} debe ser numérico`;
  if (typeof item.esRecurrente !== "boolean") return `items[${index}].esRecurrente debe ser boolean`;
  if (typeof item[claves.afecto] !== "boolean") return `items[${index}].${claves.afecto} debe ser boolean`;
  return null;
}

// Número de cotización a mostrar en el PDF: correlativo de Zoho sin "COT".
function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

function redondeoCentavos(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}
function redondeoEntero(v) {
  return Math.round(Number(v || 0));
}

function ccDesdeEnv(nombre, def) {
  return toText(process.env[nombre] || def).split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Fabrica el handler HTTP de la emisión de un país.
 *
 * perfil = {
 *   cc, etiqueta, secretEnv,
 *   territorio, moneda,                       // strings ya resueltos (env → default)
 *   owners: { interino: {id}, adoptables: Set, noHeredables?: Set },
 *   documento: { campo, nombre, validar(body) → {error?, tipoDocumento?},
 *                paraGuardar(doc), variantes(doc), compactar(v),
 *                paraCotizacion(doc), descripcionCuenta(doc, tipoDoc),
 *                nombreDesambiguado(empresa, doc), clientePdf(doc) },
 *   items: { claves, redondeo, preparar(items), total(items), totalTexto(total),
 *            amountDeal(total) },
 *   deal: { tipoDeCobro(userCount), nombre(empresa, doc), despues?(ctx) },
 *   pdf: { build(args) }, correo: { cc(), replyTo(ctx), ccEmails(ctx), html(ctx) },
 *   creator: async (ctx) → emisiones a Creator,
 *   respuestaExtra?(ctx), extrasDelBody?(body) → campos que viajan en ctx
 * }
 */
function crearHandlerEmision(perfil) {
  const P = perfil;
  const etiqueta = P.etiqueta;

  const handler = async function handler(req, res) {
    const corsAllowed = setCors(req, res);
    if (req.method === "OPTIONS") {
      res.statusCode = corsAllowed ? 204 : 403; res.end(); return;
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Método no permitido" });
    }

    // Auth: secreto del país con fallback al secreto compartido de Vicky.
    const expectedSecret = toText(process.env[P.secretEnv]) || toText(process.env.VICKY_COTIZADORA_SECRET);
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
      const doc = toText(body[P.documento.campo]);
      const contactoTelefono = toText(body.contactoTelefono);
      const userCount = Number(body.userCount) > 0 ? Number(body.userCount) : undefined;
      // DESCUENTO = CHILE (Lalo 17-sep PE / 21-sep CO / 24-sep MX): el agente
      // manda el ESCALÓN aceptado (1 = 10 %, 2 = 20 %, sobre el plan, 6 meses)
      // y los ítems a precio de LISTA; acá se estampa en la cotización para
      // que sesión, PDF, aceptación y nota de venta lo apliquen SOLO al plan.
      const escalonDescuento = Math.max(0, Math.min(DISCOUNT_LADDER.length, Math.floor(Number(body.escalonDescuento) || 0)));
      const descuentoPlanPct = escalonDescuento > 0 ? Number(DISCOUNT_LADDER[escalonDescuento - 1].pct) : 0;
      const descuentos = { recurrentePct: descuentoPlanPct, instalacionRMPct: 0, instalacionRegionPct: 0 };
      const extras = P.extrasDelBody ? P.extrasDelBody(body) : {};

      // contactoEmail es OPCIONAL (mismo contrato que Chile, Lalo 03-ago /
      // 21-sep): sin correo no sale el correo con el PDF; el link viaja por
      // el chat y el formulario de facturación lo pide al aceptar.
      if (!empresa || !contacto || !doc) {
        return sendJson(res, 400, { ok: false, error: `Faltan campos: empresa, contacto, ${P.documento.campo}` });
      }
      const validacionDoc = P.documento.validar(body, doc);
      if (validacionDoc?.error) return sendJson(res, 400, { ok: false, error: validacionDoc.error });
      const tipoDocumento = validacionDoc?.tipoDocumento || P.documento.nombre;
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return sendJson(res, 400, { ok: false, error: "items requerido (no vacío)" });
      }
      for (let i = 0; i < body.items.length; i++) {
        const err = validarItemPais(body.items[i], i, P.items.claves);
        if (err) return sendJson(res, 400, { ok: false, error: err });
      }

      const config = getAcceptanceConfig(req);
      const tokenPara = (quoteId, dealId, expMs) =>
        signAcceptancePayload({
          quoteId, dealId,
          pais: P.cc,
          iat: Date.now(), exp: expMs,
          nonce: crypto.randomBytes(8).toString("hex"),
          v: 1,
        });

      // ── IDEMPOTENCIA (fix CL 04-ago, caso Inversiones Automatic): un
      // reintento con el MISMO body devuelve los ids ya creados. ──
      const idemClave = claveIdempotencia(body);
      const previoIdem = await getIdempotente(idemClave);
      if (previoIdem && previoIdem.quoteId) {
        console.warn(`[${etiqueta}] reintento idempotente: mismo body ya creó quote ${previoIdem.quoteId} / deal ${previoIdem.dealId || "-"} — no se duplica.`);
        const expMsIdem = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
        const tokenIdem = tokenPara(previoIdem.quoteId, previoIdem.dealId || "", expMsIdem);
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
          linkCorto: linkCortoDeCotizacion(previoIdem.quoteId, config.baseUrl),
          pdfUrl: "", pdfPendiente: true,
          reuse: { retryIdempotente: true },
          expiresAt: new Date(expMsIdem).toISOString(),
        });
      }

      // Ítems del país: sin fila de Activación (patrón CL: el primer mes lo
      // calcula el cotizador) y con la capacitación de regalo en MX.
      const items = P.items.preparar(body.items);
      const total = P.items.total(items);

      // Principio (16-jul): LA COTIZACIÓN SIEMPRE SE ENTREGA. El plumbing CRM
      // es soporte: si falla, CRM_Incompleto=true y se sigue. CRM_STRICT=1
      // restaura el modo estricto.
      let crmIncompleto = false;
      let accountId;
      let accountReused = false;
      let contactId;
      let dealId;
      const docGuardar = P.documento.paraGuardar(doc);
      try {
        // LEAD-FIRST: contacto ya convertido → reusar su cuenta/contacto/deal.
        stage = "find_converted_by_phone";
        const convertidosPrevios = await findConvertedIdsByPhone(etiqueta, contactoTelefono);
        if (convertidosPrevios.accountId) { accountId = convertidosPrevios.accountId; accountReused = true; }
        if (convertidosPrevios.contactId) contactId = convertidosPrevios.contactId;
        if (convertidosPrevios.dealId) dealId = convertidosPrevios.dealId;

        // Candado cruzado hito↔cotización (kv compartida con el agente): si
        // crm-hitos acaba de crear un deal para este teléfono (invisible aún
        // para la búsqueda de Zoho), se reusa en vez de crear un gemelo.
        if (!dealId) {
          const dealCruzado = await getDealPorFono(contactoTelefono).catch(() => null);
          if (dealCruzado && dealCruzado.dealId) {
            dealId = dealCruzado.dealId;
            console.warn(`[${etiqueta}] candado kv: se reusa deal ${dealId} (origen=${dealCruzado.origen || "?"}) — no se crea gemelo.`);
          }
        }

        // ── Account: dedup por documento antes de crear ──
        if (!accountId) {
          stage = "find_account_by_documento";
          accountId = await findAccountIdByDocumento(P, doc, empresa);
          accountReused = Boolean(accountId);
        }

        if (!accountId) {
          stage = "create_account";
          const createAccountPayload = {
            Account_Name: empresa,
            RUT_Empresa: docGuardar,
            Phone: contactoTelefono || undefined,
            Description: P.documento.descripcionCuenta(doc, tipoDocumento),
            Industry: DEFAULTS.sector(),
            Territorio: P.territorio,
            N_Empleados_dependientes: userCount,
            Tiene_potencial_de_expansi_n_Regional: DEFAULTS.expansion(),
            Owner: P.owners.interino,
          };
          try {
            const accountResult = await createRecord("Accounts", createAccountPayload, true);
            accountId = toText(accountResult?.id);
            if (!accountId) throw new Error("No se obtuvo accountId");
          } catch (createError) {
            if (!isDuplicateDataError(createError)) throw createError;
            // Duplicado: por documento (carrera con la búsqueda previa) o por
            // NOMBRE homónimo con documento distinto → cuenta desambiguada
            // "Empresa (doc)": son empresas distintas, no la misma.
            stage = "dedupe_account_by_documento";
            const existingAccountId = await findAccountIdByDocumento(P, doc, empresa);
            if (existingAccountId) {
              accountId = existingAccountId;
              accountReused = true;
            } else {
              console.warn(`[${etiqueta}] duplicado por nombre con ${P.documento.nombre} distinto (${doc}); creando cuenta desambiguada.`);
              stage = "create_account_disambiguated";
              const nombreDesambiguado = P.documento.nombreDesambiguado(empresa, doc);
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
                // Capa 4: reusar SOLO si el documento coincide; si no, sin cuenta.
                stage = "reuse_account_capa4";
                const compactar = P.documento.compactar;
                const porNombre = await executeCoqlQuery(
                  etiqueta,
                  `select id, RUT_Empresa from Accounts where Account_Name = '${nombreDesambiguado.replace(/'/g, "''")}' limit 5`,
                ).catch(() => []);
                const match = (porNombre || []).find((r) => compactar(r.RUT_Empresa) === compactar(doc));
                if (match) {
                  accountId = toText(match.id);
                  accountReused = true;
                } else {
                  accountId = undefined;
                  console.error(`[${etiqueta}] Capa 4: sin salida de dedupe (${P.documento.nombre}=${doc}); cotización SIN cuenta.`);
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
              Email: contactoEmail || undefined,
              Phone: contactoTelefono || undefined,
              ...(accountId ? { Account_Name: { id: accountId } } : {}),
              Lead_Source: DEFAULTS.leadSource(),
              Territorio: P.territorio,
              Owner: P.owners.interino,
            }, true);
            contactId = toText(contactResult?.id);
            if (!contactId) throw new Error("No se obtuvo contactId");
          } catch (createError) {
            if (!isDuplicateDataError(createError)) throw createError;
            stage = "dedupe_contact_by_email";
            const existingContactId = contactoEmail ? await findContactIdByEmail(etiqueta, contactoEmail) : "";
            if (!existingContactId) {
              throw new Error(`Zoho reportó duplicate data pero no se encontró Contact con Email ${contactoEmail}`);
            }
            contactId = existingContactId;
          }
        }

        // ── Deal (Territorio del país + obligatorios del layout) ──
        if (!dealId) {
          const dealData = {
            Deal_Name: P.deal.nombre(empresa, doc),
            Stage: DEFAULTS.dealStage(),
            Pipeline: "Standard (Standard)",
            Lead_Source: DEFAULTS.leadSource(),
            ...(P.items.amountDeal ? { Amount: P.items.amountDeal(total) } : {}),
            Description: `Deal creado por Vicky ${P.cc.toUpperCase()} para cotización WhatsApp.\nUsuarios: ${userCount || "-"}\nTotal: ${P.items.totalTexto(total)} ${P.moneda}`,
            Territorio: P.territorio,
            Tombola: DEFAULTS.tombola(),
            Monda_del_trato: P.monedaDeal,
            Sector: DEFAULTS.sector(),
            N_Empleados_que_marcan: userCount,
            Tipo_de_Cobro: P.deal.tipoDeCobro(userCount),
            Producto_Soluci_n: DEFAULTS.producto(),
            Owner: P.owners.interino,
          };
          // LEAD-FIRST (regla de oro GLOBAL, Lalo 23-sep): el deal NACE de la
          // conversión del lead vivo del contacto (o de uno creado en el
          // acto). Un dueño humano previo hereda el deal; las SDR del país no.
          stage = "lead_first";
          const nacido = await nacerDealDesdeLead({
            telefono: contactoTelefono, contacto, empresa, email: contactoEmail,
            territorio: P.territorio, leadSource: DEFAULTS.leadSource(),
            empleados: userCount, documento: docGuardar,
            dealData, ownerDefault: P.owners.interino,
            ...(P.owners.noHeredables ? { noHeredables: P.owners.noHeredables } : {}),
            existingIds: { accountId, contactId }, etiqueta,
          }).catch(() => null);
          if (nacido?.dealId) {
            dealId = nacido.dealId;
            if (!accountId && nacido.accountId) { accountId = nacido.accountId; accountReused = true; }
            if (!contactId && nacido.contactId) contactId = nacido.contactId;
          } else {
            // Respaldo: deal fresco, MARCADO para revisión (la cotización siempre se entrega).
            stage = "create_deal";
            const dealResult = await createRecord("Deals", {
              ...dealData,
              ...(accountId ? { Account_Name: { id: accountId } } : {}),
              ...(contactId ? { Contact_Name: { id: contactId } } : {}),
              Description: `${dealData.Description}\n⚠️ Nació SIN lead convertido: lead-first falló (revisar).`,
            }, true);
            dealId = toText(dealResult?.id);
            if (!dealId) throw new Error("No se obtuvo dealId");
            console.error(`[${etiqueta}] deal ${dealId} nació SIN lead convertido (lead-first falló).`);
          }
          // Candado cruzado: registrar el deal apenas existe para que
          // crm-hitos lo reuse en vez de crear un gemelo por hito.
          await setDealPorFono(contactoTelefono, dealId, "cotizacion").catch(() => {});
        }
      } catch (plumbingError) {
        if (String(process.env.CRM_STRICT || "") === "1") throw plumbingError;
        crmIncompleto = true;
        console.error(
          `[${etiqueta}] CRM DEGRADADO en stage=${stage}: ${toText(plumbingError?.message || plumbingError).slice(0, 300)}. ` +
            `La cotización continúa (accountId=${accountId || "∅"}, contactId=${contactId || "∅"}, dealId=${dealId || "∅"}).`,
        );
      }
      if (!accountId || !dealId) crmIncompleto = true;

      // Ajustes del país sobre el deal ya resuelto (PE: RUC en el nombre del
      // trato, también para el que ya existía). Best-effort.
      if (P.deal.despues) {
        await P.deal.despues({ dealId, doc, docGuardar, etiqueta }).catch(() => {});
      }

      // El lead vivo del contacto sale de la cola del SDR/ejecutiva
      // convirtiéndose a la cuenta/contacto del deal. Best-effort.
      if (contactId || accountId) {
        await cerrarLeadHuerfano(P, contactoTelefono, accountId, contactId).catch(() => {});
      }

      // ── Cotización con subform (convención moneda del país en campos UF/CLP) ──
      stage = "create_quote";
      const subformItems = buildSubformItemsPais(items, P.items);
      const quoteResult = await createRecord(config.quoteModule, {
        // Zoho capa Name a 120 chars (caso Anderson 28-ago): se recorta la
        // empresa, la fecha siempre sobrevive.
        Name: `Cotización ${String(empresa || "").trim()}`.slice(0, 107) + ` - ${new Date().toISOString().slice(0, 10)}`,
        Owner: P.owners.interino,
        ...(dealId ? { [config.quoteDealLookupField]: { id: dealId } } : {}),
        ...(contactId ? { [config.quoteContactLookupField]: { id: contactId } } : {}),
        ...(accountId ? { Cuenta_Asociada: { id: accountId } } : {}),
        CRM_Incompleto: crmIncompleto,
        [config.quoteDateField]: new Date().toISOString().slice(0, 10),
        // Etiqueta de canal (28-sep): la misma de Chile. Con ella la
        // cotización entra al reenvío de correos pendientes, a la medición
        // de origen de la venta y al alta por chat.
        Intervenci_n_Humana: "100% Vicky",
        [config.quoteStatusField]: "Borrador",
        [config.contactEmailField]: contactoEmail || undefined,
        [config.contactPhoneField]: contactoTelefono || undefined,
        [config.companyRutField]: P.documento.paraCotizacion(doc),
        [config.quoteItemsSubformField]: subformItems,
        [config.quoteVersionPdfField]: 1,
        // Descuento del plan, misma forma que create-from-vicky (CL).
        ...(escalonDescuento > 0
          ? {
              [config.quoteEscalonField]: escalonDescuento,
              [config.quoteEscalonNegociacionField]: escalonDescuento,
              [config.quoteDiscountUnlockedField]: true,
              [config.quoteDiscountPctField]: descuentoPlanPct,
              [config.quoteDiscountInstRMPctField]: 0,
              [config.quoteDiscountInstRegionPctField]: 0,
            }
          : {}),
      }, true);
      const quoteId = toText(quoteResult?.id);
      if (!quoteId) throw new Error("No se obtuvo quoteId");
      if (escalonDescuento > 0) {
        console.log(`[${etiqueta}] cotización ${quoteId} con ${descuentoPlanPct} % en el plan (escalón ${escalonDescuento}, ${MESES_DESCUENTO_PLAN} meses).`);
      }
      // Marcador de idempotencia APENAS existen los registros.
      await setIdempotente(idemClave, { quoteId, dealId, accountId, contactId });

      // ── acceptanceUrl (token con el país: así session.js y los flujos
      // posteriores saben de qué país es la cotización sin campos nuevos) ──
      stage = "build_acceptance_url";
      const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
      const token = tokenPara(quoteId, dealId, expMs);
      const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

      // Alerta interna best-effort si la entrega fue en modo degradado.
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

      const ctx = {
        body, config, empresa, contacto, contactoEmail, contactoTelefono, doc, docGuardar, tipoDocumento,
        userCount, escalonDescuento, descuentoPlanPct, descuentos, extras, items, total,
        accountId, contactId, dealId, quoteId, crmIncompleto, acceptanceUrl, expMs,
        hayHardware: items.some((it) => String(it?.tipo || "").toLowerCase() === "hardware"),
      };

      sendJson(res, 200, {
        ok: true,
        quoteId, dealId, accountId, contactId,
        acceptanceUrl,
        linkCorto: linkCortoDeCotizacion(quoteId, config.baseUrl),
        pdfUrl: "",
        pdfPendiente: true,
        accountReused,
        ...(P.respuestaExtra ? P.respuestaExtra(ctx) : {}),
        expiresAt: new Date(expMs).toISOString(),
      });

      // ── PDF + correo + Creator en segundo plano (no bloquea al agente) ──
      waitUntil(
        (async () => {
          // Valor del trato al nacer (David 24-sep): misma fórmula del pase de limpieza.
          await (async () => require("./valor-deal").estamparValorDeal({ quoteModule: config.quoteModule, quoteId, dealId, empleados: Number(userCount) || 0 }))().catch(() => {});
          const numeroCotizacion = await getRecordWithFields(config.quoteModule, quoteId, ["Numero_Cotizacion"])
            .then((r) => toText(r?.Numero_Cotizacion))
            .catch(() => "");
          // Firmante (29-sep, regla de Chile para los 4 países): el dueño
          // humano del trato si lo hay; mientras espera con Vicky, firma Vicky.
          const { firmanteDeDeal, ejecutivoParaCorreo } = require("./ejecutivo-firma");
          const firmante = await firmanteDeDeal(dealId);
          const html = P.pdf.build({
            cliente: { empresa, contacto, ...P.documento.clientePdf(doc) },
            ejecutivo: firmante,
            items,
            acceptanceUrl,
            cotizacionId: numeroParaPdf(numeroCotizacion, quoteId),
            validezHasta: new Date(expMs).toISOString(),
            descuentos,
            mesesDescuento: MESES_DESCUENTO_PLAN,
          });
          const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
          const { pdfUrl } = await uploadPdfToSupabase({ pdfBuffer, quoteId, empresa });
          await updateRecord(config.quoteModule, quoteId, {
            [config.quotePdfUrlField]: pdfUrl,
          }, true);
          // Propaga al puntero de Supabase (principio Lalo 07-ago: el PDF nuevo en TODOS lados).
          await actualizarPunteroPdf(quoteId, pdfUrl);
          // Correo con el PDF: sin correo el link viaja por el chat.
          if (contactoEmail) {
            const correoCtx = { ...ctx, pdfUrl, firmante, ejecutivoParaCorreo, buildEmailHtml };
            await sendQuoteEmailViaZoho({
              quoteModule: config.quoteModule,
              quoteId,
              fromEmail: DEFAULTS.fromEmail(),
              toEmail: contactoEmail,
              toName: contacto,
              subject: `Tu cotización GeoVictoria — ${empresa}`,
              ...P.correo.destinatarios(correoCtx),
              htmlBody: P.correo.html(correoCtx),
            }).catch((mailErr) =>
              console.error(`[${etiqueta}] correo de cotización falló:`, mailErr?.message || mailErr),
            );
          }
          // Cotización en Zoho Creator: mismo puente que Chile, con la moneda,
          // el país y la escalera del país. Va ÚLTIMO y best-effort: link, PDF
          // y correo son la ruta crítica del cliente.
          try {
            await P.creator(ctx);
          } catch (creatorErr) {
            console.error(`[${etiqueta}] Creator falló (best-effort):`, creatorErr?.message || creatorErr);
          }
        })().catch((bgErr) =>
          console.error(`[${etiqueta}] PDF en segundo plano falló:`, bgErr?.message || bgErr),
        ),
      );
      return;
    } catch (error) {
      console.error(`[${etiqueta}] ERROR en stage=${stage}:`, error);
      return sendJson(res, 500, {
        ok: false,
        error: `Falla en stage='${stage}'`,
        detail: String(error?.message || error).slice(0, 400),
      });
    }
  };

  return handler;
}

module.exports = {
  crearHandlerEmision,
  buildSubformItemsPais,
  validarItemPais,
  numeroParaPdf,
  redondeoCentavos,
  redondeoEntero,
  ccDesdeEnv,
  OWNER_VICKY_ID,
  DEFAULTS,
  // expuestos para tests/reuso
  mapModalidadToZoho,
  mapCategoriaToZoho,
  mapUnidadToZoho,
  splitFullName,
  isDuplicateDataError,
};
