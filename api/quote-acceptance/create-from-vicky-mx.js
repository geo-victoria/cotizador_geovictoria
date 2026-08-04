/**
 * POST /api/quote-acceptance/create-from-vicky-mx — Cotización formal MÉXICO.
 *
 * Espejo de create-from-vicky-co.js (Colombia), con las reglas del documento
 * de tropicalización MX. Diferencias vs CO:
 *   - Moneda MXN directa (sin UF), formato $1,000 MXN. IVA 16% POR LÍNEA según
 *     afectoIva (en MX el IVA aplica en general a servicios Y hardware; el
 *     agente marca las líneas gravadas — a diferencia de CO donde solo el
 *     hardware es afecto).
 *   - Identificador tributario: RFC (12-13 caracteres). Se guarda en los
 *     MISMOS campos que CO usa para el NIT: RUT_Empresa (Accounts, convención
 *     "documento tributario del país") y RUT_Cliente (cabecera cotización).
 *   - SIN fila de Activación (no existe en la tropicalización MX). En su lugar
 *     se garantiza SIEMPRE la fila de "Capacitación online" COBRADA ($600 MXN
 *     pago único) — sin la leyenda de regalo/100 % dcto de CL/CO.
 *   - CON correo al cliente (tuteo, espejo del diseño chileno adaptado y sin
 *     regalos falsos), asunto "Tu cotización GeoVictoria — {empresa}".
 *   - Owner por defecto: Yahel Segura (zohoUserId 3525045000308323003), donde
 *     CO deja el owner por env (VICKY_CO_OWNER_ID / Alejandro Gordillo).
 *
 * Los items vienen YA calculados por el motor de precios MX del agente (misma
 * confianza que CL/CO). Tarifario MX (fuente de verdad del doc de
 * tropicalización, expuesto acá como TARIFAS_MX para tests/validación):
 *   - Plan asistencia: 1-10 usuarios tarifa FIJA $1,000 MXN/mes;
 *     11-20 $83/usuario; 21-30 $79; 31-50 $75.
 *   - Reloj: venta $2,100 pago único; arriendo $350/mes.
 *   - Envío: venta $400 por punto (no descontable); arriendo $0.
 *   - Instalación: $700 por punto SOLO zona "cdmx_metro". En zona "resto" (o
 *     auto-instalada) el payload simplemente NO trae el ítem de instalación y
 *     el PDF no lo muestra — este endpoint no agrega ni exige ese ítem.
 *   - Capacitación online: $600 MXN pago único COBRADO (ítem siempre presente).
 *   - Escalera de descuento recurrente 10→15 %: la negocia el agente y los
 *     items llegan con el precio final (igual que CO v1, sin campos de
 *     descuento acá). El clamp de 40 % de quote-pricing no interfiere.
 *
 * Auth: header `x-vicky-secret` (mismo esquema que CL/CO). Se valida contra
 * VICKY_COTIZADORA_SECRET_MX y, si esa env no existe, contra
 * VICKY_COTIZADORA_SECRET (espejo del fallback CO).
 *
 * ── CONTRATO DEL BODY (JSON) ────────────────────────────────────────────────
 * {
 *   "empresa":          string  (requerido) — razón social / nombre de la empresa
 *   "contacto":         string  (requerido) — nombre completo del contacto
 *   "contactoEmail":    string  (requerido)
 *   "rfc":              string  (requerido) — RFC, ej "CEC2005286R4"
 *   "contactoTelefono": string  (opcional)
 *   "userCount":        number  (opcional) — usuarios que marcan (para el Deal)
 *   "cc":               string[] (opcional) — correos en copia del correo al cliente
 *   "items": [          (requerido, no vacío)
 *     {
 *       "tipo":              "plan" | "modulo" | "hardware" | "servicio",
 *       "id":                string,   // ej "plan_asistencia", "reloj_arriendo",
 *                                      //    "reloj_venta", "envio_reloj",
 *                                      //    "instalacion_reloj", "capacitacion_online"
 *       "nombre":            string,   // como se muestra al cliente
 *       "descripcion":       string?,  // opcional; si viene se muestra en el PDF
 *       "modalidad":         "Por usuario" | "Fijo" | "Arriendo mensual" | "Venta única" | "Cobro único",
 *       "cantidad":          number >= 1,
 *       "precioUnitarioMXN": number,   // MXN neto (los afectos suman IVA 16% aparte)
 *       "subtotalMXN":       number,   // MXN neto = precioUnitarioMXN * cantidad
 *       "esRecurrente":      boolean,  // true = se factura mes a mes
 *       "afectoIva":         boolean   // true = la línea lleva IVA 16%
 *     }
 *   ]
 * }
 *
 * Respuesta 200: { ok, quoteId, dealId, accountId, contactId, acceptanceUrl,
 *                  pdfUrl, pdfPendiente, expiresAt } — igual que CO, el PDF (y
 * el correo) se generan EN SEGUNDO PLANO (waitUntil): pdfUrl llega "" con
 * pdfPendiente=true y queda escrito en PDF_URL al terminar el render.
 *
 * ── CONVENCIONES ZOHO (mismas de COLOMBIA.md, con MXN donde CO pone COP) ───
 *   - Account: dedup por RFC en RUT_Empresa. Homónimos con RFC distinto se
 *     crean desambiguados como "Empresa (RFC)".
 *   - Subform Detalle_Items_Cotizacion: Precio_Unitario_UF / Subtotal_UF
 *     guardan el valor en MXN (convención "unidad de pricing del país") y
 *     Precio_Unitario_CLP / Subtotal_CLP el MISMO valor MXN. Afecto_IVA por
 *     línea tal cual viene del agente. Montos con centavos (2 decimales).
 *   - RUT_Cliente (cabecera) = RFC. Estado "Enviada". Version_PDF 1.
 *   - El token de aceptación se firma con pais:"mx" (como CO con "co"):
 *     session.js y los flujos posteriores lo usan para distinguir la
 *     cotización mexicana sin campos nuevos en Zoho (respaldo: Territorio del
 *     Deal = "México").
 *   - Deal: Monda_del_trato por env VICKY_MONEDA_MX, default "MXN". Amount =
 *     total de la cotización (netos + IVA 16% de las líneas afectas).
 */

