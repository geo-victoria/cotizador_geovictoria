/**
 * Finalizacion del journey luego de que el pago unico + la suscripcion quedaron
 * confirmados en Mercado Pago.
 *
 * Reune los handoffs que en el flujo SIN pago hace `confirm.js`:
 *   1. Onboarding handoff (genera/recupera el link de auto-onboarding).
 *   2. NDV handoff (nota de venta en Zoho Creator), best-effort.
 *
 * Es IDEMPOTENTE: `runOnboardingHandoff` reutiliza el onboarding existente, por
 * lo que puede invocarse tanto desde el webhook como desde el endpoint de estado
 * sin duplicar registros.
 */

const { getRecord, toText, updateRecordBestEffort } = require("./zoho-crm");
const { runOnboardingHandoff } = require("./onboarding-handoff");
const {
  runNdvHandoff,
  quoteHasNdvReference,
  persistNdvReferences,
} = require("./ndv-handoff");
const { runNdvSubformSetup } = require("./ndv-subforms");
const { normalizeEmail } = require("./verification-token");
const { notifyQuoteEvent } = require("./quote-internal-notify");
const {
  sanitizeItems,
  clampDescuentoPct,
  computePaymentAmounts,
  computePaymentAmountsCO,
  computePaymentAmountsPE,
} = require("./quote-pricing");
const { getMercadoPagoConfigForQuoteCO, getMercadoPagoConfigForQuotePE } = require("./mercadopago-config");
const { esCotizacionCO, esCotizacionPE } = require("./payment-session");
const {
  searchPaymentsByExternalReference,
  buildExternalReference,
  hasApprovedPayment,
} = require("./mercadopago-client");

function buildAcceptanceDataFromQuote(config, quote) {
  return {
    billingEmail: normalizeEmail(quote?.[config.billingEmailField]),
    billingPhone: toText(quote?.[config.billingPhoneField]),
    companyGiro: toText(quote?.[config.companyGiroField]),
    companyRut: toText(quote?.[config.companyRutField]),
    companyComuna: toText(quote?.[config.companyComunaField]),
    companyAddress: toText(quote?.[config.companyAddressField]),
  };
}

/**
 * @returns {Promise<{ onboardingUrl: string, onboardingId: string, ndv: object, reused: boolean }>}
 */
