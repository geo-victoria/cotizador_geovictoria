const { verifyAcceptanceToken } = require("../_shared/acceptance-token");
const { getRecord, updateRecordBestEffort, createRecord, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { getMercadoPagoConfig, isTestLaneQuote } = require("../_shared/mercadopago-config");
const { runOnboardingHandoff } = require("../_shared/onboarding-handoff");
const {
  runNdvHandoff,
  persistNdvReferences,
  quoteHasNdvReference,
} = require("../_shared/ndv-handoff");
const { runNdvSubformSetup } = require("../_shared/ndv-subforms");
const { notifyQuoteEvent } = require("../_shared/quote-internal-notify");
const {
  verifyVerificationToken,
  signVerificationPayload,
  normalizeEmail,
} = require("../_shared/verification-token");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  let bodyValue;
  try {
    bodyValue = req?.body;
  } catch (_error) {
    bodyValue = undefined;
  }

  if (bodyValue && typeof bodyValue === "object") return bodyValue;
  if (typeof bodyValue === "string") {
    try {
      return JSON.parse(bodyValue || "{}");
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

function validateRequiredInput(fields) {
  // Giro/comuna/direccion se capturan DESPUES del pago (Rodrigo 09-ago):
  // son datos de FACTURA, no de pago — la factura se emite cuando lleguen
  // (onboarding/ejecutivo). Cada campo antes de pagar cuesta ventas.
  const required = [
    ["billingPhone", "telefono de facturacion"],
    ["companyRut", "RUT de empresa"],
  ];
  const missing = required
    .filter(([key]) => !toText(fields?.[key]))
    .map(([, label]) => label);
  return missing;
}

function toZohoDateTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "");
  return `${iso}+00:00`;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toText(value).toLowerCase());
}

function buildPaymentSessionToken(mpConfig, { quoteId, dealId, billingEmail, pais }) {
  const ttlMinutes = Math.max(5, Number(mpConfig.paymentSessionTtlMinutes) || 1440);
  return signVerificationPayload(
    {
      quoteId,
      dealId,
      billingEmail,
      // pais viaja SOLO cuando es "co" (viene del token de aceptación firmado
      // por create-from-vicky-co): así payment-session sabe que debe cobrar con
      // la app MP Colombia sin ir a Zoho, y el token chileno queda idéntico.
      ...(toText(pais).toLowerCase() === "co" ? { pais: "co" } : {}),
      exp: Date.now() + ttlMinutes * 60 * 1000,
    },
    "payment_session"
  );
}

function buildPaymentUrl(mpConfig, token) {
  return `${mpConfig.landingUrl}?${new URLSearchParams({ token }).toString()}`;
}

