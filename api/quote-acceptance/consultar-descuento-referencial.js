/**
 * Endpoint: POST /api/quote-acceptance/consultar-descuento-referencial
 *
 * READ-ONLY (negociación en el PREFORM, antes de existir la cotización formal).
 * Calcula el siguiente descuento que Vicky puede ofrecer y el PRECIO
 * RECALCULADO sobre los ítems referenciales que Vicky ya armó, SIN crear nada
 * en Zoho y SIN generar PDF. Es el equivalente a consultar-siguiente-descuento
 * pero operando sobre ítems posteados (no sobre una cotización persistida).
 *
 * Como no hay registro en Zoho todavía, el puntero de negociación lo lleva la
 * conversación: Vicky envía `escalonActual` (cuántos escalones ya ofreció) y el
 * endpoint devuelve `escalon_actual` (incrementado) para la próxima vuelta.
 *
 * Usa exactamente la misma construcción de subform (buildSubformItems) que
 * create-from-vicky, así el preview coincide con la cotización formal que se
 * genere después.
 *
 * Body:
 *   {
 *     cotizacion: { items: [...], ufActual: number },
 *     escalonActual: number   // 0 en la primera consulta
 *   }
 *
 * Respuesta exitosa:
 *   {
 *     ok: true,
 *     escalon: { tipo, pct, condicion_discursiva },
 *     preview: { pago_inicial_clp, mensual_clp },
 *     escalon_actual: 1,             // pasar tal cual en la próxima consulta
 *     tope_alcanzado: false,
 *     mensaje_para_prospecto: "..."
 *   }
 *
 * Sin más escalones:  { ok: false, error: "TOPE_ALCANZADO", tope_alcanzado: true }
 */

const { toText } = require("../_shared/zoho-crm");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const {
  DISCOUNT_LADDER,
  siguienteEscalonAplicable,
  hayEscalonDespues,
  descuentosHasta,
  previewAmounts,
  buildMensajeNegociacion,
} = require("../_shared/discount-engine");
const { buildSubformItems } = require("./create-from-vicky");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return typeof req.body === "object" && req.body ? req.body : {};
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });
  }

  if (!secretoValido(req)) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  let stage = "init";
  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const cotizacion = body.cotizacion || {};
    const items = cotizacion.items;
    const ufActual = Number(cotizacion.ufActual || 0);

    if (!Array.isArray(items) || items.length === 0) {
      return sendJson(res, 400, { ok: false, error: "cotizacion.items requerido (no vacío)." });
    }

    // Construir el subform EXACTAMENTE como lo hará create-from-vicky, para que
    // los números del preview coincidan con la cotización formal.
    stage = "build_subform";
    const subform = buildSubformItems(items, ufActual, config);
    const pseudoQuote = { [config.quoteItemsSubformField]: subform };

    // Puntero de negociación traído por la conversación. Avanzamos UN solo
    // escalón por llamada: el descuento se gana de tramo en tramo (10 → 20,
    // tope 20%), una objeción a la vez. NO se salta al % que pida el cliente.
    stage = "elegir_escalon";
    const start = Math.max(0, Number(body.escalonActual || 0));
    const i = siguienteEscalonAplicable(pseudoQuote, config, start);
    if (i < 0) {
      return sendJson(res, 200, {
        ok: false,
        error: "TOPE_ALCANZADO",
        tope_alcanzado: true,
      });
    }

    const escalon = DISCOUNT_LADDER[i];

    stage = "preview";
    const { descuentos } = descuentosHasta(pseudoQuote, config, i);
    const amounts = previewAmounts(pseudoQuote, config, descuentos);

    // ¿Hubo oferta previa en esta negociación? (para no repetir el detalle largo)
    // y ¿es el PRIMER descuento del plan? (la condición de 6 meses se dice una vez).
    const previo = descuentosHasta(pseudoQuote, config, i - 1).descuentos;
    const huboOfertaPrevia =
      (previo.recurrentePct || 0) > 0 ||
      (previo.instalacionRMPct || 0) > 0 ||
      (previo.instalacionRegionPct || 0) > 0;
    const esPrimerDescuentoPlan =
      String(escalon.tipo).startsWith("recurrente") && (previo.recurrentePct || 0) === 0;

    return sendJson(res, 200, {
      ok: true,
      escalon: {
        tipo: escalon.tipo,
        pct: escalon.pct,
        condicion_discursiva: escalon.condicionDiscursiva,
      },
      preview: {
        pago_inicial_clp: amounts.oneShotClp,
        mensual_clp: amounts.recurringClp,
        descuentos,
      },
      // Para la próxima consulta (si el cliente pide más rebaja).
      escalon_actual: i + 1,
      tope_alcanzado: !hayEscalonDespues(pseudoQuote, config, i),
      mensaje_para_prospecto: buildMensajeNegociacion(
        escalon,
        amounts,
        !hayEscalonDespues(pseudoQuote, config, i),
        { conciso: huboOfertaPrevia, esPrimerDescuentoPlan },
      ),
    });
  } catch (error) {
    console.error(`[consultar-descuento-referencial] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo consultar el descuento referencial.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};