const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { claveIdempotencia, getIdempotente, setIdempotente } = require("../_shared/idempotencia");
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


const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtmlMX, EJEC_MX } = require("../_shared/proposal-html-builder-mx");
const { IVA_RATE_MX } = require("../_shared/quote-pricing");
// Reuso del envío de correo vía Zoho send_mail del endpoint chileno (misma
// función que usa el cron backfill-pdf): una sola implementación.
const { sendQuoteEmailViaZoho } = require("./create-from-vicky");

// waitUntil: corre trabajo en segundo plano DESPUÉS de responder (mismo patrón
// que CL/CO). Fallback best-effort si el paquete no está disponible.
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch (_e) {
  waitUntil = (p) => {
    Promise.resolve(p).catch(() => {});
  };
}

// ── Tarifario MX (fuente de verdad del doc de tropicalización) ──
// El agente manda los items ya calculados; esta tabla queda acá como
// referencia canónica para tests de humo y validaciones futuras.
const TARIFAS_MX = {
  // Plan asistencia (recurrente, afecto IVA 16%).
  planFijoHasta10UsuariosMXN: 1000, // tarifa FIJA mensual 1-10 usuarios
  tramosPorUsuario: [
    { min: 11, max: 20, precioMXN: 83 },
    { min: 21, max: 30, precioMXN: 79 },
    { min: 31, max: 50, precioMXN: 75 },
  ],
  relojVentaMXN: 2100, // pago único
  relojArriendoMensualMXN: 350, // recurrente
  envioVentaPorPuntoMXN: 400, // pago único, NO descontable
  envioArriendoPorPuntoMXN: 0,
  instalacionCdmxMetroPorPuntoMXN: 700, // SOLO zona "cdmx_metro"; zona "resto"/auto-instalada: SIN ítem
  capacitacionOnlineMXN: 600, // pago único COBRADO, siempre presente
  iva: IVA_RATE_MX, // 0.16
  descuentoRecurrenteEscalera: [10, 15], // % — la negocia el agente
};

