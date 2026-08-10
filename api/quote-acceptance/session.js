const { verifyAcceptanceToken } = require("../_shared/acceptance-token");
const { leerMesesDescuento } = require("../_shared/descuento-meses");
const {
  mesesDescuentoNormalizados,
  textoVigenciaDescuento,
  textoVigenciaCorto,
} = require("../_shared/proposal-constants");
const { getRecord, getRecordWithFields, getUserById, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { getMercadoPagoConfig } = require("../_shared/mercadopago-config");
const { signVerificationPayload } = require("../_shared/verification-token");
const {
  computePaymentAmounts,
  computePaymentAmountsCO,
  computeTotalsCO,
  computeTotalsMX,
} = require("../_shared/quote-pricing");

// Minteo del link de pago para un cliente que VUELVE a una cotización ya
// aceptada pero sin pagar. Espejo de confirm.js (no se importa para no acoplar
// session.js — lectura — al handler de aceptación). Mantener en sync si cambia.
function buildPaymentUrlForQuote(mpConfig, { quoteId, dealId, billingEmail, pais }) {
  const ttlMinutes = Math.max(5, Number(mpConfig.paymentSessionTtlMinutes) || 1440);
  const token = signVerificationPayload(
    {
      quoteId,
      dealId,
      billingEmail,
      // pais solo viaja cuando es "co": payment-session cobra con la app MP
      // Colombia sin ir a Zoho; el token chileno queda idéntico al de siempre.
      ...(toText(pais).toLowerCase() === "co" ? { pais: "co" } : {}),
      exp: Date.now() + ttlMinutes * 60 * 1000,
    },
    "payment_session"
  );
  return `${mpConfig.landingUrl}?${new URLSearchParams({ token }).toString()}`;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sanitizeItems(items, fieldMap) {
  if (!Array.isArray(items)) return [];
  return items.map((row) => ({
    nombre: toText(row?.[fieldMap.itemName]),
    cantidad: Number(row?.[fieldMap.qty] || 0),
    precioUnitarioUf: Number(row?.[fieldMap.unitUF] || 0),
    precioUnitarioClp: Number(row?.[fieldMap.unitCLP] || 0),
    subtotalUf: Number(row?.[fieldMap.subtotalUF] || 0),
    subtotalClp: Number(row?.[fieldMap.subtotalCLP] || 0),
    modalidad: toText(row?.[fieldMap.modalidad]),
    afectoIva: row?.[fieldMap.afectoIva] === true,
    codigo: toText(row?.[fieldMap.codigo]),
    zonaTarifa: toText(row?.[fieldMap.zonaTarifa]),
  }));
}

function sumBy(items, key) {
  return (items || []).reduce((acc, row) => acc + Number(row?.[key] || 0), 0);
}

function isRecurrentModalidad(value) {
  const modalidad = toText(value).toLowerCase();
  if (!modalidad) return true;
  if (modalidad.includes("venta")) return false;
  if (modalidad.includes("no recurrente")) return false;
  return true;
}

function clampDescuentoPct(value) {
  const n = Math.round(Number(value || 0));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(30, Math.round(n / 5) * 5));
}

function clampInstalacionPctLocal(value) {
  const n = Math.round(Number(value || 0));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(50, n));
}

function isInstalacionRow(row) {
  return String(row?.codigo || "").toLowerCase() === "instalacion_reloj";
}

function getZonaTarifaLocal(row) {
  const raw = String(row?.zonaTarifa || "").toLowerCase().trim();
  if (raw === "rm") return "RM";
  if (raw === "regiones" || raw === "region") return "regiones";
  return null;
}

