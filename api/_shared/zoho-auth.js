const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

const tokenState = {
  accessToken: "",
  expiresAtMs: 0,
  refreshingPromise: null,
};

function toNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(url, fallback) {
  const raw = toNonEmptyString(url) || fallback;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function getZohoConfig() {
  const clientId = toNonEmptyString(process.env.ZOHO_CLIENT_ID);
  const clientSecret = toNonEmptyString(process.env.ZOHO_CLIENT_SECRET);
  const refreshToken = toNonEmptyString(process.env.ZOHO_REFRESH_TOKEN);
  const accountsDomain = normalizeUrl(process.env.ZOHO_ACCOUNTS_DOMAIN, "https://accounts.zoho.com");
  const apiDomain = normalizeUrl(process.env.ZOHO_API_DOMAIN, "https://www.zohoapis.com");

  const missing = [];
  if (!clientId) missing.push("ZOHO_CLIENT_ID");
  if (!clientSecret) missing.push("ZOHO_CLIENT_SECRET");
  if (!refreshToken) missing.push("ZOHO_REFRESH_TOKEN");
  if (!accountsDomain) missing.push("ZOHO_ACCOUNTS_DOMAIN");
  if (!apiDomain) missing.push("ZOHO_API_DOMAIN");

  return {
    clientId,
    clientSecret,
    refreshToken,
    accountsDomain,
    apiDomain,
    missing,
  };
}

function getTokenMeta() {
  return {
    hasToken: Boolean(tokenState.accessToken),
    expiresAtMs: tokenState.expiresAtMs || 0,
    expiresAtIso: tokenState.expiresAtMs ? new Date(tokenState.expiresAtMs).toISOString() : null,
  };
}

function canReuseToken() {
  if (!tokenState.accessToken) return false;
  return Date.now() + TOKEN_SAFETY_MARGIN_MS < tokenState.expiresAtMs;
}

// ── TOKEN COMPARTIDO ENTRE INSTANCIAS (04-sep) ─────────────────────────────
//
// Estas funciones no son un servidor encendido: cada invocación "en frío"
// arranca sin memoria y pedía SU PROPIA credencial. Zoho tiene dos límites muy
// distintos: el de llamadas de datos al día (enorme, usamos ~2%) y el de
// RENOVACIONES de la credencial (chico, de ventana corta, y solo mantiene ~10
// credenciales vivas por refresh token — al pedir la número once bota la
// primera). Con la página de aceptación de un cliente, el cron de correos y
// una emisión despertando a la vez bastaban cinco o seis renovaciones en un
// minuto para que Zoho respondiera "Access Denied" — las tormentas del 01-sep
// y del 03-sep, con clientes viendo error al abrir su cotización.
//
// El agente resolvió esto en julio guardando UNA credencial compartida; el
// cotizador nunca recibió ese cambio y por eso TODOS los errores de token de
// anoche salieron de acá. Esto porta el mismo mecanismo.
//
// Degrada solo: si Supabase no responde o la tabla no existe, se comporta
// exactamente como antes (credencial en memoria). Nunca puede dejar sin token
// a una petición de cliente.

const KV_TOKEN = "zoho_access_token_cotizador";
const KV_LOCK = "zoho_token_lock_cotizador";

function supaConfig() {
  const url = toNonEmptyString(process.env.SUPABASE_URL).replace(/\/$/, "");
  const key = toNonEmptyString(process.env.SUPABASE_SERVICE_ROLE_KEY);
  return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } } : null;
}

/** Credencial compartida vigente, o null. */
async function leerTokenCompartido() {
  const c = supaConfig();
  if (!c) return null;
  try {
    const r = await fetch(
      `${c.url}/rest/v1/vic_kv?key=eq.${KV_TOKEN}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=value,expires_at&limit=1`,
      { headers: c.headers },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.value) return null;
    const expiresAtMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAtMs)) return null;
    return { accessToken: String(row.value), expiresAtMs };
  } catch (_e) {
    return null;
  }
}

