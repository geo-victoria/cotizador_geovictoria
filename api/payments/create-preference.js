const { toText } = require("../_shared/zoho-crm");
const { resolvePaymentSession } = require("../_shared/payment-session");
const { pickInitPoint } = require("../_shared/mercadopago-config");
const { createPreference, buildExternalReference } = require("../_shared/mercadopago-client");

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

function landingUrl(mpConfig, token, extraParams) {
  const params = new URLSearchParams({ token, ...(extraParams || {}) });
  return `${mpConfig.landingUrl}?${params.toString()}`;
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

    // Country-aware vía resolvePaymentSession: para una cotización CO,
    // mpConfig es la app MP Colombia (COP, sandbox si es la empresa de prueba,
    // oneShotTitle "Activación") y amounts viene con montos finales (sin IVA,
    // precios finales 10-jul) SIN primer
    // mes extra (firstMonthClp=0: la Activación ya lo es) → la preferencia sale
    // en COP con una sola línea. Chile sigue idéntico. back_urls/notification
    // no cambian: el webhook es compartido y decide país por la firma.
    const session = await resolvePaymentSession(req, token);
    const { mpConfig, quoteId, dealId, billingEmail, quoteName, amounts } = session;

    if (!mpConfig.enabled) {
      sendJson(res, 409, { success: false, error: "Pagos con Mercado Pago no habilitados." });
      return;
    }

    if (amounts.oneShotClp <= 0) {
      sendJson(res, 200, { success: true, skipped: true, reason: "no_one_shot" });
      return;
    }

    const externalReference = buildExternalReference(quoteId, "oneshot");

    // ETIQUETA PARA REPORTES (Lalo 04-ago): la "Descripción" de los reportes
    // descargables de MP sale del TÍTULO del ítem del checkout — la metadata
    // NO aparece en esos exports. Con el título genérico, finanzas no podía
    // saber de qué empresa era cada pago. El título ahora lleva número de
    // cotización + empresa + RUT/NIT; el cliente lo ve igual en el checkout
    // (informativo, no molesta).
    const idTributario = session.pais === "co" ? "NIT" : "RUT";
    const etiquetaReporte = [
      toText(session.quote?.Numero_Cotizacion) || `Cotizacion ${quoteId}`,
      toText(session.quote?.Cuenta_Asociada?.name),
      session.companyRut ? `${idTributario} ${session.companyRut}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200);

    // Lineas del checkout: servicios iniciales (una vez) + primer mes de
    // servicio prepagado (si corresponde). El total = amounts.oneShotClp.
    const items = [];
    if (amounts.oneShotItemsClp > 0) {
      items.push({
        id: `qa-${quoteId}-oneshot`,
        title: `${mpConfig.oneShotTitle} — ${etiquetaReporte}`.slice(0, 256),
        description: quoteName || `Cotizacion ${quoteId}`,
        quantity: 1,
        unit_price: amounts.oneShotItemsClp,
        currency_id: mpConfig.currencyId,
      });
    }
    if (amounts.firstMonthClp > 0) {
      items.push({
        id: `qa-${quoteId}-firstmonth`,
        title: `Primer mes de servicio (adelantado) — ${etiquetaReporte}`.slice(0, 256),
        description: quoteName || `Cotizacion ${quoteId}`,
        quantity: 1,
        unit_price: amounts.firstMonthClp,
        currency_id: mpConfig.currencyId,
      });
    }

    // RECARGO TARJETA sobre $100.000 (Lalo 10-ago): hasta ese monto, pagar
    // con Mercado Pago no tiene costo extra para el cliente; sobre el umbral
    // se traspasa un 3% como LÍNEA VISIBLE del checkout (transparencia — y
    // en montos grandes el camino sin recargo es la transferencia). Umbral y
    // porcentaje por env; MP_RECARGO_PCT=0 lo apaga. Solo Chile: la regla es
    // en CLP y Colombia no tiene transferencia como alternativa.
    let recargoClp = 0;
    if (session.pais !== "co") {
      const recargoUmbral = Number(process.env.MP_RECARGO_UMBRAL_CLP || 100000);
      const recargoPct = Number(process.env.MP_RECARGO_PCT || 3);
      if (recargoPct > 0 && amounts.oneShotClp > recargoUmbral) {
        recargoClp = Math.round((amounts.oneShotClp * recargoPct) / 100);
        items.push({
          id: `qa-${quoteId}-recargo-tarjeta`,
          title: `Recargo pago con tarjeta (${recargoPct}%) — ${etiquetaReporte}`.slice(0, 256),
          description: "Sin costo pagando por transferencia bancaria",
          quantity: 1,
          unit_price: recargoClp,
          currency_id: mpConfig.currencyId,
        });
      }
    }

    // Petición de FINANZAS (30-jul): que el registro del pago diga QUIÉN paga.
    // El payer con nombre + identificación queda visible en la actividad y los
    // reportes de Mercado Pago; empresa y nombre van además en metadata (junto
    // al quote_id/deal_id de Zoho que ya viajaban) para los exports por API.
    const pagadorNombre = toText(
      session.quote?.Contacto_Facturacion?.name || session.quote?.Contacto_Asociado?.name,
    );
    const pagadorEmpresa = toText(session.quote?.Cuenta_Asociada?.name);
    const partesNombre = pagadorNombre.split(/\s+/).filter(Boolean);
    const payer = {
      ...(billingEmail ? { email: billingEmail } : {}),
      ...(partesNombre.length
        ? {
            name: partesNombre.slice(0, -1).join(" ") || partesNombre[0],
            surname: partesNombre.length > 1 ? partesNombre.slice(-1)[0] : undefined,
          }
        : {}),
      ...(session.companyRut
        ? {
            identification: {
              type: session.pais === "co" ? "NIT" : "RUT",
              number: session.companyRut,
            },
          }
        : {}),
    };

    const preference = {
      items,
      payer: Object.keys(payer).length ? payer : undefined,
      back_urls: {
        success: landingUrl(mpConfig, token, { oneshot: "success" }),
        pending: landingUrl(mpConfig, token, { oneshot: "pending" }),
        failure: landingUrl(mpConfig, token, { oneshot: "failure" }),
      },
      auto_return: "approved",
      notification_url: mpConfig.notificationUrl,
      external_reference: externalReference,
      statement_descriptor: mpConfig.statementDescriptor,
      metadata: {
        quote_id: quoteId,
        deal_id: dealId,
        kind: "oneshot",
        pagador_nombre: pagadorNombre || undefined,
        empresa: pagadorEmpresa || undefined,
        rut_empresa: session.companyRut || undefined,
      },
    };

    const created = await createPreference(mpConfig, preference);
    sendJson(res, 200, {
      success: true,
      skipped: false,
      preferenceId: toText(created?.id),
      initPoint: pickInitPoint(created, mpConfig),
      amountClp: amounts.oneShotClp + recargoClp,
      recargoClp,
      currencyId: mpConfig.currencyId,
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "La sesion de pago expiro. Solicita un nuevo enlace a tu ejecutivo comercial."
        : "No se pudo crear el pago unico.",
      detail: toText(error?.message || error),
    });
  }
}

