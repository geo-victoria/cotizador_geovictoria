const { toText } = require("../_shared/zoho-crm");
const { resolvePaymentSession } = require("../_shared/payment-session");
const { pickInitPoint } = require("../_shared/mercadopago-config");
const { createPreapproval, buildExternalReference } = require("../_shared/mercadopago-client");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  if (req?.body && typeof req.body === "object") return req.body;
  if (typeof req?.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (_error) {
      return {};
    }
  }
  if (!req || typeof req.on !== "function") return {};
  const chunks = [];
  await new Promise((resolve) => {
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", resolve);
    req.on("error", resolve);
  });
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
}

// El back_url del preapproval debe ser CORTO: la columna BACK_URL de Mercado
// Pago tiene un limite (~255) y un token largo en la query hace fallar el
// /preapproval con "Data too long for column 'BACK_URL'". Por eso no incrustamos
// el token aqui; pago.html lo recupera desde localStorage al volver.
function subscriptionBackUrl(mpConfig) {
  return mpConfig.landingUrl;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const body = await parseBody(req);
    const token = toText(body?.token);
    if (!token) {
      sendJson(res, 400, { success: false, error: "Falta token." });
      return;
    }

    const session = await resolvePaymentSession(req, token);
    const { mpConfig, quoteId, billingEmail, amounts } = session;

    if (!mpConfig.enabled) {
      sendJson(res, 409, { success: false, error: "Pagos con Mercado Pago no habilitados." });
      return;
    }

    // COLOMBIA: sin suscripciones de MP en v1 — la mensualidad se factura a 30
    // días (COLOMBIA.md). Guardia explícita por si algún día se enciende
    // MP_SUBSCRIPTION_ENABLED global: no debe arrastrar a las cotizaciones CO.
    if (session.pais === "co") {
      sendJson(res, 200, { success: true, skipped: true, reason: "co_sin_suscripcion" });
      return;
    }

    // Suscripcion recurrente desactivada por ahora (se cobra solo el pago unico).
    if (!mpConfig.subscriptionEnabled) {
      sendJson(res, 200, { success: true, skipped: true, reason: "subscription_disabled" });
      return;
    }

    if (amounts.recurringClp <= 0) {
      sendJson(res, 200, { success: true, skipped: true, reason: "no_subscription" });
      return;
    }

    if (!billingEmail) {
      sendJson(res, 400, {
        success: false,
        error: "Falta el correo de facturacion para crear la suscripcion.",
      });
      return;
    }

    const externalReference = buildExternalReference(quoteId, "sub");
    // ETIQUETA PARA REPORTES (Lalo 04-ago): el `reason` es la descripción que
    // muestran los reportes de cobros recurrentes de MP — lleva cotización,
    // empresa y RUT para que finanzas identifique cada cargo (misma regla que
    // el título del checkout one-shot en create-preference).
    const etiquetaReporte = [
      toText(session.quote?.Numero_Cotizacion) || "",
      toText(session.quote?.Cuenta_Asociada?.name),
      session.companyRut ? `RUT ${session.companyRut}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 180);
    const payload = {
      reason: etiquetaReporte
        ? `${mpConfig.subscriptionReason} — ${etiquetaReporte}`.slice(0, 256)
        : mpConfig.subscriptionReason,
      external_reference: externalReference,
      payer_email: billingEmail,
      back_url: subscriptionBackUrl(mpConfig),
      status: "pending",
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: amounts.recurringClp,
        currency_id: mpConfig.currencyId,
      },
    };

    const created = await createPreapproval(mpConfig, payload);
    sendJson(res, 200, {
      success: true,
      skipped: false,
      preapprovalId: toText(created?.id),
      status: toText(created?.status),
      initPoint: pickInitPoint(created, mpConfig),
      amountClp: amounts.recurringClp,
      currencyId: mpConfig.currencyId,
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "La sesion de pago expiro. Solicita un nuevo enlace a tu ejecutivo comercial."
        : "No se pudo crear la suscripcion recurrente.",
      detail: toText(error?.message || error),
    });
  }
}
