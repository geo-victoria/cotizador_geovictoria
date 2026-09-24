/**
 * DIAGNÓSTICO de credenciales de Mercado Pago por país — SOLO LECTURA.
 *
 * POR QUÉ EXISTE (15-sep, encendido de Vicky Perú): las credenciales viven en
 * envs de Vercel que nadie puede leer desde fuera, y la única forma de saber
 * si MP Perú está conectado era hacer una venta real. Este endpoint dice, por
 * país, qué envs están presentes (booleanos, jamás el valor) y valida cada
 * token contra `GET /users/me` de Mercado Pago (cuenta, site_id, tipo de
 * credencial) — sin crear preferencias ni tocar cobros.
 *
 * GET /api/payments/mp-diag[?pais=pe]
 * Auth: Authorization: Bearer ${CRON_SECRET} o x-vicky-secret.
 */
const { toText } = require("../_shared/zoho-crm");
const { secretoValido } = require("../_shared/secreto-vicky");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  return secretoValido(req);
}

// Nombres de las envs por país, derivados de la ficha (pais-pago.js): un
// país nuevo aparece en el diagnóstico sin tocar este archivo.
const { PAISES_PAGO } = require("../_shared/pais-pago");
const ENVS = Object.fromEntries(
  Object.values(PAISES_PAGO).map((f) => {
    const s = f.envSufijo;
    return [f.codigo, {
      access: `MP_ACCESS_TOKEN${s}`,
      publicKey: `MP_PUBLIC_KEY${s}`,
      webhook: `MP_WEBHOOK_SECRET${s}`,
      testAccess: `MP_TEST_ACCESS_TOKEN${s}`,
      testPublic: `MP_TEST_PUBLIC_KEY${s}`,
    }];
  }),
);

/** Tipo de credencial por su prefijo: APP_USR = producción · TEST = prueba. */
function tipoToken(t) {
  if (!t) return "ausente";
  if (/^APP_USR-/.test(t)) return "produccion";
  if (/^TEST-/.test(t)) return "prueba";
  return "desconocido";
}

async function usersMe(token) {
  if (!token) return { ok: false, motivo: "ausente" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch("https://api.mercadopago.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, motivo: `http_${r.status}`, detalle: String(data?.message || data?.error || "").slice(0, 120) };
    return {
      ok: true,
      id: data.id,
      nickname: data.nickname,
      site_id: data.site_id,
      country_id: data.country_id,
      email: data.email ? String(data.email).replace(/^(.{2}).*@/, "$1…@") : undefined,
    };
  } catch (e) {
    return { ok: false, motivo: "excepcion", detalle: String(e && e.message ? e.message : e).slice(0, 120) };
  }
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  const filtro = toText(req?.query?.pais).toLowerCase();
  const paises = filtro && ENVS[filtro] ? [filtro] : Object.keys(ENVS);
  const salida = {};
  for (const pais of paises) {
    const e = ENVS[pais];
    const access = toText(process.env[e.access]);
    const testAccess = toText(process.env[e.testAccess]);
    salida[pais] = {
      envs: {
        [e.access]: Boolean(access),
        [e.publicKey]: Boolean(toText(process.env[e.publicKey])),
        [e.webhook]: Boolean(toText(process.env[e.webhook])),
        [e.testAccess]: Boolean(testAccess),
        [e.testPublic]: Boolean(toText(process.env[e.testPublic])),
      },
      tipoToken: tipoToken(access),
      tipoTokenPrueba: tipoToken(testAccess),
      cuenta: await usersMe(access),
      cuentaPrueba: await usersMe(testAccess),
    };
  }
  return sendJson(res, 200, {
    ok: true,
    paymentsEnabled: /^(1|true|yes|on)$/i.test(toText(process.env.MP_PAYMENTS_ENABLED)),
    environment: toText(process.env.MP_ENVIRONMENT || process.env.VERCEL_ENV),
    paises: salida,
  });
};
