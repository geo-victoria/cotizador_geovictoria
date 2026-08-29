/**
 * SEGUNDA PASADA de la conversión post-pago: confirmar las notas de venta que
 * ya tienen su PDF.
 *
 * El pago solo CONVIERTE (ver post-payment-finalize). La cadena completa no
 * cabe en el tiempo de una función serverless, y además confirmar antes de que
 * el PDF exista no sirve: `ConfirmNDV` arranca leyendo `FullFormJsonPdf`.
 *
 * Este endpoint barre las notas en PENDIENTE que ya tienen PDF y las confirma.
 * Es idempotente —una nota ya CONFIRMADA se salta— y acotado, para no quedarse
 * sin tiempo: procesa unas pocas por corrida y las que queden esperan a la
 * siguiente.
 *
 * GET /api/creator/confirmar-pendientes?limite=5
 */

const { getCreatorConfig, creatorApiFetch } = require("../_shared/zoho-creator-auth");
const { secretoValido } = require("../_shared/secreto-vicky");
const { confirmarNota } = require("../_shared/ndv-conversion");

function texto(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return String(v.display_value || v.zc_display_value || v.ID || "");
  return String(v).trim();
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Cableado al cron de Vercel (29-ago, cierre P0): antes NADIE corría esta
  // segunda pasada sola — las notas quedaban PENDIENTE hasta un disparo
  // manual. El cron llega con `Authorization: Bearer ${CRON_SECRET}` (mismo
  // patrón de reconcile-pending); el secreto interno sigue valiendo.
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  const esCron = Boolean(cronSecret) && bearer === cronSecret;
  if (!esCron && !secretoValido(req)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
  }

  const config = getCreatorConfig();
  // Pocas por corrida: cada confirmación dispara ConfirmNDV, que es lento
  // (totales, PDF, orden de venta en Books, referencia en el CRM).
  const limite = Math.min(10, Math.max(1, Number(req.query?.limite) || 3));

  const criteria = encodeURIComponent('(Formulario == "Nota de Venta" && STATUS == "PENDIENTE")');
  const r = await creatorApiFetch(
    `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}` +
      `/report/${encodeURIComponent(config.reportLinkName)}?criteria=${criteria}&limit=100&field_config=all`,
    { method: "GET" }
  );
  const j = await r.json().catch(() => ({}));
  const filas = Array.isArray(j?.data) ? j.data : [];

  // Sin PDF no se puede confirmar; esas se dejan para cuando Creator termine de
  // generarlo. Y solo se tocan las nacidas de una conversión nuestra, que son
  // las que tienen cotización de origen.
  const candidatas = filas
    .filter((f) => texto(f.PDF_STRING) && texto(f.Cotizacion_Origen))
    .slice(0, limite);

  const resultados = [];
  for (const f of candidatas) {
    const out = await confirmarNota(texto(f.ID)).catch((e) => ({ ok: false, error: e.message }));
    resultados.push({ idNdv: texto(f.ID_NDV), ...out });
  }

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      pendientes: filas.length,
      conPdf: filas.filter((f) => texto(f.PDF_STRING)).length,
      procesadas: resultados.length,
      resultados,
    })
  );
};
