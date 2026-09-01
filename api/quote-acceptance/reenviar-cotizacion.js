/**
 * POST /api/quote-acceptance/reenviar-cotizacion
 *
 * Reenvía por CORREO una cotización formal ya emitida a un tercero que el
 * cliente designó (su jefe, socio, RRHH…). Pedido Lalo 20-jul (caso Hernán /
 * Ingredientes Alimenticios: "te doy el número de mi jefa de RRHH para hacer
 * este tema más expedito").
 *
 * Regla de diseño: SOLO correo. Al tercero nunca se le escribe por WhatsApp —
 * no pidió ser contactado por ese canal. El correo deja claro quién pidió
 * compartirla y trae el PDF (desde el cual se acepta/paga en línea).
 *
 * Body JSON:
 *   quoteId            (req)  id Zoho de la cotización formal
 *   destinatarioEmail  (req)  correo del tercero
 *   destinatarioNombre (opc)  nombre del tercero (para el saludo)
 *   solicitanteNombre  (opc)  quién pidió compartirla (default: contacto de la cotización)
 *   ccSolicitante      (opc)  correo del solicitante para copiarlo (transparencia)
 *
 * Auth: x-vicky-secret == VICKY_COTIZADORA_SECRET (mismo header que las demás
 * tools de Vicky) o Bearer CRON_SECRET.
 */

const { getRecordWithFields, createRecord, updateRecord, toText } = require("../_shared/zoho-crm");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { sendQuoteEmailViaZoho } = require("./create-from-vicky");
const { ejecutivoPorOwner } = require("../_shared/ejecutivo-cl");