// descuentos = { recurrentePct, instalacionRMPct, instalacionRegionPct }
// (acepta también número simple como antes para no romper callers viejos).
//
// Devuelve los totales YA con los descuentos aplicados (lo que efectivamente
// se cobra), más los valores BRUTOS (sin descuento) por separado para que el
// front pueda mostrar la referencia tachada. Convención idéntica al PDF
// (proposal-html-builder / quote-pricing):
//   - El descuento de instalación se aplica por línea (solo a ítems de
//     instalación según su zona tarifa). Esas líneas son pago único.
//   - El descuento recurrente se aplica al bucket recurrente (plan mensual +
//     primer mes). Nunca se solapa con el de instalación.
function computeTotals(items, descuentos = 0) {
  const rows = Array.isArray(items) ? items : [];

  let recRecurrente = typeof descuentos === "number" ? descuentos : descuentos?.recurrentePct;
  let recInstRM = typeof descuentos === "number" ? 0 : descuentos?.instalacionRMPct;
  let recInstRegion = typeof descuentos === "number" ? 0 : descuentos?.instalacionRegionPct;
  const pctRec = clampDescuentoPct(recRecurrente);
  const pctInstRM = clampInstalacionPctLocal(recInstRM);
  const pctInstRegion = clampInstalacionPctLocal(recInstRegion);
  const factorRec = 1 - pctRec / 100;
  const factorInstRM = 1 - pctInstRM / 100;
  const factorInstRegion = 1 - pctInstRegion / 100;

  // Brutos (sin ningún descuento), para mostrar como referencia tachada.
  const subtotalUfBruto = sumBy(rows, "subtotalUf");
  const subtotalClpBruto = sumBy(rows, "subtotalClp");

  let subtotalNetUf = 0;
  let subtotalNetClp = 0;
  let ivaUf = 0;
  let ivaClp = 0;
  let recurrenteUfBruto = 0;
  let recurrenteClpBruto = 0;
  let recurrenteUf = 0; // neto (con descuento recurrente)
  let recurrenteClp = 0;
  let noRecurrenteUf = 0; // neto (con descuento de instalación por línea)
  let noRecurrenteClp = 0;
  let ahorroInstalacionUf = 0;
  let ahorroInstalacionClp = 0;

  rows.forEach((row) => {
    const brutoUf = Number(row?.subtotalUf || 0);
    const brutoClp = Number(row?.subtotalClp || 0);
    const recurrente = isRecurrentModalidad(row?.modalidad);

    // Factor por línea: instalación (pago único) usa el descuento de su zona;
    // el recurrente usa el descuento global del plan. No se solapan.
    let factor = 1;
    if (isInstalacionRow(row)) {
      const zona = getZonaTarifaLocal(row);
      if (zona === "RM") factor = factorInstRM;
      else if (zona === "regiones") factor = factorInstRegion;
      ahorroInstalacionUf += brutoUf * (1 - factor);
      ahorroInstalacionClp += brutoClp * (1 - factor);
    } else if (recurrente) {
      factor = factorRec;
    }

    const netUf = brutoUf * factor;
    const netClp = brutoClp * factor;

    subtotalNetUf += netUf;
    subtotalNetClp += netClp;

    const afectoIva = row?.afectoIva !== false;
    if (afectoIva) {
      ivaUf += netUf * 0.19;
      ivaClp += netClp * 0.19;
    }

    if (recurrente) {
      recurrenteUfBruto += brutoUf;
      recurrenteClpBruto += brutoClp;
      recurrenteUf += netUf;
      recurrenteClp += netClp;
    } else {
      noRecurrenteUf += netUf;
      noRecurrenteClp += netClp;
    }
  });

  return {
    // Netos (con descuentos aplicados) — lo que efectivamente se cobra.
    subtotalUf: Number(subtotalNetUf.toFixed(3)),
    subtotalClp: Math.round(subtotalNetClp),
    ivaUf: Number(ivaUf.toFixed(3)),
    ivaClp: Math.round(ivaClp),
    totalUf: Number((subtotalNetUf + ivaUf).toFixed(3)),
    totalClp: Math.round(subtotalNetClp + ivaClp),
    // Brutos (sin descuento) — referencia tachada en el front.
    subtotalUfBruto: Number(subtotalUfBruto.toFixed(3)),
    subtotalClpBruto: Math.round(subtotalClpBruto),
    // Recurrente (valor mensual): neto y bruto.
    recurrenteUf: Number(recurrenteUf.toFixed(3)),
    recurrenteClp: Math.round(recurrenteClp),
    recurrenteUfBruto: Number(recurrenteUfBruto.toFixed(3)),
    recurrenteClpBruto: Math.round(recurrenteClpBruto),
    noRecurrenteUf: Number(noRecurrenteUf.toFixed(3)),
    noRecurrenteClp: Math.round(noRecurrenteClp),
    // Porcentajes de descuento vigentes.
    descuentoPct: pctRec,
    descuentoInstalacionRMPct: pctInstRM,
    descuentoInstalacionRegionPct: pctInstRegion,
    // Alias de compatibilidad (recurrente ya viene neto).
    recurrenteUfConDescuento: Number(recurrenteUf.toFixed(3)),
    recurrenteClpConDescuento: Math.round(recurrenteClp),
    descuentoRecurrenteUf: Number((recurrenteUfBruto - recurrenteUf).toFixed(3)),
    descuentoRecurrenteClp: Math.round(recurrenteClpBruto - recurrenteClp),
    ahorroInstalacionUf: Number(ahorroInstalacionUf.toFixed(3)),
    ahorroInstalacionClp: Math.round(ahorroInstalacionClp),
  };
}

