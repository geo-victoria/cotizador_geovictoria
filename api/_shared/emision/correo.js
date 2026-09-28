/**
 * Correo de la cotización (copia literal del endpoint chileno).
 *
 * - accessTokenArchivos / subirArchivoZohoParaAdjunto: PDF adjunto por Zoho
 *   Files con el token propio ZOHO_FILES_REFRESH_TOKEN (18-ago).
 * - sendQuoteEmailViaZoho: send_mail con CC deduplicado y reintento SIN CC si
 *   la copia es rechazada (27-jul).
 * - crearPlantillaCorreoCL: la plantilla `buildEmailHtml` de Chile, con el
 *   remitente y los documentos como parámetro (la ficha del país decide si va
 *   la certificación de la DT chilena).
 *
 * El endpoint chileno conserva su propia copia en esta fase (sus exports los
 * importan otros endpoints); la prueba de identidad compara ambas.
 */
const { zohoApiFetch } = require("../zoho-auth");
const { toText } = require("../zoho-crm");

let _filesTokenCache = { token: "", exp: 0 };
async function accessTokenArchivos() {
  const rt = String(process.env.ZOHO_FILES_REFRESH_TOKEN || "").trim();
  if (!rt) return "";
  if (_filesTokenCache.token && _filesTokenCache.exp - Date.now() > 2 * 60 * 1000) return _filesTokenCache.token;
  try {
    const domain = String(process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com").trim().replace(/\/+$/, "");
    const res = await fetch(`${domain}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: rt,
        client_id: String(process.env.ZOHO_CLIENT_ID || "").trim(),
        client_secret: String(process.env.ZOHO_CLIENT_SECRET || "").trim(),
        grant_type: "refresh_token",
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j?.access_token) {
      console.warn(`[send_mail] token de archivos no se pudo acuñar: ${JSON.stringify(j).slice(0, 150)}`);
      return "";
    }
    _filesTokenCache = { token: String(j.access_token), exp: Date.now() + 55 * 60 * 1000 };
    return _filesTokenCache.token;
  } catch (e) {
    console.warn(`[send_mail] token de archivos lanzó: ${e.message}`);
    return "";
  }
}

async function subirArchivoZohoParaAdjunto(buffer, filename) {
  try {
    // OJO: el endpoint de archivos vive en el MISMO api domain que el resto
    // (www.zohoapis.com/crm/v3/files). El primer intento fue contra
    // content.zohoapis.com y devolvió 404 (17-ago, prueba de Rodrigo) — ese
    // dominio es de otra API. zohoApiFetch pone el token y no fuerza
    // Content-Type, así que el FormData define su propio boundary.
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "application/pdf" }), filename);
    const tokenArchivos = await accessTokenArchivos();
    let r;
    if (tokenArchivos) {
      const api = String(process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim().replace(/\/+$/, "");
      r = await fetch(`${api}/crm/v3/files`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${tokenArchivos}` },
        body: form,
      });
    } else {
      // (zohoApiFetch ya importado arriba)
      r = await zohoApiFetch("/crm/v3/files", {
        method: "POST",
        body: form,
      });
    }
    const j = await r.json().catch(() => ({}));
    const id = j?.data?.[0]?.details?.id || j?.data?.[0]?.id || "";
    if (!r.ok || !id) {
      console.warn(`[send_mail] subida de adjunto falló (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
      return "";
    }
    return String(id);
  } catch (e) {
    console.warn(`[send_mail] subida de adjunto lanzó: ${e.message}`);
    return "";
  }
}

async function sendQuoteEmailViaZoho({
  quoteModule, quoteId, fromEmail, replyToEmail, toEmail, toName, subject, htmlBody, ccEmail, ccEmails, attachmentId,
}) {
  const path = `/crm/v3/${encodeURIComponent(quoteModule)}/${encodeURIComponent(quoteId)}/actions/send_mail`;
  const dataPayload = {
    from: { email: fromEmail },
    to: [{ user_name: toName || toEmail, email: toEmail }],
    subject,
    content: htmlBody,
    mail_format: "html",
  };
  // PDF adjunto (Eduardo 17-ago): el respaldo viaja EN el correo; el botón
  // del cuerpo lleva a la aceptación online, no al PDF.
  if (attachmentId) {
    dataPayload.attachments = [{ id: attachmentId }];
  }
  if (replyToEmail && replyToEmail !== fromEmail) {
    dataPayload.reply_to = { email: replyToEmail };
  }
  // CC: combina ccEmail (legado, 1 correo) + ccEmails (lista). Normaliza,
  // excluye el destinatario principal y deduplica (case-insensitive).
  const toLower = String(toEmail || "").trim().toLowerCase();
  const seen = new Set();
  const ccList = [];
  for (const raw of [ccEmail, ...(Array.isArray(ccEmails) ? ccEmails : [])]) {
    const email = String(raw || "").trim();
    const low = email.toLowerCase();
    if (!email || low === toLower || seen.has(low)) continue;
    seen.add(low);
    ccList.push(email);
  }
  if (ccList.length) {
    dataPayload.cc = ccList.map((email) => ({ email }));
  }
  const enviar = async (payload) => {
    const response = await zohoApiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [payload] }),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  };

  let r = await enviar(dataPayload);
  // Un destinatario en COPIA rechazado no puede matar el correo del CLIENTE.
  //
  // CASO REAL (27-jul, descubierto por Lalo con 6 clientes reclamando): el CC
  // institucional apuntaba a un buzón @geovictoria.com que Microsoft 365
  // rechaza ("5.4.1 Recipient address rejected: Access denied"), Zoho aborta
  // el envío COMPLETO con 400 NOT_ALLOWED, y el cliente se queda sin su
  // cotización — en silencio, porque esto corre en segundo plano. El correo
  // al cliente ES el envío; la copia interna es cortesía: si la copia rompe,
  // se reintenta UNA vez sin CC y se deja el grito en el log.
  if (!r.ok && dataPayload.cc && /NOT_ALLOWED|Recipient address rejected|5\.4\.1/i.test(r.text)) {
    console.error(
      `[send_mail] CC rechazado por el servidor de correo (${r.text.slice(0, 160)}). Reintentando SIN copia para no dejar al cliente sin su cotización.`,
    );
    const sinCc = { ...dataPayload };
    delete sinCc.cc;
    r = await enviar(sinCc);
  }
  if (!r.ok) {
    throw new Error(`Zoho send_mail failed (${r.status}): ${r.text.slice(0, 200)}`);
  }
  return r.text;
}

// Número de cotización a mostrar en el PDF: el correlativo de Zoho
// (Numero_Cotizacion, ej. "COT151") SIN el prefijo "COT" → "151". Si por algún
// motivo no está disponible, cae a los últimos 8 dígitos del id interno.
function buildDocFila(href, label, nota) {
  const notaHtml = nota ? ` <span style="color:#a0aec0;font-size:12px;">${nota}</span>` : "";
  return `<tr><td style="padding:11px 16px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;">
    <a href="${href}" style="color:#1a73e8;text-decoration:none;font-size:14px;font-weight:600;">${label}</a>${notaHtml}
  </td></tr><tr><td style="height:8px;"></td></tr>`;
}

// Correo de la cotización (estilo cálido/comercial). El botón principal va al
// PDF de la cotización (desde ahí se llega a la aceptación online); los
// documentos van como botones de descarga a archivos hosteados. La ficha del
// reloj solo se incluye si la cotización tiene hardware.

/**
 * Plantilla chilena del correo, con remitente y documentos como parámetro.
 * docs = { certificacion, fichaReloj, presentacion } (URL o "" para omitir).
 */
function crearPlantillaCorreoCL({ fromEmail, docs }) {
  const VICKY_FROM_EMAIL = fromEmail;
  const DOC_CERTIFICACION = (docs && docs.certificacion) || "";
  const DOC_FICHA_RELOJ = (docs && docs.fichaReloj) || "";
  const DOC_PRESENTACION = (docs && docs.presentacion) || "";
// Correo de la cotización (estilo cálido/comercial). El botón principal va al
// PDF de la cotización (desde ahí se llega a la aceptación online); los
// documentos van como botones de descarga a archivos hosteados. La ficha del
// reloj solo se incluye si la cotización tiene hardware.
return function buildEmailHtml({ contacto, empresa, pdfUrl, acceptanceUrl, tieneReloj, ejecutivo, pdfAdjunto }) {
  // El bloque "Te presento a tu ejecutivo" usa al DUEÑO REAL sorteado por la
  // tómbola (caso Grey, 31-jul: el correo decía Eddyluz fija mientras el deal
  // era de Grey). Sin dato, cae al ejecutivo por defecto de siempre.
  // Sin dueño humano real (deal esperando en Vicky, modelo 06-ago) el correo
  // lo firma VICKY — nunca una ejecutiva fija (caso Grey 31-jul): el vendedor
  // se presenta recién cuando el traspaso lo asigna de verdad.
  const esVicky = !(ejecutivo && toText(ejecutivo.email));
  const ej = esVicky
    ? { nombre: "Vicky", cargo: "Asistente Comercial", email: VICKY_FROM_EMAIL, telefono: "" }
    : {
        nombre: toText(ejecutivo.nombre) || toText(ejecutivo.email).split("@")[0],
        cargo: toText(ejecutivo.cargo) || "Ejecutivo Comercial",
        email: toText(ejecutivo.email),
        // Sin teléfono conocido NO se hereda el de otra persona: el bloque
        // sale solo con nombre y correo.
        telefono: toText(ejecutivo.telefono),
      };
  ej.whatsapp = ej.telefono.replace(/\D/g, "");
  const telHtml = ej.telefono
    ? ` &nbsp;·&nbsp; 📱 <a href="https://wa.me/${ej.whatsapp}" style="color:#1a73e8;text-decoration:none;">${ej.telefono}</a>`
    : "";
  const tituloEjecutivo = esVicky ? "Sigo aquí contigo 💬" : "Te presento a tu ejecutivo 🤝";
  const textoEjecutivo = esVicky
    ? `Cualquier duda o ajuste que necesites, <strong>responde este correo</strong> o escríbeme por el mismo WhatsApp donde ya estamos conversando — te acompaño en todo el proceso. 😊`
    : `De aquí en adelante, <strong>__EJ_NOMBRE__</strong> te acompaña en todo el proceso. Cualquier duda o ajuste que necesites, <strong>responde este correo</strong> o escríbele directo por WhatsApp — está para ayudarte. 😊`.replace("__EJ_NOMBRE__", ej.nombre);
  const primerNombre = String(contacto || "").trim().split(/\s+/)[0] || "";
  const saludo = primerNombre ? `Hola ${primerNombre} 👋` : "Hola 👋";
  const fichaFila = tieneReloj && DOC_FICHA_RELOJ
    ? buildDocFila(DOC_FICHA_RELOJ, "🕐 Ficha Técnica del Reloj", "(tu cotización lleva reloj)")
    : "";
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Tu cotización GeoVictoria</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(13,71,161,0.08);">
    <tr><td style="background:linear-gradient(135deg,#0d47a1 0%,#1a73e8 100%);padding:28px 32px;">
      <table role="presentation" width="100%"><tr><td style="color:#ffffff;font-size:22px;font-weight:700;">GeoVictoria</td><td align="right" style="color:#bbdefb;font-size:12px;">Control de Asistencia</td></tr></table>
    </td></tr>
    <tr><td style="padding:36px 32px 8px 32px;">
      <p style="margin:0 0 6px 0;font-size:14px;color:#1a73e8;font-weight:600;">${saludo}</p>
      <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.3;color:#1a202c;">Tu cotización para <span style="color:#0d47a1;">${empresa}</span> está lista</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">Preparé tu propuesta de Control de Asistencia. Revísala, acéptala y págala en línea con el botón${pdfAdjunto ? " — el PDF de respaldo va adjunto" : ""}.</p>
    </td></tr>
    <tr><td align="center" style="padding:28px 32px 8px 32px;">
      <a href="${acceptanceUrl || pdfUrl}" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:14px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">✅ Acepta y paga aquí</a>
      <br>
      <a href="${pdfUrl}" style="display:inline-block;margin-top:12px;background:#ffffff;color:#1a73e8;border:2px solid #1a73e8;padding:10px 24px;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">📄 Descargar PDF</a>
      ${pdfAdjunto ? '<p style="margin:12px 0 0 0;font-size:12px;color:#a0aec0;">El PDF también va adjunto en este correo.</p>' : ""}
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 14px 0;font-size:15px;color:#1a202c;">Cómo seguimos 🚀</h3>
      <table role="presentation" width="100%">
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">1.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Revisas tu cotización con el botón de arriba.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">2.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">La aceptas en línea y pagas el primer mes de forma segura.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">3.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;">Coordinamos la instalación e iniciamos tu onboarding en 24 horas hábiles.</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 12px 0;font-size:15px;color:#1a202c;">Documentos para ti 📎</h3>
      <table role="presentation" width="100%">
        ${DOC_CERTIFICACION ? buildDocFila(DOC_CERTIFICACION, "📄 Certificación Dirección del Trabajo", "") : ""}
        ${fichaFila}
        ${DOC_PRESENTACION ? buildDocFila(DOC_PRESENTACION, "📊 Presentación Comercial GeoVictoria", "") : ""}
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 8px 0;font-size:15px;color:#1a202c;">${tituloEjecutivo}</h3>
      <p style="margin:0 0 16px 0;font-size:14px;color:#4a5568;line-height:1.6;">${textoEjecutivo}</p>
      <table role="presentation" width="100%" style="background:#f7f9fc;border:1px solid #e2e8f0;border-radius:10px;"><tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px 0;font-size:14px;color:#1a202c;font-weight:600;">${ej.nombre}</p>
        <p style="margin:0 0 8px 0;font-size:13px;color:#718096;">${ej.cargo} · GeoVictoria</p>
        <p style="margin:0;font-size:13px;color:#718096;">✉️ <a href="mailto:${ej.email}" style="color:#1a73e8;text-decoration:none;">${ej.email}</a>${telHtml}</p>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:28px 32px 30px 32px;">
      <p style="margin:0;font-size:11px;color:#a0aec0;line-height:1.5;">GeoVictoria — Especialistas en Control de Asistencia y Accesos, presentes en 40+ países.<br><a href="https://geovictoria.com" style="color:#a0aec0;">geovictoria.com</a></p>
    </td></tr>
  </table>
  <p style="font-size:11px;color:#b8c0cc;margin:16px 0 0 0;">Este es un correo automático de tu cotización. Si no la solicitaste, ignóralo.</p>
</td></tr></table>
</body></html>`;
};
}

module.exports = {
  accessTokenArchivos,
  subirArchivoZohoParaAdjunto,
  sendQuoteEmailViaZoho,
  buildDocFila,
  crearPlantillaCorreoCL,
};
