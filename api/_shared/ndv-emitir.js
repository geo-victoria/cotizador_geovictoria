/**
 * Crear la cotización en Zoho Creator, con sus bloques de servicio.
 *
 * Un solo orquestador para los tres momentos en que hoy nace una cotización
 * en Creator:
 *   1. La EMISIÓN (create-from-vicky): el momento natural — lo que Creator crea
 *      es una Cotización, no una nota de venta confirmada.
 *   2. Un DESCUENTO POSTERIOR (aplicar-siguiente-descuento,
 *      aplicar-descuento-telefonico): el precio cambió y se regeneró el PDF, así
 *      que corresponde una cotización NUEVA que refleje el precio acordado. La
 *      anterior queda en Creator como la versión superada, igual que las
 *      versiones del PDF.
 *   3. La ACEPTACIÓN y el POST-PAGO: red de seguridad, solo si 1 falló.
 *
 * Siempre best-effort: nada de lo que pase acá puede afectar una cotización que
 * el cliente ya recibió.
 */

const { getRecordWithFields, toText } = require("./zoho-crm");
const { runNdvHandoff, persistNdvReferences, quoteHasNdvReference } = require("./ndv-handoff");
const { runNdvSubformSetup } = require("./ndv-subforms");

/**
 * @param {boolean} [args.forzarNueva] Crea otra cotización aunque ya exista una
 *   asociada. Lo usa el camino del descuento: ahí una cotización nueva es
 *   justamente lo que se quiere, no un duplicado accidental.
 * @param {object} [args.escalerasPrecio] Escalera de precios en memoria. La
 *   emisión la tiene en su propio request; el descuento la lee del CRM.
 * @returns {Promise<{status: string, ndvId: string, error?: string}>}
 */
async function emitirCotizacionEnCreator({
  config,
  quoteId,
  dealId,
  acceptanceData,
  escalerasPrecio,
  userCount,
  motivo = "emision",
  forzarNueva = false,
  crmIncompleto = false,
}) {
  if (!config.ndvHandoffEnabled) {
    return { status: "skipped", ndvId: "", error: "" };
  }

  // Sin Deal no hay Cuenta ni dueño que resolver, y el handoff exige ambos. El
  // caso degradado lo recoge la aceptación, cuando reconcile-crm ya corrió.
  if (!dealId || crmIncompleto) {
    console.warn(
      `[ndv-emitir:${motivo}] omitido (dealId=${dealId || "∅"}, crmIncompleto=${crmIncompleto}); queda para la aceptación.`
    );
    return { status: "skipped", ndvId: "", error: "sin_deal_o_crm_incompleto" };
  }

  const inicio = Date.now();
  try {
    if (!forzarNueva) {
      const campos = [config.quoteNvdIdTextField, config.quoteNvdLookupField].filter(Boolean);
      const existente = campos.length
        ? await getRecordWithFields(config.quoteModule, quoteId, campos).catch(() => null)
        : null;
      if (existente && quoteHasNdvReference(config, existente)) {
        console.log(`[ndv-emitir:${motivo}] la cotización ${quoteId} ya está en Creator; no se recrea.`);
        return { status: "already_linked", ndvId: "", error: "" };
      }
    }

    const resultado = await runNdvHandoff({
      config,
      quoteId,
      dealId,
      acceptanceData: acceptanceData || {},
      escalerasPrecio,
      userCount,
    });

    const ndvId = toText(resultado?.ndvId);
    if (!ndvId) {
      console.warn(`[ndv-emitir:${motivo}] Creator no devolvió ID para la cotización ${quoteId}.`);
      return { status: "sin_id", ndvId: "", error: "creator_sin_id" };
    }

    // La referencia apunta SIEMPRE a la última cotización creada: es la vigente,
    // y es contra la que la aceptación decide si tiene algo que hacer.
    await persistNdvReferences(config, quoteId, ndvId);
    await runNdvSubformSetup({
      ndvId,
      ndvRecord: resultado?.ndvRecord || {},
      chargeTables: resultado?.chargeTables,
      notasPdf: resultado?.notasPdf,
    });

    console.log(`[ndv-emitir:${motivo}] cotización en Creator id=${ndvId} (${Date.now() - inicio}ms)`);

    // GUARDRAIL DE COMPLETITUD (Lalo 01-sep, dolor Victoria Luna): si alguna
    // línea quedó FUERA del registro de Creator (sin artículo de Books, sin
    // precio utilizable, o la tabla cayó al fallback Valor=1), se deja NOTA
    // visible en la cotización de Zoho para que el equipo sepa exactamente
    // QUÉ completar antes de convertirla a Nota de Venta (la conversión
    // automática quedó apagada ese mismo día). Best-effort.
    try {
      const diag = resultado?.chargeTables?.diagnostico || {};
      const fuera = [
        ...(diag.lineasSinArticulo || []).map((n) => `${n} (sin artículo en el catálogo de Creator)`),
        ...(diag.lineasSinPrecio || []).map((n) => `${n} (sin precio utilizable — p. ej. fila en $0/oculta)`),
      ];
      if (diag.fallback || fuera.length > 0) {
        const { createRecord } = require("./zoho-crm");
        await createRecord("Notes", {
          Note_Title: "⚠️ Cotización en Creator INCOMPLETA — completar antes de convertir a NDV",
          Note_Content:
            `El registro de esta cotización en Creator (id ${ndvId}) quedó incompleto:\n` +
            (diag.fallback
              ? `· La tabla de cobro cayó al FALLBACK (Valor=1) — NINGUNA línea con precio utilizable llegó a Creator. NO convertir sin corregirla.\n`
              : "") +
            (fuera.length ? fuera.map((f) => `· Fuera del registro: ${f}`).join("\n") + "\n" : "") +
            `Antes de convertir a Nota de Venta, editar la Cotización en Creator y completar estas líneas a mano. ` +
            `(Guardrail automático 01-sep — la conversión automática está apagada justamente por esto.)`,
          Parent_Id: quoteId,
          $se_module: config.quoteModule,
        }).catch(() => {});
        console.warn(
          `[ndv-emitir:${motivo}] Creator INCOMPLETO quote=${quoteId}: fallback=${Boolean(diag.fallback)} fuera=${fuera.length}`,
        );
      }
    } catch {
      /* best-effort */
    }
    return { status: "ok", ndvId, error: "" };
  } catch (error) {
    const detalle = toText(error?.message || error).slice(0, 300);
    console.error(`[ndv-emitir:${motivo}] falló (${Date.now() - inicio}ms): ${detalle}`);
    return { status: "error", ndvId: "", error: detalle };
  }
}

module.exports = { emitirCotizacionEnCreator };
