/**
 * FIRMANTE del PDF y del correo de cotización — UNA regla para los 4 países
 * (29-sep, tarea "firmante desde la ficha operativa"; retira el mapa estático
 * de ejecutivo-cl.js y los nombres fijos de PE/CO/MX).
 *
 * Regla (Rodrigo 27-jul + Lalo 06-ago, hoy global): el documento firma con el
 * DUEÑO HUMANO del trato (primero) o de la cotización (después). Mientras el
 * trato ESPERA con el usuario Vicky —así nacen hoy en los cuatro países— no hay
 * humano que mostrar y firma "Vicky — Equipo Comercial".
 *
 * Fuentes, en orden:
 *   1. FICHA OPERATIVA del agente (`vic-roster-tlmk`, telemarketing + SDR +
 *      venta autónoma de CL/PE/CO/MX, con teléfono): es la fuente única del
 *      equipo, la misma que usan traspasos, espejos y el correo de PAGADA.
 *   2. Ficha de usuario en Zoho (/crm/v3/users/{id}) para un dueño que no está
 *      en la ficha (KAM, ejecutivo nuevo). Cuentas robot nunca firman.
 *   3. FIRMA_VICKY.
 * Best-effort: cualquier error de red cae a la firma de Vicky, nunca rompe la
 * emisión.
 */
const toText = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

const FIRMA_VICKY = Object.freeze({
  nombre: "Vicky — Equipo Comercial",
  cargo: "Asistente Comercial",
  email: "vicky@geovictoria.com",
  telefono: "",
  whatsapp: "",
  esVicky: true,
});

/** Línea de WhatsApp de Vicky por país: el teléfono que muestra la firma de Vicky en el PDF. */
const LINEA_VICKY = { cl: "+56 9 6730 8227", pe: "+51 922 067 167", co: "+57 318 107 0737", mx: "+52 1 56 5977 8486" };

const ROBOTS = /vicky@|info@geovictoria|productmanager@/i;