// Totales COLOMBIA (IVA 19% solo en líneas Afecto_IVA=true — hardware;
// buckets pago inicial / mensualidad): la
// lógica vive ahora en _shared/quote-pricing.js (computeTotalsCO) porque el
// flujo de pago (payment-session / finalize) la necesita también — un solo
// lugar, cero duplicación. Acá solo se consume.

async function getFallbackData(dealId) {
  const cleanDealId = toText(dealId);
  if (!cleanDealId) {
    return { deal: null, account: null, contact: null, owner: null };
  }

  const deal = await getRecordWithFields("Deals", cleanDealId, [
    "id",
    "Owner",
    "Account_Name",
    "Contact_Name",
    "Contact_Email",
    "Contact_Phone",
    "Rut_ID_Account",
    // Territorio: respaldo para detectar cotizaciones Colombia (pais "co")
    // cuando el token no viene marcado. No afecta el flujo chileno.
    "Territorio",
  ]);

  const accountId = toText(deal?.Account_Name?.id);
  const contactId = toText(deal?.Contact_Name?.id);
  const ownerId = toText(deal?.Owner?.id);

  const account = accountId
    ? await getRecordWithFields("Accounts", accountId, [
        "id",
        "RUT_Empresa",
        "Comuna",
      ])
    : null;

  const contact = contactId
    ? await getRecordWithFields("Contacts", contactId, [
        "id",
        "Email",
        "Phone",
        "Mailing_City",
        "Mailing_Street",
      ])
    : null;

  const owner = ownerId
    ? await getUserById(ownerId).catch(() => null)
    : null;

  return { deal, account, contact, owner };
}

function pickFirst(...values) {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return "";
}

