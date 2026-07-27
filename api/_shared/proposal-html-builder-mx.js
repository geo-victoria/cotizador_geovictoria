/**
 * Construye el HTML de la cotización MÉXICO (one-pager) server-side.
 *
 * Variante MX de proposal-html-builder.js (Chile), espejo del camino que tomó
 * Colombia (proposal-html-builder-co.js): reusa el MISMO CSS/layout
 * (ONEPAGER_CSS exportado por el builder chileno) con las reglas MX del
 * documento de tropicalización:
 *   - Encabezado: CHECADOR, S.A. de C.V. / RFC CEC2005286R4 / CDMX.
 *   - Montos SOLO en MXN con formato mexicano $1,000 (es-MX, coma de miles,
 *     punto decimal). Sin UF ni conversiones: el precio de lista YA es en
 *     pesos mexicanos. Centavos solo cuando existen (redondeo a 2 decimales,
 *     ver computeTotalsMX en quote-pricing.js).
 *   - IVA 16% POR LÍNEA según afectoIva (a diferencia de CO, en MX el IVA
 *     aplica en general a servicios y hardware: el agente marca las líneas
 *     gravadas). Las filas afectas se marcan "+ IVA" y los totales lo
 *     desglosan como "IVA (16 %)".
 *   - Capacitación online: ítem COBRADO ($600 MXN pago único) que el endpoint
 *     create-from-vicky-mx garantiza en items (ensureCapacitacion). Este
 *     builder NO agrega líneas fijas propias — nada de la mecánica CL/CO de
 *     "valorizada con 100 % de descuento": la capacitación MX se cobra y su
 *     descripción es honesta (sin leyenda de regalo).
 *   - Bloque de totales: "Pago inicial (al aceptar)" = pagos únicos
 *     (capacitación + equipos/envío/instalación si aplican); "Mensualidad" =
 *     recurrentes, facturada desde la activación del servicio. MX no tiene
 *     fila de Activación ni "primer mes por adelantado".
 *   - T&C adaptados de Chile: MXN con IVA 16% donde se indique; relojes en
 *     arriendo propiedad de GeoVictoria con devolución a Hamburgo 213 y multa
 *     equivalente a 6 mensualidades de arriendo ($2,100 MXN por reloj, espejo
 *     de la regla chilena) si conserva equipos con menos de 6 mensualidades
 *     pagadas; sin permanencia con aviso de 30 días; soporte L-V; nube con
 *     uptime 99,5 %. Incluye datos de transferencia BANORTE.
 *   - Registro de TUTEO (mismo tono que Chile y que el correo MX).
 *
 * Interfaz (espejo de buildProposalHtmlCO):
 *   buildProposalHtmlMX({ cliente, items, acceptanceUrl, cotizacionId,
 *                         validezHasta, version })
 *   - cliente: { empresa, contacto, rfc }
 *   - items: items del contrato de create-from-vicky-mx (INCLUYENDO la fila
 *     de capacitación que ese endpoint garantiza): {tipo, id, nombre,
 *     descripcion?, modalidad, cantidad, precioUnitarioMXN, subtotalMXN,
 *     esRecurrente, afectoIva}.
 */

const { ONEPAGER_CSS } = require("./proposal-html-builder");
const { IVA_RATE_MX } = require("./quote-pricing");

// Ventana de validez de la cotización (días) — misma que CL/CO.
const VALIDEZ_DIAS_MX = 30;

// Datos fijos de la entidad mexicana (cabecera superior derecha del PDF).
const ORG_MX = {
  nombre: "CHECADOR, S.A. de C.V.",
  rfc: "CEC2005286R4",
  direccion: "Hamburgo 213, Piso 10, Cuauhtémoc",
  ciudad: "Ciudad de México, C.P. 06600",
};

