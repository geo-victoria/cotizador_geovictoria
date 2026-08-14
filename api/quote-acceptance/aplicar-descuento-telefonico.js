/**
 * Endpoint: POST /api/quote-acceptance/aplicar-descuento-telefonico
 *
 * Canal de VOZ (Dapta): la Vicky telefónica está autorizada a negociar un
 * precio exacto con tope de 25% de descuento sobre el plan mensual ("¿qué
 * precio te haría sentido para que cerremos ahora?", acuerdo 14-jul). Este
 * endpoint COMITEA ese acuerdo: aplica el % EXACTO pactado (no la escalera),
 * regenera el PDF versionado, lo sube a Storage y actualiza Zoho — mismo
 * pipeline que aplicar-siguiente-descuento, sin el avance por escalones.
 *
 * Lo invoca vic-dapta-postcall (whatsapp-agent) de forma DETERMINISTA cuando
 * la llamada termina con precio_acordado: sin pasar por el modelo, para que
 * "lo acordado por teléfono = lo aplicado" siempre.
 *
 * Body:
 *   { "quoteId": "<id Zoho>", "pctExacto": 17.5 }   // 0 < pct <= 25, sobre el plan
 *
 * Reglas:
 *   - Tope duro 25% (autorización comercial del canal telefónico).
 *   - Nunca REBAJA un descuento ya comiteado: si pctExacto <= lo vigente,
 *     devuelve el PDF vigente (idempotente, ya_comiteado: true).
 *   - Los descuentos de instalación vigentes se conservan tal cual.
 *   - Deja los punteros de escalera coherentes para negociaciones futuras por
 *     WhatsApp: pct >= tope de escalera → tope alcanzado; pct menor → la
 *     escalera puede seguir desde el escalón que cubre el pct.
 *
 * Auth: header x-vicky-secret == env VICKY_COTIZADORA_SECRET.
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
const { DISCOUNT_LADDER, textoVigenciaCorto } = require("../_shared/proposal-constants");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");
const { leerMesesDescuento } = require("../_shared/descuento-meses");
const { getUFActualSafe } = require("../_shared/uf-actual");
const { ufDeCotizacion } = require("../_shared/uf-cotizacion");
const crypto = require("crypto");
const { emitirCotizacionEnCreator } = require("../_shared/ndv-emitir");

// waitUntil: corre trabajo en segundo plano DESPUÉS de responder, dentro de la
// misma invocación. La cotización nueva en Creator no debe hacer esperar a
// quien llama (Vicky o el post-call de Dapta).
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch (_e) {
  waitUntil = (p) => {
    Promise.resolve(p).catch(() => {});
  };
}

const TOPE_TELEFONICO_PCT = 25;
const CONDICION_TELEFONICA =
  "Es el precio que acordamos por teléfono; aplica si pagas dentro de las próximas 72 horas.";

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

// Espejo de aplicar-siguiente-descuento (mismos lookups de cliente para el PDF).
async function buildClienteParaHtml(quote, config) {
  const accountId = toText(quote?.Cuenta_Asociada?.id);
  const contactId = toText(
    quote?.[config.quoteContactLookupField]?.id || quote?.[config.quoteContactLookupField]
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

function subformACotizacionItems(quote, config) {
  const subform = quote?.[config.quoteItemsSubformField];
  if (!Array.isArray(subform)) return [];
  return subform.map((row) => {
    const modalidadZoho = String(row?.Modalidad || "");
    const codigo = String(row?.Codigo_Item || "").toLowerCase();
    let tipo = "modulo";
    if (codigo === "instalacion_reloj") tipo = "servicio";
    else if (modalidadZoho === "Arriendo" || modalidadZoho === "Venta") tipo = "hardware";
    return {
      tipo,
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

function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

// Puntero de escalera coherente con un pct arbitrario: cantidad de escalones
// de la escalera cuyo pct queda cubierto por el comiteado. Con la escalera
// [10, 20]: pct 8 → 0, pct 15 → 1, pct 22 → 2 (tope).
function punteroEscaleraPorPct(pct) {
  let idx = 0;
  for (let i = 0; i < DISCOUNT_LADDER.length; i++) {
    if (DISCOUNT_LADDER[i].pct <= pct) idx = i + 1;
  }
  return idx;
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
    const pctExacto = Math.round(Number(body.pctExacto || 0) * 10) / 10;
    if (!quoteId) return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    if (!(pctExacto > 0)) {
      return sendJson(res, 400, { ok: false, error: "pctExacto debe ser > 0." });
    }
    if (pctExacto > TOPE_TELEFONICO_PCT) {
      return sendJson(res, 400, {
        ok: false,
        error: `pctExacto supera el tope telefónico autorizado (${TOPE_TELEFONICO_PCT}%).`,
      });
    }

    stage = "fetch_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });

    // Nunca rebajar lo ya comiteado: idempotencia hacia arriba.
    const recVigente = Number(quote?.[config.quoteDiscountPctField] || 0);
    if (pctExacto <= recVigente) {
      const pdfVigente = toText(quote?.[config.quotePdfUrlField]);
      return sendJson(res, 200, {
        ok: true,
        ya_comiteado: true,
        version: Math.max(1, Number(quote?.[config.quoteVersionPdfField] || 1)),
        pct_aplicado: recVigente,
        link_pdf: pdfVigente,
        mensaje_para_prospecto: pdfVigente
          ? `Tu cotización ya tiene un descuento igual o mejor aplicado. Aquí la revisas, aceptas y pagas: ${toText(quote?.[config.quoteAcceptanceUrlField]) || pdfVigente}`
          : "Tu cotización ya tiene un descuento igual o mejor aplicado.",
      });
    }

    // Instalación: se conserva lo que ya estaba comiteado.
    const descRM = Number(quote?.[config.quoteDiscountInstRMPctField] || 0);
    const descRegion = Number(quote?.[config.quoteDiscountInstRegionPctField] || 0);
    // Vigencia propia del descuento si el ejecutivo la definió (Lalo 10-ago).
    const mesesPlanQuote = await leerMesesDescuento(quoteId, quote);

    stage = "version_bump";
    const versionNueva = Math.max(1, Number(quote?.[config.quoteVersionPdfField] || 1)) + 1;

    stage = "render_pdf";
    const cliente = await buildClienteParaHtml(quote, config);
    // UF de la cotización primero (campo UF_Valor / derivada del subform);
    // UF del día solo como último recurso (pedido Lalo 06-ago).
    const ufQuote = ufDeCotizacion(quote, config.quoteItemsSubformField);
    const ufActual = ufQuote.uf > 0 ? ufQuote.uf : await getUFActualSafe();
    const items = subformACotizacionItems(quote, config);
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
        recurrentePct: pctExacto,
        instalacionRMPct: descRM,
        instalacionRegionPct: descRegion,
        mesesPlan: mesesPlanQuote,
      },
      condicionDiscursiva: CONDICION_TELEFONICA,
    });

    stage = "upload_pdf";
    const pdfBuffer = await htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
    const { pdfUrl } = await uploadPdfToSupabase({
      pdfBuffer,
      quoteId,
      empresa: cliente.empresa,
    });

    stage = "update_quote";
    const puntero = punteroEscaleraPorPct(pctExacto);
    await updateRecord(
      config.quoteModule,
      quoteId,
      {
        [config.quoteDiscountPctField]: pctExacto,
        [config.quoteDiscountUnlockedField]: true,
        [config.quoteEscalonField]: puntero,
        [config.quoteEscalonNegociacionField]: puntero,
        [config.quoteVersionPdfField]: versionNueva,
        [config.quotePdfUrlField]: pdfUrl,
        [config.quoteAcceptanceUrlField]: acceptanceUrl,
      },
      true
    );
    // Propaga al puntero de Supabase (principio Lalo 07-ago: el PDF nuevo en TODOS lados)
    await actualizarPunteroPdf(quoteId, pdfUrl);

    // Precio nuevo → cotización NUEVA en Creator. No se actualiza la anterior:
    // queda como la versión superada, igual que las versiones del PDF.
    waitUntil(
      emitirCotizacionEnCreator({
        config,
        quoteId,
        dealId,
        motivo: "descuento_telefonico",
        forzarNueva: true,
      })
    );

    return sendJson(res, 200, {
      ok: true,
      version: versionNueva,
      pct_aplicado: pctExacto,
      link_pdf: pdfUrl,
      acceptance_url: acceptanceUrl,
      mensaje_para_prospecto:
        `Listo! Como acordamos por teléfono, te dejé el plan mensual con un ${pctExacto}% de descuento. ` +
        `El descuento ${textoVigenciaCorto(mesesPlanQuote)}. ` +
        `${CONDICION_TELEFONICA} Aquí revisas, aceptas y pagas tu cotización actualizada: ${acceptanceUrl}`,
    });
  } catch (error) {
    console.error(`[aplicar-descuento-telefonico] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo aplicar el descuento telefónico.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};
