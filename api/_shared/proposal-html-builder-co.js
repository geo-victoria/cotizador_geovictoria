/**
 * Construye el HTML de la cotización COLOMBIA (one-pager) server-side.
 *
 * Variante CO de proposal-html-builder.js (Chile). Reusa el MISMO CSS/layout
 * (ONEPAGER_CSS exportado por el builder chileno) pero con las reglas CO:
 *   - Encabezado: Geovictoria Colombia SAS / NIT 901.367.959-1 / Bogotá.
 *   - Montos SOLO en COP con formato $1.234.567 (es-CO). Sin columna UF ni
 *     "UF del día": en Colombia el precio de lista YA es en pesos.
 *   - PRECIOS FINALES (decisión de negocio de Lalo, 10-jul, definitiva): el
 *     IVA NO existe en la experiencia del cliente CO — sin columna de IVA,
 *     sin marcas "Excluido de IVA", sin notas tributarias (art. 476). El
 *     tratamiento del IVA vive en la factura electrónica de GeoVictoria
 *     Colombia, no en la cotización.
 *   - Bloque de totales: "Pago inicial (al aceptar)" = suma de los pagos
 *     únicos (montos tal cual), con la Activación explicada como el primer
 *     mes del plan cobrado por adelantado; "Mensualidad — desde el mes
 *     siguiente" = suma de los recurrentes. Sin líneas de IVA.
 *   - Línea fija de "Capacitación online" valorizada en $95.000, tachada con
 *     100 % de descuento (misma mecánica comercial que Chile).
 *   - T&C adaptados: sin UF, sin Dirección del Trabajo, sin multa de arriendo.
 *     Arriendo: equipos propiedad de GeoVictoria, devolución al término del
 *     servicio. Sin cláusula de permanencia (terminación con aviso de 30
 *     días). Soporte L-V 8:30-18:30. Azure uptime 99,5 %. Vigencia 30 días.
 *   - TODO el texto al cliente en registro de usted (español neutro).
 *
 * Interfaz:
 *   buildProposalHtmlCO({ cliente, items, acceptanceUrl, cotizacionId,
 *                         validezHasta, version })
 *   - cliente: { empresa, contacto, nit }
 *   - items: items del contrato de create-from-vicky-co (INCLUYENDO la fila
 *     de Activación que ese endpoint garantiza): {tipo, id, nombre,
 *     descripcion?, modalidad, cantidad, precioUnitarioCOP, subtotalCOP,
 *     esRecurrente, afectoIva}.
 */

const { ONEPAGER_CSS } = require("./proposal-html-builder");

// Ventana de validez de la cotización (días) — decisión de negocio CO.
const VALIDEZ_DIAS_CO = 30;

// Capacitación online: valorizada en $95.000 COP con 100 % de descuento.
const CAPACITACION_COP = 95000;

// Datos fijos de la entidad colombiana (cabecera superior derecha del PDF).
const ORG_CO = {
  nombre: "Geovictoria Colombia SAS",
  nit: "901.367.959-1",
  direccion: "Carrera 14 # 89-48, Oficina 201, Edificio Novanta",
  ciudad: "Bogotá, Colombia",
};

// Ejecutivo comercial CO (aparece en meta y pie del PDF). Alejandro Gordillo
// es quien toma los deals y cotizaciones de Vicky CO (definición Lalo 16-jul,
// equivalente a Anderson Díaz en Chile). Parametrizado por env para poder
// cambiarlo sin tocar código; el teléfono es el de la ficha de Alejandro
// en Zoho (decisión Lalo 17-jul, provisorio hasta que él confirme).
const EJEC_CO = {
  // Rodrigo 27-jul: siempre el ejecutivo HUMANO — el símil de Eddyluz en
  // Colombia es Alejandro Gordillo (teléfono de su ficha en Zoho).
  nombre: (process.env.VICKY_EJECUTIVO_NOMBRE_CO || "Alejandro Gordillo").trim(),
  cargo: (process.env.VICKY_EJECUTIVO_CARGO_CO || "Ejecutivo Comercial").trim(),
  email: (process.env.VICKY_EJECUTIVO_EMAIL_CO || "agordillo@geovictoria.com").trim(),
  telefono: (process.env.VICKY_EJECUTIVO_TELEFONO_CO || "+57 314 267 7765").trim(),
};