// Datos de transferencia bancaria MX (T&C del PDF y flujos de pago futuros).
const TRANSFERENCIA_MX = {
  banco: "BANORTE",
  cuenta: "1161438886",
  clabe: "072180011614388864",
  titular: "CHECADOR, S.A. de C.V.",
  rfc: "CEC2005286R4",
  swift: "MENOMXMTXXX",
};

// Ejecutivo comercial MX (meta y pie del PDF). Yahel Segura toma los deals y
// cotizaciones de Vicky MX (espejo de Alejandro Gordillo en CO). Parametrizado
// por env; el TELÉFONO está pendiente de confirmación — si la env no está
// definida se OMITE del PDF (no se inventa).
const EJEC_MX = {
  nombre: (process.env.VICKY_EJECUTIVO_NOMBRE_MX || "Yahel Segura").trim(),
  cargo: (process.env.VICKY_EJECUTIVO_CARGO_MX || "Ejecutivo Comercial").trim(),
  email: (process.env.VICKY_EJECUTIVO_EMAIL_MX || "ysegura@geovictoria.com").trim(),
  telefono: (process.env.VICKY_EJECUTIVO_TELEFONO_MX || "+52 55 3763 6604").trim(),
};

// ───────────────────────────────────────────────────────────────────────────
// Helpers de formato (locales al archivo, como en la variante CO: el formato
// MX difiere — es-MX, coma de miles, punto decimal, centavos cuando existen).
// ───────────────────────────────────────────────────────────────────────────

