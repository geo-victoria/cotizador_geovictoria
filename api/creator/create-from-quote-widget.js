const { toText, updateRecordBestEffort } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { runNdvHandoffFromDraft, NdvBusinessError, normalizeCreatorBusinessError } = require("../_shared/ndv-handoff");
const { runNdvSubformSetup } = require("../_shared/ndv-subforms");

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowedList = (process.env.ALLOWED_UPLOAD_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const allowedByRule =
    /^https:\/\/[a-z0-9-]+\.zappsusercontent\.com$/i.test(origin) ||
    /^https:\/\/([a-z0-9-]+\.)?zoho\.[a-z.]+$/i.test(origin) ||
    origin === "https://cotizacion.geovictoria.com" ||
    origin === "http://127.0.0.1:5000" ||
    origin === "http://localhost:3000";

  const allowed = !origin || allowedByRule || allowedList.includes(origin);
  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return allowed;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (_error) {
      return {};
    }
  }
  if (typeof req.body === "object") return req.body;
  return {};
}

function errorToText(error) {
  if (!error) return "";
  const message = toText(error?.message || error);
  if (message && message !== "[object Object]") return message;
  try {
    return JSON.stringify(error);
  } catch (_jsonError) {
    return String(error);
  }
}

function normalizeEndpointError(error) {
  if (!error) return "No se pudo crear la cotización.";
  if (error instanceof NdvBusinessError) {
    return toText(error.userMessage || error.message) || "No se pudo crear la cotización.";
  }
  const raw = errorToText(error);
  return normalizeCreatorBusinessError(raw) || raw || "No se pudo crear la cotización.";
}

async function persistNdvReferences(config, quoteId, ndvId) {
  const normalizedNdvId = toText(ndvId);
  if (!normalizedNdvId || !quoteId) return;

  if (config.quoteNvdIdTextField) {
    await updateRecordBestEffort(
      config.quoteModule,
      quoteId,
      { [config.quoteNvdIdTextField]: normalizedNdvId },
      true
    );
  }

  if (!config.quoteNvdLookupField) return;
  try {
    await updateRecordBestEffort(
      config.quoteModule,
      quoteId,
      { [config.quoteNvdLookupField]: { id: normalizedNdvId } },
      true
    );
  } catch (_firstError) {
    await updateRecordBestEffort(
      config.quoteModule,
      quoteId,
      { [config.quoteNvdLookupField]: normalizedNdvId },
      true
    );
  }
}

export default async function handler(req, res) {
  const corsAllowed = setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = corsAllowed ? 204 : 403;
    res.end();
    return;
  }
  if (!corsAllowed) {
    sendJson(res, 403, { success: false, error: "Origin no permitido." });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const body = parseBody(req);
    const dealId = toText(body?.dealId);
    const proposalData = body?.proposalData || {};
    if (!dealId) {
      sendJson(res, 400, { success: false, error: "Falta dealId." });
      return;
    }

    const config = getAcceptanceConfig(req);
    const result = await runNdvHandoffFromDraft({
      config,
      dealId,
      proposalData,
      contactEmail: toText(proposalData?.contactoEmail),
      contactPhone: toText(proposalData?.contactoTelefono),
    });

    const ndvId = toText(result?.ndvId);
    const quoteId = toText(body?.quoteId);
    if (quoteId && ndvId) {
      await persistNdvReferences(config, quoteId, ndvId);
    }

    let subformResult = null;
    if (ndvId) {
      try {
        subformResult = await runNdvSubformSetup({
          ndvId,
          ndvRecord: result?.ndvRecord || {},
          chargeTables: result?.chargeTables,
        });
      } catch (subformError) {
        subformResult = { errors: [String(subformError?.message || subformError)] };
      }
    }

    sendJson(res, 200, {
      success: true,
      ndvId,
      reconciled: result?.reconciled === true,
      subformSetup: subformResult,
      message: ndvId
        ? "NDV creada correctamente en Creator."
        : "NDV creada, pero Creator no devolvio ID.",
    });
  } catch (error) {
    const normalized = normalizeEndpointError(error);
    sendJson(res, 502, {
      success: false,
      error: normalized,
      detail: errorToText(error) || normalized || "Error desconocido",
    });
  }
}
