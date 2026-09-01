/**
 * Endpoint: POST /api/quote-acceptance/aplicar-siguiente-descuento
 *
 * Avanza una cotización al siguiente escalón de descuento según el orden de
 * negocio (ver DISCOUNT_LADDER en proposal-constants.js). Regenera el PDF
 * con la versión incrementada (mismo número de cotización, nueva fecha/hora,
 * "vN" en el header), lo sube a Supabase Storage y actualiza Zoho.
 *
 * Reemplaza al endpoint anterior escalar-descuento.js, que solo subía el %
 * recurrente y no regeneraba PDF.
 *
 * Body:
 *   { "quoteId": "<id de la cotización en Zoho>" }
 *
 * Respuesta exitosa:
 *   {
 *     ok: true,
 *     version: 2,
 *     link_pdf: "https://cotizacion.geovictoria.com/pdf/...",
 *     ultimo_escalon: {
 *       tipo: "instalacion_rm" | "recurrente_10" | ...,
 *       pct: 50,
 *       condicion_discursiva: null | "Este descuento aplica si pagas..."
 *     },
 *     tope_alcanzado: false,
 *     mensaje_para_prospecto: "Texto que Vicky copia tal cual al cliente"
 *   }
 *
 * Respuesta cuando ya no hay más escalones:
 *   { ok: false, error: "TOPE_ALCANZADO", tope_alcanzado: true }
 */

const {
  getRecord,
  getRecordWithFields,
  updateRecord,
  toText,
} = require("../_shared/zoho-crm");
const { actualizarPunteroPdf } = require("../_shared/pointer-sync");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { tramoModuloCL } = require("../_shared/tramos-cl");
const {
  DISCOUNT_LADDER,
  mesesDescuentoNormalizados,
} = require("../_shared/proposal-constants");
const {
  normalizarIndiceGuardado,
  siguienteEscalonAplicable,
  hayEscalonDespues,
  descuentosHasta,
} = require("../_shared/discount-engine");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");
const { leerMesesDescuento } = require("../_shared/descuento-meses");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return typeof req.body === "object" && req.body ? req.body : {};
}

// Índice del primer escalón recurrente (sobre el plan) cuyo pct cubre `pct`
// (es decir, el menor escalón con pct >= pct pedido). Si `pct` supera el tope,
// devuelve el último escalón de la escalera. Devuelve -1 si pct <= 0.
function idxEscalonRecurrentePorPct(pct) {
  const target = Number(pct) || 0;
  if (target <= 0) return -1;
  let ultimoRecurrente = -1;
  for (let i = 0; i < DISCOUNT_LADDER.length; i++) {
    ultimoRecurrente = i;
    if (DISCOUNT_LADDER[i].pct >= target) return i;
  }
  // Pidió más que el tope: comiteamos hasta el máximo recurrente disponible.
  return ultimoRecurrente;
}

// Decide hasta qué escalón comitear. En el flujo nuevo, la negociación ocurre
// vía consultar-siguiente-descuento, que va avanzando Escalon_Negociacion. Al
// aceptar, comiteamos TODO el nivel negociado de una sola vez (un solo PDF):
//
//   - Si hubo negociación (Escalon_Negociacion > Escalon_Descuento), el último
//     escalón ofrecido es (Escalon_Negociacion - 1); comiteamos hasta ahí.
//   - Si NO hubo negociación previa (llamada directa al commit), avanzamos un
//     solo escalón aplicable desde lo comiteado — comportamiento clásico.
//
// GARANTÍA "lo ofrecido = lo aplicado": si Vicky ya le comunicó un % al cliente
// (pctOfrecido), comiteamos AL MENOS el escalón recurrente que cubre ese %,
// aunque el puntero de negociación se haya quedado atrás (modelo que se adelantó
// a las tools). Esto evita el desfase "ofrezco 20 / aplico 10". Queda acotado
// por la escalera, así que nunca compromete más del tope (20%).
//
// Devuelve { targetIdx, escalon } o null si no hay más escalones aplicables.
function elegirNivelACommitear(quote, config, pctOfrecido) {
  // Índices guardados con la escalera vieja (pre jul-2026) → re-derivar.
  const recComiteado = Number(quote?.[config.quoteDiscountPctField] || 0);
  const commitIdx = normalizarIndiceGuardado(quote?.[config.quoteEscalonField], recComiteado);
  const negocIdx = normalizarIndiceGuardado(quote?.[config.quoteEscalonNegociacionField], recComiteado);

  let targetIdx;
  if (negocIdx > commitIdx) {
    // Último escalón ofrecido durante la negociación.
    targetIdx = negocIdx - 1;
  } else {
    // Sin negociación previa: siguiente escalón aplicable desde lo comiteado.
    targetIdx = siguienteEscalonAplicable(quote, config, commitIdx);
  }

  // Piso por el % que Vicky ya prometió de palabra al cliente.
  const minIdx = idxEscalonRecurrentePorPct(pctOfrecido);
  if (minIdx >= 0 && minIdx > targetIdx) targetIdx = minIdx;

  if (targetIdx < 0 || targetIdx >= DISCOUNT_LADDER.length) return null;
  return { targetIdx, escalon: DISCOUNT_LADDER[targetIdx] };
}

