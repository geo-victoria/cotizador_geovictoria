/**
 * Endpoint: POST /api/quote-acceptance/send-reactivation-email
 *
 * Correo de REACTIVACIÓN (toque fuera de la ventana de 24h) para una cotización
 * formal que el cliente todavía no acepta. Lo dispara el cron de reactivación del
 * agente de WhatsApp (vic-reactivation-cron) en paralelo a la plantilla HSM.
 *
 * CTA principal: botón de ACEPTACIÓN ONLINE (link firmado). Adjunta el PDF
 * vigente de la cotización; si el adjunto no se puede enviar, el PDF queda igual
 * como link alternativo dentro del cuerpo, secundario al botón de aceptación.
 *
 * SEGURO POR DEFECTO:
 *   - Si REACTIVATION_EMAIL_ENABLED != "true" → responde { skipped } sin enviar.
 *   - Filtra correos internos / de prueba con shouldNotify (mismos filtros que la
 *     notificación interna de aceptación).
 *   - Si la cotización no tiene correo de cliente válido → skipped (no error).
 *
 * Auth: header x-vicky-secret == VICKY_COTIZADORA_SECRET (igual que el endpoint
 * de descuentos). Body: { "quoteId": "<id de la cotización en Zoho>" }.
 */

const crypto = require("crypto");
const {
  getRecord,
  getRecordWithFields,
  updateRecord,
  readJsonSafe,
  toText,
} = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { shouldNotify } = require("../_shared/quote-internal-notify");
const { validateEmail } = require("../_shared/verification-mailer");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { hayEscalonDespues } = require("../_shared/discount-engine");

const FLAG_ENABLED =
  toText(process.env.REACTIVATION_EMAIL_ENABLED).toLowerCase() === "true";
const VALIDEZ_HORAS = Number(process.env.REACTIVATION_EMAIL_VALIDEZ_HORAS || 24);
const ZOHO_FROM_EMAIL = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";

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

