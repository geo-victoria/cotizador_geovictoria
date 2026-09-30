// ADMIN — scope real de cada credencial de Zoho del COTIZADOR (30-sep).
// Misma idea que vic-admin-zoho-scope del agente: la respuesta del refresco
// trae `scope`; se devuelve eso y se descarta el access token. Auth: Bearer
// CRON_SECRET o x-vicky-secret (por el proxy admin del agente).
//   GET ?cual=principal|files|creator
const CREDENCIALES = {
  principal: { refresh: "ZOHO_REFRESH_TOKEN", id: "ZOHO_CLIENT_ID", secret: "ZOHO_CLIENT_SECRET" },
  files: { refresh: "ZOHO_FILES_REFRESH_TOKEN", id: "ZOHO_CLIENT_ID", secret: "ZOHO_CLIENT_SECRET" },
  creator: { refresh: "ZOHO_CREATOR_REFRESH_TOKEN", id: "ZOHO_CREATOR_CLIENT_ID", secret: "ZOHO_CREATOR_CLIENT_SECRET" },
};

function autorizado(req) {
  const env = (n) => String(process.env[n] || "").trim();
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const vicky = String(req.headers["x-vicky-secret"] || "").trim();
  const cron = env("CRON_SECRET");
  const secretos = [env("VICKY_COTIZADORA_SECRET"), env("VICKY_COTIZADORA_SECRET_ZOHO")].filter(Boolean);
  return (cron && bearer === cron) || (vicky && secretos.includes(vicky));
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET" });
  if (!autorizado(req)) return res.status(401).json({ ok: false, error: "no autorizado" });
  const cual = String((req.query && req.query.cual) || "principal").trim();
  const c = CREDENCIALES[cual];
  if (!c) return res.status(400).json({ ok: false, error: "cual debe ser principal | files | creator" });
  const env = (n) => String(process.env[n] || "").trim();
  if (!env(c.refresh)) return res.status(200).json({ ok: true, cual, configurado: false, env: c.refresh });
  const domain = (env("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com").replace(/\/+$/, "");
  const r = await fetch(`${domain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: env(c.refresh), client_id: env(c.id), client_secret: env(c.secret), grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  const scope = String(j.scope || "");
  return res.status(200).json({
    ok: Boolean(j.access_token),
    cual,
    configurado: true,
    env: c.refresh,
    scope: scope ? scope.split(/[ ,]+/).filter(Boolean).sort() : [],
    api_domain: j.api_domain || null,
    expires_in: j.expires_in || null,
    error: j.access_token ? undefined : j.error || j,
  });
};