// Carga datos de cliente para regenerar el HTML del PDF. Espejo simplificado
// de lo que arma create-from-vicky.js en el primer PDF.
async function buildClienteParaHtml(quote, config) {
  const dealId = toText(
    quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]
  );
  const accountId = toText(quote?.Cuenta_Asociada?.id);
  const contactId = toText(
    quote?.[config.quoteContactLookupField]?.id ||
      quote?.[config.quoteContactLookupField]
  );

  const account = accountId
    ? await getRecordWithFields("Accounts", accountId, ["Account_Name", "RUT_Empresa"])
    : null;
  const contact = contactId
    ? await getRecordWithFields("Contacts", contactId, ["First_Name", "Last_Name"])
    : null;

  const contactoFullName = [contact?.First_Name, contact?.Last_Name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    empresa: toText(account?.Account_Name) || toText(quote?.Name) || "EMPRESA",
    contacto: contactoFullName || "",
    contactoEmail: toText(quote?.[config.contactEmailField]),
    rutEmpresa: toText(quote?.[config.companyRutField]) || toText(account?.RUT_Empresa),
    ejecutivo: "Vicky - Equipo Comercial GeoVictoria",
    ejecutivoEmail: "vicky@geovictoria.com",
    ejecutivoTelefono: "+56 9 6730 8227",
  };
}

// Convierte el subform de Zoho a la forma que espera buildProposalHtml en
// cotizacion.items (mismo shape que envía Vicky en create-from-vicky).
function subformACotizacionItems(quote, config) {
  const subform = quote?.[config.quoteItemsSubformField];
  if (!Array.isArray(subform)) return [];
  return subform.map((row) => {
    const modalidadZoho = String(row?.Modalidad || "");
    const codigo = String(row?.Codigo_Item || "").toLowerCase();
    // El builder usa item.tipo para enrutar la fila a servicios / equipos /
    // serviciosAsoc. Reconstruimos el tipo a partir del código y modalidad.
    let tipo = "modulo";
    if (codigo === "instalacion_reloj" || codigo === "plan_anual") tipo = "servicio";
    else if (modalidadZoho === "Arriendo" || modalidadZoho === "Venta") tipo = "hardware";
    // Marca OCULTO del subform (anualidad 01-sep): el PDF no pinta la fila.
    let oculto = false;
    try {
      oculto = JSON.parse(String(row?.Metadata_Item_JSON || "null"))?.oculto === true;
    } catch { /* sin metadata */ }
    return {
      tipo,
      oculto,
      id: codigo,
      nombre: String(row?.Nombre_Item || ""),
      descripcion: String(row?.Descripcion_Item || ""),
      modalidad:
        modalidadZoho === "Recurrente"
          ? "Por usuario"
          : modalidadZoho === "Único"
          ? "Fijo"
          : modalidadZoho === "Arriendo"
          ? "Arriendo mensual"
          : modalidadZoho === "Venta"
          ? "Venta única"
          : "Cobro único",
      cantidad: Number(row?.Cantidad || 0),
      precioUnitarioUF: Number(row?.Precio_Unitario_UF || 0),
      subtotalUF: Number(row?.Subtotal_UF || 0),
      zonaTarifa: String(row?.[config.quoteItemZonaTarifaField] || ""),
      // Descuento por línea (bonificaciones acordadas, ej. envío −100%).
      descuentoPct: Number(row?.Descuento_Pct || 0),
      // Tramo del módulo, DERIVADO (caso Grey/COT347 05-ago): el subform no
      // persiste tierAplicado y el PDF regenerado perdía el "Tramo X-Y".
      tierAplicado:
        tipo === "modulo"
          ? tramoModuloCL({
              modalidad:
                modalidadZoho === "Recurrente" || modalidadZoho === "Por usuario"
                  ? "Por usuario"
                  : "Fijo",
              cantidad: Number(row?.Cantidad || 0),
              precioUnitarioUF: Number(row?.Precio_Unitario_UF || 0),
            })
          : undefined,
    };
  });
}

const { getUFActualSafe } = require("../_shared/uf-actual");
const { ufDeCotizacion } = require("../_shared/uf-cotizacion");

// Número de cotización para el PDF: correlativo de Zoho sin el prefijo "COT".
function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