function esc(value) {
  return toText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml({ nombre, numero, acceptanceUrl, pdfUrl, supportEmail }) {
  const saludo = nombre ? `Hola ${esc(nombre)}:` : "Hola:";
  const refCot = numero ? ` <strong>${esc(numero)}</strong>` : "";
  const pdfBloque = pdfUrl
    ? `<p style="margin:22px 0 0;font-size:13px;line-height:1.5;color:#475569">` +
      `Te adjuntamos tu cotización${refCot} en PDF. Si no ves el adjunto, ` +
      `puedes descargarla aquí: <a href="${esc(pdfUrl)}" style="color:#0284c7">ver PDF</a>.</p>`
    : "";
  const soporteBloque = supportEmail
    ? `<p style="margin:8px 0 0;font-size:13px;color:#475569">` +
      `¿Dudas? Respóndeme este correo o escríbeme por WhatsApp y lo vemos.</p>`
    : "";
  return (
    `<div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#0f172a;max-width:560px">` +
    `<h2 style="margin:0 0 12px;color:#0d47a1">Tu precio especial en GeoVictoria vence pronto</h2>` +
    `<p style="margin:0 0 10px">${saludo}</p>` +
    `<p style="margin:0 0 10px">Dejamos lista tu cotización${refCot} con un ` +
    `<strong>precio especial válido por las próximas ${VALIDEZ_HORAS} horas</strong>. ` +
    `Puedes revisarla y aceptarla online con un clic:</p>` +
    `<p style="margin:22px 0">` +
    `<a href="${esc(acceptanceUrl)}" ` +
    `style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;` +
    `font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px">` +
    `Aceptar mi cotización online</a></p>` +
    `<p style="margin:0;font-size:12px;color:#64748b">Si el botón no funciona, copia este enlace: ` +
    `<a href="${esc(acceptanceUrl)}" style="color:#0284c7">${esc(acceptanceUrl)}</a></p>` +
    pdfBloque +
    soporteBloque +
    `<p style="margin:18px 0 0;font-size:13px;color:#334155">— Vicky, GeoVictoria</p>` +
    `</div>`
  );
}

function buildText({ nombre, numero, acceptanceUrl, pdfUrl }) {
  const saludo = nombre ? `Hola ${nombre}:` : "Hola:";
  const ref = numero ? ` ${numero}` : "";
  const lineas = [
    "Tu precio especial en GeoVictoria vence pronto",
    "",
    saludo,
    `Dejamos lista tu cotización${ref} con un precio especial válido por las próximas ${VALIDEZ_HORAS} horas.`,
    "",
    `Acéptala online aquí: ${acceptanceUrl}`,
  ];
  if (pdfUrl) lineas.push("", `PDF de tu cotización: ${pdfUrl}`);
  lineas.push("", "¿Dudas? Responde este correo o escríbeme por WhatsApp.", "— Vicky, GeoVictoria");
  return lineas.join("\n");
}

async function sendViaResend({ toEmail, subject, html, text, pdfUrl, pdfFilename }) {
  const apiKey = toText(process.env.RESEND_API_KEY);
  if (!apiKey) return null;
  const fromEmail = toText(process.env.RESEND_FROM_EMAIL);
  if (!fromEmail) {
    throw new Error("Falta RESEND_FROM_EMAIL para el correo de reactivación.");
  }
  const body = { from: fromEmail, to: [toEmail], subject, html, text };
  // Resend descarga el PDF desde la URL pública (path). Si fallara, el cuerpo ya
  // trae el PDF como link alternativo, así que el correo igual es útil.
  if (pdfUrl) body.attachments = [{ filename: pdfFilename, path: pdfUrl }];

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJsonSafe(response);
  if (!response.ok) {
    const message =
      toText(payload?.message) || toText(payload?.error) || toText(payload?.raw) || `HTTP ${response.status}`;
    throw new Error(`Resend fallo: ${message}`);
  }
  return { provider: "resend", id: toText(payload?.id) };
}

// Fallback sin adjunto: Zoho send_mail desde el registro de la cotización (el PDF
// queda como link en el cuerpo, secundario al botón de aceptación online).
async function sendViaZoho({ quoteModule, quoteId, toEmail, subject, html }) {
  const path = `/crm/v3/${encodeURIComponent(quoteModule)}/${encodeURIComponent(
    quoteId
  )}/actions/send_mail`;
  const payload = {
    data: [
      {
        from: { email: ZOHO_FROM_EMAIL },
        to: [{ email: toEmail }],
        subject,
        content: html,
        mail_format: "html",
      },
    ],
  };
  const response = await zohoApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await readJsonSafe(response);
  const row = Array.isArray(result?.data) ? result.data[0] : null;
  const ok = response.ok && row && /SUCCESS/i.test(toText(row?.code || row?.status));
  if (!ok) {
    const message =
      toText(row?.message) || toText(result?.message) || toText(result?.code) || `HTTP ${response.status}`;
    throw new Error(`Zoho send_mail fallo: ${message}`);
  }
  return { provider: "zoho_crm", id: toText(row?.details?.message_id || row?.details?.id) };
}

// Devuelve un link de aceptación online válido: regenera un token fresco si la
// cotización tiene Deal asociado; si no, cae al URL ya guardado en la cotización.
async function resolverAcceptanceUrl(quote, quoteId, config) {
  const dealId = toText(
    quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]
  );
  if (dealId) {
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const token = signAcceptancePayload({
      quoteId,
      dealId,
      iat: Date.now(),
      exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const url = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;
    // Persistimos el link fresco (best-effort) para que la cotización quede al día.
    try {
      await updateRecord(config.quoteModule, quoteId, { [config.quoteAcceptanceUrlField]: url }, true);
    } catch {
      /* best-effort */
    }
    return url;
  }
  return toText(quote?.[config.quoteAcceptanceUrlField]);
}

async function nombreContacto(quote, config) {
  try {
    const contactId = toText(
      quote?.[config.quoteContactLookupField]?.id || quote?.[config.quoteContactLookupField]
    );
    if (!contactId) return "";
    const contact = await getRecordWithFields("Contacts", contactId, ["First_Name"]);
    return toText(contact?.First_Name);
  } catch {
    return "";
  }
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

  const expectedSecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  const providedSecret = toText(req.headers["x-vicky-secret"]);
  if (expectedSecret && expectedSecret !== providedSecret) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  // Seguro por defecto: no envía nada hasta activarlo explícitamente.
  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    // `forzar: true` (campaña 10%, Lalo 26-ago: "ideal que le llegue correo a
    // todos con su actualización en PDF"): el descuento aceptado dispara este
    // correo aunque el flag global de reactivación esté apagado. Los filtros
    // de seguridad (correo válido, internos/prueba) siguen intactos.
    if (!FLAG_ENABLED && body.forzar !== true) {
      return sendJson(res, 200, { ok: true, skipped: "REACTIVATION_EMAIL_ENABLED != true" });
    }
    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    }

    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });
    }

    const toEmail = toText(quote?.[config.contactEmailField]).toLowerCase();
    if (!validateEmail(toEmail)) {
      return sendJson(res, 200, { ok: true, skipped: "sin correo de cliente valido" });
    }

    // Empresa para el filtro anti-prueba: Name de la cotización (best-effort).
    const empresa = toText(quote?.Name);
    if (!shouldNotify({ clientEmail: toEmail, empresa })) {
      return sendJson(res, 200, { ok: true, skipped: "correo interno/de prueba" });
    }

    // Correctitud: solo reenviamos la cotización si YA está en su descuento
    // máximo (el PDF vigente refleja el mejor precio). Si todavía queda descuento
    // por dar, NO mandamos este PDF —tendría un precio peor que el que Vicky le va
    // a ofrecer—; ese gancho va por WhatsApp, donde Vicky aplica el descuento y
    // recién ahí entrega el PDF nuevo. Mismo criterio que `topeAlcanzado`.
    const commitIdx = Math.max(0, Number(quote?.[config.quoteEscalonField] || 0));
    const enMaximo = !hayEscalonDespues(quote, config, commitIdx - 1);
    if (!enMaximo) {
      return sendJson(res, 200, {
        ok: true,
        skipped: "descuento no esta en el maximo: reenganche del precio via WhatsApp",
      });
    }

    const acceptanceUrl = await resolverAcceptanceUrl(quote, quoteId, config);
    if (!acceptanceUrl) {
      return sendJson(res, 200, { ok: true, skipped: "sin link de aceptacion (cotizacion sin Deal)" });
    }

    const pdfUrl = toText(quote?.[config.quotePdfUrlField]);
    const numero = toText(quote?.Numero_Cotizacion);
    const nombre = await nombreContacto(quote, config);
    const pdfFilename = `Cotizacion-${(numero || quoteId).replace(/[^\w.-]+/g, "_")}.pdf`;

    const subject = "Tu precio especial en GeoVictoria vence pronto";
    const html = buildHtml({
      nombre,
      numero,
      acceptanceUrl,
      pdfUrl,
      supportEmail: config.supportContactEmail,
    });
    const text = buildText({ nombre, numero, acceptanceUrl, pdfUrl });

    let result = null;
    try {
      result = await sendViaResend({ toEmail, subject, html, text, pdfUrl, pdfFilename });
    } catch (resendErr) {
      console.warn(`[reactivation-email] Resend falló, intento Zoho: ${toText(resendErr?.message)}`);
      result = null;
    }
    if (!result) {
      result = await sendViaZoho({ quoteModule: config.quoteModule, quoteId, toEmail, subject, html });
    }

    console.log(
      `[reactivation-email] enviado quote=${numero || quoteId} via=${result?.provider} → ${toEmail}`
    );
    return sendJson(res, 200, {
      ok: true,
      sent: true,
      provider: result?.provider || null,
      id: result?.id || null,
    });
  } catch (error) {
    console.error("[reactivation-email] ERROR:", error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo enviar el correo de reactivacion.",
      detail: String(error?.message || error).slice(0, 300),
    });
  }
};