function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// MXN: $1,000 (sin decimales cuando son .00) o $1,540.48 (2 decimales).
function formatMXN(value) {
  const n = Math.round(Number(value || 0) * 100) / 100;
  if (Number.isInteger(n)) return "$" + n.toLocaleString("es-MX");
  return (
    "$" +
    n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function formatFechaCorta(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

// Fecha + hora en horario de Ciudad de México (America/Mexico_City, sin DST
// desde 2022).
function formatFechaHoraMX(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Mexico_City",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")} hrs`;
}

// ───────────────────────────────────────────────────────────────────────────
// Descripciones por tipo de ítem (tuteo; sin normativa chilena ni colombiana).
// ───────────────────────────────────────────────────────────────────────────
const DESC_PLAN_MX =
  "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.";
const DESC_EQUIPO_MX =
  "Reloj checador biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.";
const DESC_ENVIO_MX =
  "Envío del equipo a la dirección del cliente: incluye embalaje y transporte hasta destino. Se cobra por punto y no es descontable.";
const DESC_INSTALACION_MX =
  "Instalación en sitio y puesta en marcha del equipo, con carga inicial de trabajadores.";
// Descripción HONESTA de la capacitación MX: se cobra ($600 MXN pago único),
// sin la leyenda de regalo/100 % de descuento que usan CL/CO.
const DESC_CAPACITACION_MX =
  "Capacitación online al equipo administrador en el uso de la plataforma.";

// Resuelve la descripción de una fila: la del item si viene, si no una por
// tipo/id (mismo criterio de clasificación que la variante CO).
function descripcionItemMX(item) {
  const manual = String(item.descripcion || "").trim();
  if (manual) return manual;
  const tipo = String(item.tipo || "").toLowerCase();
  const id = String(item.id || "").toLowerCase();
  const nombre = String(item.nombre || "").toLowerCase();
  if (/capacitaci/.test(id) || /capacitaci/.test(nombre)) return DESC_CAPACITACION_MX;
  if (tipo === "hardware") return DESC_EQUIPO_MX;
  if (/envio|env[íi]o|despacho/.test(id) || /env[íi]o|despacho/.test(nombre)) return DESC_ENVIO_MX;
  if (/instalacion|instalaci/.test(id) || /instalaci/.test(nombre)) return DESC_INSTALACION_MX;
  return DESC_PLAN_MX;
}

// ───────────────────────────────────────────────────────────────────────────
// Builder principal MX
// ───────────────────────────────────────────────────────────────────────────
function buildProposalHtmlMX({
  cliente,
  items,
  acceptanceUrl,
  cotizacionId,
  validezHasta,
  version,
}) {
  cliente = cliente || {};
  const versionNum = Number(version) > 1 ? Number(version) : 1;

  const empresa = escapeHtml(cliente.empresa || "EMPRESA");
  const contacto = escapeHtml(cliente.contacto || "");
  const rfc = escapeHtml(cliente.rfc || "");
  const cotizNumero = escapeHtml(cotizacionId || "—");

  const hoy = new Date();
  const fechaHora = formatFechaHoraMX(hoy);
  const vence = validezHasta
    ? formatFechaCorta(new Date(validezHasta))
    : formatFechaCorta(new Date(hoy.getTime() + VALIDEZ_DIAS_MX * 24 * 60 * 60 * 1000));

  // ── Filas de la tabla (una por item; NINGUNA línea fija del builder: la
  // capacitación cobrada viene garantizada en items por el endpoint) ──
  const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const filas = (Array.isArray(items) ? items : []).map((item) => {
    const subtotal = round2(item.subtotalMXN);
    const afectoIva = item.afectoIva === true;
    return {
      nombre: escapeHtml(item.nombre || ""),
      modalidad: item.esRecurrente === true ? "Pago mensual" : "Pago único",
      desc: escapeHtml(descripcionItemMX(item)),
      puMXN: round2(item.precioUnitarioMXN),
      cant: Number(item.cantidad || 1),
      subtotal,
      iva: afectoIva ? round2(subtotal * IVA_RATE_MX) : 0,
      afectoIva,
      recurrente: item.esRecurrente === true,
    };
  });

  // ── Totales MX: únicos (pago inicial) vs recurrentes (mensualidad) ──
  // Netos + IVA 16% de las líneas afectas. Redondeo a centavos al cierre.
  let uniNeto = 0, uniIva = 0, recNeto = 0, recIva = 0;
  for (const f of filas) {
    if (f.recurrente) {
      recNeto += f.subtotal;
      recIva += f.iva;
    } else {
      uniNeto += f.subtotal;
      uniIva += f.iva;
    }
  }
  uniNeto = round2(uniNeto); uniIva = round2(uniIva);
  recNeto = round2(recNeto); recIva = round2(recIva);
  const uniTot = round2(uniNeto + uniIva);
  const recTot = round2(recNeto + recIva);

  const rowItem = (f) => {
    const totalCellInner = f.afectoIva
      ? `${formatMXN(f.subtotal)} + IVA`
      : formatMXN(f.subtotal);
    return (
      `<tr>` +
      `<td class="c-nom">${f.nombre}</td>` +
      `<td class="c-modal">${f.modalidad}</td>` +
      `<td class="c-desc">${f.desc}</td>` +
      `<td class="c-num">${formatMXN(f.puMXN)}</td>` +
      `<td class="c-num">${f.cant}</td>` +
      `<td class="c-num c-tot">${totalCellInner}</td>` +
      `</tr>`
    );
  };
  const rowsHtml = filas.map(rowItem).join("");
  // La fila "Subtotal" de la tabla suma los netos; el IVA se desglosa en la
  // caja de totales.
  const totalTabla = round2(uniNeto + recNeto);

  // ── Caja de totales ──
  let totHtml = "";
  totHtml += `<div class="tot-h">Pago inicial — al aceptar</div>`;
  totHtml += `<div class="tr"><span>Conceptos de pago único (incluye capacitación)</span><span>${formatMXN(uniNeto)}</span></div>`;
  if (uniIva > 0) {
    totHtml += `<div class="tr"><span>IVA (16 %)</span><span>${formatMXN(uniIva)}</span></div>`;
  }
  totHtml += `<div class="tr grand"><span>Total a pagar ahora</span><span>${formatMXN(uniTot)} MXN</span></div>`;
  if (recTot > 0) {
    totHtml += `<div class="tot-h" style="margin-top:6px">Mensualidad del servicio</div>`;
    totHtml += `<div class="tr"><span>Neto</span><span>${formatMXN(recNeto)}</span></div>`;
    if (recIva > 0) {
      totHtml += `<div class="tr"><span>IVA (16 %)</span><span>${formatMXN(recIva)}</span></div>`;
    }
    totHtml += `<div class="tr grand"><span>Total mensual</span><span>${formatMXN(recTot)} MXN/mes</span></div>`;
  }
  totHtml +=
    `<div style="margin-top:8px;font-size:8px;line-height:1.4;color:#646464">` +
    `El <b>Pago inicial</b> se cobra al aceptar y corresponde a los conceptos de pago &uacute;nico ` +
    `(capacitaci&oacute;n y, si aplica, equipos, env&iacute;o e instalaci&oacute;n). ` +
    `La <b>mensualidad</b> se factura desde la activaci&oacute;n del servicio; la variaci&oacute;n de usuarios activos la ajusta en la facturaci&oacute;n del per&iacute;odo siguiente.` +
    `</div>`;

  const ctaHref = escapeHtml(acceptanceUrl || "#");
  const notaTexto =
    "Valores en pesos mexicanos (MXN). Los montos no incluyen IVA (16 %), que se agrega donde se indica.";

  // T&C MX (adaptación de los chilenos: MXN e IVA 16%, devolución de arriendo
  // a Hamburgo 213 con multa espejo de la regla CL en MXN, sin permanencia,
  // capacitación COBRADA — por eso NO figura en el bullet "incluye sin costo").
  const TYC_MX = [
    "El pago inicial —al aceptar esta cotización— corresponde a los conceptos de pago único: capacitación y, si aplica, equipos, envío e instalación. La mensualidad del servicio se factura desde la activación.",
    "Valores en pesos mexicanos (MXN). Los montos no incluyen IVA (16 %), que se agrega donde se indica.",
    "La mensualidad está sujeta a la cantidad de usuarios de esta cotización: la variación de usuarios activos ajusta el cobro en la facturación del período siguiente.",
    `Para los relojes en modalidad arriendo: el servicio incluye mantención y reposición por falla técnica. Los equipos son propiedad de GeoVictoria y al término del servicio deben devolverse en ${ORG_MX.direccion}, ${ORG_MX.ciudad}. Si terminas el servicio con menos de 6 mensualidades de arriendo pagadas y conservas los equipos, se cobra el equivalente a 6 mensualidades de arriendo ($2,100 MXN por reloj).`,
    "Los equipos en modalidad venta incluyen garantía de fábrica de 1 año bajo uso normal. El envío se cobra por punto y no es descontable.",
    "Sin cláusula de permanencia: puedes terminar el servicio avisando con 30 días de anticipación.",
    "Incluye sin costo: soporte de lunes a viernes, actualizaciones, app móvil y portal del colaborador.",
    "Plataforma en la nube con uptime garantizado de 99,5 %.",
    `Pago por transferencia bancaria en pesos mexicanos (MXN) a ${TRANSFERENCIA_MX.titular} (RFC ${TRANSFERENCIA_MX.rfc}) — ${TRANSFERENCIA_MX.banco}, Cuenta ${TRANSFERENCIA_MX.cuenta}, CLABE ${TRANSFERENCIA_MX.clabe}, SWIFT ${TRANSFERENCIA_MX.swift}.`,
    `Cotización válida por ${VALIDEZ_DIAS_MX} días desde su emisión.`,
  ];
  const tycHtml = TYC_MX.map((t) => `<li>${escapeHtml(t)}</li>`).join("");

  // Logo: mismo require perezoso a proposal-constants que la variante CO.
  const { LOGO_ORIGINAL_SVG } = require("./proposal-constants");

  // Pie: el teléfono del ejecutivo se omite si no está configurado (pendiente).
  const footEjecutivo =
    `<b>${escapeHtml(EJEC_MX.cargo)}:</b> ${escapeHtml(EJEC_MX.nombre)} · ${escapeHtml(EJEC_MX.email)}` +
    (EJEC_MX.telefono ? ` · ${escapeHtml(EJEC_MX.telefono)}` : "");

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Cotización ${cotizNumero} — ${empresa}</title>
<style>${ONEPAGER_CSS}</style></head>
<body>
<div class="page"><div class="sheet">

  <div class="hdr">
    <div class="logo">${LOGO_ORIGINAL_SVG}</div>
    <div class="org">
      <b>${ORG_MX.nombre}</b>
      RFC: ${ORG_MX.rfc}<br>${ORG_MX.direccion}<br>${ORG_MX.ciudad}
    </div>
  </div>

  <div class="title">
    <span class="t">COTIZACIÓN N°</span>
    <span class="n">${cotizNumero}</span>
    ${versionNum >= 2 ? `<span class="v">v${versionNum}</span>` : ""}
    <div class="ys"></div>
  </div>

  <div class="meta">
    <div>
      <div class="row"><span class="l">Empresa:</span><span>${empresa}</span></div>
      <div class="row"><span class="l">RFC:</span><span>${rfc}</span></div>
      <div class="row"><span class="l">Contacto:</span><span>${contacto}</span></div>
    </div>
    <div>
      <div class="row"><span class="l">Fecha:</span><span>${fechaHora}</span></div>
      <div class="row"><span class="l">Válida hasta:</span><span>${vence}</span></div>
      <div class="row"><span class="l">Ejecutivo:</span><span>${escapeHtml(EJEC_MX.nombre)}</span></div>
      <div class="row"><span class="l">E-mail:</span><span>${escapeHtml(EJEC_MX.email)}</span></div>
    </div>
  </div>

  <div class="band">Productos y Servicios</div>
  <table>
    <thead>
      <tr><th>Nombre</th><th>Modalidad</th><th>Descripción</th><th class="r">P. Unitario</th><th class="r">Cant.</th><th class="r">Total</th></tr>
    </thead>
    <tbody>${rowsHtml}
      <tr class="sub"><td colspan="5">Subtotal (sin IVA)</td><td class="c-num">${formatMXN(totalTabla)}</td></tr>
    </tbody>
  </table>

  <div class="note">${notaTexto}</div>

  <div class="bottom">
    <div class="box">
      <h4>Términos y Condiciones</h4>
      <ul class="tyc">
        ${tycHtml}
      </ul>
      <h4>Cómo continúas</h4>
      <ol class="flow">
        <li>Revisa el detalle de tu cotización.</li>
        <li>Acepta los términos y condiciones.</li>
        <li>Realiza el pago inicial.</li>
        <li>Comienza a usar GeoVictoria en 24 horas hábiles.</li>
      </ol>
    </div>
    <div>
      <div class="tot">${totHtml}</div>
      <a class="cta-btn" href="${ctaHref}">Haz clic aquí para aceptar y comenzar…</a>
      <p class="cta-sub">Acepta e inicia tu onboarding en solo 15 minutos.<br>Activaremos tu servicio en 24 horas hábiles.</p>
    </div>
  </div>

  <div class="foot">
    <div>Página 1 de 1 · Cotización N° ${cotizNumero}</div>
    <div>${footEjecutivo}</div>
  </div>

</div></div>
<script>
/* Auto-ajuste: si el contenido excede la hoja (cotizaciones con muchos ítems),
   se escala hacia abajo lo justo para caber en una sola página, sin recortar. */
(function () {
  var sheet = document.querySelector(".sheet");
  if (!sheet) return;
  var avail = 1048; // alto útil de la hoja (px @96dpi)
  var h = sheet.scrollHeight;
  if (h > avail) {
    var k = avail / h;
    sheet.style.transform = "scale(" + k + ")";
  }
})();
</script>
</body></html>`;
}

module.exports = { buildProposalHtmlMX, ORG_MX, TRANSFERENCIA_MX, EJEC_MX };