function buildMensajeParaProspecto(escalon, linkAceptacion, mesesPlan) {
  let cuerpo;
  if (escalon.tipo === "instalacion_rm") {
    cuerpo = `Puedo aplicarte un ${escalon.pct}% de descuento en la instalación (Región Metropolitana).`;
  } else if (escalon.tipo === "instalacion_region") {
    cuerpo = `Puedo aplicarte un ${escalon.pct}% de descuento en la instalación.`;
  } else {
    cuerpo = `Puedo aplicarte un ${escalon.pct}% de descuento sobre el plan mensual.`;
  }
  const partes = [cuerpo];
  // Descuento de plan (recurrente): aclarar que aplica solo los primeros N meses.
  const esDescuentoPlan =
    escalon.tipo !== "instalacion_rm" && escalon.tipo !== "instalacion_region";
  if (esDescuentoPlan) {
    // Vigencia real de ESTA cotización (Lalo 10-ago): por defecto 6 meses,
    // pero el ejecutivo pudo fijar otra o dejarla indefinida.
    const n = mesesDescuentoNormalizados(mesesPlan);
    partes.push(
      n === 0
        ? "El descuento no tiene vencimiento: se mantiene mientras dure el servicio."
        : `Aplica ${n === 1 ? "el primer mes" : `los primeros ${n} meses`}; desde el mes ${n + 1} el plan vuelve a su tarifa normal.`,
    );
  }
  if (escalon.condicionDiscursiva) partes.push(escalon.condicionDiscursiva);
  partes.push(`Aquí revisas, aceptas y pagas tu cotización actualizada: ${linkAceptacion}`);
  return partes.join(" ");
}

const crypto = require("crypto");
const { emitirCotizacionEnCreator } = require("../_shared/ndv-emitir");

// waitUntil: corre trabajo en segundo plano DESPUÉS de responder, dentro de la
// misma invocación. La cotización nueva en Creator no debe hacer esperar a Vicky.
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch (_e) {
  waitUntil = (p) => {
    Promise.resolve(p).catch(() => {});
  };
}