async function finalizeAfterPayment({ config, quoteId, dealId }) {
  const quote = await getRecord(config.quoteModule, quoteId);
  const resolvedDealId = toText(
    dealId || quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]
  );
  const acceptanceData = buildAcceptanceDataFromQuote(config, quote);

  // Onboarding y NDV en paralelo: son independientes entre sí y juntos sumarían
  // ~30 s secuenciales; en paralelo el techo baja a ~15 s.
  console.log("[finalize] iniciando onboarding + NDV en paralelo");
  // La cotización se crea en Creator al EMITIRLA (create-from-vicky). Acá solo
  // queda la red de seguridad: si aquella vez falló o se quedó sin tiempo de
  // función, se crea ahora. Si ya existe, no se toca — la conversión a Nota de
  // Venta es el paso humano del ejecutivo.
  const ndvYaExiste = quoteHasNdvReference(config, quote);
  if (ndvYaExiste) {
    console.log(`[finalize] cotización ${quoteId} ya está en Creator; no se recrea.`);
  }

  const [handoffResult, ndvResultRaw] = await Promise.all([
    runOnboardingHandoff({ config, quoteId, dealId: resolvedDealId, acceptanceData }),
    config.ndvHandoffEnabled && !ndvYaExiste
      ? runNdvHandoff({ config, quoteId, dealId: resolvedDealId, acceptanceData }).catch((err) => ({
          _error: toText(err?.message || err),
        }))
      : Promise.resolve(null),
  ]);
  console.log("[finalize] onboarding + NDV completados");

  const onboardingUrl = toText(handoffResult?.onboardingUrl);
  if (!onboardingUrl) {
    throw new Error("No se obtuvo onboardingUrl al finalizar el pago.");
  }

  // Notificación interna "pagada" ANTES del trabajo lento de NDV (subforms):
  // si la función muere por timeout después de crear el onboarding, el
  // reintento entra por reused=true y ya nadie notifica (le pasó a COT315
  // Lotus Pet el 31-jul: pago OK, onboarding OK, cero correo PAGADA). Solo en
  // la PRIMERA finalización (onboarding nuevo) para no duplicar entre el
  // webhook y el polling de status; best-effort: jamás bloquea el onboarding.
  if (handoffResult?.reused !== true) {
    try {
      await notifyQuoteEvent({ config, quote, quoteId, evento: "pagada" });
    } catch (notifyError) {
      console.warn(`[finalize] notificación PAGADA falló: ${toText(notifyError?.message || notifyError)}`);
    }
  }

  // NDV best-effort: no debe bloquear la entrega del onboarding tras un pago OK.
  let ndv = { status: "skipped", reason: ndvYaExiste ? "already_linked" : "disabled" };
  if (config.ndvHandoffEnabled && !ndvYaExiste) {
    if (ndvResultRaw?._error) {
      console.warn(`[finalize] NDV handoff error: ${ndvResultRaw._error}`);
      ndv = { status: "error", error: ndvResultRaw._error };
    } else {
      try {
        const ndvResult = ndvResultRaw;
        const ndvId = toText(ndvResult?.ndvId);
        if (ndvId) {
          await persistNdvReferences(config, quoteId, ndvId);
        }
        console.log(`[finalize] NDV id=${ndvId}, iniciando subforms`);
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
        console.log(`[finalize] subforms done: ${JSON.stringify(subformSetup)}`);
        ndv = { status: "ok", ndvId, reconciled: ndvResult?.reconciled === true, subformSetup };
      } catch (error) {
        ndv = { status: "error", error: toText(error?.message || error) };
      }
    }
  }

  // El pago CONVIERTE la cotización en nota de venta y la confirma (orden de
  // Lalo, 15-ago). Hasta hoy ese paso lo hacía una ejecutiva a mano en Creator.
  //
  // Va al final y siempre en best-effort: el onboarding y la notificación ya
  // salieron, y si Creator falla la nota se puede convertir después sin que el
  // cliente note nada.
  let notaDeVenta = { status: "skipped" };
  if (config.ndvHandoffEnabled && String(process.env.NDV_CONVERTIR_POST_PAGO || "1") === "1") {
    const cotCreatorId = toText(ndv?.ndvId) || toText(quote?.[config.quoteNvdIdTextField]);
    if (!cotCreatorId) {
      notaDeVenta = { status: "skipped", reason: "sin cotización en Creator" };
    } else {
      try {
        const { convertirYConfirmar } = require("./ndv-conversion");
        // Solo CONVIERTE. La confirmación va en una pasada posterior
        // (api/creator/confirmar-pendientes), cuando el PDF ya existe: la
        // cadena entera no cabe en el tiempo de una función y el corte nos
        // dejaba sin saber si había fallado algo de verdad.
        notaDeVenta = await convertirYConfirmar(cotCreatorId, { confirmar: false });
        console.log(`[finalize] nota de venta: ${JSON.stringify(notaDeVenta)}`);
      } catch (error) {
        notaDeVenta = { status: "error", error: toText(error?.message || error) };
        console.warn(`[finalize] conversión a nota de venta falló: ${notaDeVenta.error}`);
      }
    }
  }

  return {
    onboardingUrl,
    onboardingId: toText(handoffResult?.onboardingId),
    reused: handoffResult?.reused === true,
    ndv,
    notaDeVenta,
  };
}

/**
 * Carga la cotizacion, calcula los montos requeridos, consulta el estado real
 * en Mercado Pago (pago unico + suscripcion) y, si ambos flujos estan
 * completos y el onboarding aun no existe, lo finaliza.
 *
 * Pensado para el webhook (no recibe token; resuelve todo a partir del quoteId).
 *
 * @returns {Promise<{ paymentsComplete: boolean, onboardingUrl: string,
 *   oneShotApproved: boolean, subscriptionAuthorized: boolean, finalized: boolean }>}
 */
