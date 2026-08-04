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

function supaEnv() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return url && key ? { url, key } : null;
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
    if (!parsed || !parsed.dealId || !parsed.at) return null;
    if (Date.now() - new Date(parsed.at).getTime() > DEAL_FONO_TTL_MS) return null;
    return { dealId: String(parsed.dealId), origen: String(parsed.origen || "") };
  } catch {
    return null;
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

module.exports = { claveIdempotencia, getIdempotente, setIdempotente, getDealPorFono, setDealPorFono };
