/**
 * Endpoint: POST /api/quote-acceptance/consultar-siguiente-descuento
 *
 * READ-ONLY (negociación). Devuelve el siguiente descuento que Vicky puede
 * ofrecer en la conversación, junto con el PRECIO RECALCULADO (pago inicial y
 * mensual), SIN regenerar el PDF ni comitear el descuento. Vicky usa el
 * `mensaje_para_prospecto` para negociar verbalmente.
 *
 * Lo único que persiste es el puntero de negociación (Escalon_Negociacion):
 * cada llamada avanza un escalón aplicable, de modo que si el cliente insiste
 * en más rebaja, la siguiente consulta ofrece el escalón siguiente. El
 * descuento comiteado (Escalon_Descuento), el PDF y la versión NO se tocan:
 * eso solo ocurre en aplicar-siguiente-descuento cuando el cliente acepta.
 *
 * Body:
 *   { "quoteId": "<id de la cotización en Zoho>" }
 *
 * Respuesta exitosa:
 *   {
 *     ok: true,
 *     escalon: { tipo, pct, condicion_discursiva },
 *     preview: { pago_inicial_clp, mensual_clp },
 *     tope_alcanzado: false,       // true si este es el último escalón posible
 *     mensaje_para_prospecto: "Texto que Vicky usa para negociar (sin PDF)"
 *   }
 *
 * Cuando ya no hay más escalones que ofrecer:
 *   { ok: false, error: "TOPE_ALCANZADO", tope_alcanzado: true }
 */

const { getRecord, updateRecord, toText } = require("../_shared/zoho-crm");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const {
  DISCOUNT_LADDER,
  normalizarIndiceGuardado,
  siguienteEscalonAplicable,
  hayEscalonDespues,
  descuentosHasta,
  previewAmounts,
  buildMensajeNegociacion,
} = require("../_shared/discount-engine");

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
    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    }

    stage = "fetch_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });
    }

    // Cotización ya ACEPTADA: el precio quedó cerrado, no se negocia más descuento
    // sobre un trato cerrado. Antes esto computaba el escalón igual (o reventaba) y
    // Vicky lo mostraba como "problema técnico" y derivaba (caso real: pidieron
    // descuento sobre una cotización ya aceptada y en el tope). Devolvemos un estado
    // CLARO (no error técnico) para que Vicky diga que ya está aceptada al mejor precio.
    stage = "check_estado";
    const estadoNorm = toText(quote?.[config.quoteStatusField]).toLowerCase();
    if (estadoNorm.includes("acept")) {
      return sendJson(res, 200, {
        ok: false,
        error: "YA_ACEPTADA",
        ya_aceptada: true,
        tope_alcanzado: true,
      });
    }

    // El puntero de negociación nunca retrocede por debajo de lo comiteado.
    // Los índices guardados con la escalera vieja (pre jul-2026, largo 4) se
    // re-derivan del % recurrente ya comiteado.
    stage = "elegir_escalon";
    const recComiteado = Number(quote?.[config.quoteDiscountPctField] || 0);
    const commitIdx = normalizarIndiceGuardado(quote?.[config.quoteEscalonField], recComiteado);
    const negocIdx = normalizarIndiceGuardado(quote?.[config.quoteEscalonNegociacionField], recComiteado);
    const start = Math.max(commitIdx, negocIdx);

    const i = siguienteEscalonAplicable(quote, config, start);
    if (i < 0) {
      return sendJson(res, 200, {
        ok: false,
        error: "TOPE_ALCANZADO",
        tope_alcanzado: true,
      });
    }
    const escalon = DISCOUNT_LADDER[i];

    // Avanzar SOLO el puntero de negociación. No tocamos descuento comiteado,
    // PDF ni versión. BEST-EFFORT: si el update falla, NO tumbamos la negociación
    // (devolvemos igual la oferta); el puntero se reintenta en la próxima vuelta.
    stage = "avanzar_puntero";
    try {
      await updateRecord(
        config.quoteModule,
        quoteId,
        { [config.quoteEscalonNegociacionField]: i + 1 },
        false,
      );
    } catch (updErr) {
      console.error(
        `[consultar-siguiente-descuento] avanzar_puntero FALLÓ (best-effort) quote=${quoteId} negoc=${i + 1}:`,
        String(updErr?.message || updErr).slice(0, 300),
      );
    }

    // Preview de precio con el descuento ACUMULADO hasta este escalón.
    stage = "preview";
    const { descuentos } = descuentosHasta(quote, config, i);
    const amounts = previewAmounts(quote, config, descuentos);

    // ¿Hubo oferta previa? (no repetir el detalle largo) y ¿primer descuento del
    // plan? (la condición de 6 meses se dice una vez).
    const previo = descuentosHasta(quote, config, i - 1).descuentos;
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
      tope_alcanzado: !hayEscalonDespues(quote, config, i),
      mensaje_para_prospecto: buildMensajeNegociacion(
        escalon,
        amounts,
        !hayEscalonDespues(quote, config, i),
        { conciso: huboOfertaPrevia, esPrimerDescuentoPlan },
      ),
    });
  } catch (error) {
    console.error(`[consultar-siguiente-descuento] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo consultar el siguiente descuento.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};