async function maybeFinalizeQuote({ mpConfig, acceptanceConfig, quoteId, dealId }) {
  const quote = await getRecord(acceptanceConfig.quoteModule, quoteId);
  if (!quote) {
    throw new Error(`No se encontro la cotizacion ${quoteId}.`);
  }

  // País: el webhook ya trae la config CO cuando la firma CO validó (fast
  // path); los demás llamadores (reconcile-pending) pasan siempre la config
  // chilena, así que detectamos por Deal/Territorio. Si es CO se recalcula la
  // config (respetando el carril sandbox de la empresa de prueba) y los montos
  // CO (con el IVA del hardware incluido), para que oneShotApproved
  // busque los pagos con el token correcto y compare contra el monto correcto.
  const pais =
    mpConfig?.pais === "co" || (await esCotizacionCO(quote, null, acceptanceConfig))
      ? "co"
      : mpConfig?.pais === "pe" || (await esCotizacionPE(quote, null, acceptanceConfig))
        ? "pe"
        : "cl";
  if (pais === "co") {
    mpConfig = getMercadoPagoConfigForQuoteCO(null, quote, acceptanceConfig);
  } else if (pais === "pe") {
    mpConfig = getMercadoPagoConfigForQuotePE(null, quote, acceptanceConfig);
  }

  const items = sanitizeItems(quote?.[acceptanceConfig.quoteItemsSubformField]);
  const descuentoPct = clampDescuentoPct(quote?.[acceptanceConfig.quoteDiscountPctField]);
  const amounts =
    pais === "co"
      ? computePaymentAmountsCO(items)
      : pais === "pe"
        ? computePaymentAmountsPE(items)
        : computePaymentAmounts(items, descuentoPct, {
            includeIva: mpConfig.includeIva,
            // FIX Gescor/COT395 (13-ago): el checkout cobra el PRIMER MES en el
            // pago inicial (oneShotIncludeFirstMonth), pero el finalize lo
            // calculaba sin él — toda cotización SOLO SOFTWARE daba oneShot=0,
            // 'no hay cobro online' y el pago aprobado en MP quedaba invisible
            // para siempre. Misma fórmula en ambas caras, siempre.
            includeFirstMonth: mpConfig.oneShotIncludeFirstMonth,
          });

  const hasOneShot = amounts.oneShotClp > 0;
  // Suscripción MP RETIRADA (Lalo 12-ago): la mensualidad va SIEMPRE por
  // facturación en todos los países; el único cobro online es el pago inicial.
  const hasSubscription = false;

  let oneShotApproved = !hasOneShot;
  if (hasOneShot) {
    const payments = await searchPaymentsByExternalReference(
      mpConfig,
      buildExternalReference(quoteId, "oneshot")
    );
    oneShotApproved = hasApprovedPayment(payments);
    // QUIÉN PAGÓ (Lalo 04-ago): MP captura la identidad del pagador en cada
    // pago con tarjeta — el titular puede ser otra persona que el contacto de
    // la cotización (caso Grupo Dog Delivery). Se persiste en campos propios
    // (Pagador_Nombre / Pagador_RUT) la PRIMERA vez que se ve el pago
    // aprobado; nunca se pisa un valor ya escrito. Best-effort.
    if (oneShotApproved) {
      const aprobado = (payments || []).find(
        (p) => String(p?.status || "").toLowerCase() === "approved"
      );
      const titular = aprobado?.card?.cardholder || {};
      const nombrePagador =
        toText(titular.name) ||
        [toText(aprobado?.payer?.first_name), toText(aprobado?.payer?.last_name)]
          .filter(Boolean)
          .join(" ");
      const rutPagador =
        toText(titular?.identification?.number) ||
        toText(aprobado?.payer?.identification?.number);
      const sinPagadorPrevio =
        !toText(quote?.Pagador_Nombre) && !toText(quote?.Pagador_RUT);
      if ((nombrePagador || rutPagador) && sinPagadorPrevio) {
        await updateRecordBestEffort(acceptanceConfig.quoteModule, quoteId, {
          ...(nombrePagador ? { Pagador_Nombre: nombrePagador.slice(0, 255) } : {}),
          ...(rutPagador ? { Pagador_RUT: rutPagador.slice(0, 50) } : {}),
        }, true);
        console.log(
          `[finalize] pagador registrado en ${quoteId}: ${nombrePagador || "(sin nombre)"} · ${rutPagador || "(sin RUT)"}`
        );
      }
    }
  }

  const subscriptionAuthorized = true;

  // GUARDA (caso real Aitas COT215, 10-jul): si NO hay ningún cobro online
  // que verificar (monto $0 por configuración o por la naturaleza de la
  // cotización), ambas condiciones quedarían "cumplidas" en el vacío y la
  // cotización se declararía PAGADA sin que exista NINGÚN pago en Mercado
  // Pago — con NDV, onboarding y correo "PAGADA" gatillados solos. Eso pasó
  // con una cotización solo-software mientras un env apagaba el cobro del
  // primer mes: la clienta pagó por transferencia y el sistema "confirmó" un
  // pago que nunca vio. Regla: la finalización AUTOMÁTICA exige al menos una
  // confirmación real de MP; sin nada que cobrar online (ej. transferencia),
  // la finalización es manual/conciliación.
  const hayCobroOnline = hasOneShot || hasSubscription;
  const paymentsComplete = hayCobroOnline && oneShotApproved && subscriptionAuthorized;
  let onboardingUrl = toText(quote?.[acceptanceConfig.quoteOnboardingUrlField]);
  let finalized = false;

  if (paymentsComplete && !onboardingUrl) {
    // El finalize downstream (onboarding + NDV) corre IGUAL que Chile también
    // para CO (decisión paso 4 COLOMBIA.md); si algo resulta Chile-específico
    // se ajustará en fase 2 CO. Se deja traza para diagnosticar esos casos.
    if (pais === "co" || pais === "pe") {
      console.log(`[finalize] cotizacion ${pais.toUpperCase()} ${quoteId}: pago confirmado, finalize estandar (pasos Chile-especificos se ajustan si aparecen).`);
    }
    const result = await finalizeAfterPayment({
      config: acceptanceConfig,
      quoteId,
      dealId: dealId || toText(quote?.[acceptanceConfig.quoteDealLookupField]?.id),
    });
    onboardingUrl = toText(result?.onboardingUrl);
    finalized = true;
  }

  return { paymentsComplete, onboardingUrl, oneShotApproved, subscriptionAuthorized, finalized };
}

module.exports = {
  finalizeAfterPayment,
  maybeFinalizeQuote,
  buildAcceptanceDataFromQuote,
};