// ── Roster remoto (ficha operativa del agente) ──────────────────────────────
let rosterRemotoCache = { at: 0, data: null };
let rosterEnVuelo = null;
async function rosterRemoto() {
  if (Date.now() - rosterRemotoCache.at < 10 * 60 * 1000 && rosterRemotoCache.data) return rosterRemotoCache.data;
  if (rosterEnVuelo) return rosterEnVuelo;
  const base = toText(process.env.VICKY_AGENT_NOTIFY_URL);
  const secret = toText(process.env.VICKY_AGENT_CRON_SECRET);
  if (!base || !secret) return null;
  rosterEnVuelo = (async () => {
    try {
      const origin = new URL(base).origin;
      const r = await fetch(`${origin}/api/vic-roster-tlmk`, { headers: { "x-cron-secret": secret }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (!j?.ok || !Array.isArray(j.telemarketing)) return null;
      rosterRemotoCache = { at: Date.now(), data: j };
      return j;
    } catch (_e) {
      return null;
    } finally {
      rosterEnVuelo = null;
    }
  })();
  return rosterEnVuelo;
}

/** Todas las personas del roster (equipo plano si el agente lo manda; si no, se arma desde `paises`). */
function personasDe(roster) {
  if (!roster) return [];
  if (Array.isArray(roster.equipo) && roster.equipo.length) return roster.equipo;
  const out = [];
  for (const [pais, eq] of Object.entries(roster.paises || {})) {
    for (const p of eq?.telemarketing || []) out.push({ ...p, pais, rol: "telemarketing" });
    for (const p of eq?.sdr || []) out.push({ ...p, pais, rol: "sdr" });
    if (eq?.ventaAutonoma) out.push({ ...eq.ventaAutonoma, pais, rol: "venta_autonoma" });
  }
  return out;
}

function fichaDesdePersona(p) {
  const telefono = toText(p?.telefono);
  return {
    nombre: toText(p?.nombre) || toText(p?.email).split("@")[0],
    cargo: "Ejecutivo Comercial",
    email: toText(p?.email).toLowerCase(),
    telefono,
    whatsapp: telefono.replace(/\D/g, ""),
    esVicky: false,
    pais: toText(p?.pais),
  };
}

// Cache en memoria del proceso por id de Zoho (la próxima resolución no va a la red).
const FIRMAS_POR_ID = new Map();

/** Firma de un dueño ya resuelto en este proceso (o en el roster cacheado); si no, Vicky. Síncrona. */
function firmantePorOwner(ownerId) {
  const id = toText(ownerId);
  if (!id) return FIRMA_VICKY;
  const enCache = FIRMAS_POR_ID.get(id);
  if (enCache) return enCache;
  const p = personasDe(rosterRemotoCache.data).find((x) => toText(x.zohoId) === id);
  if (p) {
    const f = fichaDesdePersona(p);
    FIRMAS_POR_ID.set(id, f);
    return f;
  }
  // Calienta el roster para la próxima (best-effort, sin esperar).
  rosterRemoto().catch(() => {});
  return FIRMA_VICKY;
}

/**
 * @param {string|string[]} ownerIds ids de dueño en orden de preferencia (deal, cotización)
 * @param {{roster?: object, buscarZoho?: (id:string)=>Promise<object|null>}} [opts] inyección para tests
 */
async function resolverFirmante(ownerIds, opts = {}) {
  const ids = (Array.isArray(ownerIds) ? ownerIds : [ownerIds]).map(toText).filter(Boolean);
  if (!ids.length) return FIRMA_VICKY;
  for (const id of ids) {
    const enCache = FIRMAS_POR_ID.get(id);
    if (enCache) return enCache;
  }
  const roster = opts.roster !== undefined ? opts.roster : await rosterRemoto();
  const personas = personasDe(roster);
  for (const id of ids) {
    const p = personas.find((x) => toText(x.zohoId) === id);
    if (p) {
      const f = fichaDesdePersona(p);
      FIRMAS_POR_ID.set(id, f);
      return f;
    }
  }
  const buscarZoho = opts.buscarZoho || usuarioZoho;
  for (const id of ids) {
    try {
      const u = await buscarZoho(id);
      const nombre = toText(u?.full_name || u?.name);
      const email = toText(u?.email).toLowerCase();
      if (!nombre || !email || ROBOTS.test(email)) continue;
      const telefono = toText(u?.phone || u?.mobile);
      const f = { nombre, cargo: "Ejecutivo Comercial", email, telefono, whatsapp: telefono.replace(/\D/g, ""), esVicky: false, pais: "" };
      FIRMAS_POR_ID.set(id, f);
      return f;
    } catch (_e) {
      /* best-effort */
    }
  }
  return FIRMA_VICKY;
}

async function usuarioZoho(id) {
  const { zohoApiFetch } = require("./zoho-auth");
  const r = await zohoApiFetch(`/crm/v3/users/${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  return ((await r.json().catch(() => ({})))?.users || [])[0] || null;
}

/** Dueño del trato primero, de la cotización después (la aceptación presenta al dueño del DEAL). */
async function firmanteDeCotizacion(quote, config) {
  const dealId = toText(quote?.[config?.quoteDealLookupField]?.id || quote?.Deal_Asociado?.id);
  return firmanteDeDeal(dealId, toText(quote?.Owner?.id));
}

async function firmanteDeDeal(dealId, ownerCotizacionId) {
  let ownerDealId = "";
  if (toText(dealId)) {
    try {
      const { getRecordWithFields } = require("./zoho-crm");
      const d = await getRecordWithFields("Deals", toText(dealId), ["Owner"]);
      ownerDealId = toText(d?.Owner?.id);
    } catch (_e) {
      /* best-effort */
    }
  }
  return resolverFirmante([ownerDealId, toText(ownerCotizacionId)]);
}

/** Lo que recibe buildEmailHtml: con Vicky va vacío ("Sigo aquí contigo"), con humano su ficha. */
function ejecutivoParaCorreo(firma) {
  if (!firma || firma.esVicky) return undefined;
  return { nombre: firma.nombre, cargo: firma.cargo, email: firma.email, telefono: firma.telefono };
}

/** Firma para el pie del PDF de un país: humano tal cual; Vicky con la línea de WhatsApp del país. */
function firmaParaPdf(firma, pais) {
  const p = toText(pais).toLowerCase() || "cl";
  if (!firma || firma.esVicky) return { ...FIRMA_VICKY, telefono: LINEA_VICKY[p] || "" };
  return firma;
}

function _resetParaTests() {
  FIRMAS_POR_ID.clear();
  rosterRemotoCache = { at: 0, data: null };
}

module.exports = {
  FIRMA_VICKY,
  LINEA_VICKY,
  rosterRemoto,
  personasDe,
  firmantePorOwner,
  resolverFirmante,
  firmanteDeCotizacion,
  firmanteDeDeal,
  ejecutivoParaCorreo,
  firmaParaPdf,
  _resetParaTests,
};
