/**
 * Idempotencia de create-from-vicky (caso Inversiones Automatic, 04-ago):
 * el tool del agente reintenta hasta 3 veces con el MISMO body cuando la
 * respuesta falla — pero si el intento 1 murió DESPUÉS de crear el deal y la
 * cotización (p. ej. en el update a "Enviada"), el intento 2 creaba TODO de
 * nuevo: dos deals con 9 segundos de diferencia para la misma empresa.
 *
 * Mecánica: el body es constante entre reintentos (por diseño del tool), así
 * que su hash sirve de llave. Apenas existen los IDs creados se guardan en
 * vic_kv; un reintento con la misma llave recibe ESOS ids en vez de crear.
 * TTL 30 minutos (el mismo cuerpo días después es legítimamente otra venta).
 * Best-effort: sin Supabase configurado, el flujo sigue como siempre.
 */

const crypto = require("crypto");

const VENTANA_MS = 30 * 60 * 1000;

// OJO: vic_kv NO vive en el Supabase de los PDF — ver api/_shared/kv-supabase.js.
// Estos candados son CRUZADOS con el agente (él escribe la reserva del deal,
// nosotros la leemos antes de crear): tienen que mirar SU base, no la nuestra.
const { kvSupabase } = require("./kv-supabase");

function supaEnv() {
  const c = kvSupabase();
  return c ? { url: c.url, key: c.key } : null;
}

function claveIdempotencia(body) {
  return (
    "cfv_" +
    crypto.createHash("sha256").update(JSON.stringify(body || {})).digest("hex").slice(0, 40)
  );
}