async function guardarTokenCompartido(accessToken, expiresAtMs) {
  const c = supaConfig();
  if (!c) return;
  try {
    // Se guarda con un margen: la credencial dura una hora y la damos por
    // vencida cinco minutos antes, para que nadie use una a punto de morir.
    const expira = new Date(expiresAtMs - 5 * 60 * 1000).toISOString();
    await fetch(`${c.url}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key: KV_TOKEN, value: accessToken, expires_at: expira }),
    });
  } catch (_e) {
    /* best-effort: si no se puede compartir, igual sirve en memoria */
  }
}

/** Candado de renovación: gana quien logra INSERTAR (la unicidad arbitra). */
async function tomarCandado() {
  const c = supaConfig();
  if (!c) return false;
  try {
    const r = await fetch(`${c.url}/rest/v1/vic_kv`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        key: KV_LOCK,
        value: new Date().toISOString(),
        // 40 s: más que una renovación normal, menos que un tick de cron.
        expires_at: new Date(Date.now() + 40 * 1000).toISOString(),
      }),
    });
    return r.status === 201;
  } catch (_e) {
    return false;
  }
}

async function soltarCandado() {
  const c = supaConfig();
  if (!c) return;
  try {
    await fetch(`${c.url}/rest/v1/vic_kv?key=eq.${KV_LOCK}`, { method: "DELETE", headers: c.headers });
  } catch (_e) {
    /* vence solo por expires_at */
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchNewAccessToken() {
  const config = getZohoConfig();
  if (config.missing.length > 0) {
    throw new Error(`Missing Zoho env vars: ${config.missing.join(", ")}`);
  }

  const url = `${config.accountsDomain}/oauth/v2/token`;
  const body = new URLSearchParams({
    refresh_token: config.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    payload = { raw: text };
  }

  if (!response.ok || !payload.access_token) {
    const reason = payload.error || payload.error_description || payload.raw || `HTTP ${response.status}`;
    throw new Error(`Zoho token refresh failed: ${reason}`);
  }

  const expiresInSec = Number(payload.expires_in || payload.expires_in_sec || 3600);
  const ttlSec = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 3600;

  tokenState.accessToken = String(payload.access_token);
  tokenState.expiresAtMs = Date.now() + ttlSec * 1000;
  await guardarTokenCompartido(tokenState.accessToken, tokenState.expiresAtMs);
  return tokenState.accessToken;
}

/**
 * Orden de búsqueda: memoria de ESTA instancia → credencial COMPARTIDA →
 * renovar (con candado). Así una invocación en frío reusa lo que otra ya pidió
 * en vez de pedir la suya, que es lo que agotaba el límite de renovaciones.
 */
async function obtenerTokenConCompartido() {
  const compartido = await leerTokenCompartido();
  if (compartido && Date.now() + TOKEN_SAFETY_MARGIN_MS < compartido.expiresAtMs) {
    tokenState.accessToken = compartido.accessToken;
    tokenState.expiresAtMs = compartido.expiresAtMs;
    return compartido.accessToken;
  }

  // Solo UNA instancia renueva; las demás esperan y leen lo que dejó. Sin
  // esto, diez funciones que despiertan juntas piden diez credenciales y
  // Zoho corta — exactamente lo que pasó el 01 y el 03 de septiembre.
  const miTurno = await tomarCandado();
  if (!miTurno) {
    for (let i = 0; i < 6; i++) {
      await dormir(700);
      const ajeno = await leerTokenCompartido();
      if (ajeno && Date.now() + TOKEN_SAFETY_MARGIN_MS < ajeno.expiresAtMs) {
        tokenState.accessToken = ajeno.accessToken;
        tokenState.expiresAtMs = ajeno.expiresAtMs;
        return ajeno.accessToken;
      }
    }
    // El otro no alcanzó a dejarla: se renueva igual antes que dejar sin
    // respuesta a un cliente. Fail-open, siempre.
  }

  try {
    return await fetchNewAccessToken();
  } finally {
    if (miTurno) await soltarCandado();
  }
}

async function getZohoAccessToken(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  if (!forceRefresh && canReuseToken()) {
    return tokenState.accessToken;
  }

  if (!forceRefresh && tokenState.refreshingPromise) {
    return tokenState.refreshingPromise;
  }

  // forceRefresh (un 401 con la credencial en mano) NO pasa por el
  // compartido: esa credencial ya se probó y no sirve.
  tokenState.refreshingPromise = (forceRefresh ? fetchNewAccessToken() : obtenerTokenConCompartido())
    .catch((error) => {
      tokenState.accessToken = "";
      tokenState.expiresAtMs = 0;
      throw error;
    })
    .finally(() => {
      tokenState.refreshingPromise = null;
    });

  return tokenState.refreshingPromise;
}

async function zohoApiFetch(path, options = {}) {
  const config = getZohoConfig();
  if (config.missing.length > 0) {
    throw new Error(`Missing Zoho env vars: ${config.missing.join(", ")}`);
  }

  const method = toNonEmptyString(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  const requestBody = options.body;
  const fullPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${config.apiDomain}${fullPath}`;

  const doFetch = async (forceRefresh) => {
    const accessToken = await getZohoAccessToken({ forceRefresh });
    const finalHeaders = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      ...headers,
    };
    return fetch(url, {
      method,
      headers: finalHeaders,
      body: requestBody,
    });
  };

  let response = await doFetch(false);
  if (response.status !== 401) return response;

  response = await doFetch(true);
  return response;
}

module.exports = {
  getZohoConfig,
  getZohoAccessToken,
  getTokenMeta,
  zohoApiFetch,
};