function normalizeWhatsappPhone(value) {
  const raw = toText(value);
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return digits;
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

    const config = getAcceptanceConfig(req);
    const payload = verifyAcceptanceToken(token);
    const quote = await getRecord(config.quoteModule, payload.quoteId);
    const status = toText(quote?.[config.quoteStatusField]);
    const isAcceptedLocked = /Aceptada/i.test(status);
    const acceptedAt = toText(quote?.[config.quoteAcceptanceAtField]);
    const onboardingUrl = toText(quote?.[config.quoteOnboardingUrlField]);
    const onboardingToken = toText(quote?.[config.quoteOnboardingTokenField]);
    const onboardingId = toText(quote?.[config.quoteOnboardingLookupField]?.id);
    const pdfUrl = toText(quote?.[config.quotePdfUrlField]);
    const dealId = toText(quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]);
    const fallback = await getFallbackData(dealId);

    // País de la cotización. Mecanismo primario: create-from-vicky-co firma el
    // token de aceptación con pais:"co" (cero campos nuevos en Zoho, cero
    // llamadas extra) y create-from-vicky-mx con pais:"mx". Respaldo:
    // Territorio del Deal = "Colombia" / "México" (por si un link se re-mintea
    // con otra herramienta). Chile queda igual ("cl").
    const paisToken = toText(payload.pais).toLowerCase();
    const territorioDeal = toText(fallback?.deal?.Territorio);
    const pais =
      paisToken === "mx" || /m[eé]xico/i.test(territorioDeal)
        ? "mx"
        : paisToken === "co" || /colombia/i.test(territorioDeal)
          ? "co"
          : "cl";

    // La asociación de deal puede cambiar legítimamente DESPUÉS de emitido el
    // link (consolidación de duplicados, reparaciones — caso vaitiare 31-jul:
    // el deal del token se eliminó al consolidar y el link quedó "no
    // disponible" para un cliente real). El token firma la COTIZACIÓN
    // (quoteId) y esa es la identidad que importa; si el deal del token quedó
    // viejo, manda el Deal_Asociado vigente de la cotización.
    const dealIdVigente = dealId || toText(payload.dealId);
    if (dealId && dealId !== payload.dealId) {
      console.warn(
        `[session] deal del token (${payload.dealId}) distinto al vigente (${dealId}) para quote ${payload.quoteId} — se usa el vigente.`,
      );
    }

    const fieldMap = {
      itemName: "Nombre_Item",
      qty: "Cantidad",
      unitUF: "Precio_Unitario_UF",
      unitCLP: "Precio_Unitario_CLP",
      subtotalUF: "Subtotal_UF",
      subtotalCLP: "Subtotal_CLP",
      modalidad: "Modalidad",
      afectoIva: "Afecto_IVA",
      codigo: "Codigo_Item",
      zonaTarifa: config.quoteItemZonaTarifaField,
    };
    const items = sanitizeItems(quote?.[config.quoteItemsSubformField], fieldMap);
    const descuentos = {
      recurrentePct: clampDescuentoPct(quote?.[config.quoteDiscountPctField]),
      instalacionRMPct: Number(quote?.[config.quoteDiscountInstRMPctField] || 0),
      instalacionRegionPct: Number(quote?.[config.quoteDiscountInstRegionPctField] || 0),
    };
    // Vigencia del descuento del plan (Lalo 10-ago): por defecto 6 meses, pero
    // el ejecutivo pudo fijar otra o dejarla indefinida (0). La página imprime
    // el texto que viene de acá, para no tener el número escrito a mano.
    const mesesDescuento = mesesDescuentoNormalizados(await leerMesesDescuento(payload.quoteId, quote));

    // Ruteo state-aware: una cotización ACEPTADA, con pagos habilitados y SIN
    // onboarding listo significa que falta el pago. Minteamos el link de pago
    // para que la página muestre "Ir a pagar" en vez del callejón de onboarding.
    const onboardingReady = Boolean(isAcceptedLocked && onboardingUrl && onboardingToken);
    const mpConfig = getMercadoPagoConfig(req);
    const paymentsEnabled = Boolean(mpConfig.enabled);
    // MX v1: SIN pago en línea (no hay app de MercadoPago México; el pago es
    // por transferencia BANORTE, indicada en el PDF). Nunca se mintea un link
    // de pago para una cotización MX — cobraría con la app chilena en CLP.
    // CL/CO no cambian.
    const needsPayment = isAcceptedLocked && paymentsEnabled && !onboardingReady && pais !== "mx";
    const paymentUrl = needsPayment
      ? buildPaymentUrlForQuote(mpConfig, {
          quoteId: payload.quoteId,
          dealId: dealIdVigente,
          billingEmail: toText(quote?.[config.billingEmailField]),
          pais,
        })
      : "";
    // Monto del pago inicial (mismo cálculo que el checkout de MercadoPago en
    // resolvePaymentSession): one-shot + primer mes según config. Solo para
    // mostrarlo en la página; el cobro real lo recalcula el checkout.
    // CO: pago único en COP con el IVA del hardware incluido (el resto son
    // precios finales; la Activación ya es el 1er mes).
    const pagoInicialClp = needsPayment
      ? pais === "co"
        ? computePaymentAmountsCO(items).oneShotClp
        : computePaymentAmounts(items, descuentos, {
            includeIva: mpConfig.includeIva,
            includeFirstMonth: mpConfig.oneShotIncludeFirstMonth,
          }).oneShotClp
      : 0;

    sendJson(res, 200, {
      success: true,
      // "co" = Colombia (montos COP finales, sin IVA); "mx" = México (MXN,
      // IVA 16%); "cl" = Chile (sin cambios).
      pais,
      quote: {
        id: payload.quoteId,
        dealId: dealIdVigente,
        name: toText(quote?.Name),
        status,
        isAcceptedLocked,
        acceptedAt,
        onboardingUrl,
        onboardingId,
        onboardingReady,
        paymentsEnabled,
        needsPayment,
        paymentUrl,
        pagoInicialClp,
        quoteDate: toText(quote?.[config.quoteDateField]),
        pdfUrl,
        termsVersion: config.termsVersion,
        expiresAt: new Date(payload.exp).toISOString(),
        isExpired: Date.now() >= Number(payload.exp),
        contactEmail: pickFirst(
          quote?.[config.contactEmailField],
          fallback?.contact?.Email,
          fallback?.deal?.Contact_Email
        ),
        contactPhone: pickFirst(
          quote?.[config.contactPhoneField],
          fallback?.contact?.Phone,
          fallback?.deal?.Contact_Phone
        ),
        billingEmail: pickFirst(quote?.[config.billingEmailField]),
        billingPhone: pickFirst(quote?.[config.billingPhoneField]),
        companyRut: pickFirst(
          quote?.[config.companyRutField],
          fallback?.deal?.Rut_ID_Account,
          fallback?.account?.RUT_Empresa
        ),
        companyGiro: pickFirst(quote?.[config.companyGiroField]),
        companyComuna: pickFirst(
          quote?.[config.companyComunaField],
          fallback?.account?.Comuna,
          fallback?.contact?.Mailing_City
        ),
        companyAddress: pickFirst(
          quote?.[config.companyAddressField],
          fallback?.contact?.Mailing_Street
        ),
      },
      support: {
        executiveName: pickFirst(
          fallback?.owner?.full_name,
          fallback?.owner?.name,
          fallback?.deal?.Owner?.name,
          config.supportContactLabel
        ),
        executivePhone: normalizeWhatsappPhone(
          pickFirst(fallback?.owner?.phone, fallback?.owner?.mobile)
        ),
        supportEmail: config.supportContactEmail,
      },
      items,
      // Chile: totales de siempre. Colombia: además el bloque `co` (IVA 19%
      // solo en las líneas de hardware) con buckets pago inicial /
      // mensualidad (el front CO usa solo `co`). México: bloque `mx` (MXN,
      // IVA 16% por línea afecta, buckets pago inicial / mensualidad).
      descuento: {
        meses: mesesDescuento,
        indefinido: mesesDescuento === 0,
        texto: textoVigenciaDescuento(mesesDescuento),
        textoCorto: textoVigenciaCorto(mesesDescuento),
      },
      totals: {
        ...computeTotals(items, descuentos),
        ...(pais === "co" ? { co: computeTotalsCO(items) } : {}),
        ...(pais === "mx" ? { mx: computeTotalsMX(items) } : {}),
      },
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "Esta cotizacion ya expiro. Contacta a tu ejecutivo comercial para actualizarla."
        : "No se pudo cargar la sesion de aceptacion.",
      detail: String(error?.message || error),
    });
  }
}