const VICKY_FROM_EMAIL = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const vickySecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  if (secretoValido(req)) return true;
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  return false;
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function buildShareEmailHtml({ destinatario, solicitante, empresa, numero, pdfUrl, reenvioRespaldo, correoPropio, waLink }) {
  const saludo = destinatario ? `Hola ${destinatario},` : "Hola,";
  const quien = solicitante ? `<b>${solicitante}</b>` : "Tu equipo";
  // Tres modos: tercero (default), RESPALDO (28-jul: seguimiento natural para
  // cotizaciones cuyo correo original no salió, sin transparentar la falla) y
  // CORREO PROPIO (01-sep, orden de Lalo "ese correo debe salir sí o sí si
  // tenemos el correo": el cliente entregó su email después de emitida la
  // formal — se le manda SU cotización, como continuación del chat).
  const intro = correoPropio
    ? `Soy Vicky, de GeoVictoria. Aquí tienes tu cotización <b>${numero}</b> de Control de Asistencia para <b>${empresa}</b>, tal como conversamos por WhatsApp — te la dejo también por correo para que la tengas de respaldo.`
    : reenvioRespaldo
      ? `Soy Vicky, de GeoVictoria. ¿Cómo te ha ido con la cotización <b>${numero}</b> de Control de Asistencia para <b>${empresa}</b>? Te la comparto nuevamente por este canal para que la tengas de respaldo.`
      : `Soy Vicky, ejecutiva comercial de GeoVictoria. ${quien} me pidió compartirte la cotización <b>${numero}</b> de Control de Asistencia para <b>${empresa}</b>, para que puedas revisarla directamente.`;
  // El tercero del flujo normal no autorizó WhatsApp; el cliente del respaldo
  // y el del correo propio ya conversan con Vicky por ahí — a ellos sí se les
  // ofrece el canal.
  const cierre = (reenvioRespaldo || correoPropio)
    ? `Cualquier duda me puedes hablar directo por <a href="${waLink}" style="color:#1a73e8;font-weight:700;">WhatsApp</a> o responder este correo — con gusto la resolvemos.`
    : `Cualquier duda me puedes escribir respondiendo este correo — con gusto la resolvemos.`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
  <tr><td style="background:#1a73e8;padding:20px 30px;">
    <span style="color:#ffffff;font-size:20px;font-weight:700;">GeoVictoria</span>
  </td></tr>
  <tr><td style="padding:28px 30px 8px;">
    <p style="margin:0 0 12px;font-size:16px;color:#2d3748;">${saludo}</p>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">${intro}</p>
  </td></tr>
  <tr><td align="center" style="padding:22px 30px;">
    <a href="${pdfUrl}" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:14px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">📄 Ver la cotización (PDF)</a>
    <p style="margin:12px 0 0 0;font-size:12px;color:#a0aec0;">Dentro del PDF encuentras el botón para aceptarla en línea cuando lo decidan.</p>
  </td></tr>
  <tr><td style="padding:0 30px 26px;">
    <p style="margin:0;font-size:14px;line-height:1.6;color:#4a5568;">${cierre}</p>
    <p style="margin:14px 0 0;font-size:14px;color:#2d3748;">Un abrazo,<br><b>Vicky</b> · GeoVictoria</p>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

const CC_FIJOS_PROPIO = (process.env.QUOTE_EMAIL_CC_FIJO || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** CORREO PROPIO (orden Lalo 01-sep: "ese correo debe salir sí o sí si
 * tenemos el correo"): envía al PROPIO cliente su cotización cuando el email
 * llegó después de la emisión, y deja el correo persistido en el CRM.
 * Reutilizado por el handler (tool del agente) y por el barrido
 * correos-pendientes (determinista, sin depender del modelo). */
async function enviarCorreoPropioDeCotizacion({ config, quote, quoteId, email, waLink }) {
  const pdfUrl = toText(quote[config.quotePdfUrlField]);
  if (!pdfUrl) return { ok: false, error: "sin PDF generado aún" };
  const numero = toText(quote.Numero_Cotizacion) || quoteId;
  const empresa = toText(quote.Cuenta_Asociada?.name) || "tu empresa";
  const nombre = toText(quote.Contacto_Asociado?.name);
  const ejecutivo = ejecutivoPorOwner(quote.Owner?.id);
  await sendQuoteEmailViaZoho({
    quoteModule: config.quoteModule,
    quoteId,
    fromEmail: VICKY_FROM_EMAIL,
    replyToEmail: ejecutivo.email,
    toEmail: email,
    toName: nombre || email,
    // Misma visibilidad interna que el correo de la emisión.
    ccEmails: [ejecutivo.email, ...CC_FIJOS_PROPIO].filter(Boolean),
    subject: `Tu cotización GeoVictoria ${numero} — ${empresa}`,
    htmlBody: buildShareEmailHtml({
      destinatario: nombre,
      solicitante: "",
      empresa,
      numero,
      pdfUrl,
      correoPropio: true,
      waLink: waLink || "https://wa.me/56967308227",
    }),
  });
  // El correo entregado por chat queda a la vista en el CRM (no pisa uno ya
  // registrado — ese pudo venir de la aceptación).
  if (!toText(quote[config.contactEmailField])) {
    await updateRecord(config.quoteModule, quoteId, { [config.contactEmailField]: email }, true)
      .catch(() => {});
  }
  createRecord("Notes", {
    Note_Title: `Cotización ${numero} enviada al correo del cliente`,
    Note_Content:
      `Vicky envió la cotización ${numero} a ${email} el ` +
      new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" }) +
      ". El correo llegó después de la emisión formal (entregado por chat) — regla 01-sep: si el correo existe, el correo sale.",
    Parent_Id: quoteId,
    $se_module: config.quoteModule,
  }).catch(() => {});
  console.log(`[reenviar-cotizacion] correoPropio ${numero} → ${email}`);
  return { ok: true, numero, empresa, destinatario: email };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Método no permitido." });
  }
  if (!authorized(req)) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const quoteId = toText(body.quoteId);
    const destinatarioEmail = toText(body.destinatarioEmail).trim();
    const destinatarioNombre = toText(body.destinatarioNombre).trim();
    const solicitanteNombreIn = toText(body.solicitanteNombre).trim();
    const ccSolicitante = toText(body.ccSolicitante).trim();
    // Modo respaldo (28-jul): seguimiento "¿cómo te ha ido?" con el PDF de
    // vuelta, sin transparentar la incidencia. Acepta el nombre viejo del
    // flag por compatibilidad con los scripts del barrido.
    const reenvioRespaldo = body.reenvioRespaldo === true || body.notaIncidencia === true;
    // Modo correo PROPIO (01-sep): el destinatario es el MISMO cliente, que
    // entregó su email después de emitida la formal.
    const correoPropio = body.correoPropio === true;
    // Línea de Vicky para el CTA de WhatsApp del respaldo (default CL).
    const waLinkIn = toText(body.waLink).trim();
    const waLink = /^https:\/\/wa\.me\/\d{8,15}$/.test(waLinkIn) ? waLinkIn : "https://wa.me/56967308227";

    if (!quoteId) return sendJson(res, 400, { ok: false, error: "quoteId requerido." });
    if (!emailValido(destinatarioEmail)) {
      return sendJson(res, 400, { ok: false, error: "destinatarioEmail inválido." });
    }

    const config = getAcceptanceConfig(req);
    const quote = await getRecordWithFields(config.quoteModule, quoteId, [
      "Numero_Cotizacion",
      config.quotePdfUrlField,
      config.quoteStatusField,
      "Cuenta_Asociada",
      "Contacto_Asociado",
      config.contactEmailField,
      "Owner",
    ]);
    if (!quote) return sendJson(res, 404, { ok: false, error: "Cotización no encontrada." });

    if (correoPropio) {
      const r = await enviarCorreoPropioDeCotizacion({
        config, quote, quoteId, email: destinatarioEmail, waLink,
      });
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    const pdfUrl = toText(quote[config.quotePdfUrlField]);
    if (!pdfUrl) {
      return sendJson(res, 409, {
        ok: false,
        error: "La cotización aún no tiene PDF generado; reintentar en unos minutos.",
      });
    }

    const numero = toText(quote.Numero_Cotizacion) || quoteId;
    const empresa = toText(quote.Cuenta_Asociada?.name) || "tu empresa";
    const solicitante = solicitanteNombreIn || toText(quote.Contacto_Asociado?.name);
    // Reply-to al ejecutivo HUMANO dueño de la cotización (relevo 27-jul: lo
    // de Anderson responde Anderson, lo de Eddyluz responde Eddyluz). Nunca
    // vicky@ — ese buzón no existe en M365 y las respuestas rebotarían.
    const ejecutivo = ejecutivoPorOwner(quote.Owner?.id);

    await sendQuoteEmailViaZoho({
      quoteModule: config.quoteModule,
      quoteId,
      fromEmail: VICKY_FROM_EMAIL,
      replyToEmail: ejecutivo.email,
      toEmail: destinatarioEmail,
      toName: destinatarioNombre || destinatarioEmail,
      // Transparencia: el solicitante va en copia (sabe que su cotización se
      // compartió y con quién).
      ccEmails: [ccSolicitante, toText(quote[config.contactEmailField])].filter(Boolean),
      subject: reenvioRespaldo
        ? `Tu cotización GeoVictoria ${numero} — ${empresa}`
        : `Cotización GeoVictoria ${numero} — ${empresa}`,
      htmlBody: buildShareEmailHtml({
        destinatario: destinatarioNombre,
        solicitante,
        empresa,
        numero,
        pdfUrl,
        reenvioRespaldo,
        waLink,
      }),
    });

    // Trazabilidad en Zoho: nota en la cotización (best-effort).
    createRecord("Notes", {
      Note_Title: `Cotización reenviada por correo a ${destinatarioNombre || destinatarioEmail}`,
      Note_Content: reenvioRespaldo
        ? `Vicky reenvió la cotización ${numero} como respaldo a ${destinatarioNombre || "(sin nombre)"} <${destinatarioEmail}> el ` +
          new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" }) +
          ". Motivo interno: el correo original (18-27 jul) no salió por el CC rechazado; al cliente se le presentó como seguimiento, sin mencionar la incidencia."
        : `Vicky reenvió la cotización ${numero} a ${destinatarioNombre || "(sin nombre)"} <${destinatarioEmail}> ` +
          `a pedido de ${solicitante || "el cliente"} el ` +
          new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" }) +
          ". Canal: solo correo (el tercero no autorizó WhatsApp).",
      Parent_Id: quoteId,
      $se_module: config.quoteModule,
    }).catch(() => {});

    console.log(
      `[reenviar-cotizacion] ${numero} → ${destinatarioEmail} (solicitó: ${solicitante || "?"})`,
    );
    return sendJson(res, 200, { ok: true, numero, empresa, destinatario: destinatarioEmail });
  } catch (error) {
    console.error("[reenviar-cotizacion] ERROR:", error?.message || error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo reenviar la cotización.",
      detail: String(error?.message || error).slice(0, 300),
    });
  }
};

module.exports.enviarCorreoPropioDeCotizacion = enviarCorreoPropioDeCotizacion;