/**
 * Tarifa del plan de asistencia MX según usuarios (escalera del doc de
 * tropicalización). Devuelve null fuera de rango (>50: canal ejecutivo).
 *  - 1-10:  tarifa FIJA $1,000 MXN/mes (modalidad "Fijo").
 *  - 11-50: tarifa por usuario según tramo (modalidad "Por usuario").
 */
function tarifaPlanAsistenciaMX(usuarios) {
  const n = Math.floor(Number(usuarios) || 0);
  if (n < 1) return null;
  if (n <= 10) {
    return {
      modalidad: "Fijo",
      cantidad: n,
      precioUnitarioMXN: TARIFAS_MX.planFijoHasta10UsuariosMXN,
      subtotalMXN: TARIFAS_MX.planFijoHasta10UsuariosMXN,
    };
  }
  const tramo = TARIFAS_MX.tramosPorUsuario.find((t) => n >= t.min && n <= t.max);
  if (!tramo) return null;
  return {
    modalidad: "Por usuario",
    cantidad: n,
    precioUnitarioMXN: tramo.precioMXN,
    subtotalMXN: Math.round(tramo.precioMXN * n * 100) / 100,
  };
}

// Defaults MX (mismos nombres de env que CL/CO con sufijo _MX donde difieren).
const VICKY_MX_DEAL_STAGE = toText(process.env.VICKY_DEAL_STAGE_INICIAL) || "4. Propuesta Enviada / En Negociación";
const VICKY_MX_LEAD_SOURCE = toText(process.env.VICKY_LEAD_SOURCE) || "SEO";
const VICKY_MX_TERRITORIO = toText(process.env.VICKY_TERRITORIO_MX) || "México";
const VICKY_MX_MONEDA = toText(process.env.VICKY_MONEDA_MX) || "MXN";
const VICKY_MX_TOMBOLA = toText(process.env.VICKY_TOMBOLA) || "Mantener propietario";
const VICKY_MX_PRODUCTO = toText(process.env.VICKY_PRODUCTO_DEFAULT) || "Control de Asistencia";
const VICKY_MX_SECTOR = toText(process.env.VICKY_SECTOR_FALLBACK) || "19. Servicios";
const VICKY_MX_EXPANSION = toText(process.env.VICKY_EXPANSION_REGIONAL) || "No";
const VICKY_FROM_EMAIL = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";

// Owner MX: Yahel Segura (usuario activo verificado en el doc de
// tropicalización). Overrideable por env, como el owner CO.
const VICKY_MX_OWNER_ID = toText(process.env.VICKY_MX_OWNER_ID) || "3525045000308323003";
const OWNER_MX = { id: VICKY_MX_OWNER_ID };

// Documentos hosteados para el correo (los mismos genéricos del chileno; la
// certificación de la Dirección del Trabajo es SOLO Chile y NO se incluye).
const DOC_FICHA_RELOJ = "https://cotizacion.geovictoria.com/pdf/assets/ficha-reloj-senseface.pdf";
const DOC_PRESENTACION = "https://cotizacion.geovictoria.com/pdf/assets/presentacion-comercial.pdf";

// Cuentas internas que NUNCA deben reusarse al deduplicar por RFC (mismo
// riesgo real que en CL/CO).
const INTERNAL_ACCOUNT_NAMES = (process.env.VICKY_INTERNAL_ACCOUNT_NAMES || "GeoVictoria")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ── CORS (espejo de CL/CO) ──
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

// ── Variantes de RFC ──
// El RFC no lleva dígito verificador con guion (a diferencia del RUT/NIT), así
// que las variantes son el valor tal cual y el compacto en mayúsculas sin
// puntos/espacios/guiones (formatos con separadores tipo "CEC-200528-6R4"
// existen en registros manuales).
function getRfcVariants(rfc) {
  if (!rfc) return [];
  const raw = String(rfc).trim();
  if (!raw) return [];
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  return Array.from(new Set([raw, compact])).filter(Boolean);
}