async function getIdempotente(clave) {
  const env = supaEnv();
  if (!env) return null;
  try {
    const r = await fetch(
      `${env.url}/rest/v1/vic_kv?key=eq.${encodeURIComponent(clave)}&select=value&limit=1`,
      {
        headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
        cache: "no-store",
      },
    );
    if (!r.ok) return null;
    const filas = await r.json().catch(() => []);
    const valor = filas && filas[0] && filas[0].value;
    if (!valor) return null;
    const parsed = JSON.parse(valor);
    if (!parsed || !parsed.at || Date.now() - new Date(parsed.at).getTime() > VENTANA_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function setIdempotente(clave, ids) {
  const env = supaEnv();
  if (!env) return;
  try {
    await fetch(`${env.url}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        key: clave,
        value: JSON.stringify({ at: new Date().toISOString(), ...ids }),
      }),
      cache: "no-store",
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Candado CRUZADO hito↔cotización (fix duplicados 04-ago: Lotus Pet y cía).
 * Misma llave que usa el agente (lib/crm-hitos.ts): vic_kv `deal_fono_<fono>`.
 * Las dos puertas que crean deals (crm-hitos por hito de conversación y este
 * cotizador por emisión) escriben la llave APENAS su deal existe y la
 * consultan ANTES de crear: la que llega segunda reusa el deal de la primera
 * en vez de duplicarlo. El índice de búsqueda de Zoho no ve registros de hace
 * segundos — este candado sí. TTL 6 h.
 */
const DEAL_FONO_TTL_MS = 6 * 60 * 60 * 1000;

function claveDealFono(fono) {
  return `deal_fono_${String(fono || "").replace(/\D/g, "")}`;
}

async function getDealPorFono(fono) {
  const env = supaEnv();
  const clave = claveDealFono(fono);
  if (!env || clave === "deal_fono_") return null;
  try {
    const r = await fetch(
      `${env.url}/rest/v1/vic_kv?key=eq.${encodeURIComponent(clave)}&select=value&limit=1`,
      {
        headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
        cache: "no-store",
      },
    );
    if (!r.ok) return null;
    const filas = await r.json().catch(() => []);
    const valor = filas && filas[0] && filas[0].value;
    if (!valor) return null;
    const parsed = JSON.parse(valor);
    if (!parsed || !parsed.at) return null;
    if (Date.now() - new Date(parsed.at).getTime() > DEAL_FONO_TTL_MS) return null;
    // Marca "creando" (candado anti-carrera 25-ago, gemelos Quilodrán): la
    // otra puerta está pariendo el deal AHORA — esperar su id real un rato.
    if (!parsed.dealId && parsed.creando) {
      if (Date.now() - new Date(parsed.at).getTime() > 120000) return null; // reserva vencida
      for (let i = 0; i < 3; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        const r2 = await fetch(
          `${env.url}/rest/v1/vic_kv?key=eq.${encodeURIComponent(clave)}&select=value&limit=1`,
          { headers: { apikey: env.key, Authorization: `Bearer ${env.key}` }, cache: "no-store" },
        ).catch(() => null);
        const f2 = r2 && r2.ok ? await r2.json().catch(() => []) : [];
        const v2 = f2 && f2[0] && f2[0].value ? JSON.parse(f2[0].value) : null;
        if (v2 && v2.dealId) return { dealId: String(v2.dealId), origen: String(v2.origen || "") };
      }
      return null;
    }
    if (!parsed.dealId) return null;
    return { dealId: String(parsed.dealId), origen: String(parsed.origen || "") };
  } catch {
    return null;
  }
}

/** Reserva la creación del deal del fono (marca "creando") ANTES de crear.
 * Devuelve {ok:true} si la reserva es nuestra; {ok:false} si otra puerta ya
 * tiene deal o reserva vigente (el caller debe re-consultar y REUSAR). */
async function reservarDealPorFono(fono, origen) {
  const env = supaEnv();
  const clave = claveDealFono(fono);
  if (!env || clave === "deal_fono_") return { ok: true };
  try {
    const r = await fetch(
      `${env.url}/rest/v1/vic_kv?key=eq.${encodeURIComponent(clave)}&select=value&limit=1`,
      { headers: { apikey: env.key, Authorization: `Bearer ${env.key}` }, cache: "no-store" },
    );
    const filas = r.ok ? await r.json().catch(() => []) : [];
    const valor = filas && filas[0] && filas[0].value ? JSON.parse(filas[0].value) : null;
    if (valor && valor.at && Date.now() - new Date(valor.at).getTime() < DEAL_FONO_TTL_MS) {
      if (valor.dealId) return { ok: false, dealId: String(valor.dealId), origen: String(valor.origen || "") };
      if (valor.creando && Date.now() - new Date(valor.at).getTime() < 120000) return { ok: false };
    }
    await fetch(`${env.url}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ key: clave, value: JSON.stringify({ at: new Date().toISOString(), creando: true, origen }) }),
    });
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

async function setDealPorFono(fono, dealId, origen) {
  const env = supaEnv();
  const clave = claveDealFono(fono);
  if (!env || clave === "deal_fono_" || !dealId) return;
  try {
    await fetch(`${env.url}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        key: clave,
        value: JSON.stringify({ at: new Date().toISOString(), dealId: String(dealId), origen: String(origen || "cotizacion") }),
      }),
      cache: "no-store",
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Candado de LEADS del agente (lib/zoho-leads.ts): vic_kv `zoho_lead_<fono>`
 * guarda el id del lead que Vicky creó para ese teléfono (o "creando:<ts>"
 * mientras está en vuelo). Leerlo acá permite que la emisión ADOPTE ese lead
 * y lo convierta, en vez de crear el deal directo dejando el lead huérfano.
 */
async function getLeadCandadoPorFono(fono) {
  const env = supaEnv();
  const digits = String(fono || "").replace(/\D/g, "");
  if (!env || !digits) return "";
  try {
    const r = await fetch(
      `${env.url}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`zoho_lead_${digits}`)}&select=value&limit=1`,
      {
        headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
        cache: "no-store",
      },
    );
    if (!r.ok) return "";
    const filas = await r.json().catch(() => []);
    const valor = String((filas && filas[0] && filas[0].value) || "").trim();
    return /^\d{5,}$/.test(valor) ? valor : "";
  } catch {
    return "";
  }
}

/** Lee un flag simple de vic_kv (para encender/apagar features al instante,
 * sin redeploy). Devuelve el string crudo del value, o "" si no existe. */
async function getKvFlag(key) {
  const env = supaEnv();
  if (!env || !key) return "";
  try {
    const r = await fetch(
      `${env.url}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=value&limit=1`,
      { headers: { apikey: env.key, Authorization: `Bearer ${env.key}` }, cache: "no-store" },
    );
    if (!r.ok) return "";
    const filas = await r.json().catch(() => []);
    return String((filas && filas[0] && filas[0].value) || "").trim();
  } catch {
    return "";
  }
}

module.exports = { claveIdempotencia, getIdempotente, setIdempotente, getDealPorFono, setDealPorFono, reservarDealPorFono, getLeadCandadoPorFono, getKvFlag };
