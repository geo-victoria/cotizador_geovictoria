/**
 * PDF de cotización PERÚ (una página) — espejo del builder CO con las reglas
 * peruanas de la Fase 2 (11-ago-2026):
 *   - Encabezado: GEOVICTORIA PERU S.A.C. / RUC 20605842055 / Magdalena del
 *     Mar, Lima.
 *   - Montos SOLO en soles con formato S/1,234.56 (es-PE). Sin UF.
 *   - IGV 18 % EN TODOS los conceptos (regla del excel de tropicalización,
 *     VB Diego Bendezú 05-ago): la tabla muestra netos y las cajas de
 *     totales desglosan neto + IGV = total, tanto en el pago inicial como
 *     en la mensualidad.
 *   - SIN capacitación (en Perú no existe, ni cobrada ni de regalo — no se
 *     agrega la línea valorizada del PDF CO).
 *   - Activación (primer mes por adelantado) NO se tabula como producto
 *     (diseño chileno, Lalo 24-jul): vive en la caja "Pago inicial".
 *   - Ejecutiva: Mónica Mendoza (única del canal PE, sin tómbola).
 *
 * Contrato de items (create-from-vicky-pe): { tipo, id, nombre, descripcion?,
 * modalidad, cantidad, precioUnitarioPEN, subtotalPEN, esRecurrente,
 * afectoIgv }.
 */

const { ONEPAGER_CSS } = require("./proposal-html-builder");

const VALIDEZ_DIAS_PE = 30;

// Datos fijos de la entidad peruana (cabecera superior derecha del PDF).
const ORG_PE = {
  nombre: "GEOVICTORIA PERU S.A.C.",
  ruc: "20605842055",
  direccion: "Av. Juan de Aliaga 425 Int. 612, Magdalena del Mar",
  ciudad: "Lima, Perú",
};

// Ejecutiva comercial PE (meta y pie del PDF). Mónica Mendoza es la única
// ejecutiva del canal Perú (definición Fase 1, 05-ago; sin tómbola).
// Parametrizado por env para cambiarla sin deploy; teléfono de su ficha Zoho.
const EJEC_PE = {
  nombre: (process.env.VICKY_EJECUTIVO_NOMBRE_PE || "Mónica Mendoza").trim(),
  cargo: (process.env.VICKY_EJECUTIVO_CARGO_PE || "Ejecutiva Comercial").trim(),
  email: (process.env.VICKY_EJECUTIVO_EMAIL_PE || "mmendozav@geovictoria.com").trim(),
  telefono: (process.env.VICKY_EJECUTIVO_TELEFONO_PE || "+51 962 277 502").trim(),
};

// IGV peruano: 18 % parejo en todos los conceptos (a diferencia de CO, donde
// solo el hardware es afecto). El flag afectoIgv viaja por línea igual, por
// si negocio algún día exime algo.
const IGV_PE = 0.18;

function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// PEN: S/1,234.56 (es-PE: miles con coma, decimales con punto). Enteros sin
// decimales — los precios de lista PE son enteros (100/200/70/525).
function formatPEN(value) {
  const n = Math.round(Number(value || 0) * 100) / 100;
  const opts = Number.isInteger(n)
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return "S/" + n.toLocaleString("es-PE", opts);
}