module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });
  }

  if (!secretoValido(req)) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  let stage = "init";
  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    }
    // % que Vicky ya le comunicó al cliente (opcional). Garantiza que lo
    // comiteado no quede por debajo de lo ofrecido. Se acota luego por la
    // escalera, así que un valor inflado nunca compromete más del tope.
    const pctOfrecido = Math.max(0, Number(body.pctOfrecido || 0)) || 0;

    stage = "fetch_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });
    }

    // 1. Decidir hasta qué escalón comitear (todo el nivel negociado).
    stage = "elegir_escalon";
    const eleccion = elegirNivelACommitear(quote, config, pctOfrecido);
    if (!eleccion) {
      // No hay nada nuevo que comitear. Si el cliente está ACEPTANDO un descuento
      // que ya quedó aplicado (re-aceptar el tope), NO es un error: devolvemos el
      // PDF vigente para que Vicky lo re-entregue (idempotente). Antes esto caía
      // en TOPE_ALCANZADO → el guardrail lo mostraba como "tuve un problema".
      const pdfVigente = toText(quote?.[config.quotePdfUrlField]);
      const commitIdx = Math.max(0, Number(quote?.[config.quoteEscalonField] || 0));
      const escalonComiteado = commitIdx > 0 ? DISCOUNT_LADDER[commitIdx - 1] : null;
      if (pdfVigente && escalonComiteado) {
        return sendJson(res, 200, {
          ok: true,
          version: Math.max(1, Number(quote?.[config.quoteVersionPdfField] || 1)),
          link_pdf: pdfVigente,
          acceptance_url: toText(quote?.[config.quoteAcceptanceUrlField]) || undefined,
          ultimo_escalon: {
            tipo: escalonComiteado.tipo,
            pct: escalonComiteado.pct,
            condicion_discursiva: escalonComiteado.condicionDiscursiva,
          },
          tope_alcanzado: true,
          ya_comiteado: true,
          mensaje_para_prospecto: `Ese es el mejor precio que te puedo dejar. Aquí tienes tu cotización: ${pdfVigente}`,
        });
      }
      return sendJson(res, 200, {
        ok: false,
        error: "TOPE_ALCANZADO",
        tope_alcanzado: true,
      });
    }
    const { targetIdx, escalon } = eleccion;
    const nuevoEscalonIdx = targetIdx + 1; // forma "siguiente índice" para guardar

    // 2. Descuentos ACUMULADOS hasta el nivel a comitear (instalación RM/región
    //    + recurrente conviven). `escalon` es el último efectivamente aplicado.
    stage = "consolidar_descuentos";
    const { descuentos: descAcum } = descuentosHasta(quote, config, targetIdx);
    const descRecNuevo = descAcum.recurrentePct;
    const descRMNuevo = descAcum.instalacionRMPct;
    const descRegionNuevo = descAcum.instalacionRegionPct;
    // Vigencia del descuento de ESTA cotización (null = política por defecto).
    const mesesPlanQuote = await leerMesesDescuento(quoteId, quote);

    // 3. Versionar.
    stage = "version_bump";
    const versionActual = Math.max(1, Number(quote?.[config.quoteVersionPdfField] || 1));
    const versionNueva = versionActual + 1;

    // 4. Regenerar el PDF.
    stage = "render_pdf";
    const cliente = await buildClienteParaHtml(quote, config);
    // UF de la cotización primero (campo UF_Valor / derivada del subform);
    // UF del día solo como último recurso (pedido Lalo 06-ago).
    const ufQuote = ufDeCotizacion(quote, config.quoteItemsSubformField);
    const ufActual = ufQuote.uf > 0 ? ufQuote.uf : await getUFActualSafe();
    const items = subformACotizacionItems(quote, config);

    // acceptanceUrl: regeneramos el token con la misma data, expiración fresca
    // según validityDays. La página de aceptación trabaja contra el mismo
    // quoteId/dealId.
    const dealId = toText(
      quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]
    );
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const acceptanceToken = signAcceptancePayload({
      quoteId,
      dealId,
      iat: Date.now(),
      exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(acceptanceToken)}`;

    const html = buildProposalHtml({
      cliente,
      cotizacion: { items, ufActual },
      acceptanceUrl,
      cotizacionId: numeroParaPdf(quote && quote.Numero_Cotizacion, quoteId),
      validezHasta: new Date(expMs).toISOString(),
      version: versionNueva,
      descuentos: {
        recurrentePct: descRecNuevo,
        instalacionRMPct: descRMNuevo,
        instalacionRegionPct: descRegionNuevo,
        // Vigencia propia si el ejecutivo la definió (Lalo 10-ago).
        mesesPlan: mesesPlanQuote,
      },
      condicionDiscursiva: escalon.condicionDiscursiva,
    });

    stage = "upload_pdf";
    const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
    const { pdfUrl } = await uploadPdfToSupabase({
      pdfBuffer,
      quoteId,
      empresa: cliente.empresa,
    });

    // 5. Persistir el nuevo estado en Zoho. PDF_URL apunta al último PDF;
    //    los anteriores quedan archivados en Supabase Storage.
    stage = "update_quote";
    await updateRecord(
      config.quoteModule,
      quoteId,
      {
        [config.quoteDiscountPctField]: descRecNuevo,
        [config.quoteDiscountInstRMPctField]: descRMNuevo,
        [config.quoteDiscountInstRegionPctField]: descRegionNuevo,
        [config.quoteDiscountUnlockedField]: true,
        [config.quoteEscalonField]: nuevoEscalonIdx,
        // Sincronizamos el puntero de negociación con lo comiteado: cualquier
        // negociación futura arranca desde acá.
        [config.quoteEscalonNegociacionField]: nuevoEscalonIdx,
        [config.quoteVersionPdfField]: versionNueva,
        [config.quotePdfUrlField]: pdfUrl,
        [config.quoteAcceptanceUrlField]: acceptanceUrl,
      },
      true
    );
    // Propaga al puntero de Supabase (principio Lalo 07-ago: el PDF nuevo en TODOS lados)
    await actualizarPunteroPdf(quoteId, pdfUrl);

    // Precio nuevo → cotización NUEVA en Creator. No se actualiza la anterior:
    // queda como la versión superada, igual que las versiones del PDF. En
    // segundo plano, porque el agente está esperando esta respuesta.
    waitUntil(
      emitirCotizacionEnCreator({
        config,
        quoteId,
        dealId,
        motivo: "descuento",
        forzarNueva: true,
      })
    );

    const topeAlcanzado = !hayEscalonDespues(quote, config, targetIdx);

    return sendJson(res, 200, {
      ok: true,
      version: versionNueva,
      link_pdf: pdfUrl,
      // Link de aceptación NUEVO (token regenerado): el agente actualiza su
      // puntero durable con esto — sin él, el guardrail anti-alucinación
      // bloquea reenvíos legítimos del link (caso Bioval 15-jul).
      acceptance_url: acceptanceUrl,
      ultimo_escalon: {
        tipo: escalon.tipo,
        pct: escalon.pct,
        condicion_discursiva: escalon.condicionDiscursiva,
      },
      tope_alcanzado: topeAlcanzado,
      mensaje_para_prospecto: buildMensajeParaProspecto(escalon, acceptanceUrl, mesesPlanQuote),
    });
  } catch (error) {
    console.error(`[aplicar-siguiente-descuento] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo aplicar el siguiente descuento.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};