// RFC bien formado: 3-4 letras (persona moral/física) + fecha AAMMDD + 3 de
// homoclave = 12-13 caracteres. Solo se ADVIERTE si no calza (no se rechaza:
// misma tolerancia que CO con el NIT — el dato manda el agente).
function rfcPareceValido(rfc) {
  const compact = String(rfc || "").replace(/[.\s-]/g, "").toUpperCase();
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(compact);
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
      console.warn(`[create-from-vicky-mx] coql error ${response.status}: ${text.slice(0, 150)}`);
      return [];
    }
    const parsed = JSON.parse(text);
    return parsed?.data || [];
  } catch (err) {
    console.warn(`[create-from-vicky-mx] coql excepción: ${err.message?.slice(0, 150)}`);
    return [];
  }
}

// Dedup de Account por RFC en RUT_Empresa (convención "documento tributario
// del país", la misma que CO usa para el NIT). Descarta cuentas internas; con
// RFC repetido en varias cuentas prefiere la que coincide en nombre.
async function findAccountIdByRfc(rfc, empresaName) {
  const variants = getRfcVariants(rfc);
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
      `[create-from-vicky-mx] dedup por RFC '${rfc}' solo matcheó cuenta(s) interna(s); se ignora.`,
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
// tratamiento que CL/CO, incluida la variante "multiple errors".
function isDuplicateDataError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("duplicate data") ||
    message.includes("duplicate_data") ||
    message.includes("multiple errors")
  );
}

// ── Mapeos al subform (mismos picklists de Zoho que CL/CO) ──
// "Único" en Zoho NO significa "pago único": es el reference_value del display
// "Fijo" (tarifa fija mensual — el plan MX de 1-10 usuarios). Los pagos únicos
// reales van a "Venta".
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

// ¿El item ya es la fila de capacitación? (por id o nombre).
function esItemCapacitacion(item) {
  return (
    /capacitaci/i.test(String(item?.id || "")) ||
    /capacitaci/i.test(String(item?.nombre || ""))
  );
}

/**
 * Garantiza la fila de "Capacitación online" ($600 MXN, pago único COBRADO).
 * Es el equivalente estructural de ensureActivacion en CO (fila que va SIEMPRE
 * en Zoho, PDF y página de aceptación), pero con la regla MX: la capacitación
 * SE COBRA — nada de "100 % de descuento". Si el agente ya la mandó (con otro
 * precio negociado, por ejemplo), se respeta la suya.
 * afectoIva=true: es un servicio gravado con IVA 16% como el resto en MX.
 */
function ensureCapacitacion(items) {
  if (items.some(esItemCapacitacion)) return items;
  return [
    ...items,
    {
      tipo: "servicio",
      id: "capacitacion_online",
      nombre: "Capacitación online",
      descripcion: "Capacitación online al equipo administrador en el uso de la plataforma.",
      modalidad: "Cobro único",
      cantidad: 1,
      precioUnitarioMXN: TARIFAS_MX.capacitacionOnlineMXN,
      subtotalMXN: TARIFAS_MX.capacitacionOnlineMXN,
      esRecurrente: false,
      afectoIva: true,
    },
  ];
}

// Redondeo MX: a centavos (2 decimales). Ver nota en computeTotalsMX
// (quote-pricing.js): el MXN usa centavos y el redondeo a peso entero de
// CL/CO descontaría el IVA exacto (ej: $1,540.48).
function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/**
 * Convierte los items del contrato MX al subform Detalle_Items_Cotizacion.
 * Convención espejo de COLOMBIA.md: los campos *_UF guardan el valor en MXN
 * ("unidad de pricing del país") y los *_CLP el MISMO valor MXN. Afecto_IVA
 * por línea tal cual viene del agente.
 */
