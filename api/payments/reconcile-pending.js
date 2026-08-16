/**
 * Cron de reconciliacion de pagos: GET/POST /api/payments/reconcile-pending
 *
 * RED DE SEGURIDAD del finalize post-pago. El onboarding tras un pago se gatilla
 * por dos caminos y ninguno es confiable por si solo:
 *   1. El navegador del cliente vuelve a la pagina de exito (`auto_return`) y
 *      hace polling a status.js. Con DEBITO o pago desde la app de Mercado Pago,
 *      `auto_return` NO devuelve al sitio -> ese camino no finaliza.
 *   2. El webhook de Mercado Pago (server-to-server). Si la firma/registro del
 *      webhook falla, tampoco finaliza.
 *
 * Cuando ambos fallan, la cotizacion queda en "Pago Pendiente" para siempre
 * aunque el pago ESTE aprobado en Mercado Pago (caso real: COT196 ELEAM, pagada
 * con debito, sin redireccion, atascada).
 *
 * Este cron barre las cotizaciones atascadas en "Pago Pendiente" (sin
 * Onboarding_Link) y, por cada una, consulta a Mercado Pago si el pago esta
 * aprobado via `maybeFinalizeQuote`. Si lo esta, finaliza (genera el onboarding
 * + NDV); si no (pago no aprobado / pago por transferencia manual), no hace nada
 * y la deja para la proxima pasada o gestion manual.
 *
 * Idempotencia: `maybeFinalizeQuote` solo finaliza cuando NO hay Onboarding_Link;
 * al setearlo, la cotizacion sale de la proxima barrida. No duplica registros.
 *
 * Ventana: se respeta una gracia corta (para no competir con el flujo en vivo) y
 * un tope de antiguedad (una cotizacion vieja sin pagar es abandono, no error).
 *
 * Auth: header `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron) o
 * `x-vicky-secret = ${VICKY_COTIZADORA_SECRET}` (disparo manual).
 */

const { toText, getRecord } = require("../_shared/zoho-crm");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { getMercadoPagoConfig } = require("../_shared/mercadopago-config");
const { maybeFinalizeQuote } = require("../_shared/post-payment-finalize");

// Gracia: no tocar cotizaciones recien marcadas "Pago Pendiente"; dales unos
// minutos para que el flujo normal (navegador/webhook) las cierre primero.
const GRACE_MINUTES = Number(process.env.PAY_RECONCILE_GRACE_MINUTES || 5);
// Tope de antiguedad: una cotizacion sin pagar pasado este plazo es abandono;
// dejar de pedirle el estado a Mercado Pago indefinidamente.
const MAX_AGE_DAYS = Number(process.env.PAY_RECONCILE_MAX_AGE_DAYS || 30);
// Tope de candidatas revisadas por ejecucion (cada una consulta a MP).
const MAX_CANDIDATAS = Number(process.env.PAY_RECONCILE_MAX_CANDIDATAS || 15);
// Tope de finalizaciones por ejecucion (cada finalize es pesado, ~15-30s).
const MAX_FINALIZE = Number(process.env.PAY_RECONCILE_MAX_FINALIZE || 5);

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  const vickySecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  if (vickySecret && toText(req.headers["x-vicky-secret"]) === vickySecret) return true;
  return false;
}