// IVA (decisión 10-jul refinada): SOLO el hardware (reloj arriendo/venta,
// afectoIva=true) lleva IVA 19%; el resto son precios finales. Retenciones y
// artículos tributarios (ej. art. 476) no se mencionan jamás.
const IVA_CO = 0.19;

// ───────────────────────────────────────────────────────────────────────────
// Helpers de formato (locales al archivo: el chileno no exporta los suyos y
// el formato CO difiere — es-CO y sin UF).
// ───────────────────────────────────────────────────────────────────────────

function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// COP: sin decimales, separador de miles con punto → $1.234.567 (es-CO).
function formatCOP(value) {
  return "$" + Math.round(Number(value || 0)).toLocaleString("es-CO");
}

function formatFechaCorta(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

// Fecha + hora en horario de Colombia (America/Bogota, sin DST).
function formatFechaHoraCO(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
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
// Descripciones por tipo de ítem (registro de usted / neutro; sin menciones a
// la Dirección del Trabajo ni a normativa chilena).
// ───────────────────────────────────────────────────────────────────────────
const DESC_PLAN_CO =
  "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.";
const DESC_ACTIVACION_CO =
  "Habilitación y configuración inicial del servicio. Equivale al primer mes del plan, cobrado por adelantado.";
const DESC_EQUIPO_CO =
  "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.";
const DESC_ENVIO_CO =
  "Despacho del equipo a la dirección del cliente: incluye embalaje y transporte hasta destino.";
const DESC_INSTALACION_CO =
  "Instalación en sitio y puesta en marcha del equipo, con carga inicial de trabajadores.";
const DESC_CAPACITACION_CO =
  "Capacitación online al equipo administrador en el uso de la plataforma: configuración, marcaje, turnos, vacaciones y reportería. Valorizada en $95.000, incluida con 100 % de descuento.";

// Resuelve la descripción de una fila: la del item si viene, si no una por
// tipo/id. Clasifica envío/instalación por id o nombre porque el agente CO
// los manda como tipo "servicio" genérico.
// La Activación NO se tabula como producto (diseño chileno, pedido de Lalo
// 24-jul): repetía el monto del plan como segunda fila y el Subtotal la
// sumaba, pareciendo un doble cobro que luego "se restaba" en los recuadros.
// Sigue cobrándose igual — vive solo en la caja "Pago inicial — al aceptar",
// cuya nota explica que equivale al primer mes por adelantado.
function esItemActivacion(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  const id = String(item.id || "").toLowerCase();
  const nombre = String(item.nombre || "").toLowerCase();
  return tipo === "activacion" || /activaci/.test(id) || /activaci/.test(nombre);
}

function descripcionItemCO(item) {
  const manual = String(item.descripcion || "").trim();
  if (manual) return manual;
  const tipo = String(item.tipo || "").toLowerCase();
  const id = String(item.id || "").toLowerCase();
  const nombre = String(item.nombre || "").toLowerCase();
  if (esItemActivacion(item)) return DESC_ACTIVACION_CO;
  if (tipo === "hardware") return DESC_EQUIPO_CO;
  if (/envio|env[íi]o|despacho/.test(id) || /env[íi]o|despacho/.test(nombre)) return DESC_ENVIO_CO;
  if (/instalacion|instalaci/.test(id) || /instalaci/.test(nombre)) return DESC_INSTALACION_CO;
  return DESC_PLAN_CO;
}

// ───────────────────────────────────────────────────────────────────────────
// Builder principal CO
// ───────────────────────────────────────────────────────────────────────────
function buildProposalHtmlCO({
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
  const nit = escapeHtml(cliente.nit || "");
  const cotizNumero = escapeHtml(cotizacionId || "—");

  const hoy = new Date();
  const fechaHora = formatFechaHoraCO(hoy);
  const vence = validezHasta
    ? formatFechaCorta(new Date(validezHasta))
    : formatFechaCorta(new Date(hoy.getTime() + VALIDEZ_DIAS_CO * 24 * 60 * 60 * 1000));

  // ── Filas de la tabla (una por item + capacitación fija) ──
  // IVA (decisión 10-jul refinada): SOLO el hardware (afectoIva=true) lleva
  // IVA 19% — su fila lo marca "+ IVA" y los totales lo desglosan. El resto
  // son precios finales, sin mención de impuestos.
  const filas = (Array.isArray(items) ? items : []).map((item) => {
    const subtotal = Math.round(Number(item.subtotalCOP || 0));
    const afectoIva = item.afectoIva === true;
    return {
      nombre: escapeHtml(item.nombre || ""),
      modalidad: item.esRecurrente === true ? "Pago mensual" : "Pago único",
      desc: escapeHtml(descripcionItemCO(item)),
      puCOP: Math.round(Number(item.precioUnitarioCOP || 0)),
      cant: Number(item.cantidad || 1),
      subtotal,
      iva: afectoIva ? Math.round(subtotal * IVA_CO) : 0,
      afectoIva,
      recurrente: item.esRecurrente === true,
      descLineaPct: 0,
      esActivacion: esItemActivacion(item),
    };
  });

  // Línea fija: capacitación online valorizada y tachada (100 % dcto). No suma
  // al total porque su neto es 0.
  filas.push({
    nombre: "Capacitación online",
    modalidad: "Pago único",
    desc: escapeHtml(DESC_CAPACITACION_CO),
    puCOP: CAPACITACION_COP,
    cant: 1,
    subtotal: 0,
    subtotalBruto: CAPACITACION_COP,
    iva: 0,
    afectoIva: false,
    recurrente: false,
    descLineaPct: 100,
  });

  // ── Totales CO: únicos (pago inicial) vs recurrentes (mensualidad) ──
  // Netos + IVA de las líneas afectas (solo hardware).
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
  const uniTot = uniNeto + uniIva;
  const recTot = recNeto + recIva;

  const rowItem = (f) => {
    // Fila con descuento por línea (hoy solo la capacitación al 100 %):
    // bruto tachado + badge de descuento, neto al lado.
    let totalCellInner;
    if (f.descLineaPct > 0 && Number(f.subtotalBruto || 0) > 0) {
      totalCellInner =
        `<span class="line-old">${formatCOP(f.subtotalBruto)}</span> ` +
        `${formatCOP(f.subtotal)}` +
        `<span class="line-disc">−${f.descLineaPct}%</span>`;
    } else if (f.afectoIva) {
      totalCellInner = `${formatCOP(f.subtotal)} + IVA`;
    } else {
      totalCellInner = formatCOP(f.subtotal);
    }
    return (
      `<tr>` +
      `<td class="c-nom">${f.nombre}</td>` +
      `<td class="c-modal">${f.modalidad}</td>` +
      `<td class="c-desc">${f.desc}</td>` +
      `<td class="c-num">${formatCOP(f.puCOP)}</td>` +
      `<td class="c-num">${f.cant}</td>` +
      `<td class="c-num c-tot">${totalCellInner}</td>` +
      `</tr>`
    );
  };
  // La Activación no se tabula (ver esItemActivacion) pero SÍ queda contada
  // en uniNeto: la caja "Pago inicial" la cobra igual, como en Chile.
  const filasVisibles = filas.filter((f) => !f.esActivacion);
  const rowsHtml = filasVisibles.map(rowItem).join("");
  // La fila "Subtotal" de la tabla suma los netos visibles; el IVA del
  // hardware se desglosa en la caja de totales.
  const totalTabla = filasVisibles.reduce((acc, f) => acc + f.subtotal, 0);

  // ── Caja de totales ──
  // El IVA aparece SOLO si hay hardware (única familia afecta).
  let totHtml = "";
  totHtml += `<div class="tot-h">Pago inicial — al aceptar</div>`;
  totHtml += `<div class="tr"><span>Conceptos de pago único (incluye Activación)</span><span>${formatCOP(uniNeto)}</span></div>`;
  if (uniIva > 0) {
    totHtml += `<div class="tr"><span>IVA equipos (19 %)</span><span>${formatCOP(uniIva)}</span></div>`;
  }
  totHtml += `<div class="tr grand"><span>Total a pagar ahora</span><span>${formatCOP(uniTot)}</span></div>`;
  if (recTot > 0) {
    totHtml += `<div class="tot-h" style="margin-top:6px">Mensualidad — desde el mes siguiente</div>`;
    if (recIva > 0) {
      totHtml += `<div class="tr"><span>Servicio y equipos</span><span>${formatCOP(recNeto)}</span></div>`;
      totHtml += `<div class="tr"><span>IVA equipos (19 %)</span><span>${formatCOP(recIva)}</span></div>`;
    }
    totHtml += `<div class="tr grand"><span>Total mensual</span><span>${formatCOP(recTot)}/mes</span></div>`;
  }
  totHtml +=
    `<div style="margin-top:8px;font-size:8px;line-height:1.4;color:#646464">` +
    `El <b>Pago inicial</b> se cobra al aceptar y corresponde a los conceptos de pago &uacute;nico; ` +
    `la <b>Activaci&oacute;n</b> equivale al primer mes de servicio, cobrado por adelantado. ` +
    `La <b>mensualidad</b> se factura desde el mes siguiente; la variaci&oacute;n de usuarios activos la ajusta en la facturaci&oacute;n del per&iacute;odo siguiente.` +
    `</div>`;

  const ctaHref = escapeHtml(acceptanceUrl || "#");
  const notaTexto = "Valores en pesos colombianos (COP).";

  // T&C CO (sin UF, sin Dirección del Trabajo, sin multa de arriendo).
  // Precios finales (10-jul): el bullet tributario se reemplazó por la moneda
  // a secas — cero menciones a IVA en el texto al cliente.
  const TYC_CO = [
    "El pago inicial —al aceptar esta cotización— corresponde a los conceptos de pago único e incluye la Activación, equivalente al primer mes de servicio cobrado por adelantado. La mensualidad se factura desde el mes siguiente.",
    "Valores en pesos colombianos (COP).",
    "La mensualidad está sujeta a la cantidad de usuarios de esta cotización: la variación de usuarios activos ajusta el cobro en la facturación del período siguiente.",
    "Para los equipos en modalidad arriendo: el servicio incluye mantención y reposición por falla técnica; los equipos son propiedad de GeoVictoria y deben devolverse al término del servicio.",
    "Sin cláusula de permanencia: usted puede terminar el servicio avisando con 30 días de anticipación.",
    "Los equipos en modalidad venta incluyen garantía de fábrica de 1 año bajo uso normal.",
    "Incluye sin costo: soporte de lunes a viernes de 8:30 a 18:30, capacitación inicial, actualizaciones, app móvil y portal del colaborador.",
    "Plataforma cloud en Microsoft Azure con uptime garantizado de 99,5 %.",
    `Cotización válida por ${VALIDEZ_DIAS_CO} días desde su emisión.`,
  ];
  const tycHtml = TYC_CO.map((t) => `<li>${escapeHtml(t)}</li>`).join("");

  // Logo: se toma del builder chileno vía require perezoso a proposal-constants
  // para no duplicar el SVG acá.
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
      <b>${ORG_CO.nombre}</b>
      NIT: ${ORG_CO.nit}<br>${ORG_CO.direccion}<br>${ORG_CO.ciudad}
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
      <div class="row"><span class="l">NIT:</span><span>${nit}</span></div>
      <div class="row"><span class="l">Contacto:</span><span>${contacto}</span></div>
    </div>
    <div>
      <div class="row"><span class="l">Fecha:</span><span>${fechaHora}</span></div>
      <div class="row"><span class="l">Válida hasta:</span><span>${vence}</span></div>
      <div class="row"><span class="l">Ejecutiva:</span><span>${escapeHtml(EJEC_CO.nombre)}</span></div>
      <div class="row"><span class="l">E-mail:</span><span>${escapeHtml(EJEC_CO.email)}</span></div>
    </div>
  </div>

  <div class="band">Productos y Servicios</div>
  <table>
    <thead>
      <tr><th>Nombre</th><th>Modalidad</th><th>Descripción</th><th class="r">P. Unitario</th><th class="r">Cant.</th><th class="r">Total</th></tr>
    </thead>
    <tbody>${rowsHtml}
      <tr class="sub"><td colspan="5">Subtotal</td><td class="c-num">${formatCOP(totalTabla)}</td></tr>
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
    <div><b>${escapeHtml(EJEC_CO.cargo)}:</b> ${escapeHtml(EJEC_CO.nombre)} · ${escapeHtml(EJEC_CO.email)} · ${escapeHtml(EJEC_CO.telefono)}</div>
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

module.exports = { buildProposalHtmlCO, CAPACITACION_COP };
