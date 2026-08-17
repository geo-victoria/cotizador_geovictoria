/**
 * Código corto y firmado de una cotización: `<quoteId>-<firma>`.
 *
 * Es el formato que resuelve `/q/<codigo>` (ver api/q.js): la firma es
 * HMAC-SHA256(quoteId, VICKY_COTIZADORA_SECRET) truncada a 10 hex, para que el
 * id solo no permita enumerar cotizaciones ajenas.
 *
 * Existe como módulo aparte porque ahora lo necesitan DOS lados: `/q` para
 * validar, y las emisiones para PUBLICARLO. La plantilla de WhatsApp
 * `vicky_cotizacion_pago` lleva el botón "Pagar aquí" apuntando a
 * `…/q/${codigo}`, y el `${codigo}` viaja como parámetro de la plantilla — el
 * token largo del acceptanceUrl no cabe en un botón.
 */

const crypto = require("crypto");

/**
 * @param {string|number} quoteId id de la cotización en Zoho
 * @returns {string} `<quoteId>-<firma>`, o "" si falta el id o el secreto
 */
function codigoCortoDeCotizacion(quoteId) {
  const id = String(quoteId || "").replace(/\D/g, "");
  const secret = String(process.env.VICKY_COTIZADORA_SECRET || "").trim();
  if (!id || !secret) return "";
  const firma = crypto.createHmac("sha256", secret).update(id).digest("hex").slice(0, 10);
  return `${id}-${firma}`;
}

/** URL corta completa, lista para pegar o para el botón de la plantilla. */
function linkCortoDeCotizacion(quoteId, baseUrl) {
  const codigo = codigoCortoDeCotizacion(quoteId);
  if (!codigo) return "";
  const base = String(baseUrl || "https://cotizacion.geovictoria.com").replace(/\/+$/, "");
  return `${base}/q/${codigo}`;
}

module.exports = { codigoCortoDeCotizacion, linkCortoDeCotizacion };