function buildSubformItemsMX(items) {
  return items.map((item, index) => {
    const modalidadZoho = mapModalidadToZoho(item.modalidad);
    const tipo = String(item.tipo || "").toLowerCase();
    const precioUnitario = round2(item.precioUnitarioMXN);
    const subtotal = round2(item.subtotalMXN);
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
// prefijo "COT" (espejo de CL/CO).
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
  if (!Number.isFinite(Number(item.precioUnitarioMXN))) return `items[${index}].precioUnitarioMXN debe ser numérico`;
  if (!Number.isFinite(Number(item.subtotalMXN))) return `items[${index}].subtotalMXN debe ser numérico`;
  if (typeof item.esRecurrente !== "boolean") return `items[${index}].esRecurrente debe ser boolean`;
  if (typeof item.afectoIva !== "boolean") return `items[${index}].afectoIva debe ser boolean`;
  return null;
}

// ── Correo al cliente MX ──
// Espejo del diseño del correo chileno (tuteo cálido/comercial), adaptado:
//   - SIN regalos falsos: la capacitación se cobra, así que NO se promete
//     "capacitación incluida sin costo" en ninguna parte.
//   - SIN Certificación de la Dirección del Trabajo (documento SOLO Chile).
//   - Ejecutivo: Yahel Segura; el teléfono/WhatsApp se omite si no está
//     configurado (pendiente de confirmación).
function buildDocFila(href, label, nota) {
  const notaHtml = nota ? ` <span style="color:#a0aec0;font-size:12px;">${nota}</span>` : "";
  return `<tr><td style="padding:11px 16px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;">
    <a href="${href}" style="color:#1a73e8;text-decoration:none;font-size:14px;font-weight:600;">${label}</a>${notaHtml}
  </td></tr><tr><td style="height:8px;"></td></tr>`;
}

function buildEmailHtmlMX({ contacto, empresa, pdfUrl, tieneReloj }) {
  const primerNombre = String(contacto || "").trim().split(/\s+/)[0] || "";
  const saludo = primerNombre ? `Hola ${primerNombre} 👋` : "Hola 👋";
  const fichaFila = tieneReloj
    ? buildDocFila(DOC_FICHA_RELOJ, "🕐 Ficha Técnica del Reloj Checador", "(tu cotización lleva reloj)")
    : "";
  const contactoEjecutivo = EJEC_MX.telefono
    ? `✉️ <a href="mailto:${EJEC_MX.email}" style="color:#1a73e8;text-decoration:none;">${EJEC_MX.email}</a> &nbsp;·&nbsp; 📱 ${EJEC_MX.telefono}`
    : `✉️ <a href="mailto:${EJEC_MX.email}" style="color:#1a73e8;text-decoration:none;">${EJEC_MX.email}</a>`;
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
      <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">Preparé tu propuesta de Control de Asistencia. Ábrela en el PDF y, desde ahí mismo, puedes aceptarla en línea cuando quieras.</p>
    </td></tr>
    <tr><td align="center" style="padding:28px 32px 8px 32px;">
      <a href="${pdfUrl}" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:14px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">📄 Ver tu cotización (PDF)</a>
      <p style="margin:12px 0 0 0;font-size:12px;color:#a0aec0;">Dentro del PDF encuentras el botón para aceptarla en línea.</p>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 14px 0;font-size:15px;color:#1a202c;">Cómo seguimos 🚀</h3>
      <table role="presentation" width="100%">
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">1.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Abres el PDF y revisas tu cotización.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">2.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Desde el mismo PDF la aceptas en línea y coordinamos el pago inicial.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">3.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;">Iniciamos tu onboarding y activamos tu servicio en 24 horas hábiles.</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 12px 0;font-size:15px;color:#1a202c;">Documentos para ti 📎</h3>
      <table role="presentation" width="100%">
        ${fichaFila}
        ${buildDocFila(DOC_PRESENTACION, "📊 Presentación Comercial GeoVictoria", "")}
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 8px 0;font-size:15px;color:#1a202c;">Te presento a tu ejecutivo 🤝</h3>
      <p style="margin:0 0 16px 0;font-size:14px;color:#4a5568;line-height:1.6;">De aquí en adelante, <strong>${EJEC_MX.nombre}</strong> te acompaña en todo el proceso. Cualquier duda o ajuste que necesites, <strong>responde este correo</strong> — está para ayudarte. 😊</p>
      <table role="presentation" width="100%" style="background:#f7f9fc;border:1px solid #e2e8f0;border-radius:10px;"><tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px 0;font-size:14px;color:#1a202c;font-weight:600;">${EJEC_MX.nombre}</p>
        <p style="margin:0 0 8px 0;font-size:13px;color:#718096;">${EJEC_MX.cargo} · GeoVictoria</p>
        <p style="margin:0;font-size:13px;color:#718096;">${contactoEjecutivo}</p>
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

// ── Handler principal ──
module.exports = async function handler(req, res) {
  const corsAllowed = setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = corsAllowed ? 204 : 403; res.end(); return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Método no permitido" });
  }

  // Auth: secreto MX dedicado con fallback al secreto compartido de Vicky
  // (mismo esquema x-vicky-secret que CL/CO).
  const expectedSecret =
    toText(process.env.VICKY_COTIZADORA_SECRET_MX) || toText(process.env.VICKY_COTIZADORA_SECRET);
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
    const rfc = toText(body.rfc);
    const contactoTelefono = toText(body.contactoTelefono);
    const userCount = Number(body.userCount) > 0 ? Number(body.userCount) : undefined;

    // Validaciones del contrato
    if (!empresa || !contacto || !contactoEmail || !rfc) {
      return sendJson(res, 400, {
        ok: false,
        error: "Faltan campos: empresa, contacto, contactoEmail, rfc",
      });
    }
    if (!rfcPareceValido(rfc)) {
      // Solo advertencia (misma tolerancia que CO con el NIT): el flujo sigue.
      console.warn(`[create-from-vicky-mx] RFC con formato inusual: '${rfc}' (se acepta igual).`);
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
        `[create-from-vicky-mx] reintento idempotente: mismo body ya creó quote ${previoIdem.quoteId} / deal ${previoIdem.dealId || "-"} — no se duplica.`,
      );
      const expMsIdem = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
      const tokenIdem = signAcceptancePayload({
        quoteId: previoIdem.quoteId, dealId: previoIdem.dealId || "",
        pais: "mx",
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

    // La fila de Capacitación online (COBRADA) va SIEMPRE: en Zoho, en el PDF
    // y en la página de aceptación, así los tres muestran los mismos números.
    const items = ensureCapacitacion(body.items);
    // Total de la cotización: netos + IVA 16% de las líneas afectas.
    const totalMXN = round2(items.reduce((acc, it) => {
      const subtotal = Number(it.subtotalMXN || 0);
      return acc + subtotal + (it.afectoIva === true ? subtotal * IVA_RATE_MX : 0);
    }, 0));

    // Principio (16-jul, igual que CL/CO): LA COTIZACIÓN SIEMPRE SE ENTREGA.
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

    // ── Account: dedup por RFC antes de crear ──
    stage = "find_account_by_rfc";
    accountId = await findAccountIdByRfc(rfc, empresa);
    accountReused = Boolean(accountId);

    if (!accountId) {
      stage = "create_account";
      const createAccountPayload = {
        Account_Name: empresa,
        RUT_Empresa: rfc,
        Phone: contactoTelefono || undefined,
        Description: `Cuenta creada por Vicky MX (WhatsApp). RFC: ${rfc}`,
        Industry: VICKY_MX_SECTOR,
        Territorio: VICKY_MX_TERRITORIO,
        N_Empleados_dependientes: userCount,
        Tiene_potencial_de_expansi_n_Regional: VICKY_MX_EXPANSION,
        Owner: OWNER_MX,
      };
      try {
        const accountResult = await createRecord("Accounts", createAccountPayload, true);
        accountId = toText(accountResult?.id);
        if (!accountId) throw new Error("No se obtuvo accountId");
      } catch (createError) {
        if (!isDuplicateDataError(createError)) throw createError;
        // Duplicado: puede ser por RFC (carrera con la búsqueda previa) o por
        // NOMBRE homónimo con RFC distinto. Re-buscamos por RFC y, si no hay
        // match, creamos la cuenta desambiguada "Empresa (RFC)" (regla CL/CO).
        stage = "dedupe_account_by_rfc";
        const existingAccountId = await findAccountIdByRfc(rfc, empresa);
        if (existingAccountId) {
          accountId = existingAccountId;
          accountReused = true;
        } else {
          console.warn(
            `[create-from-vicky-mx] duplicado por nombre con RFC distinto (${rfc}); creando cuenta desambiguada.`,
          );
          stage = "create_account_disambiguated";
          const nombreDesambiguado = `${empresa} (${rfc})`;
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
            // Capa 4: reusar SOLO si el RFC coincide; si no, seguir sin cuenta.
            stage = "reuse_account_capa4";
            const compactar = (v) => String(v || "").replace(/[.\s-]/g, "").toUpperCase();
            const porNombre = await executeCoqlQuery(
              `select id, RUT_Empresa from Accounts where Account_Name = '${nombreDesambiguado.replace(/'/g, "''")}' limit 5`,
            ).catch(() => []);
            const matchRfc = (porNombre || []).find((r) => compactar(r.RUT_Empresa) === compactar(rfc));
            if (matchRfc) {
              accountId = toText(matchRfc.id);
              accountReused = true;
            } else {
              accountId = undefined;
              console.error(`[create-from-vicky-mx] Capa 4: sin salida de dedupe (RFC=${rfc}); cotización SIN cuenta.`);
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
        Lead_Source: VICKY_MX_LEAD_SOURCE,
        Territorio: VICKY_MX_TERRITORIO,
        Owner: OWNER_MX,
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

    // ── Deal (Territorio México + obligatorios del layout, ver Chile) ──
    stage = "create_deal";
    if (!dealId) {
    const dealResult = await createRecord("Deals", {
      Deal_Name: `${empresa} - Cotización Vicky`,
      ...(accountId ? { Account_Name: { id: accountId } } : {}),
      ...(contactId ? { Contact_Name: { id: contactId } } : {}),
      Stage: VICKY_MX_DEAL_STAGE,
      Pipeline: "Standard (Standard)",
      Lead_Source: VICKY_MX_LEAD_SOURCE,
      Amount: totalMXN || undefined,
      Description: `Deal creado por Vicky MX para cotización WhatsApp.\nUsuarios: ${userCount || "-"}\nTotal: ${totalMXN} MXN`,
      // Obligatorios del layout de Deals del org (mismo set que CL/CO: sin
      // ellos el create devuelve MANDATORY_NOT_FOUND).
      Territorio: VICKY_MX_TERRITORIO,
      Tombola: VICKY_MX_TOMBOLA,
      Monda_del_trato: VICKY_MX_MONEDA,
      Sector: VICKY_MX_SECTOR,
      N_Empleados_que_marcan: userCount,
      Tipo_de_Cobro: (Number(userCount) || 1) <= 10 ? "Mensual fijo" : "Por usuario",
      Producto_Soluci_n: VICKY_MX_PRODUCTO,
      Owner: OWNER_MX,
    }, true);
    dealId = toText(dealResult?.id);
    if (!dealId) throw new Error("No se obtuvo dealId");
    }
    } catch (plumbingError) {
      if (String(process.env.CRM_STRICT || "") === "1") throw plumbingError;
      crmIncompleto = true;
      console.error(
        `[create-from-vicky-mx] CRM DEGRADADO en stage=${stage}: ${toText(plumbingError?.message || plumbingError).slice(0, 300)}. ` +
          `La cotización continúa (accountId=${accountId || "∅"}, contactId=${contactId || "∅"}, dealId=${dealId || "∅"}).`,
      );
    }
    if (!accountId || !dealId) crmIncompleto = true;

    // ── Cotización con subform (convención MXN en campos UF/CLP) ──
    stage = "create_quote";
    const subformItems = buildSubformItemsMX(items);
    const quoteResult = await createRecord(config.quoteModule, {
      Name: `Cotización ${empresa} - ${new Date().toISOString().slice(0, 10)}`,
      Owner: OWNER_MX,
      ...(dealId ? { [config.quoteDealLookupField]: { id: dealId } } : {}),
      ...(contactId ? { [config.quoteContactLookupField]: { id: contactId } } : {}),
      ...(accountId ? { Cuenta_Asociada: { id: accountId } } : {}),
      CRM_Incompleto: crmIncompleto,
      [config.quoteDateField]: new Date().toISOString().slice(0, 10),
      [config.quoteStatusField]: "Borrador",
      [config.contactEmailField]: contactoEmail,
      [config.contactPhoneField]: contactoTelefono || undefined,
      [config.companyRutField]: rfc,
      [config.quoteItemsSubformField]: subformItems,
      [config.quoteVersionPdfField]: 1,
    }, true);
    const quoteId = toText(quoteResult?.id);
    if (!quoteId) throw new Error("No se obtuvo quoteId");
    // Marcador de idempotencia APENAS existen los registros: si el resto del
    // flujo muere, el reintento devuelve estos ids en vez de duplicar.
    await setIdempotente(idemClave, { quoteId, dealId, accountId, contactId });

    // ── acceptanceUrl (token firmado con pais:"mx" — así session.js y los
    // flujos posteriores marcan la sesión como México, igual que CO con "co") ──
    stage = "build_acceptance_url";
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const token = signAcceptancePayload({
      quoteId, dealId,
      pais: "mx",
      iat: Date.now(), exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

    // Alerta interna best-effort si la entrega fue en modo degradado (sin
    // Cuenta/Deal). El cliente jamás ve nada de esto.
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

    // ── PDF + correo en segundo plano (no bloquea la respuesta al agente) ──
    waitUntil(
      (async () => {
        const numeroCotizacion = await getRecordWithFields(config.quoteModule, quoteId, ["Numero_Cotizacion"])
          .then((r) => toText(r?.Numero_Cotizacion))
          .catch(() => "");
        const html = buildProposalHtmlMX({
          cliente: { empresa, contacto, rfc },
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
        const tieneReloj = items.some((it) => it && String(it.tipo || "").toLowerCase() === "hardware");
        await sendQuoteEmailViaZoho({
          quoteModule: config.quoteModule,
          quoteId,
          fromEmail: VICKY_FROM_EMAIL,
          replyToEmail: EJEC_MX.email,
          ccEmail: EJEC_MX.email,
          // Copias fijas: Lalo (31-jul) + Rodrigo (03-ago) + las del body.
          ccEmails: [
            ...(process.env.QUOTE_EMAIL_CC_FIJO || "egomez@geovictoria.com,rlewit@geovictoria.com")
              .split(",")
              .map((s) => s.trim()),
            ...(Array.isArray(body.cc) ? body.cc : []),
          ].filter(Boolean),
          toEmail: contactoEmail,
          toName: contacto,
          subject: `Tu cotización GeoVictoria — ${empresa}`,
          htmlBody: buildEmailHtmlMX({
            contacto,
            empresa,
            pdfUrl,
            tieneReloj,
          }),
        });
      })().catch((bgErr) =>
        console.error(
          "[create-from-vicky-mx] PDF/correo en segundo plano falló:",
          bgErr?.message || bgErr,
        ),
      ),
    );
    return;

  } catch (error) {
    console.error(`[create-from-vicky-mx] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: `Falla en stage='${stage}'`,
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};

// Se exponen para tests/reuso (misma convención que CL/CO).
module.exports.buildSubformItemsMX = buildSubformItemsMX;
module.exports.ensureCapacitacion = ensureCapacitacion;
module.exports.buildEmailHtmlMX = buildEmailHtmlMX;
module.exports.TARIFAS_MX = TARIFAS_MX;
module.exports.tarifaPlanAsistenciaMX = tarifaPlanAsistenciaMX;