// COQL: cotizaciones atascadas en el estado de pago pendiente y sin onboarding.
// Filtramos por edad en JS (la ventana de gracia evita pisar el flujo en vivo),
// asi no hay que embeber literales datetime con offset de zona en el COQL.
async function buscarAtascadas(acceptanceConfig, pendingStatus) {
  const estadoField = acceptanceConfig.quoteHandoffStatusField; // Onboarding_Status
  const linkField = acceptanceConfig.quoteOnboardingUrlField; // Onboarding_Link
  // Escapamos comillas simples del valor de estado por seguridad del COQL.
  const safeStatus = String(pendingStatus || "").replace(/'/g, "\\'");
  const select =
    `select id, Created_Time, ${estadoField}, ${linkField} ` +
    `from ${acceptanceConfig.quoteModule} ` +
    `where (${estadoField} = '${safeStatus}') and (${linkField} is null) ` +
    `order by Created_Time desc limit 100`;
  const response = await zohoApiFetch("/crm/v3/coql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ select_query: select }),
  });
  if (response.status === 204) return [];
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`COQL fallo (${response.status}): ${text.slice(0, 200)}`);
  }
  const rows = JSON.parse(text)?.data || [];
  const now = Date.now();
  const minEdadMs = GRACE_MINUTES * 60 * 1000;
  const maxEdadMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return rows.filter((row) => {
    const creado = Date.parse(toText(row.Created_Time));
    if (!Number.isFinite(creado)) return false;
    const edad = now - creado;
    return edad >= minEdadMs && edad <= maxEdadMs;
  });
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });
  }
  if (!authorized(req)) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const acceptanceConfig = getAcceptanceConfig(req);
    const mpConfig = getMercadoPagoConfig(req);

    if (!mpConfig.enabled || !mpConfig.accessToken) {
      return sendJson(res, 200, { ok: true, skipped: "mp_disabled", reconciliadas: 0 });
    }

    const atascadas = await buscarAtascadas(acceptanceConfig, mpConfig.statusPaymentPending);

    const resultados = [];
    let reconciliadas = 0;
    let revisadas = 0;
    for (const row of atascadas) {
      if (revisadas >= MAX_CANDIDATAS || reconciliadas >= MAX_FINALIZE) break;
      const quoteId = toText(row.id);
      if (!quoteId) continue;
      revisadas++;
      try {
        const out = await maybeFinalizeQuote({ mpConfig, acceptanceConfig, quoteId });
        // SEGUNDA PASADA de la nota de venta, para el cliente que pagó y cerró
        // la pestaña: ahí el polling de `payments/status` —que es quien
        // normalmente confirma— nunca llega a correr, y la nota se quedaría en
        // PENDIENTE para siempre. Confirmar exige PDF, así que si Creator aún
        // no lo generó, `confirmarNota` se niega y la próxima pasada reintenta.
        try {
          const { confirmarNota } = require("../_shared/ndv-conversion");
          // La referencia a Creator se relee del registro: `maybeFinalizeQuote`
          // no la devuelve, y acabamos de crearla en esta misma pasada.
          const quoteRow = await getRecord(acceptanceConfig.quoteModule, quoteId).catch(() => null);
          const ndvCreatorId = toText(quoteRow?.[acceptanceConfig.quoteNvdIdTextField]);
          if (ndvCreatorId) await confirmarNota(ndvCreatorId);
        } catch (errNota) {
          console.warn(`[reconcile] confirmación de nota falló: ${toText(errNota?.message || errNota)}`);
        }
        if (out.finalized) {
          reconciliadas++;
          resultados.push({ quoteId, ok: true, finalized: true, onboardingReady: Boolean(out.onboardingUrl) });
          console.log(`[reconcile-pending] cotizacion ${quoteId} reconciliada -> onboarding generado.`);
        } else {
          resultados.push({
            quoteId,
            ok: true,
            finalized: false,
            reason: out.paymentsComplete ? "ya_finalizada" : "pago_no_aprobado",
          });
        }
      } catch (err) {
        resultados.push({ quoteId, ok: false, error: String(err?.message || err).slice(0, 200) });
        console.error(`[reconcile-pending] fallo en ${quoteId}:`, err?.message || err);
      }
    }

    return sendJson(res, 200, {
      ok: true,
      atascadas: atascadas.length,
      revisadas,
      reconciliadas,
      pendientes: Math.max(0, atascadas.length - revisadas),
      resultados,
    });
  } catch (error) {
    console.error("[reconcile-pending] ERROR:", error?.message || error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo correr la reconciliacion de pagos.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};