async function triggerHandoff(config, payload) {
  if (!config.handoffWebhookUrl) {
    const result = await runOnboardingHandoff({
      config,
      quoteId: payload.quoteId,
      dealId: payload.dealId,
      acceptanceData: payload.acceptanceData || {},
    });
    return {
      status: "OK",
      message: "handoff interno completado",
      onboardingUrl: toText(result?.onboardingUrl),
      onboardingId: toText(result?.onboardingId),
      response: result,
    };
  }

  const fallbackToInternal = async (reason) => {
    const result = await runOnboardingHandoff({
      config,
      quoteId: payload.quoteId,
      dealId: payload.dealId,
      acceptanceData: payload.acceptanceData || {},
    });
    return {
      status: "OK",
      message: `handoff interno completado (${reason})`,
      onboardingUrl: toText(result?.onboardingUrl),
      onboardingId: toText(result?.onboardingId),
      response: result,
    };
  };

  try {
    const response = await fetch(config.handoffWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let parsed = {};
    try {
      parsed = JSON.parse(text || "{}");
    } catch (_error) {
      parsed = { raw: text || "" };
    }

    if (!response.ok) {
      throw new Error(
        `handoff webhook HTTP ${response.status}: ${toText(parsed?.message || parsed?.error || parsed?.raw)}`
      );
    }

    const onboardingUrl = toText(parsed?.onboardingUrl || parsed?.link || parsed?.url);
    const onboardingId = toText(parsed?.onboardingId || parsed?.id || parsed?.onboarding_id);
    if (onboardingUrl) {
      return {
        status: "OK",
        message: "handoff enviado",
        onboardingUrl,
        onboardingId,
        response: parsed,
      };
    }

    return await fallbackToInternal("webhook_sin_onboarding_url");
  } catch (_webhookError) {
    return await fallbackToInternal("webhook_error");
  }
}

function shouldBlockNdv(config) {
  return toText(config?.ndvHandoffMode).toLowerCase() === "blocking";
}

// quoteHasNdvReference y persistNdvReferences viven en ndv-handoff.js: los
// comparten la emisión, la aceptación y el post-pago, y tener copias por
// archivo era pedir que se desincronizaran.

async function triggerNdvIfEnabled(config, payload) {
  if (!config.ndvHandoffEnabled) {
    return { status: "skipped", reason: "disabled" };
  }

  // La cotización se crea en Creator al EMITIRLA (create-from-vicky). Acá solo
  // queda la red de seguridad para cuando aquello falló. Si ya existe no se
  // toca: convertirla a Nota de Venta es el paso humano del ejecutivo.
  if (payload.quoteRow && quoteHasNdvReference(config, payload.quoteRow)) {
    return { status: "skipped", reason: "already_linked" };
  }

  try {
    const ndvResult = await runNdvHandoff({
      config,
      quoteId: payload.quoteId,
      dealId: payload.dealId,
      acceptanceData: payload.acceptanceData || {},
    });

    const ndvId = toText(ndvResult?.ndvId);
    if (ndvId) {
      await persistNdvReferences(config, payload.quoteId, ndvId);
    }

    let subformSetup = null;
    if (ndvId) {
      try {
        subformSetup = await runNdvSubformSetup({
          ndvId,
          ndvRecord: ndvResult?.ndvRecord || {},
          chargeTables: ndvResult?.chargeTables,
          notasPdf: ndvResult?.notasPdf,
        });
      } catch (subformError) {
        subformSetup = { errors: [String(subformError?.message || subformError)] };
      }
    }

    return {
      status: "ok",
      ndvId,
      reconciled: ndvResult?.reconciled === true,
      subformSetup,
    };
  } catch (error) {
    const message = toText(error?.message || error) || "Error desconocido en handoff NDV.";
    if (shouldBlockNdv(config)) {
      throw new Error(message);
    }
    return {
      status: "error",
      error: message,
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const body = await parseBody(req);
    const token = toText(body?.token);
    const verificationToken = toText(body?.verificationToken);
    const termsAccepted = body?.termsAccepted === true;
    const acceptanceData = body?.acceptanceData || {};
    const paymentMethod = toText(body?.paymentMethod);

    if (!token) {
      sendJson(res, 400, { success: false, error: "Falta token." });
      return;
    }
    if (!termsAccepted) {
      sendJson(res, 400, { success: false, error: "Debes aceptar terminos y condiciones." });
      return;
    }

    const config = getAcceptanceConfig(req);
    const mpConfig = getMercadoPagoConfig(req);
    const payload = verifyAcceptanceToken(token);
    // MÉXICO v1: sin pago en línea. La pasarela MercadoPago de este proyecto es
    // CHILENA (cuenta CL, moneda CLP; el token de sesión de pago ni siquiera
    // propaga pais "mx") — un mexicano NO puede pasar por ahí. Su camino es:
    // aceptar acá → transferir a BANORTE → mandar el comprobante por WhatsApp
    // (registrar_comprobante_transferencia le entrega el onboarding). Por lo
    // mismo, la aceptación MX TAMPOCO dispara el handoff directo: la puerta del
    // onboarding es el comprobante (decisión de dos puertas, 26-jul).
    const esMx = toText(payload.pais).toLowerCase() === "mx";
    const DATOS_TRANSFERENCIA_MX = {
      beneficiario: "CHECADOR, S.A. de C.V.",
      rfc: "CEC2005286R4",
      banco: "BANORTE",
      cuenta: "1161438886",
      clabe: "072180011614388864",
      swift: "MENOMXMTXXX",
      moneda: "MXN",
    };
    const MX_TRANSFER_MESSAGE =
      "Cotización aceptada. El pago inicial es por transferencia bancaria a " +
      "CHECADOR, S.A. de C.V. (RFC CEC2005286R4) — BANORTE, cuenta 1161438886, " +
      "CLABE 072180011614388864, SWIFT MENOMXMTXXX, en pesos mexicanos (MXN). Cuando transfieras, manda el comprobante por el " +
      "mismo chat de WhatsApp donde recibiste esta cotización: ahí mismo te " +
      "habilitamos la configuración de tu cuenta.";
    const quote = await getRecord(config.quoteModule, payload.quoteId);
    // Bypass de pago para la empresa de prueba (HuelleroCompany): en vez de ir a
    // MercadoPago, se trata la cotización como pagada y se finaliza directo
    // (mismo handoff que crea el COT). Permite testear el flujo completo sin pago.
    const bypassPayment = isTestLaneQuote(quote, config);
    const currentOnboardingUrl = toText(quote?.[config.quoteOnboardingUrlField]);
    const currentOnboardingLookup = toText(quote?.[config.quoteOnboardingLookupField]?.id);
    let authoritativeContactEmail = normalizeEmail(quote?.[config.contactEmailField]);
    // Correo de facturacion POSPUESTO (Rodrigo 09-ago): si el form no lo trae,
    // se asume el correo de contacto de la cotizacion — la captura post-pago
    // de datos de factura puede entregar uno distinto y ahi se actualiza.
    let billingEmailFromForm = normalizeEmail(acceptanceData?.billingEmail);
    if (!isValidEmail(billingEmailFromForm) && isValidEmail(authoritativeContactEmail)) {
      billingEmailFromForm = authoritativeContactEmail;
    }

    const currentStatus = toText(quote?.[config.quoteStatusField]);
    const alreadyAccepted = /Aceptada/i.test(currentStatus);
    const existingAcceptedAt = toText(quote?.[config.quoteAcceptanceAtField]);
    const acceptedAtIso = existingAcceptedAt || toZohoDateTime();

    // Edicion post-aceptacion (Rodrigo 09-ago): una aceptada que vuelve con
    // datos de facturacion corregidos o completados (giro/comuna/direccion
    // que quedaron vacios) los actualiza en la cotizacion antes de reanudar
    // el pago — el cliente debe poder completar sus datos, no quedar preso
    // de lo que alcanzo a llenar al aceptar. Best-effort: un fallo del
    // update jamas frena el camino al pago.
    if (alreadyAccepted && acceptanceData && typeof acceptanceData === "object") {
      const cambios = {};
      const setSi = (field, value) => {
        const v = toText(value);
        if (field && v && v !== toText(quote?.[field])) cambios[field] = v;
      };
      setSi(config.billingEmailField, billingEmailFromForm);
      setSi(config.billingPhoneField, acceptanceData.billingPhone);
      setSi(config.companyRutField, acceptanceData.companyRut);
      setSi(config.companyGiroField, acceptanceData.companyGiro);
      setSi(config.companyComunaField, acceptanceData.companyComuna);
      setSi(config.companyAddressField, acceptanceData.companyAddress);
      if (Object.keys(cambios).length > 0) {
        try {
          await updateRecordBestEffort(config.quoteModule, payload.quoteId, cambios, true);
          Object.assign(quote, cambios);
        } catch (updateError) {
          console.error("[confirm] update post-aceptacion fallo:", toText(updateError?.message || updateError));
        }
      }
    }

    if (alreadyAccepted && currentOnboardingUrl) {
      let ndv = { status: "skipped", reason: "already_linked" };
      if (config.ndvHandoffEnabled && !quoteHasNdvReference(config, quote)) {
        try {
          ndv = await triggerNdvIfEnabled(config, {
            quoteId: payload.quoteId,
            dealId: payload.dealId,
            acceptanceData: {
              billingEmail: normalizeEmail(quote?.[config.billingEmailField]),
              billingPhone: toText(quote?.[config.billingPhoneField]),
              companyGiro: toText(quote?.[config.companyGiroField]),
              companyRut: toText(quote?.[config.companyRutField]),
              companyComuna: toText(quote?.[config.companyComunaField]),
              companyAddress: toText(quote?.[config.companyAddressField]),
            },
          });
        } catch (ndvError) {
          sendJson(res, 502, {
            success: false,
            alreadyAccepted: true,
            quoteId: payload.quoteId,
            acceptedAt: acceptedAtIso,
            error: "La cotizacion ya fue aceptada, pero fallo la creacion de NDV.",
            detail: toText(ndvError?.message || ndvError),
          });
          return;
        }
      }

      sendJson(res, 200, {
        success: true,
        alreadyAccepted: true,
        quoteId: payload.quoteId,
        onboardingUrl: currentOnboardingUrl,
        onboardingId: currentOnboardingLookup,
        ndv,
        acceptedAt: acceptedAtIso,
        message: "La cotizacion ya estaba aceptada.",
      });
      return;
    }
    if (alreadyAccepted) {
      // MX ya aceptada: se repiten las instrucciones de transferencia. Nunca
      // se reanuda el "journey de pago" chileno ni se entrega onboarding.
      if (esMx && !bypassPayment) {
        sendJson(res, 200, {
          success: true,
          alreadyAccepted: true,
          requiresPayment: false,
          mxTransfer: true,
          datosTransferencia: DATOS_TRANSFERENCIA_MX,
          quoteId: payload.quoteId,
          acceptedAt: acceptedAtIso,
          message: "Esta cotizacion ya fue aceptada. " + MX_TRANSFER_MESSAGE,
        });
        return;
      }
      // Con pagos habilitados, una cotizacion aceptada sin onboarding implica
      // que el pago/suscripcion aun esta pendiente: reanudamos el journey de pago.
      // Excepción: empresa de prueba (bypassPayment) → recupera onboarding/COT sin pago.
      if (mpConfig.enabled && !bypassPayment) {
        const sessionToken = buildPaymentSessionToken(mpConfig, {
          quoteId: payload.quoteId,
          dealId: payload.dealId,
          billingEmail: normalizeEmail(quote?.[config.billingEmailField]),
          pais: payload.pais,
        });
        sendJson(res, 200, {
          success: true,
          alreadyAccepted: true,
          requiresPayment: true,
          quoteId: payload.quoteId,
          acceptedAt: acceptedAtIso,
          paymentUrl: buildPaymentUrl(mpConfig, sessionToken),
          paymentSessionToken: sessionToken,
          message:
            "Esta cotizacion ya fue aceptada. Continua con el pago para activar tu servicio.",
        });
        return;
      }

      try {
        const handoffResult = await triggerHandoff(config, {
          eventType: "quote.accepted.recover",
          quoteId: payload.quoteId,
          dealId: payload.dealId,
          acceptedAt: acceptedAtIso,
          termsVersion: toText(quote?.[config.quoteTermsVersionField]) || config.termsVersion,
          acceptanceData: {
            billingEmail: normalizeEmail(quote?.[config.billingEmailField]),
            billingPhone: toText(quote?.[config.billingPhoneField]),
            companyGiro: toText(quote?.[config.companyGiroField]),
            companyRut: toText(quote?.[config.companyRutField]),
            companyComuna: toText(quote?.[config.companyComunaField]),
            companyAddress: toText(quote?.[config.companyAddressField]),
          },
        });
        const recoveredOnboardingUrl = toText(handoffResult?.onboardingUrl);
        if (!recoveredOnboardingUrl) {
          throw new Error("No se pudo recuperar el enlace de onboarding para cotizacion aceptada.");
        }
        sendJson(res, 200, {
          success: true,
          alreadyAccepted: true,
          quoteId: payload.quoteId,
          onboardingUrl: recoveredOnboardingUrl,
          onboardingId: toText(handoffResult?.onboardingId || currentOnboardingLookup),
          acceptedAt: acceptedAtIso,
          message: "La cotizacion ya estaba aceptada.",
        });
        return;
      } catch (recoveryError) {
        sendJson(res, 409, {
          success: false,
          alreadyAccepted: true,
          quoteId: payload.quoteId,
          acceptedAt: acceptedAtIso,
          error:
            "Esta cotizacion ya fue aceptada y no se pudo recuperar el enlace de onboarding. Contacta a tu ejecutivo comercial.",
          detail: toText(recoveryError?.message || recoveryError),
        });
        return;
      }
    }

    const missing = validateRequiredInput(acceptanceData);
    if (missing.length > 0) {
      sendJson(res, 400, {
        success: false,
        error: `Faltan datos requeridos: ${missing.join(", ")}.`,
      });
      return;
    }

    if (!isValidEmail(billingEmailFromForm)) {
      sendJson(res, 400, {
        success: false,
        error: "Debes ingresar un correo de facturacion valido para continuar.",
      });
      return;
    }

    // Cotización emitida SIN correo de contacto (entrega por WhatsApp, Lalo
    // 03-ago): la aceptación no se bloquea — el correo de facturación que el
    // cliente acaba de ingresar pasa a ser su correo de contacto y se
    // respalda en la cotización.
    let backfillContactEmail = false;
    if (!isValidEmail(authoritativeContactEmail)) {
      authoritativeContactEmail = billingEmailFromForm;
      backfillContactEmail = true;
    }

    // Política Lalo 24-jul: el OTP ya NO es requisito para aceptar. Si el
    // front (una pestaña vieja) igual manda un verificationToken, se valida
    // como siempre; si no viene, la aceptación sigue sin verificación.
    if (!alreadyAccepted && verificationToken) {
      let verificationPayload = null;
      try {
        verificationPayload = verifyVerificationToken(verificationToken, "quote_email_verified");
      } catch (_error) {
        sendJson(res, 400, {
          success: false,
          error: "La verificacion de correo no es valida o expiro. Solicita un nuevo codigo.",
        });
        return;
      }

      if (toText(verificationPayload?.quoteId) !== toText(payload?.quoteId)) {
        sendJson(res, 400, {
          success: false,
          error: "La verificacion de correo no corresponde a esta cotizacion.",
        });
        return;
      }
      if (toText(verificationPayload?.dealId) !== toText(payload?.dealId)) {
        sendJson(res, 400, {
          success: false,
          error: "La verificacion de correo no corresponde al Deal de esta cotizacion.",
        });
        return;
      }
      if (normalizeEmail(verificationPayload?.email) !== authoritativeContactEmail) {
        sendJson(res, 400, {
          success: false,
          error: "El correo verificado no coincide con el correo de contacto de la cotizacion.",
        });
        return;
      }
    }

    if (!alreadyAccepted) {
      const updateMap = {
        [config.quoteStatusField]: "Aceptada",
        [config.quoteAcceptanceAtField]: acceptedAtIso,
        [config.quoteTermsAcceptedField]: true,
        [config.quoteTermsVersionField]: config.termsVersion,
        [config.billingEmailField]: billingEmailFromForm,
        [config.billingPhoneField]: toText(acceptanceData.billingPhone),
        [config.companyGiroField]: toText(acceptanceData.companyGiro),
        [config.companyRutField]: toText(acceptanceData.companyRut),
        [config.companyComunaField]: toText(acceptanceData.companyComuna),
        [config.companyAddressField]: toText(acceptanceData.companyAddress),
        [config.quoteHandoffStatusField]: config.quoteOnboardingStatusPending || "En Curso",
        [config.quoteHandoffErrorField]: "",
      };
      if (backfillContactEmail) {
        updateMap[config.contactEmailField] = authoritativeContactEmail;
      }
      if (config.quoteEmailVerifiedField) {
        updateMap[config.quoteEmailVerifiedField] = true;
      }
      if (config.quoteEmailVerifiedAtField) {
        updateMap[config.quoteEmailVerifiedAtField] = acceptedAtIso;
      }
      await updateRecordBestEffort(config.quoteModule, payload.quoteId, updateMap, true);

      // Notificación interna al equipo (best-effort, no bloquea la aceptación).
      // Solo en la PRIMERA aceptación (estamos dentro de !alreadyAccepted).
      await notifyQuoteEvent({ config, quote, quoteId: payload.quoteId, evento: "aceptada" });
    }

    // Forma de pago elegida por el cliente: se deja como NOTA en la cotizacion
    // (best-effort, nunca rompe la aceptacion). Hoy solo "transferencia" agrega
    // nota; el pago con tarjeta sigue su flujo normal de pasarela.
    if (paymentMethod === "transferencia") {
      try {
        await createRecord(
          "Notes",
          {
            Note_Title: "Forma de pago elegida: transferencia bancaria",
            Note_Content:
              "El cliente eligio pagar por transferencia bancaria desde la pagina de aceptacion. Queda pendiente el envio del comprobante al ejecutivo para procesar el pedido.",
            Parent_Id: payload.quoteId,
            se_module: config.quoteModule,
          },
          false
        );
      } catch (noteErr) {
        console.warn(
          "[confirm] No se pudo crear la nota de transferencia:",
          (noteErr && noteErr.message) || noteErr
        );
      }
    }

    // MÉXICO: aceptada, con nota, y el cliente vuelve al chat con los datos de
    // la transferencia. Ni MercadoPago (pasarela chilena) ni handoff (la puerta
    // del onboarding es el comprobante por WhatsApp).
    if (esMx && !bypassPayment) {
      try {
        await createRecord(
          "Notes",
          {
            Note_Title: "Aceptada (MX) — pago por transferencia pendiente",
            Note_Content:
              "El cliente acepto la cotizacion desde la pagina. Pago inicial por transferencia BANORTE; queda pendiente el comprobante por WhatsApp (registrar_comprobante_transferencia lo habilita).",
            Parent_Id: payload.quoteId,
            se_module: config.quoteModule,
          },
          false
        );
      } catch (noteErr) {
        console.warn("[confirm] nota MX no creada:", (noteErr && noteErr.message) || noteErr);
      }
      sendJson(res, 200, {
        success: true,
        requiresPayment: false,
        mxTransfer: true,
        datosTransferencia: DATOS_TRANSFERENCIA_MX,
        quoteId: payload.quoteId,
        dealId: payload.dealId,
        acceptedAt: acceptedAtIso,
        message: MX_TRANSFER_MESSAGE,
      });
      return;
    }

    // Pagos habilitados: se difiere el handoff a onboarding hasta que el pago
    // unico + la suscripcion recurrente queden confirmados (via webhook/status).
    // Excepción: empresa de prueba (bypassPayment) → NO pasa por pago, cae al
    // handoff directo de abajo (crea el COT), para testear sin MercadoPago.
    if (mpConfig.enabled && !bypassPayment) {
      await updateRecordBestEffort(
        config.quoteModule,
        payload.quoteId,
        { [config.quoteHandoffStatusField]: mpConfig.statusPaymentPending },
        true
      );
      const sessionToken = buildPaymentSessionToken(mpConfig, {
        quoteId: payload.quoteId,
        dealId: payload.dealId,
        billingEmail: billingEmailFromForm,
        pais: payload.pais,
      });
      sendJson(res, 200, {
        success: true,
        requiresPayment: true,
        quoteId: payload.quoteId,
        dealId: payload.dealId,
        acceptedAt: acceptedAtIso,
        paymentUrl: buildPaymentUrl(mpConfig, sessionToken),
        paymentSessionToken: sessionToken,
        message: "Cotizacion aceptada. Continua con el pago para activar tu servicio.",
      });
      return;
    }

    let handoffResult = null;
    let ndvResult = { status: "skipped", reason: "not_executed" };
    try {
      handoffResult = await triggerHandoff(config, {
        eventType: "quote.accepted",
        quoteId: payload.quoteId,
        dealId: payload.dealId,
        acceptedAt: acceptedAtIso,
        termsVersion: config.termsVersion,
        acceptanceData: {
          billingEmail: billingEmailFromForm,
          billingPhone: toText(acceptanceData.billingPhone),
          companyGiro: toText(acceptanceData.companyGiro),
          companyRut: toText(acceptanceData.companyRut),
          companyComuna: toText(acceptanceData.companyComuna),
          companyAddress: toText(acceptanceData.companyAddress),
        },
      });

      const onboardingUrl = toText(handoffResult?.onboardingUrl);
      if (!onboardingUrl) {
        throw new Error("No se obtuvo onboardingUrl durante handoff.");
      }

      ndvResult = await triggerNdvIfEnabled(config, {
        quoteId: payload.quoteId,
        dealId: payload.dealId,
        quoteRow: quote,
        acceptanceData: {
          billingEmail: billingEmailFromForm,
          billingPhone: toText(acceptanceData.billingPhone),
          companyGiro: toText(acceptanceData.companyGiro),
          companyRut: toText(acceptanceData.companyRut),
          companyComuna: toText(acceptanceData.companyComuna),
          companyAddress: toText(acceptanceData.companyAddress),
        },
      });
    } catch (handoffError) {
      const handoffMessage = toText(handoffError?.message || handoffError).slice(0, 255);
      await updateRecordBestEffort(
        config.quoteModule,
        payload.quoteId,
        {
          [config.quoteHandoffStatusField]: config.quoteOnboardingStatusError || "Error",
          [config.quoteHandoffErrorField]: handoffMessage,
        },
        true
      );

      sendJson(res, 502, {
        success: false,
        error:
          "La cotizacion fue aceptada, pero fallo el enlace hacia onboarding. Contacta a tu ejecutivo comercial.",
        detail: handoffMessage,
      });
      return;
    }

    sendJson(res, 200, {
      success: true,
      quoteId: payload.quoteId,
      dealId: payload.dealId,
      acceptedAt: acceptedAtIso,
      onboardingUrl: toText(handoffResult?.onboardingUrl),
      onboardingId: toText(handoffResult?.onboardingId),
      ndv: ndvResult,
      message: "Cotizacion aceptada correctamente.",
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "Esta cotizacion ya expiro. Contacta a tu ejecutivo comercial para actualizarla."
        : "No se pudo confirmar la aceptacion.",
      detail: String(error?.message || error),
    });
  }
}
