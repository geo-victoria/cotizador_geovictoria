/**
 * Notificación interna por correo cuando una cotización se ACEPTA o se PAGA.
 *
 * Avisa al equipo (Eduardo, Anderson, Rodrigo por defecto) vía Zoho send_mail
 * desde el registro de la cotización (queda en su historial). Es best-effort:
 * nunca debe bloquear la aceptación ni la finalización del pago.
 *
 * Filtro anti-pruebas: NO notifica si el correo del cliente es de un dominio
 * interno (geovictoria.com) o si la empresa/contacto contiene palabras de prueba
 * (prueba/test/demo/qa). Todo configurable por env.
 */

const { zohoApiFetch } = require("./zoho-auth");
const { getRecordWithFields, toText } = require("./zoho-crm");
const { getMercadoPagoConfig } = require("./mercadopago-config");
const { esCotizacionCO } = require("./payment-session");
const {
  searchPaymentsByExternalReference,
  buildExternalReference,
} = require("./mercadopago-client");

const NOTIFY_FROM = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";
// Base de destinatarios (Lalo 31-jul): Lalo + Rodrigo + Victoria Luna. El
// PROPIETARIO del trato/cotización se agrega DINÁMICO en notifyQuoteEvent —
// con la tómbola el dueño cambia por deal, ya no sirve una lista fija.
const NOTIFY_BASE = "egomez@geovictoria.com,rlewit@geovictoria.com,vluna@geovictoria.com";
const NOTIFY_RECIPIENTS = (process.env.QUOTE_NOTIFY_RECIPIENTS || NOTIFY_BASE)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Multi-país: misma base; el ejecutivo del país llega por el dueño dinámico.
const NOTIFY_RECIPIENTS_CO = (process.env.QUOTE_NOTIFY_RECIPIENTS_CO || NOTIFY_BASE)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const NOTIFY_RECIPIENTS_MX = (process.env.QUOTE_NOTIFY_RECIPIENTS_MX || NOTIFY_BASE)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SUPPRESS_DOMAINS = (process.env.QUOTE_NOTIFY_SUPPRESS_DOMAINS || "geovictoria.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const SUPPRESS_KEYWORDS = (process.env.QUOTE_NOTIFY_SUPPRESS_KEYWORDS || "prueba,test,demo,qa")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const DEAL_URL_BASE = (
  process.env.ZOHO_DEAL_URL_BASE || "https://crm.zoho.com/crm/tab/Potentials/"
).replace(/\/*$/, "/");

// ¿Debe notificarse? (filtra cotizaciones de prueba para no alarmar al equipo).
function shouldNotify({ clientEmail, empresa }) {
  const email = toText(clientEmail).toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : "";
  if (domain && SUPPRESS_DOMAINS.includes(domain)) return false;
  const hay = toText(empresa).toLowerCase();
  if (SUPPRESS_KEYWORDS.some((k) => k && hay.includes(k))) return false;
  return true;
}

/**
 * true si la cotización es MÉXICO. Mecanismo primario: el token del link de
 * aceptación (URL_Aceptacion_Web) viene firmado con pais:"mx" por
 * create-from-vicky-mx — se decodifica el payload sin verificar firma (solo
 * decide destinatarios internos). Respaldo: Territorio del Deal = "México".
 * Best-effort: ante cualquier duda devuelve false (destinatarios de siempre).
 */
async function esCotizacionMX(quote, config) {
  try {
    const url = toText(quote?.[config?.quoteAcceptanceUrlField || "URL_Aceptacion_Web"]);
    const m = String(url || "").match(/[?&]token=([^&]+)/);
    if (m) {
      const body = decodeURIComponent(m[1]).split(".")[0];
      const json = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      if (String(JSON.parse(json)?.pais || "").toLowerCase() === "mx") return true;
    }
  } catch (_e) {
    /* sigue al respaldo por Territorio */
  }
  const dealField = toText(config?.quoteDealLookupField) || "Deal_Asociado";
  const dealId = toText(quote?.[dealField]?.id || quote?.[dealField]);
  if (!dealId) return false;
  const deal = await getRecordWithFields("Deals", dealId, ["id", "Territorio"]).catch(() => null);
  return /m[eé]xico/i.test(toText(deal?.Territorio));
}

function fmtClp(n) {
  const v = Number(n || 0);
  if (!v) return "";
  return "$" + Math.round(v).toLocaleString("es-CL");
}

// Detalle de los pagos APROBADOS en Mercado Pago para la cotización (best-effort,
// para que el equipo reciba el comprobante sin entrar al panel de MP).
async function detallePagosMP(quoteId) {
  try {
    const mp = getMercadoPagoConfig();
    if (!mp.enabled || !mp.accessToken) return [];
    const pagos = [];
    for (const kind of ["oneshot", "sub"]) {
      const found = await searchPaymentsByExternalReference(
        mp,
        buildExternalReference(quoteId, kind),
      ).catch(() => []);
      for (const p of found || []) {
        if (String(p?.status) !== "approved") continue;
        pagos.push({
          operacion: toText(p.id),
          monto: fmtClp(p.transaction_amount),
          fecha: p.date_approved
            ? new Date(p.date_approved).toLocaleString("es-CL", { timeZone: "America/Santiago" })
            : "",
          metodo:
            toText(p.payment_method_id) +
            (p?.card?.last_four_digits ? ` ****${p.card.last_four_digits}` : ""),
          tipo: kind === "sub" ? "suscripción mensual" : "pago inicial",
          comprobanteUrl:
            toText(p?.transaction_details?.external_resource_url) ||
            toText(p?.point_of_interaction?.transaction_data?.ticket_url),
        });
      }
    }
    return pagos;
  } catch (_e) {
    return [];
  }
}

function buildHtml({ evento, empresa, numero, clientEmail, rut, montoClp, dealId, pagosMp }) {
  const titulo = evento === "pagada" ? "💰 Cotización PAGADA" : "✅ Cotización ACEPTADA";
  const dealLink = dealId
    ? `<a href="${DEAL_URL_BASE}${encodeURIComponent(dealId)}">Ver el Deal en Zoho</a>`
    : "";
  const filaMonto = montoClp ? `<tr><td><b>Monto</b></td><td>${montoClp}</td></tr>` : "";
  return `<!DOCTYPE html><html lang="es"><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;">
<h2 style="color:#0d47a1;margin:0 0 8px;">${titulo}</h2>
<p style="margin:0 0 12px;color:#4a5568;">Una cotización de Vicky acaba de ${evento === "pagada" ? "pagarse" : "aceptarse"}.</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px;">
  <tr><td><b>Empresa</b></td><td>${empresa || "—"}</td></tr>
  <tr><td><b>Cotización</b></td><td>${numero || "—"}</td></tr>
  <tr><td><b>Contacto</b></td><td>${clientEmail || "—"}</td></tr>
  <tr><td><b>RUT</b></td><td>${rut || "—"}</td></tr>
  ${filaMonto}
</table>
${seccionPagosMp(pagosMp)}
<p style="margin:14px 0 0;">${dealLink}</p>
</body></html>`;
}


// Sección "Comprobante Mercado Pago" del correo interno (solo si hay pagos).
function seccionPagosMp(pagos) {
  if (!Array.isArray(pagos) || pagos.length === 0) return "";
  const filas = pagos
    .map(
      (p) => `<tr>
  <td>${p.tipo}</td><td><b>${p.operacion}</b></td><td>${p.monto}</td>
  <td>${p.fecha}</td><td>${p.metodo}</td>
  <td>${p.comprobanteUrl
    ? `<a href="${p.comprobanteUrl}">Ver comprobante</a>`
    : `<a href="https://www.mercadopago.cl/activities?q=${encodeURIComponent(p.operacion)}">Ver en panel MP</a>`}</td>
</tr>`,
    )
    .join("");
  return `<h3 style="color:#0d47a1;margin:18px 0 6px;">Comprobante Mercado Pago</h3>
<table cellpadding="6" style="border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0;">
  <tr style="background:#f7fafc;"><th>Tipo</th><th>N° operación</th><th>Monto</th><th>Fecha</th><th>Método</th><th></th></tr>
  ${filas}
</table>`;
}

async function sendInternalMail({ quoteModule, quoteId, subject, htmlBody, recipients }) {
  const path = `/crm/v3/${encodeURIComponent(quoteModule)}/${encodeURIComponent(quoteId)}/actions/send_mail`;
  const [first, ...rest] = recipients && recipients.length ? recipients : NOTIFY_RECIPIENTS;
  if (!first) return;
  const dataPayload = {
    from: { email: NOTIFY_FROM },
    to: [{ email: first }],
    subject,
    content: htmlBody,
    mail_format: "html",
  };
  if (rest.length) dataPayload.cc = rest.map((email) => ({ email }));
  const enviar = async (payload) => {
    const response = await zohoApiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [payload] }),
    });
    const text = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, text };
  };
  let r = await enviar(dataPayload);
  // Un destinatario BLOQUEADO por Zoho no puede matar el aviso al resto
  // (caso pdíaz@ con tilde en la lista de rebotes, 31-jul): se reintenta sin
  // CC — al menos el destinatario principal recibe la notificación.
  if (!r.ok && dataPayload.cc && /NOT_ALLOWED|blocked email|UTF-8 addresses/i.test(r.text)) {
    console.error(
      `[quote-notify] CC bloqueado por Zoho (${r.text.slice(0, 160)}). Reintentando SIN copias.`,
    );
    const sinCc = { ...dataPayload };
    delete sinCc.cc;
    r = await enviar(sinCc);
  }
  if (!r.ok) {
    throw new Error(`send_mail ${r.status}: ${r.text.slice(0, 200)}`);
  }
}

