/**
 * Notificación interna de "Cotización PAGADA" para pagos que NO pasan por
 * MercadoPago (Lalo 10-ago, caso Fernando/COT408).
 *
 * El correo de PAGADA al equipo nace en notifyQuoteEvent y hasta hoy solo lo
 * gatillaban los caminos de MP (webhook / polling de status). Un pago por
 * TRANSFERENCIA entra por el agente de WhatsApp: Vicky registra el
 * comprobante, marca la cotización Pagada en Zoho y avanza el deal — pero el
 * cotizador nunca se enteraba, así que el equipo se quedaba sin el correo (y
 * sin el WhatsApp interno) de PAGADA. Este endpoint es la puerta para que el
 * agente lo dispare.
 *
 * POST/GET /api/payments/notify-paid?quoteId=<id>
 * Auth: Bearer ${CRON_SECRET} o x-vicky-secret == VICKY_COTIZADORA_SECRET.
 *
 * Reusa notifyQuoteEvent COMPLETO: mismos destinatarios por país + Owner
 * dinámico, mismo filtro anti-pruebas (dominio interno / "prueba"), mismo
 * WhatsApp interno. Idempotencia simple por header de quién llama: el agente
 * lo invoca UNA vez por comprobante (best-effort tras marcar Pagada); los
 * caminos MP no pasan por acá, así que no hay doble correo.
 */
const { getRecord, toText } = require("../_shared/zoho-crm");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { notifyQuoteEvent } = require("../_shared/quote-internal-notify");

/**
 * ¿Ya salió el correo de PAGADA de esta cotización? (02-sep, incidente en
 * vivo: COT1142 mandó SIETE avisos idénticos en 11 minutos.) El agente deja
 * una marca `notify_pagada_pend_<quoteId>` cuando no logra confirmar la
 * entrega y un cron la reintenta cada ~2 min; si la llamada manda el correo
 * pero la respuesta no vuelve a tiempo, la marca nunca se borra y el aviso se
 * repite para siempre. Este endpoint tiene que ser IDEMPOTENTE por sí mismo:
 * la related list Emails de la cotización es el candado, igual que en el
 * barrido de correos-pendientes. Ante un fallo de lectura NO se bloquea el
 * envío (mejor un duplicado que perder el aviso de una venta).
 */
async function yaSalioCorreoPagada(quoteModule, quoteId) {
  try {
    const r = await zohoApiFetch(
      `/crm/v3/${encodeURIComponent(quoteModule)}/${encodeURIComponent(quoteId)}/Emails`,
      { method: "GET" },
    );
    if (r.status === 204) return false;
    if (!r.ok) return false;
    const data = await r.json().catch(() => ({}));
    const emails = Array.isArray(data?.Emails) ? data.Emails : [];
    return emails.some((e) => /\bPAGADA\b/i.test(String(e?.subject || "")));
  } catch {
    return false;
  }
}

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

module.exports = async function handler(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  const quoteId = toText(req?.query?.quoteId) || toText(req?.body?.quoteId);
  if (!quoteId) return sendJson(res, 400, { ok: false, error: "quoteId requerido" });
  try {
    const config = getAcceptanceConfig(req);
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) return sendJson(res, 404, { ok: false, error: `cotización ${quoteId} no encontrada` });
    // El aviso de PAGADA sale UNA vez por cotización: si ya está en la related
    // list, se responde ok (para que el reintento del agente borre su marca)
    // sin volver a mandarlo.
    if (!/^1|true$/i.test(toText(req?.query?.forzar))) {
      const yaSalio = await yaSalioCorreoPagada(config.quoteModule, quoteId);
      if (yaSalio) {
        console.log(`[notify-paid] correo PAGADA ya enviado antes, se omite quote=${quoteId}`);
        return sendJson(res, 200, { ok: true, quoteId, omitido: "ya_enviado", numero: toText(quote?.Numero_Cotizacion) });
      }
    }
    // notifyQuoteEvent es best-effort por diseño (nunca lanza): el resultado
    // real queda en los logs [quote-notify]. Acá solo confirmamos el disparo.
    await notifyQuoteEvent({ config, quote, quoteId, evento: "pagada" });
    return sendJson(res, 200, { ok: true, quoteId, numero: toText(quote?.Numero_Cotizacion) });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: toText(err?.message || err).slice(0, 300) });
  }
};
