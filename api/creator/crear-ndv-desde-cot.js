/**
 * Crea una NOTA DE VENTA convertida en Zoho Creator a partir de una cotización
 * formal del CRM — a demanda, sin pasar por el pago.
 *
 * Es el mismo handoff + subforms que corre el post-pago (numeración por el
 * workflow del app, bloques Servicio_Recurrente, tabla de cobro, Finalizar →
 * PDF), pero el maestro nace como Formulario "Nota de Venta" en vez de
 * "Cotización". La conversión manual de la UI de Creator queda intacta; esto
 * es el equivalente programático para el botón del editor del dash.
 *
 * Al cliente NO le llega nada por este camino.
 *
 * Auth: x-vicky-secret == VICKY_COTIZADORA_SECRET (o Bearer CRON_SECRET).
 * Uso: POST { quoteId, status? }  (status: CONFIRMADA default | PENDIENTE | BORRADOR)
 */
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getRecord, updateRecordBestEffort, toText } = require("../_shared/zoho-crm");
const { getCreatorConfig, creatorApiFetch } = require("../_shared/zoho-creator-auth");
const { runNdvHandoff, persistNdvReferences, NdvBusinessError } = require("../_shared/ndv-handoff");
const { runNdvSubformSetup } = require("../_shared/ndv-subforms");
const { buildAcceptanceDataFromQuote } = require("../_shared/post-payment-finalize");

const STATUS_PERMITIDOS = new Set(["CONFIRMADA", "PENDIENTE", "BORRADOR"]);

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return typeof req.body === "object" && req.body ? req.body : {};
}

function authorized(req) {
  const vickySecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  if (secretoValido(req)) return true;
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  return false;
}

async function readJsonSafe(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 400) }; }
}

function reportPath(creatorConfig, suffix) {
  return (
    `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}` +
    `/${encodeURIComponent(creatorConfig.appLinkName)}/report/${suffix}`
  );
}

/** NDV ya existente para esta COT de Creator (dedup best-effort). Solo cuentan
 * las NDV SANAS (ID_NDV numerado): un maestro incompleto creado por API sin
 * workflow ("NDV-null") no debe bloquear la creación real. */
async function ndvExistenteDeCot(creatorConfig, idSo) {
  if (!idSo) return null;
  try {
    const criteria = encodeURIComponent(`Cotizacion_Origen == ${idSo}`);
    const resp = await creatorApiFetch(
      reportPath(creatorConfig, `ALL_DATA?criteria=${criteria}&max_records=20`),
      { method: "GET" },
    );
    if (!resp.ok) return null;
    const payload = await readJsonSafe(resp);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    for (const row of rows) {
      const esNdv = toText(row?.Formulario) === "Nota de Venta";
      const idNdv = toText(row?.ID_NDV);
      if (esNdv && /^NDV-\d+/i.test(idNdv)) {
        return { ndvId: toText(row.ID), idNdv, status: toText(row.STATUS) };
      }
    }
  } catch {
    // best effort: sin dedup no se bloquea la creación.
  }
  return null;
}