// Notificación por WhatsApp (vía el agente Vicky → línea de Meta). Best-effort y
// seguro por defecto: si la URL o el secreto no están configurados, no hace nada.
const AGENT_NOTIFY_URL = toText(process.env.VICKY_AGENT_NOTIFY_URL);
const AGENT_CRON_SECRET = toText(process.env.VICKY_AGENT_CRON_SECRET);

async function notifyWhatsApp({ evento, empresa, numero, montoClp, quoteId }) {
  // Sin la config, el aviso al agente NO sale — y con él se pierden el cierre
  // de cadencia y el traspaso post-pago en tiempo real (el agente tiene un
  // barrido horario de respaldo, pero el tiempo real vive aquí). Gritarlo en
  // el log: así fue invisible el caso COT233 (20-jul).
  if (!AGENT_NOTIFY_URL || !AGENT_CRON_SECRET) {
    console.warn(
      `[quote-notify] aviso al agente OMITIDO (faltan VICKY_AGENT_NOTIFY_URL/VICKY_AGENT_CRON_SECRET) evento=${evento} quote=${numero || quoteId}`,
    );
    return;
  }
  try {
    const res = await fetch(AGENT_NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": AGENT_CRON_SECRET },
      // quoteId permite al agente cerrar la cadencia de seguimiento del
      // contacto (nada de nudges ni llamadas a quien ya aceptó/pagó).
      body: JSON.stringify({ evento, empresa, numero, monto: montoClp, quoteId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[quote-notify] aviso al agente respondió ${res.status} evento=${evento} quote=${numero || quoteId}: ${text.slice(0, 150)}`,
      );
    } else {
      console.log(`[quote-notify] aviso al agente OK evento=${evento} quote=${numero || quoteId}`);
    }
  } catch (err) {
    console.warn(`[quote-notify] WhatsApp best-effort falló:`, toText(err?.message || err).slice(0, 150));
  }
}

/**
 * Notifica al equipo el evento de la cotización. Best-effort: captura todos los
 * errores (no lanza). `quote` es el registro de Zoho ya cargado por el caller.
 *
 * @param {"aceptada"|"pagada"} evento
 */
async function notifyQuoteEvent({ config, quote, quoteId, evento }) {
  try {
    if (!config || !quote || !quoteId) return;
    const numero = toText(quote?.Numero_Cotizacion);
    const clientEmail = toText(quote?.[config.contactEmailField]);
    const rut = toText(quote?.[config.companyRutField]);
    const dealId = toText(
      quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField],
    );
    const accountId = toText(quote?.Cuenta_Asociada?.id || quote?.Cuenta_Asociada);

    // Enriquecimiento best-effort: nombre de empresa y monto del Deal.
    let empresa = "";
    let montoClp = "";
    try {
      if (accountId) {
        const acc = await getRecordWithFields("Accounts", accountId, ["Account_Name"]);
        empresa = toText(acc?.Account_Name);
      }
    } catch (_e) {
      /* ignore */
    }
    if (!empresa) empresa = toText(quote?.Name).replace(/^\s*Cotización\s*/i, "").replace(/\s*-\s*\d{4}-\d{2}-\d{2}\s*$/, "");
    try {
      if (dealId) {
        const deal = await getRecordWithFields("Deals", dealId, ["Amount"]);
        montoClp = fmtClp(deal?.Amount);
      }
    } catch (_e) {
      /* ignore */
    }

    if (!shouldNotify({ clientEmail, empresa })) {
      console.log(
        `[quote-notify] omitido (prueba/interno) evento=${evento} quote=${numero || quoteId} empresa="${empresa}" email="${clientEmail}"`,
      );
      return;
    }

    // Comprobante MP: solo en el evento de pago (best-effort, nunca bloquea).
    const pagosMp = evento === "pagada" ? await detallePagosMP(quoteId) : [];

    const subject = `[GeoVictoria] Cotización ${numero || quoteId} ${
      evento === "pagada" ? "PAGADA" : "ACEPTADA"
    } — ${empresa || "cliente"}`;
    const htmlBody = buildHtml({ evento, empresa, numero, clientEmail, rut, montoClp, dealId, pagosMp });
    // Multi-país: en cotizaciones CO la ejecutiva es Laura (no Anderson);
    // en cotizaciones MX es Yahel Segura. CL sigue con los destinatarios de
    // siempre.
    const esCO = await esCotizacionCO(quote, null, config).catch(() => false);
    const esMX = !esCO && (await esCotizacionMX(quote, config).catch(() => false));
    // PROPIETARIO del trato/cotización SIEMPRE copiado (Lalo 31-jul): primero
    // el Owner de la cotización; si no viene, el Owner del deal. Dedup contra
    // la base y jamás el robot Vicky.
    let ownerEmail = toText(quote?.Owner?.email);
    if (!ownerEmail && dealId) {
      const dealOwner = await getRecordWithFields("Deals", dealId, ["Owner"]).catch(() => null);
      ownerEmail = toText(dealOwner?.Owner?.email);
    }
    const base = esCO ? NOTIFY_RECIPIENTS_CO : esMX ? NOTIFY_RECIPIENTS_MX : NOTIFY_RECIPIENTS;
    const vistos = new Set();
    const recipients = [...base, ownerEmail].filter((e) => {
      const low = String(e || "").trim().toLowerCase();
      if (!low || low === "vicky@geovictoria.com" || vistos.has(low)) return false;
      vistos.add(low);
      return true;
    });
    await sendInternalMail({ quoteModule: config.quoteModule, quoteId, subject, htmlBody, recipients });
    console.log(`[quote-notify] enviado evento=${evento} quote=${numero || quoteId} pais=${esCO ? "co" : esMX ? "mx" : "cl"} → ${recipients.join(", ")}`);
    // Además del correo: aviso por WhatsApp (best-effort, no bloquea).
    await notifyWhatsApp({ evento, empresa, numero, montoClp, quoteId });
  } catch (err) {
    console.error(`[quote-notify] falló (best-effort) evento=${evento}:`, toText(err?.message || err).slice(0, 200));
  }
}

module.exports = { notifyQuoteEvent, shouldNotify, detallePagosMP, buildHtml };
