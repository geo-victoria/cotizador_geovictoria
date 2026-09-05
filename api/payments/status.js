const { toText, getRecordWithFields } = require("../_shared/zoho-crm");
const { resolvePaymentSession } = require("../_shared/payment-session");
const {
  searchPaymentsByExternalReference,
  buildExternalReference,
  hasApprovedPayment,
} = require("../_shared/mercadopago-client");
const { finalizeAfterPayment, marcarEstadoPagada } = require("../_shared/post-payment-finalize");
const { onboardingPorChat } = require("../_shared/onboarding-chat");
const { notifyQuoteEvent } = require("../_shared/quote-internal-notify");

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

// Correo de la fila "Email" en los datos de transferencia (Lalo 18-ago, dos
// vueltas): vicky@ confundía (el cliente creía que el comprobante iba por
// correo, y el caso SURCONTROL llegó SOLO por el aviso del banco a esa
// casilla). La fila ahora muestra al PROPIETARIO del deal/cotización en Zoho
// — el aviso automático del banco le llega directo a quien gestiona la venta.
// Vicky robot no cuenta (interina): se cae al Owner del DEAL y, sin humano,
// al env TRANSFER_CONTACT_EMAIL (vacío = la fila no sale). El canal del
// COMPROBANTE sigue siendo el botón de WhatsApp.
const TRANSFER_CONTACT_EMAIL = toText(process.env.TRANSFER_CONTACT_EMAIL || "");
const ROBOT_EMAIL = "vicky@geovictoria.com";
// pago.html hace poll de /status cada pocos segundos: el Owner del deal y su
// ficha de usuario se cachean para no pegarle a Zoho en cada tick.
const _ownerMailCache = new Map();
async function propietarioHumano(quote) {
  const propio = quote?.Owner || null;
  let mail = toText(propio?.email).toLowerCase();
  if (mail && mail !== ROBOT_EMAIL) {
    return { id: toText(propio?.id), email: mail, name: toText(propio?.name) };
  }
  const dealId = toText(quote?.Deal_Asociado?.id || quote?.Deal_Asociado);
  if (!dealId) return null;
  const hit = _ownerMailCache.get(dealId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.dueno;
  const deal = await getRecordWithFields("Deals", dealId, ["Owner"]).catch(() => null);
  const dm = toText(deal?.Owner?.email).toLowerCase();
  const dueno =
    dm && dm !== ROBOT_EMAIL
      ? { id: toText(deal?.Owner?.id), email: dm, name: toText(deal?.Owner?.name) }
      : null;
  _ownerMailCache.set(dealId, { dueno, at: Date.now() });
  return dueno;
}
// Teléfono del ejecutivo desde su ficha de usuario en Zoho (phone → mobile).
const _userPhoneCache = new Map();
async function telefonoUsuario(userId) {
  if (!userId) return "";
  const hit = _userPhoneCache.get(userId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.fono;
  let fono = "";
  try {
    const { zohoApiFetch } = require("../_shared/zoho-auth");
    const r = await zohoApiFetch(`/crm/v3/users/${encodeURIComponent(userId)}`, { method: "GET" });
    if (r && r.ok) {
      const data = await r.json().catch(() => ({}));
      const u = Array.isArray(data?.users) ? data.users[0] : null;
      fono = toText(u?.phone) || toText(u?.mobile);
    }
  } catch (_e) {
    fono = "";
  }
  _userPhoneCache.set(userId, { fono, at: Date.now() });
  return fono;
}
async function buildTransferInfo(quote) {
  const dueno = await propietarioHumano(quote).catch(() => null);
  // WHATSAPP DEL COMPROBANTE (Lalo 19-ago, caso MATER): el del EJECUTIVO
  // propietario de la cotización, con su nombre — el cliente del canal
  // ejecutivo le habla a SU vendedor, no a Vicky. Fallbacks: dueño humano
  // sin teléfono en su ficha de Zoho, o cotización de Vicky (dueño robot)
  // → Vicky como siempre (el botón JAMÁS puede desaparecer — bug 25-jul).
  // Ojo operativo: cuando el comprobante va al ejecutivo, el registro del
  // pago y el onboarding dejan de ser automáticos — los procesa él.
  let executiveName = "Vicky";
  let whatsappPhone = normalizeWhatsappPhone(VICKY_WHATSAPP_PHONE);
  if (dueno && dueno.id) {
    const fono = normalizeWhatsappPhone(await telefonoUsuario(dueno.id).catch(() => ""));
    if (fono) {
      executiveName = toText(dueno.name).split(" ")[0] || "tu ejecutivo";
      whatsappPhone = fono;
    }
  }
  return {
    executiveName,
    whatsappPhone,
    transferEmail: (dueno && dueno.email) || TRANSFER_CONTACT_EMAIL,
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
    // ONBOARDING DE VICKY POR CHAT (05-sep, caso Josefa/COT1250): si el
    // contacto está en el alta por WhatsApp del agente, el cliente NO va al
    // wizard — Vicky le manda el formulario de alta al confirmarse el pago.
    // Se pregunta al agente ANTES de generar el link; ante cualquier falla se
    // sigue con el wizard de siempre (fail-closed al comportamiento anterior).
    const chatOnboarding = paymentsComplete ? await onboardingPorChat(acceptanceConfig, quoteId, pais) : false;

    // Pago real verificado en MP → "Pagada" al tiro (Lalo 24-ago). Solo con
    // cobro online efectivo: el camino sin cobro (transferencia) se declara
    // pagado por comprobante/conciliación, jamás solo (guarda Aitas).
    if (hasOneShot && oneShotApproved) {
      const estadoVolteado = await marcarEstadoPagada(acceptanceConfig, quote, quoteId);
      // UN PAGO, UN CORREO (31-ago, COT1042): el aviso interno PAGADA lo manda
      // SOLO quien hizo la transición real a Pagada — este polling incluido,
      // porque el webhook de MP puede no llegar (a Daniela la pilló el polling
      // 34 min después y nadie notificó).
      if (estadoVolteado) {
        try {
          await notifyQuoteEvent({ config: acceptanceConfig, quote, quoteId, evento: "pagada" });
        } catch (notifyError) {
          console.warn(`[status] notificación PAGADA falló: ${toText(notifyError?.message || notifyError)}`);
        }
      }
    }

    if (paymentsComplete && !onboardingUrl && !chatOnboarding) {
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
      onboarding: chatOnboarding
        ? { ready: true, chat: true, url: "" }
        : { ready: Boolean(onboardingUrl), url: onboardingUrl },
      finalizeError: finalizeError || undefined,
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    // El 500 salía MUDO en los runtime logs (caso Patiño 25-ago: 4×500 justo
    // post-pago y cero rastro del porqué) — el detalle queda registrado.
    if (!isExpired) {
      console.error(`[status] 500: ${toText(error?.message || error)}`, error?.stack ? String(error.stack).slice(0, 400) : "");
    }
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "La sesion de pago expiro. Solicita un nuevo enlace a tu ejecutivo comercial."
        : "No se pudo obtener el estado del pago.",
      detail: toText(error?.message || error),
    });
  }
}