async function leerNdv(creatorConfig, ndvId) {
  try {
    const resp = await creatorApiFetch(reportPath(creatorConfig, encodeURIComponent(toText(ndvId))), {
      method: "GET",
    });
    const payload = await readJsonSafe(resp);
    const data = payload?.data || {};
    return {
      idNdv: toText(data.ID_NDV),
      formStatus: toText(data.FORM_STATUS),
      status: toText(data.STATUS),
      formOrderLen: Array.isArray(data.Form_Order) ? data.Form_Order.length : 0,
      pdfPresente: Boolean(toText(data.PDF_STRING)),
    };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });

  let stage = "init";
  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const quoteId = toText(body.quoteId).replace(/\D/g, "");
    if (!quoteId) return sendJson(res, 400, { ok: false, error: "Falta quoteId." });

    const statusPedido = toText(body.status).toUpperCase() || "CONFIRMADA";
    if (!STATUS_PERMITIDOS.has(statusPedido)) {
      return sendJson(res, 400, { ok: false, error: `status inválido (${statusPedido}). Usa CONFIRMADA, PENDIENTE o BORRADOR.` });
    }

    stage = "load_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) return sendJson(res, 404, { ok: false, error: `No se encontró la cotización ${quoteId}.` });

    const dealId = toText(quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]);
    const idSo = toText(quote?.ID_SO); // espejo COT en Creator → lookup Cotizacion_Origen
    const creatorConfig = getCreatorConfig();
    if (creatorConfig.missing.length > 0) {
      return sendJson(res, 500, { ok: false, error: `Faltan variables de Zoho Creator: ${creatorConfig.missing.join(", ")}` });
    }

    stage = "dedup";
    const existente = await ndvExistenteDeCot(creatorConfig, idSo);
    if (existente) {
      return sendJson(res, 200, {
        ok: true,
        reused: true,
        ndvId: existente.ndvId,
        idNdv: existente.idNdv,
        status: existente.status,
        mensaje: `Esta cotización ya tiene la NDV ${existente.idNdv} en Creator — se reutiliza.`,
      });
    }

    stage = "handoff";
    const acceptanceData = buildAcceptanceDataFromQuote(config, quote);
    const ndvResult = await runNdvHandoff({
      config,
      quoteId,
      dealId,
      acceptanceData,
      creatorOverrides: {
        formulario: "Nota de Venta",
        status: statusPedido,
        formStatus: "BEING EDITED",
        hitoFacturacion: "Cargando...",
      },
    });
    const ndvId = toText(ndvResult?.ndvId);
    if (!ndvId) {
      return sendJson(res, 502, { ok: false, stage, error: "Creator creó la NDV pero no devolvió su ID." });
    }

    // Amarre a la COT de Creator (mismo lookup que usa la conversión manual).
    stage = "cotizacion_origen";
    let origenOk = false;
    if (idSo) {
      try {
        const patchResp = await creatorApiFetch(reportPath(creatorConfig, encodeURIComponent(ndvId)), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { Cotizacion_Origen: idSo } }),
        });
        origenOk = patchResp.ok;
      } catch {
        // best effort
      }
    }

    stage = "subforms";
    const subformSetup = await runNdvSubformSetup({
      ndvId,
      ndvRecord: ndvResult?.ndvRecord || {},
      chargeTables: ndvResult?.chargeTables,
      notasPdf: ndvResult?.notasPdf,
    });

    stage = "referencias_crm";
    await persistNdvReferences(config, quoteId, ndvId).catch(() => {});

    stage = "readback";
    const despues = await leerNdv(creatorConfig, ndvId);
    // El correlativo a la vista en el CRM (campo Nota_de_Venta de la COT).
    if (despues?.idNdv) {
      await updateRecordBestEffort(config.quoteModule, quoteId, { Nota_de_Venta: despues.idNdv }, true).catch(() => {});
    }

    return sendJson(res, 200, {
      ok: true,
      reused: false,
      ndvId,
      idNdv: toText(despues?.idNdv),
      status: statusPedido,
      formStatus: toText(despues?.formStatus),
      formOrderLen: despues?.formOrderLen ?? 0,
      pdfPresente: Boolean(despues?.pdfPresente),
      cotizacionOrigen: idSo ? { idSo, vinculada: origenOk } : null,
      subformErrors: Array.isArray(subformSetup?.errors) && subformSetup.errors.length ? subformSetup.errors : undefined,
      mensaje: despues?.idNdv
        ? `NDV ${despues.idNdv} creada en Creator (el PDF puede tardar ~1 min en aparecer).`
        : "NDV creada en Creator; el correlativo puede tardar unos segundos en asignarse.",
    });
  } catch (error) {
    const businessMessage = error instanceof NdvBusinessError ? error.publicMessage || error.message : "";
    const msg = businessMessage || toText(error?.message || error) || "Error desconocido";
    return sendJson(res, 500, { ok: false, stage, error: msg.slice(0, 400) });
  }
};