function formatFechaCorta(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

// Fecha + hora en horario de Perú (America/Lima, sin DST).
function formatFechaHoraPE(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Lima",
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

const DESC_PLAN_PE =
  "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.";
const DESC_ACTIVACION_PE =
  "Habilitación y configuración inicial del servicio. Equivale al primer mes del plan, cobrado por adelantado.";
const DESC_EQUIPO_PE =
  "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío e instalación sin costo en Lima Metropolitana.";

function esItemActivacion(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  const id = String(item.id || "").toLowerCase();
  const nombre = String(item.nombre || "").toLowerCase();
  return tipo === "activacion" || /activaci/.test(id) || /activaci/.test(nombre);
}

function descripcionItemPE(item) {
  const manual = String(item.descripcion || "").trim();
  if (manual) return manual;
  if (esItemActivacion(item)) return DESC_ACTIVACION_PE;
  if (String(item.tipo || "").toLowerCase() === "hardware") return DESC_EQUIPO_PE;
  return DESC_PLAN_PE;
}

function buildProposalHtmlPE({
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
  const ruc = escapeHtml(cliente.ruc || "");
  const cotizNumero = escapeHtml(cotizacionId || "—");

  const hoy = new Date();
  const fechaHora = formatFechaHoraPE(hoy);
  const vence = validezHasta
    ? formatFechaCorta(new Date(validezHasta))
    : formatFechaCorta(new Date(hoy.getTime() + VALIDEZ_DIAS_PE * 24 * 60 * 60 * 1000));

  // ── Filas (netos; el IGV vive en las cajas de totales) ──
  const filas = (Array.isArray(items) ? items : []).map((item) => {
    const subtotal = Math.round(Number(item.subtotalPEN || 0) * 100) / 100;
    const afectoIgv = item.afectoIgv !== false; // en PE todo es afecto salvo excepción explícita
    return {
      nombre: escapeHtml(item.nombre || ""),
      modalidad: item.esRecurrente === true ? "Pago mensual" : "Pago único",
      desc: escapeHtml(descripcionItemPE(item)),
      puPEN: Math.round(Number(item.precioUnitarioPEN || 0) * 100) / 100,
      cant: Number(item.cantidad || 1),
      subtotal,
      igv: afectoIgv ? Math.round(subtotal * IGV_PE * 100) / 100 : 0,
      recurrente: item.esRecurrente === true,
      esActivacion: esItemActivacion(item),
    };
  });

  // ── Totales: únicos (pago inicial) vs recurrentes (mensualidad), con IGV ──
  let uniNeto = 0, uniIgv = 0, recNeto = 0, recIgv = 0;
  for (const f of filas) {
    if (f.recurrente) {
      recNeto += f.subtotal;
      recIgv += f.igv;
    } else {
      uniNeto += f.subtotal;
      uniIgv += f.igv;
    }
  }
  const uniTot = uniNeto + uniIgv;
  const recTot = recNeto + recIgv;

  const rowItem = (f) =>
    `<tr>` +
    `<td class="c-nom">${f.nombre}</td>` +
    `<td class="c-modal">${f.modalidad}</td>` +
    `<td class="c-desc">${f.desc}</td>` +
    `<td class="c-num">${formatPEN(f.puPEN)}</td>` +
    `<td class="c-num">${f.cant}</td>` +
    `<td class="c-num c-tot">${formatPEN(f.subtotal)}</td>` +
    `</tr>`;
  // La Activación no se tabula (diseño chileno) pero SÍ queda contada en
  // uniNeto: la caja "Pago inicial" la cobra igual.
  const filasVisibles = filas.filter((f) => !f.esActivacion);
  const rowsHtml = filasVisibles.map(rowItem).join("");
  const totalTabla = filasVisibles.reduce((acc, f) => acc + f.subtotal, 0);

  // ── Cajas de totales (neto + IGV 18 % = total, en ambas) ──
  let totHtml = "";
  totHtml += `<div class="tot-h">Pago inicial — al aceptar</div>`;
  totHtml += `<div class="tr"><span>Conceptos de pago único (incluye Activación)</span><span>${formatPEN(uniNeto)}</span></div>`;
  if (uniIgv > 0) {
    totHtml += `<div class="tr"><span>IGV (18 %)</span><span>${formatPEN(uniIgv)}</span></div>`;
  }
  totHtml += `<div class="tr grand"><span>Total a pagar ahora</span><span>${formatPEN(uniTot)}</span></div>`;
  if (recTot > 0) {
    totHtml += `<div class="tot-h" style="margin-top:6px">Mensualidad — desde el mes siguiente</div>`;
    totHtml += `<div class="tr"><span>Servicio${recNeto !== recIgv ? " y equipos" : ""}</span><span>${formatPEN(recNeto)}</span></div>`;
    if (recIgv > 0) {
      totHtml += `<div class="tr"><span>IGV (18 %)</span><span>${formatPEN(recIgv)}</span></div>`;
    }
    totHtml += `<div class="tr grand"><span>Total mensual</span><span>${formatPEN(recTot)}/mes</span></div>`;
  }
  totHtml +=
    `<div style="margin-top:8px;font-size:8px;line-height:1.4;color:#646464">` +
    `El <b>Pago inicial</b> se cobra al aceptar y corresponde a los conceptos de pago &uacute;nico; ` +
    `la <b>Activaci&oacute;n</b> equivale al primer mes de servicio, cobrado por adelantado. ` +
    `La <b>mensualidad</b> se factura desde el mes siguiente seg&uacute;n usuarios activos.` +
    `</div>`;

  const ctaHref = escapeHtml(acceptanceUrl || "#");
  const notaTexto = "Valores netos en soles (PEN). El IGV (18 %) se detalla en los totales.";

  const TYC_PE = [
    "El pago inicial —al aceptar esta cotización— corresponde a los conceptos de pago único e incluye la Activación, equivalente al primer mes de servicio cobrado por adelantado. La mensualidad se factura desde el mes siguiente.",
    "Valores netos en soles (PEN); a todos los conceptos se les aplica IGV (18 %).",
    "La mensualidad está sujeta a la cantidad de usuarios de esta cotización: la variación de usuarios activos ajusta el cobro en la facturación del período siguiente.",
    "Envío e instalación del reloj sin costo en Lima Metropolitana. El envío a provincia corre por cuenta del cliente; la instalación fuera de Lima se coordina con nuestro servicio técnico y se cotiza aparte.",
    "Para los equipos en modalidad arriendo: el servicio incluye mantención y reposición por falla técnica; los equipos son propiedad de GeoVictoria y deben devolverse al término del servicio.",
    "Sin cláusula de permanencia: usted puede terminar el servicio avisando con 30 días de anticipación.",
    "Los equipos en modalidad venta incluyen garantía de fábrica de 1 año bajo uso normal.",
    "Incluye sin costo: soporte de lunes a viernes de 8:30 a 18:30, actualizaciones, app móvil y portal del colaborador.",
    "Plataforma cloud en Microsoft Azure con uptime garantizado de 99,5 %.",
    `Cotización válida por ${VALIDEZ_DIAS_PE} días desde su emisión.`,
  ];
  const tycHtml = TYC_PE.map((t) => `<li>${escapeHtml(t)}</li>`).join("");

  const { LOGO_ORIGINAL_SVG } = require("./proposal-constants");

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Cotización ${cotizNumero} — ${empresa}</title>
<style>${ONEPAGER_CSS}</style></head>
<body>
<div class="page"><div class="sheet">

  <div class="hdr">
    <div class="logo">${LOGO_ORIGINAL_SVG}</div>
    <div class="org">
      <b>${ORG_PE.nombre}</b>
      RUC: ${ORG_PE.ruc}<br>${ORG_PE.direccion}<br>${ORG_PE.ciudad}
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
      <div class="row"><span class="l">RUC:</span><span>${ruc}</span></div>
      <div class="row"><span class="l">Contacto:</span><span>${contacto}</span></div>
    </div>
    <div>
      <div class="row"><span class="l">Fecha:</span><span>${fechaHora}</span></div>
      <div class="row"><span class="l">Válida hasta:</span><span>${vence}</span></div>
      <div class="row"><span class="l">Ejecutiva:</span><span>${escapeHtml(EJEC_PE.nombre)}</span></div>
      <div class="row"><span class="l">E-mail:</span><span>${escapeHtml(EJEC_PE.email)}</span></div>
    </div>
  </div>

  <div class="band">Productos y Servicios</div>
  <table>
    <thead>
      <tr><th>Nombre</th><th>Modalidad</th><th>Descripción</th><th class="r">P. Unitario</th><th class="r">Cant.</th><th class="r">Total</th></tr>
    </thead>
    <tbody>${rowsHtml}
      <tr class="sub"><td colspan="5">Subtotal</td><td class="c-num">${formatPEN(totalTabla)}</td></tr>
    </tbody>
  </table>

  <div class="note">${notaTexto}</div>

  <div class="bottom">
    <div class="box">
      <h4>Términos y Condiciones</h4>
      <ul class="tyc">
        ${tycHtml}
      </ul>
      <h4>Cómo continúa</h4>
      <ol class="flow">
        <li>Revise el detalle de su cotización.</li>
        <li>Acepte los términos y condiciones.</li>
        <li>Pague en línea de forma segura.</li>
        <li>Comience a usar GeoVictoria en 24 horas hábiles.</li>
      </ol>
    </div>
    <div>
      <div class="tot">${totHtml}</div>
      <a class="cta-btn" href="${ctaHref}">Haga clic aquí para aceptar, pagar y comenzar…</a>
      <p class="cta-sub">Pague e inicie su onboarding en solo 15 minutos.<br>Activaremos su servicio en 24 horas hábiles.</p>
    </div>
  </div>

  <div class="foot">
    <div>Página 1 de 1 · Cotización N° ${cotizNumero}</div>
    <div><b>${escapeHtml(EJEC_PE.cargo)}:</b> ${escapeHtml(EJEC_PE.nombre)} · ${escapeHtml(EJEC_PE.email)} · ${escapeHtml(EJEC_PE.telefono)}</div>
  </div>

</div></div>
<script>
/* Auto-ajuste: si el contenido excede la hoja, se escala para caber en una
   sola página, sin recortar (mismo mecanismo que CL/CO). */
(function () {
  var sheet = document.querySelector(".sheet");
  if (!sheet) return;
  var avail = 1048;
  var h = sheet.scrollHeight;
  if (h > avail) {
    var k = avail / h;
    sheet.style.transform = "scale(" + k + ")";
  }
})();
</script>
</body></html>`;
}

module.exports = { buildProposalHtmlPE, IGV_PE, VALIDEZ_DIAS_PE };
