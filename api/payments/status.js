const { toText } = require("../_shared/zoho-crm");
const { resolvePaymentSession } = require("../_shared/payment-session");
const {
  searchPaymentsByExternalReference,
  buildExternalReference,
  hasApprovedPayment,
} = require("../_shared/mercadopago-client");
const { finalizeAfterPayment } = require("../_shared/post-payment-finalize");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function normalizeWhatsappPhone(value) {
  const digits = toText(value).replace(/[^\d]/g, "");
  return digits || "";
}

// Datos para el CTA de transferencia en pago.html (best-effort: nunca rompe el
// estado de pago). Decisión Lalo 25-jul: TODO comprobante va a Vicky — el
// único canal que lo registra automáticamente (tool → nota Zoho → aviso a
// finanzas). Antes apuntaba al teléfono del Owner de la cotización en Zoho,
// pero el usuario "Vicky GeoVictoria" no tiene teléfono, así que el botón de
// WhatsApp jamás aparecía y el cliente quedaba con un texto vago.
const VICKY_WHATSAPP_PHONE = toText(process.env.VICKY_WHATSAPP_PHONE || "56967308227");
async function buildTransferInfo(quote) {
  return {
    executiveName: "Vicky",
    whatsappPhone: normalizeWhatsappPhone(VICKY_WHATSAPP_PHONE),
    quoteNumber: toText(quote?.Numero_Cotizacion),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const token = toText(req?.query?.token);
    if (!token) {
      sendJson(res, 400, { success: false, error: "Falta token." });
      return;
    }

    // Country-aware: para una cotización CO la sesión trae la config de la app
    // MP Colombia (sandbox si es la empresa de prueba), por lo que los pagos se
    // consultan con el token CO y los montos ya vienen FINALES (sin IVA —
    // precios finales 10-jul).
    const session = await resolvePaymentSession(req, token);
    const { mpConfig, acceptanceConfig, quote, quoteId, dealId, amounts, quoteName, pais } = session;

    if (!mpConfig.enabled) {
      sendJson(res, 409, { success: false, error: "Pagos con Mercado Pago no habilitados." });
      return;
    }

    const hasOneShot = amounts.oneShotClp > 0;
    // Suscripción MP RETIRADA (Lalo 12-ago): la mensualidad SIEMPRE va por
    // facturación; el único cobro online es el pago inicial. El contrato del
    // JSON conserva el bloque subscription (not_required) por compatibilidad
    // con pago.html cacheados.
    const hasSubscription = false;

    let oneShotApproved = !hasOneShot;
    let oneShotStatus = hasOneShot ? "pending" : "not_required";
    const subscriptionAuthorized = true;
    const subscriptionStatus = "not_required";

    if (hasOneShot) {
      try {
        const payments = await searchPaymentsByExternalReference(
          mpConfig,
          buildExternalReference(quoteId, "oneshot")
        );
        oneShotApproved = hasApprovedPayment(payments);
        oneShotStatus = oneShotApproved
          ? "approved"
          : toText(payments?.[0]?.status) || "pending";
      } catch (_error) {
        oneShotStatus = "unknown";
      }
    }


    const paymentsComplete = oneShotApproved && subscriptionAuthorized;

    // Solo se necesita el bloque de transferencia cuando el cliente aun debe
    // pagar (es el estado en que pago.html muestra el selector de metodo). En
    // los demas estados se omite el fetch del ejecutivo para no recargar el poll.
    // CO: sin transferencia (aún no hay cuenta bancaria CO; pago.html solo
    // ofrece tarjeta) → se omite también el fetch del ejecutivo.
    const transfer =
      hasOneShot && !oneShotApproved && pais !== "co"
        ? await buildTransferInfo(quote)
        : { executiveName: "", whatsappPhone: "", quoteNumber: "" };

    let onboardingUrl = toText(quote?.[acceptanceConfig.quoteOnboardingUrlField]);
    let finalizeError = "";

    if (paymentsComplete && !onboardingUrl) {
      try {
        const result = await finalizeAfterPayment({ config: acceptanceConfig, quoteId, dealId });
        onboardingUrl = toText(result?.onboardingUrl);
      } catch (error) {
        finalizeError = toText(error?.message || error);
      }
    }

    // SEGUNDA PASADA de la nota de venta. El pago solo CONVIERTE: el PDF lo
    // genera Creator en segundo plano y sin PDF no se puede confirmar, así que
    // la confirmación necesita una mirada posterior. No hace falta agendar nada
    // nuevo — la página de aceptación consulta este endpoint varias veces
    // mientras el cliente espera, que es justo la ventana en que el PDF
    // aparece. Es best-effort y nunca altera lo que se le responde al cliente.
    if (paymentsComplete && String(process.env.NDV_CONVERTIR_POST_PAGO || "1") === "1") {
      try {
        const { confirmarNota } = require("../_shared/ndv-conversion");
        const ndvCreatorId = toText(quote?.[acceptanceConfig.quoteNvdIdTextField]);
        if (ndvCreatorId) await confirmarNota(ndvCreatorId);
      } catch (error) {
        console.warn(`[status] confirmación de nota de venta falló: ${toText(error?.message || error)}`);
      }
    }

    sendJson(res, 200, {
      success: true,
      quote: { id: quoteId, name: quoteName },
      // "co" = Colombia: pago.html muestra COP, trato de usted y solo tarjeta.
      pais,
      currencyId: mpConfig.currencyId,
      includeIva: amounts.includeIva,
      // Regla del recargo tarjeta — MISMA fuente que create-preference
      // (Rodrigo 17-ago: umbral $200.000). pago.html la lee de acá en vez de
      // espejarla hardcodeada: botón y cobro jamás se desalinean.
      recargo: {
        umbralClp: Number(process.env.MP_RECARGO_UMBRAL_CLP || 200000),
        pct: Number(process.env.MP_RECARGO_PCT || 3),
      },
      amounts: {
        oneShotClp: amounts.oneShotClp,
        oneShotItemsClp: amounts.oneShotItemsClp,
        firstMonthClp: amounts.firstMonthClp,
        recurringClp: amounts.recurringClp,
        breakdown: amounts.breakdown,
      },
      oneShot: { required: hasOneShot, approved: oneShotApproved, status: oneShotStatus },
      subscription: {
        required: hasSubscription,
        authorized: subscriptionAuthorized,
        status: subscriptionStatus,
      },
      paymentsComplete,
      transfer,
      onboarding: { ready: Boolean(onboardingUrl), url: onboardingUrl },
      finalizeError: finalizeError || undefined,
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "La sesion de pago expiro. Solicita un nuevo enlace a tu ejecutivo comercial."
        : "No se pudo obtener el estado del pago.",
      detail: toText(error?.message || error),
    });
  }
}
