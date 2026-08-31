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
// CHILE (Lalo 31-jul): Lalo + Rodrigo + Victoria Luna, y el PROPIETARIO del
// trato/cotización se agrega DINÁMICO en notifyQuoteEvent — con la tómbola
// el dueño cambia por deal, ya no sirve una lista fija. Victoria va SOLO en
// Chile: CO y MX conservan sus reglas antiguas (ejecutivo del país fijo).
const NOTIFY_RECIPIENTS = (
  process.env.QUOTE_NOTIFY_RECIPIENTS ||
  "egomez@geovictoria.com,rlewit@geovictoria.com,vluna@geovictoria.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// COPIA FIJA del correo de PAGO en CL (Lalo 24-ago): la dueña del
// acompañamiento de ventas autónomas siempre se entera del pago.
const NOTIFY_CC_PAGADA_CL = (process.env.QUOTE_NOTIFY_CC_PAGADA || "aaraque@geovictoria.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Usuarios "robot" cuyas notas no cuentan como gestión del ejecutivo (el
// usuario Vicky y el token de integración). Las notas del ESPEJO las crea el
// robot pero SÍ cuentan — son el chat real del vendedor (título "(espejo").
const USUARIOS_ROBOT_NOTAS = new Set(["3525045000484500876", "3525045000000200013"]);

/** ¿El ejecutivo HIZO algo en el deal? (Lalo 24-ago) — alguna nota humana o
 * la nota-espejo de su WhatsApp. MISMO criterio que usa el agente para
 * decidir si el deal vuelve al dueño de ventas autónomas en el post-pago. */
async function hayGestionEjecutivoEnDeal(dealId) {
  try {
    if (!dealId) return false;
    const r = await zohoApiFetch(
      `/crm/v3/Deals/${encodeURIComponent(dealId)}/Notes?fields=Note_Title,Created_By&per_page=100`,
    );
    if (!r.ok || r.status === 204) return false;
    const notas = ((await r.json().catch(() => ({})))?.data) || [];
    return notas.some((n) => {
      if (/\(espejo/i.test(toText(n?.Note_Title))) return true;
      const autor = toText(n?.Created_By?.id);
      return Boolean(autor) && !USUARIOS_ROBOT_NOTAS.has(autor);
    });
  } catch (_e) {
    return false;
  }
}

// Direcciones que NO quieren los avisos del canal ejecutivo (Lalo 31-ago):
// miden la venta de Vicky y estos correos les ensucian la lectura. Editable
// por env (coma-separado); vacío = nadie se excluye.
const SOLO_VENTAS_VICKY = new Set(
  (process.env.QUOTE_NOTIFY_SOLO_VICKY === undefined
    ? "rlewit@geovictoria.com"
    : process.env.QUOTE_NOTIFY_SOLO_VICKY
  )
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

const NOTIFY_RECIPIENTS_CO = (
  process.env.QUOTE_NOTIFY_RECIPIENTS_CO ||
  "egomez@geovictoria.com,agordillo@geovictoria.com,rlewit@geovictoria.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const NOTIFY_RECIPIENTS_MX = (
  process.env.QUOTE_NOTIFY_RECIPIENTS_MX ||
  "egomez@geovictoria.com,ysegura@geovictoria.com,rlewit@geovictoria.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const NOTIFY_RECIPIENTS_PE = (
  process.env.QUOTE_NOTIFY_RECIPIENTS_PE ||
  "egomez@geovictoria.com,mmendozav@geovictoria.com,rlewit@geovictoria.com"
)
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

/** true si la cotización es PERÚ: token del link de aceptación con pais:"pe"
 * (create-from-vicky-pe); respaldo Territorio del Deal = "Perú". */
async function esCotizacionPEnotify(quote, config) {
  try {
    const url = toText(quote?.[config?.quoteAcceptanceUrlField || "URL_Aceptacion_Web"]);
    const m = String(url || "").match(/[?&]token=([^&]+)/);
    if (m) {
      const body = decodeURIComponent(m[1]).split(".")[0];
      const json = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      if (String(JSON.parse(json)?.pais || "").toLowerCase() === "pe") return true;
    }
  } catch (_e) {
    /* sigue al respaldo por Territorio */
  }
  const dealField = toText(config?.quoteDealLookupField) || "Deal_Asociado";
  const dealId = toText(quote?.[dealField]?.id || quote?.[dealField]);
  if (!dealId) return false;
  const deal = await getRecordWithFields("Deals", dealId, ["id", "Territorio"]).catch(() => null);
  return /per[u\u00fa]/i.test(toText(deal?.Territorio));
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

function buildHtml({ evento, empresa, numero, clientEmail, rut, montoClp, dealId, pagosMp, canal, venta }) {
  const titulo = evento === "pagada" ? "💰 Cotización PAGADA" : "✅ Cotización ACEPTADA";
  const dealLink = dealId
    ? `<a href="${DEAL_URL_BASE}${encodeURIComponent(dealId)}">Ver el Deal en Zoho</a>`
    : "";
  const filaMonto = montoClp ? `<tr><td><b>Monto</b></td><td>${montoClp}</td></tr>` : "";
  // CANAL DE ORIGEN (Lalo 19-ago, "actualmente solo confunden"): el correo
  // dice de frente si la venta la inició VICKY (WhatsApp) o un EJECUTIVO con
  // la cotizadora. Fuente: Intervenci_n_Humana, estampado en la emisión.
  const intro =
    canal === "ejecutivo"
      ? `Una cotización emitida por un <b>EJECUTIVO con la cotizadora</b> acaba de ${evento === "pagada" ? "pagarse" : "aceptarse"}.`
      : canal === "vicky"
        ? `Una venta iniciada por <b>VICKY (WhatsApp)</b> acaba de ${evento === "pagada" ? "pagarse" : "aceptarse"}.`
        : `Una cotización acaba de ${evento === "pagada" ? "pagarse" : "aceptarse"}.`;
  // AUTÓNOMA vs ASISTIDA (Lalo 24-ago): solo en el pago de ventas de Vicky.
  const filaVenta =
    venta === "autonoma"
      ? `<tr><td><b>Venta</b></td><td>🤖 <b>100% AUTÓNOMA</b> — sin gestión del ejecutivo registrada en el deal; el acompañamiento post-venta pasa al dueño de ventas autónomas</td></tr>`
      : venta === "asistida"
        ? `<tr><td><b>Venta</b></td><td>🤝 <b>ASISTIDA</b> — el ejecutivo registró gestión en el deal (nota o WhatsApp espejado)</td></tr>`
        : "";
  const filaCanal =
    canal === "ejecutivo"
      ? `<tr><td><b>Canal</b></td><td>👤 Ejecutivo (cotizadora)</td></tr>`
      : canal === "vicky"
        ? `<tr><td><b>Canal</b></td><td>🤖 Vicky (WhatsApp)</td></tr>`
        : "";
  return `<!DOCTYPE html><html lang="es"><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;">
<h2 style="color:#0d47a1;margin:0 0 8px;">${titulo}</h2>
<p style="margin:0 0 12px;color:#4a5568;">${intro}</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px;">
  <tr><td><b>Empresa</b></td><td>${empresa || "—"}</td></tr>
  <tr><td><b>Cotización</b></td><td>${numero || "—"}</td></tr>
  ${filaCanal}
  ${filaVenta}
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
  // Un destinatario BLOQUEADO por Zoho no puede matar el aviso al resto.
  // La v1 (31-jul, caso pdíaz@ en la lista de rebotes) reintentaba SIN
  // NINGUNA copia — y con la lista de equipo del 18-ago eso dejó el correo
  // de COT524 solo en Eduardo. Ahora: (1) se quitan SOLO las direcciones que
  // el error nombra; (2) si Zoho no las nombra o sigue fallando, envíos
  // INDIVIDUALES best-effort — cada bloqueada cae sola, el resto recibe.
  if (!r.ok && dataPayload.cc && /NOT_ALLOWED|blocked email|UTF-8 addresses/i.test(r.text)) {
    const textoError = String(r.text || "").toLowerCase();
    const ccVivas = dataPayload.cc.filter((c) => !textoError.includes(String(c.email).toLowerCase()));
    if (ccVivas.length < dataPayload.cc.length) {
      console.error(
        `[quote-notify] CC bloqueado por Zoho (${r.text.slice(0, 160)}). Reintentando sin las direcciones nombradas (${dataPayload.cc.length - ccVivas.length}).`,
      );
      const filtrado = { ...dataPayload };
      if (ccVivas.length) filtrado.cc = ccVivas;
      else delete filtrado.cc;
      r = await enviar(filtrado);
    }
    if (!r.ok) {
      console.error(
        `[quote-notify] envío con copias sigue fallando (${r.text.slice(0, 120)}). Pasando a envíos individuales.`,
      );
      let algunoOk = false;
      for (const dest of [first, ...rest]) {
        const individual = {
          from: { email: NOTIFY_FROM },
          to: [{ email: dest }],
          subject,
          content: htmlBody,
          mail_format: "html",
        };
        const ri = await enviar(individual);
        if (ri.ok) algunoOk = true;
        else console.error(`[quote-notify] destinatario ${dest} falló: ${ri.text.slice(0, 120)}`);
      }
      if (algunoOk) return;
    }
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

    // CANAL DE ORIGEN (Lalo 19-ago): Intervenci_n_Humana se estampa en la
    // emisión ("100% Vicky" / "Con intervención humana" = cotizadora del
    // ejecutivo). Cotizaciones anteriores al 19-ago no lo traen → sin sufijo.
    let canal = "";
    try {
      const marca = toText(
        quote?.Intervenci_n_Humana ||
          (await getRecordWithFields(config.quoteModule, quoteId, ["Intervenci_n_Humana"]).then(
            (r) => r?.Intervenci_n_Humana,
          )),
      );
      canal = /100%\s*Vicky/i.test(marca) ? "vicky" : /intervenci/i.test(marca) ? "ejecutivo" : "";
    } catch (_e) {
      canal = "";
    }
    // VENTA AUTÓNOMA vs ASISTIDA (Lalo 24-ago): en el PAGO de una venta de
    // Vicky, el correo dice si el ejecutivo registró gestión en el deal
    // (nota humana o nota-espejo). Sin gestión, el agente además devuelve el
    // deal al dueño de ventas autónomas — este correo es el aviso.
    let venta = "";
    if (evento === "pagada" && canal === "vicky") {
      venta = (await hayGestionEjecutivoEnDeal(dealId)) ? "asistida" : "autonoma";
    }
    const sufijoCanal =
      (canal === "ejecutivo" ? " · Canal: EJECUTIVO (cotizadora)" : canal === "vicky" ? " · Canal: VICKY" : "") +
      (venta === "autonoma" ? " · VENTA AUTÓNOMA" : venta === "asistida" ? " · VENTA ASISTIDA" : "");
    const subject = `[GeoVictoria] Cotización ${numero || quoteId} ${
      evento === "pagada" ? "PAGADA" : "ACEPTADA"
    } — ${empresa || "cliente"}${sufijoCanal}`;
    const htmlBody = buildHtml({ evento, empresa, numero, clientEmail, rut, montoClp, dealId, pagosMp, canal, venta });
    // Multi-país: en cotizaciones CO la ejecutiva es Laura (no Anderson);
    // en cotizaciones MX es Yahel Segura. CL sigue con los destinatarios de
    // siempre.
    const esCO = await esCotizacionCO(quote, null, config).catch(() => false);
    const esMX = !esCO && (await esCotizacionMX(quote, config).catch(() => false));
    const esPE = !esCO && !esMX && (await esCotizacionPEnotify(quote, config).catch(() => false));
    // PROPIETARIO del trato/cotización SIEMPRE copiado (Lalo 31-jul): primero
    // el Owner de la cotización; si no viene, el Owner del deal. Dedup contra
    // la base y jamás el robot Vicky.
    let ownerEmail = toText(quote?.Owner?.email);
    // DUEÑO ROBOT ≠ EJECUTIVO (bug cazado 20-ago, caso SYM/COT510): desde el
    // 04-ago las cotizaciones de Vicky NACEN con el robot como Owner y el
    // humano vive en el DEAL (traspaso). El robot tiene correo
    // (vicky@geovictoria.com), así que este fallback nunca corría y el
    // ejecutivo del deal quedaba fuera del correo ACEPTADA/PAGADA.
    if (/^vicky@geovictoria\.com$/i.test(ownerEmail)) ownerEmail = "";
    if (!ownerEmail && dealId) {
      const dealOwner = await getRecordWithFields("Deals", dealId, ["Owner"]).catch(() => null);
      ownerEmail = toText(dealOwner?.Owner?.email);
    }
    let base = esCO ? NOTIFY_RECIPIENTS_CO : esMX ? NOTIFY_RECIPIENTS_MX : esPE ? NOTIFY_RECIPIENTS_PE : NOTIFY_RECIPIENTS;
    // SOLO LAS VENTAS DE VICKY (Lalo 31-ago): los avisos del canal EJECUTIVO
    // confunden a quien mide cuánto vende Vicky —parecen ventas suyas y no lo
    // son—, así que esas direcciones quedan fuera cuando la cotización viene
    // de la cotizadora. Las de Vicky y las anteriores al 19-ago (sin marca de
    // canal) les siguen llegando enteras.
    if (canal === "ejecutivo" && SOLO_VENTAS_VICKY.size) {
      base = base.filter((e) => !SOLO_VENTAS_VICKY.has(String(e || "").trim().toLowerCase()));
    }
    // Copia a la dueña del acompañamiento autónomo en TODO pago CL (Lalo
    // 24-ago) — se entera tanto de las autónomas (suyas) como de las
    // asistidas (contexto).
    const ccPagada = evento === "pagada" && !esCO && !esMX && !esPE ? NOTIFY_CC_PAGADA_CL : [];
    const vistos = new Set();
    const recipients = [...base, ownerEmail, ...ccPagada].filter((e) => {
      const low = String(e || "").trim().toLowerCase();
      if (!low || low === "vicky@geovictoria.com" || vistos.has(low)) return false;
      vistos.add(low);
      return true;
    });
    await sendInternalMail({ quoteModule: config.quoteModule, quoteId, subject, htmlBody, recipients });
    console.log(`[quote-notify] enviado evento=${evento} quote=${numero || quoteId} pais=${esCO ? "co" : esMX ? "mx" : esPE ? "pe" : "cl"} → ${recipients.join(", ")}`);
    // Además del correo: aviso por WhatsApp (best-effort, no bloquea).
    await notifyWhatsApp({ evento, empresa, numero, montoClp, quoteId });
  } catch (err) {
    console.error(`[quote-notify] falló (best-effort) evento=${evento}:`, toText(err?.message || err).slice(0, 200));
  }
}

module.exports = { notifyQuoteEvent, shouldNotify, detallePagosMP, buildHtml };
