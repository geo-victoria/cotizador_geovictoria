/**
 * Construye el HTML de la cotización (one-pager) server-side.
 *
 * Reemplaza la versión de 4 páginas por una cotización de UNA sola página,
 * alineada al estilo gráfico de GeoVictoria. PDFShift (Chromium headless) la
 * renderiza como PDF profesional.
 *
 * Interfaz pública (compat hacia atrás): create-from-vicky no necesita
 * pasar descuentos en la generación inicial.
 *   buildProposalHtml({ cliente, cotizacion, acceptanceUrl, cotizacionId,
 *                       validezHasta, version, descuentos, condicionDiscursiva })
 *
 *   - version: número de versión del PDF (1 = original). Se pinta como "vN"
 *     junto al N° de cotización cuando >= 2.
 *   - descuentos: { recurrentePct, instalacionRMPct, instalacionRegionPct,
 *     mesesPlan }. Si viene, los descuentos se aplican por línea en la tabla y
 *     al total. `mesesPlan` es la VIGENCIA del descuento del plan (Lalo
 *     10-ago): vacío = política por defecto (6 meses), 0 = indefinido, N = N
 *     meses. El texto sale siempre de textoVigenciaDescuento().
 *   - condicionDiscursiva: texto que se pinta al pie del bloque de totales
 *     (ej. "Este descuento aplica si pagas en 24 horas").
 *
 * Mapeo de datos:
 *   - cliente: empresa, contacto, rutEmpresa, ejecutivo (+ email/teléfono).
 *   - cotizacion.items (tipo modulo/hardware/servicio) → filas con modalidad
 *     normalizada a 3 valores: "Pago mensual" / "Pago único" / "Sin costo".
 *   - cotizacion.ufActual: UF del día para convertir UF → CLP.
 *   - Totales separados: Recurrente (mensual) vs Pago único.
 *   - Línea fija de Capacitación online sin costo en TODAS las cotizaciones.
 */

const {
  LOGO_ORIGINAL_SVG,
  PROPOSAL_TYC_ARRIENDO,
  textoVigenciaDescuento,
} = require("./proposal-constants");

// Ventana de validez de la cotización (días).
const VALIDEZ_DIAS = 30;

// ───────────────────────────────────────────────────────────────────────────
// Helpers de formato
// ───────────────────────────────────────────────────────────────────────────

function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCLP(value) {
  return "$" + Math.round(Number(value || 0)).toLocaleString("es-CL");
}

// UF: hasta 2 decimales, sin ceros trailing, coma decimal (formato chileno).
function formatUF(value) {
  const n = Number(value || 0);
  const r = Math.round(n * 100) / 100;
  if (Number.isInteger(r)) return r.toLocaleString("es-CL");
  const [e, d] = r.toFixed(2).split(".");
  const ec = Number(e).toLocaleString("es-CL");
  const dt = d.replace(/0+$/, "");
  return dt ? `${ec},${dt}` : ec;
}

function formatFechaCorta(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

// Fecha + hora en horario de Chile (America/Santiago, maneja DST). Se usa en el
// campo "Fecha" de la cotización para que cada versión (v2, v3…) quede con su
// fecha y hora exactas de emisión.
function formatFechaHora(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Santiago",
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
// Adaptador Vicky → listas tipadas
//   tipo "modulo"   → servicios (suscripción mensual)
//   tipo "hardware" → equipos   (arriendo recurrente o venta no recurrente)
//   tipo "servicio" → serviciosAsoc (instalación, no recurrente)
// ───────────────────────────────────────────────────────────────────────────
function adaptarItemsVicky(items) {
  const servicios = [];
  const equipos = [];
  const accesorios = []; // Vicky no genera accesorios separados hoy
  const serviciosAsoc = [];

  for (const it of items || []) {
    // Ítems OCULTOS (anualidad 01-sep): siguen en el subform y en los totales
    // del checkout, pero no se pintan (recurrentes en $0 tras anualizar —
    // regla Lalo: "solo debe verse anualidad, en la primera fila").
    if (it && it.oculto === true) continue;
    if (it.tipo === "modulo") {
      servicios.push({
        nombre: String(it.nombre || ""),
        cantidad: Number(it.cantidad || 1),
        tipo: it.modalidad === "Fijo" ? "Fijo" : "Por usuario",
        precioUnit: Number(it.precioUnitarioUF || 0),
        subtotalUF: Number(it.subtotalUF || 0),
        rango: it.tierAplicado || "",
      });
    } else if (it.tipo === "hardware") {
      const modalidad = String(it.modalidad || "").toLowerCase();
      const tipo = modalidad.startsWith("venta") ? "Venta" : "Arriendo";
      equipos.push({
        nombre: String(it.nombre || ""),
        cantidad: Number(it.cantidad || 1),
        tipo,
        codigo: String(it.id || it.codigo || "").toLowerCase(),
        // Descripción editada en Zoho (Descripcion_Item): si viene, GANA sobre
        // las descripciones por código (ítems manuales como "Tarjetas ID"
        // heredaban la descripción del reloj — caso real COT203, jul-2026).
        descripcion: String(it.descripcion || "").trim(),
        precioUnit: Number(it.precioUnitarioUF || 0),
        subtotalUF: Number(it.subtotalUF || 0),
        // Descuento por LÍNEA (Descuento_Pct del subform): el envío bonificado
        // llega como hardware/Venta al regenerar desde Zoho (caso Mesa
        // Incógnita 05-ago) y también debe mostrar el tachado −N%.
        descuentoPct: Number(it.descuentoPct || 0),
      });
    } else if (it.tipo === "servicio") {
      // El nombre suele venir como "Instalación reloj (Comuna)" — extraemos
      // la zona entre paréntesis si existe.
      const nombreRaw = String(it.nombre || "");
      const zonaMatch = nombreRaw.match(/\(([^)]+)\)\s*$/);
      const zona = zonaMatch ? zonaMatch[1] : "";
      const nombre = zonaMatch
        ? nombreRaw.replace(/\s*\([^)]+\)\s*$/, "")
        : nombreRaw;
      // zonaTarifa viene de la generación inicial en Vicky ("RM" / "regiones");
      // si no, se infiere "regiones" como fallback (mismo criterio que session.js
      // cuando no hay clasificación clara).
      const zonaTarifa = String(it.zonaTarifa || "").toLowerCase() === "rm"
        ? "RM"
        : "regiones";
      serviciosAsoc.push({
        nombre,
        cantidad: Number(it.cantidad || 1),
        zona,
        zonaTarifa,
        // Descripción manual (si viene, GANA sobre la fija por código — el
        // "Plan anual" de Quilacanta salió con la descripción de instalación
        // por no respetarla acá).
        descripcion: String(it.descripcion || "").trim(),
        codigo: String(it.id || it.codigo || "").toLowerCase(),
        precioUnit: Number(it.precioUnit || it.precioUnitarioUF || 0),
        subtotalUF: Number(it.subtotalUF || 0),
        // Descuento por LÍNEA del subform (Descuento_Pct) — caso "envío
        // bonificado" (Lalo 05-ago): mismo tachado −N% de la Capacitación.
        descuentoPct: Number(it.descuentoPct || 0),
      });
    }
  }

  return { servicios, equipos, accesorios, serviciosAsoc };
}

// Codigo_Item de servicios reconocidos como instalación. Espejo de
// CODIGOS_INSTALACION en quote-pricing.js (no se importa para no acoplar el
// builder de HTML a quote-pricing).
const CODIGOS_INSTALACION_PDF = new Set(["instalacion_reloj"]);

// ───────────────────────────────────────────────────────────────────────────
// Descripciones por tipo de ítem (oferta actual: asistencia + relojes control)
// ───────────────────────────────────────────────────────────────────────────
// Tramo en el NOMBRE del producto, entre paréntesis (aprobado por Lalo
// 05-ago, caso Grey/COT347): "Control de Asistencia (3 a 10 usuarios)".
// El rango viene como "3-10 usuarios" (tierAplicado) → se legibiliza a
// "3 a 10 usuarios". Sin rango (relojes, servicios), el nombre queda igual.
function nombreConTramo(s) {
  const rango = String(s.rango || "").trim();
  if (!rango) return s.nombre;
  const legible = rango.replace(/^(\d+)-(\d+)/, "$1 a $2");
  return `${s.nombre} (${legible})`;
}

function descServicio(s) {
  const nom = String(s.nombre || "").toLowerCase();
  // Módulo Vacaciones y Permisos (add-on pagado desde 21-jul): descripción
  // propia — sin esto heredaba el texto de asistencia (que además mencionaba
  // "vacaciones" como incluido, contradiciendo el cobro del módulo).
  // El tramo ya NO va acá: vive en el nombre del producto (nombreConTramo).
  if (nom.includes("vacacion") || nom.includes("permiso")) {
    return "Solicitud y aprobación digital de vacaciones, días administrativos, licencias y permisos desde la app. Saldos de días calculados automáticamente, con trazabilidad completa.";
  }
  return "Marcaje web, app móvil con GPS y biometría. Gestión de turnos y horas extra. Reportería en línea.";
}
const DESC_EQUIPO =
  "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Autorizado por la Dirección del Trabajo.";
const DESC_ENVIO_RELOJ =
  "Despacho del reloj a la dirección del cliente: incluye embalaje y transporte hasta destino.";
const DESC_UPS =
  "Sistema de respaldo de energía (UPS) para el reloj de control: mantiene el equipo operativo ante cortes de suministro eléctrico.";

// Descripción por ítem de hardware/accesorio. El subform de Zoho mezcla relojes
// con add-ons (envío, UPS) que NO son relojes; sin esto todos heredaban la
// descripción del reloj. Se resuelve por Codigo_Item (con respaldo por nombre);
// el reloj biométrico queda como fallback.
// Descripción manual del subform: vale solo si es una descripción REAL (una
// oración), no un código de modelo interno ("Sense Face 3A") que el flujo de
// creación deja en ese campo y que NUNCA debe mostrarse al cliente.
function descManualValida(texto) {
  const t = String(texto || "").trim();
  if (t.length < 40) return "";
  if (/sense\s*face|zk\s?teco|hikvision/i.test(t)) return "";
  return t;
}

function descEquipo(e) {
  const cod = String(e.codigo || "").toLowerCase();
  const nom = String(e.nombre || "").toLowerCase();
  if (cod.includes("envio") || cod.includes("envío") || cod.includes("despacho") || nom.includes("envío") || nom.includes("envio") || nom.includes("despacho")) {
    return DESC_ENVIO_RELOJ;
  }
  if (cod === "ups" || cod.includes("ups") || cod.includes("sai") || nom.includes("ups")) {
    return DESC_UPS;
  }
  return DESC_EQUIPO;
}
const DESC_SERVICIO_ASOC =
  "Instalación en terreno y puesta en marcha del equipo, con carga inicial de trabajadores.";
const DESC_CAPACITACION =
  "Capacitación online al equipo administrador en el uso de la plataforma: configuración, marcaje, turnos, vacaciones y reportería. Valorizada en 1 UF, incluida con 100% de descuento.";

// Datos fijos de la empresa (cabecera superior derecha).
const ORG = {
  nombre: "Victoria S.A",
  rut: "76.188.587-1",
  matriz: "Matriz: Avenida Los Leones 2061, Piso 4, Providencia, Santiago",
  tel: "(2) 2897 6514",
};

// Cursor "click" (SVG blanco) para el botón CTA.
const CTA_CURSOR =
  '<span class="cta-cursor"><svg width="42" height="42" viewBox="0 0 64 64"><g transform="rotate(-18 32 32)"><g stroke="#ffffff" stroke-width="3" stroke-linecap="round" fill="none"><line x1="30" y1="5" x2="30" y2="11"/><line x1="19" y1="8" x2="22" y2="13"/><line x1="41" y1="8" x2="38" y2="13"/><line x1="12" y1="16" x2="17" y2="19"/></g><path d="M26 20 C26 16.7 27.8 14 30 14 C32.2 14 34 16.7 34 20 L34 33 C35.5 31 38 30 40 31.5 C41 29.5 43.5 29.5 44.5 31.5 C45.5 30 48 30.5 48 34 L48 44 C48 51 43 56 36 56 L33 56 C29 56 26 54.5 23 51.5 L18.5 47 C16.8 45.3 16.8 43 18.5 41.3 C20.2 39.6 22.5 39.6 24.2 41.3 L26 43 Z" fill="#ffffff" stroke="#0a5470" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></g></svg></span>';

// ───────────────────────────────────────────────────────────────────────────
// CSS (one-pager, versión para PDF: fondo blanco, sin sombra de página)
// ───────────────────────────────────────────────────────────────────────────
const ONEPAGER_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#fff;margin:0;padding:0;font-family:'Nunito','Segoe UI',sans-serif;color:#4b4b4b}
.page{width:816px;height:1048px;background:#fff;margin:0 auto;position:relative;overflow:hidden}
.sheet{width:816px;min-height:1048px;padding:26px 40px 12px;display:flex;flex-direction:column;transform-origin:top center}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #FFBB00;padding-bottom:10px}
.hdr .logo{flex-shrink:0}
.hdr .org{text-align:right;font-size:9.5px;line-height:1.5;color:#646464}
.hdr .org b{font-size:13px;color:#00AFF2;display:block;margin-bottom:2px}
.title{text-align:center;margin:10px 0 4px}
.title .t{font-size:23px;font-weight:800;color:#646464;letter-spacing:1px}
.title .n{font-size:23px;font-weight:800;color:#00AFF2;margin-left:10px}
.title .ys{height:4px;width:200px;background:#FFBB00;margin:4px auto 0;border-radius:2px}
.meta{display:grid;grid-template-columns:1.3fr 1fr;gap:3px 24px;margin:9px 0 4px;font-size:11px}
.meta .l{color:#00AFF2;font-weight:800;text-transform:uppercase;font-size:9px;letter-spacing:.5px}
.meta .row{display:flex;gap:6px}
.meta .row span{color:#4b4b4b;font-weight:600}
.band{background:#00AFF2;color:#fff;font-weight:800;font-size:12px;padding:5px 12px;border-left:5px solid #FFBB00;margin-top:7px}
table{width:100%;border-collapse:collapse;font-size:10px;margin-top:5px}
th{background:rgba(0,175,242,.16);color:#00AFF2;font-weight:800;text-transform:uppercase;font-size:8.5px;letter-spacing:.3px;padding:5px 7px;border-bottom:2px solid rgba(0,175,242,.4);text-align:left}
th.r{text-align:right}
td{padding:4px 7px;border-bottom:1px solid rgba(100,100,100,.18);vertical-align:top}
.c-nom{font-weight:700;color:#4b4b4b;width:18%}
.c-modal{font-weight:700;color:#646464;font-size:9px;width:10%}
.c-desc{color:rgba(75,75,75,.85);font-size:9px;line-height:1.35;width:38%}
.c-num{text-align:right;white-space:nowrap}
.c-tot{font-weight:800;color:#646464}
.uf-ref{display:block;font-size:8px;color:rgba(100,100,100,.55);font-weight:600;font-style:italic}
.sub td{font-weight:800;color:#646464;border-top:2px solid rgba(100,100,100,.3)}
.note{background:#00AFF2;color:#fff;font-size:9.5px;padding:5px 12px;margin-top:6px;border-radius:3px}
.bottom{display:grid;grid-template-columns:1.55fr 1fr;gap:24px;margin-top:9px;align-items:start}
.box h4{color:#00AFF2;font-size:11px;font-weight:800;text-transform:uppercase;margin-bottom:4px}
.tyc{list-style:none;margin:0 0 8px}
.tyc li{font-size:9px;line-height:1.4;color:rgba(75,75,75,.9);padding-left:13px;position:relative;margin-bottom:2px}
.tyc li:before{content:'';position:absolute;left:0;top:5px;width:5px;height:5px;background:#00AFF2;border-radius:50%}
.flow{list-style:none;counter-reset:s;margin:0}
.flow li{counter-increment:s;font-size:9.5px;line-height:1.35;color:#4b4b4b;font-weight:600;padding-left:24px;position:relative;margin-bottom:3px}
.flow li:before{content:counter(s);position:absolute;left:0;top:-1px;width:16px;height:16px;background:#FFBB00;color:#646464;border-radius:50%;text-align:center;font-weight:800;font-size:10px;line-height:16px}
.tot{border:1px solid rgba(0,175,242,.5);border-radius:6px;overflow:hidden}
.tot .tr{display:flex;justify-content:space-between;padding:3.5px 14px;font-size:11px;border-bottom:1px solid rgba(100,100,100,.18)}
.tot .tr span:first-child{color:#646464;font-weight:600}
.tot .tr span:last-child{font-weight:700;color:#4b4b4b;text-align:right}
.tot .tr .uf-ref{font-size:8px}
.tot .grand{background:#00AFF2;border-bottom:none}
.tot .grand span{color:#fff !important;font-weight:800;font-size:13px}
.tot .tot-h{background:rgba(0,175,242,.10);color:#00AFF2;font-weight:800;text-transform:uppercase;font-size:8px;letter-spacing:.4px;padding:4px 14px;border-bottom:1px solid rgba(100,100,100,.15)}
.tot .tot-st{background:rgba(0,175,242,.05)}
.tot .tot-st span{font-weight:800 !important;color:#00AFF2 !important}
.tot .grand .uf-ref{color:rgba(255,255,255,.85) !important}
.cta-btn{display:block;position:relative;text-align:center;margin-top:9px;background:#00AFF2;color:#fff;text-decoration:none;font-weight:800;font-size:12.5px;padding:10px 10px;border-radius:9px;border-bottom:4px solid #0086c0;letter-spacing:.3px}
.cta-cursor{position:absolute;right:12px;bottom:-13px;line-height:0}
.cta-cursor svg{display:block}
.cta-sub{margin-top:10px;text-align:center;font-size:9.5px;line-height:1.45;font-weight:700;color:rgba(75,75,75,.92)}
.foot{margin-top:auto;border-top:1px solid rgba(0,175,242,.25);padding-top:7px;display:flex;justify-content:space-between;font-size:9px;color:rgba(100,100,100,.7)}
.foot b{color:#00AFF2}
.line-old{text-decoration:line-through;color:#a0a0a0;font-weight:600;margin-right:4px;font-size:9.5px}
.line-disc{display:inline-block;margin-left:5px;background:#FFBB00;color:#646464;font-weight:800;font-size:8.5px;padding:1px 5px;border-radius:3px;letter-spacing:.3px}
.title .v{display:inline-block;margin-left:8px;background:#FFBB00;color:#646464;font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px;vertical-align:middle;letter-spacing:.5px}
.disc-applied{margin-top:6px;padding:6px 10px;background:rgba(255,187,12,.18);border-left:3px solid #FFBB00;font-size:9.5px;color:#646464;line-height:1.4}
.disc-applied b{color:#646464;font-weight:800}
.disc-cond{margin-top:6px;font-size:9px;color:#646464;font-style:italic;line-height:1.35}
@page{size:Letter;margin:0}
`;

function clampPctLocal(value, max) {
  const n = Math.round(Number(value || 0));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(max, n));
}

// ───────────────────────────────────────────────────────────────────────────
// Builder principal
// ───────────────────────────────────────────────────────────────────────────
function buildProposalHtml({
  cliente,
  cotizacion,
  acceptanceUrl,
  cotizacionId,
  validezHasta,
  version,
  descuentos,
  condicionDiscursiva,
}) {
  cliente = cliente || {};
  cotizacion = cotizacion || {};

  // Descuentos por línea / global. Sanear acá para que sea robusto al caller.
  const descRecPct = clampPctLocal(descuentos?.recurrentePct, 40);
  const descInstRMPct = clampPctLocal(descuentos?.instalacionRMPct, 50);
  const descInstRegionPct = clampPctLocal(descuentos?.instalacionRegionPct, 50);
  const factorRec = 1 - descRecPct / 100;
  const factorInstRM = 1 - descInstRMPct / 100;
  const factorInstRegion = 1 - descInstRegionPct / 100;

  const versionNum = Number(version) > 1 ? Number(version) : 1;

  // ── Cliente / ejecutivo ──
  const empresa = escapeHtml(cliente.empresa || "EMPRESA");
  const contacto = escapeHtml(cliente.contacto || "");
  const rutEmpresa = escapeHtml(cliente.rutEmpresa || "");
  const ejecutivo = escapeHtml(cliente.ejecutivo || "Vicky - Equipo Comercial GeoVictoria");
  const ejecutivoEmail = escapeHtml(
    cliente.ejecutivoEmail || "vicky@geovictoria.com",
  );
  const ejecutivoTelefono = escapeHtml(
    cliente.ejecutivoTelefono || "+56 9 6730 8227",
  );
  const cotizNumero = escapeHtml(cotizacionId || "—");

  // ── Fechas ──
  const hoy = new Date();
  const fecha = formatFechaCorta(hoy);
  const fechaHora = formatFechaHora(hoy);
  // "Válida hasta": idealmente la expiración real del enlace de aceptación
  // (create-from-vicky calcula expMs = ahora + config.validityDays y lo guarda
  // como expiresAt). Si no se entrega, se usa el fallback de VALIDEZ_DIAS.
  const vence = validezHasta
    ? formatFechaCorta(new Date(validezHasta))
    : formatFechaCorta(
        new Date(hoy.getTime() + VALIDEZ_DIAS * 24 * 60 * 60 * 1000),
      );

  // ── UF del día ──
  const ufValue = Number(cotizacion.ufActual || 0);
  const toCLP = (uf) => (ufValue > 0 ? Math.round(Number(uf || 0) * ufValue) : 0);

  // ── Items → filas tipadas ──
  const { servicios, equipos, accesorios, serviciosAsoc } = adaptarItemsVicky(
    cotizacion.items || [],
  );
  // Cláusulas de arriendo: van SIEMPRE en las T&C, redactadas como condición
  // ("Para los relojes en modalidad arriendo…"), sin lógica de mostrar/ocultar.
  const tycArriendoHtml = PROPOSAL_TYC_ARRIENDO.map(
    (t) => `<li>${escapeHtml(t)}</li>`,
  ).join("");

  const filas = [];
  const pushFila = (nombre, modalidad, desc, precioUnitUF, cant, subtotalUF, recurrente, opts = {}) => {
    const stUF = Number(subtotalUF || 0);
    // Descuento opcional por línea (solo se usa hoy para instalación).
    const factorLinea = Number(opts.factorLinea ?? 1);
    const descLineaPct = Number(opts.descLineaPct ?? 0);
    const stUFNeto = stUF * factorLinea;
    filas.push({
      nombre: escapeHtml(nombre),
      modalidad,
      desc: escapeHtml(desc),
      puCLP: toCLP(precioUnitUF),
      cant: Number(cant || 1),
      totalUFBruto: stUF,
      totalCLPBruto: toCLP(stUF),
      totalUF: stUFNeto,
      totalCLP: toCLP(stUFNeto),
      recurrente: !!recurrente,
      descLineaPct,
    });
  };

  // El descuento del plan mensual (recurrente) se aplica POR LÍNEA, pero SOLO a
  // los servicios de software (asistencia), NO al arriendo de hardware (reloj u
  // otros equipos/accesorios en arriendo), aunque sean recurrentes. Regla
  // comercial. El desglose es la única fuente del descuento.
  const optRec = descRecPct > 0 ? { factorLinea: factorRec, descLineaPct: descRecPct } : {};
  // PLAN ANUAL SIEMPRE PRIMERO (Lalo 01-sep): cuando la cotización está
  // anualizada, la fila del pago anual encabeza la tabla (los recurrentes
  // vienen ocultos, así que esta ES la fila principal).
  serviciosAsoc
    .filter((s) => s.codigo === "plan_anual")
    .forEach((s) =>
      pushFila(
        s.nombre,
        "Pago único",
        descManualValida(s.descripcion) || "Los 12 meses del servicio pagados por adelantado. Sin mensualidades durante la vigencia anual.",
        s.precioUnit,
        s.cantidad,
        s.subtotalUF,
        false,
      ),
    );
  servicios.forEach((s) =>
    pushFila(nombreConTramo(s), "Pago mensual", descServicio(s), s.precioUnit, s.cantidad, s.subtotalUF, true, optRec),
  );
  // Bonificación por línea en hardware/accesorios (Descuento_Pct del subform):
  // el subform bonificado lleva Subtotal 0 (la página de aceptación suma
  // Subtotal_UF tal cual), así que el bruto tachado se reconstruye con
  // precioUnit × cantidad — mismo patrón que serviciosAsoc.
  const optsHw = (x) => {
    if (!(Number(x.descuentoPct) > 0)) return { bruto: x.subtotalUF, opts: {} };
    const bruto = x.subtotalUF > 0 ? x.subtotalUF : x.precioUnit * x.cantidad;
    return {
      bruto,
      opts: { factorLinea: 1 - x.descuentoPct / 100, descLineaPct: x.descuentoPct },
    };
  };
  equipos.forEach((e) => {
    const rec = e.tipo === "Arriendo";
    const { bruto, opts } = optsHw(e);
    pushFila(e.nombre, rec ? "Pago mensual" : "Pago único", descManualValida(e.descripcion) || descEquipo(e), e.precioUnit, e.cantidad, bruto, rec, opts);
  });
  accesorios.forEach((a) => {
    const rec = a.tipo === "Arriendo";
    const { bruto, opts } = optsHw(a);
    pushFila(a.nombre, rec ? "Pago mensual" : "Pago único", descManualValida(a.descripcion) || descEquipo(a), a.precioUnit, a.cantidad, bruto, rec, opts);
  });
  serviciosAsoc.forEach((s) => {
    if (s.codigo === "plan_anual") return; // ya se pintó primero
    const nombre = s.zona ? `${s.nombre} (${s.zona})` : s.nombre;
    // El envío puede venir como "servicio" en la emisión (caso Supermercado
    // Belén/COT385 06-ago): con la descripción fija de instalación el PDF
    // decía "Instalación en terreno..." en la línea del despacho. La
    // descripción MANUAL del ítem (si viene) gana sobre ambas fijas.
    const descServicioAsoc =
      descManualValida(s.descripcion) ||
      (/env[ií]o|despacho/i.test(`${s.codigo || ""} ${s.nombre || ""}`)
        ? DESC_ENVIO_RELOJ
        : DESC_SERVICIO_ASOC);
    // Descuento de instalación aplica solo a items reconocidos como instalación
    // y según la zona tarifa (RM vs regiones).
    const esInstalacion = CODIGOS_INSTALACION_PDF.has(String(s.codigo || ""));
    let factorLinea = 1;
    let descLineaPct = 0;
    // Descuento explícito de la línea (Descuento_Pct del subform) MANDA sobre
    // las reglas por zona — es el canal para bonificaciones acordadas por la
    // ejecutiva (ej. envío −100%, caso Mesa Incógnita 05-ago). La página de
    // aceptación suma Subtotal_UF tal cual (no conoce Descuento_Pct), así que
    // el subform bonificado lleva Subtotal 0 y acá se reconstruye el precio de
    // lista (precioUnit × cantidad) para el tachado.
    if (s.descuentoPct > 0) {
      const bruto = s.subtotalUF > 0 ? s.subtotalUF : s.precioUnit * s.cantidad;
      pushFila(nombre, "Pago único", descServicioAsoc, s.precioUnit, s.cantidad, bruto, false, {
        factorLinea: 1 - s.descuentoPct / 100,
        descLineaPct: s.descuentoPct,
      });
      return;
    }
    if (esInstalacion) {
      if (s.zonaTarifa === "RM" && descInstRMPct > 0) {
        factorLinea = factorInstRM;
        descLineaPct = descInstRMPct;
      } else if (s.zonaTarifa === "regiones" && descInstRegionPct > 0) {
        factorLinea = factorInstRegion;
        descLineaPct = descInstRegionPct;
      }
    }
    pushFila(nombre, "Pago único", descServicioAsoc, s.precioUnit, s.cantidad, s.subtotalUF, false, {
      factorLinea,
      descLineaPct,
    });
  });
  // Línea fija: capacitación online sin costo, en TODAS las cotizaciones.
  // Capacitación: valorizada en 1 UF con 100% de descuento (neto 0, no suma al total).
  pushFila("Capacitación online", "Pago único", DESC_CAPACITACION, 1, 1, 1, false, {
    factorLinea: 0,
    descLineaPct: 100,
  });

  // ── Totales separados (recurrente vs único) ──
  // Sobre los recurrentes aplica el descuento global del recurrente.
  // Sobre los no recurrentes ya quedaron aplicados los descuentos por línea.
  const sumUF = (arr) => arr.reduce((acc, f) => acc + f.totalUF, 0);
  // Los items recurrentes ya traen el descuento del plan aplicado por línea.
  const recUF = sumUF(filas.filter((f) => f.recurrente));
  const uniUF = sumUF(filas.filter((f) => !f.recurrente));
  const netoUF = recUF + uniUF;
  const netoCLP = toCLP(netoUF);

  const recNetoCLP = toCLP(recUF);
  const recIva = Math.round(recNetoCLP * 0.19);
  const recTot = recNetoCLP + recIva;
  const recTotUF = recUF * 1.19;

  const uniNetoCLP = toCLP(uniUF);
  const uniIva = Math.round(uniNetoCLP * 0.19);
  const uniTot = uniNetoCLP + uniIva;
  const uniTotUF = uniUF * 1.19;

  // ── Filas de la tabla ──
  const rowItem = (f) => {
    // Si hay descuento por línea, mostramos el bruto tachado encima del neto.
    let totalCellInner;
    if (f.descLineaPct > 0 && f.totalUFBruto > 0) {
      totalCellInner =
        `<span class="line-old">${formatCLP(f.totalCLPBruto)}</span> ` +
        `${formatCLP(f.totalCLP)}` +
        `<span class="line-disc">−${f.descLineaPct}%</span>` +
        (f.totalUF > 0 ? `<span class="uf-ref">${formatUF(f.totalUF)} UF</span>` : "");
    } else {
      totalCellInner =
        `${formatCLP(f.totalCLP)}` +
        (f.totalUF > 0 ? `<span class="uf-ref">${formatUF(f.totalUF)} UF</span>` : "");
    }
    return (
      `<tr>` +
      `<td class="c-nom">${f.nombre}</td>` +
      `<td class="c-modal">${f.modalidad}</td>` +
      `<td class="c-desc">${f.desc}</td>` +
      `<td class="c-num">${formatCLP(f.puCLP)}</td>` +
      `<td class="c-num">${f.cant}</td>` +
      `<td class="c-num c-tot">${totalCellInner}</td>` +
      `</tr>`
    );
  };

  const rowsHtml = filas.map(rowItem).join("");

  // ── Caja de totales (oculta el grupo cuyo neto es 0) ──
  const grpRec = recUF > 0;
  const grpUni = uniUF > 0;
  // ── Caja de totales: "Pago inicial (ahora)" vs "Valor mensual (referencial)" ──
  const iniIva = uniIva + recIva;
  const iniTot = uniTot + recTot;
  const iniTotUF = uniTotUF + recTotUF;
  // Etiqueta dinámica del pago único: lista SOLO los conceptos que la cotización
  // realmente cobra como pago único, clasificando cada ítem por su CÓDIGO/nombre
  // (no por el array): el envío puede llegar como "hardware/Venta" (sobre todo al
  // regenerar desde Zoho), así que hay que distinguirlo de un equipo comprado de
  // verdad. El arriendo es recurrente (no es pago único). Evita decir
  // "instalación"/"equipos" cuando no aplican (causa de confusión de clientes).
  const esEnvioItem = (cod, nom) => {
    const c = String(cod || "").toLowerCase();
    const n = String(nom || "").toLowerCase();
    return (
      c.includes("envio") || c.includes("despacho") ||
      n.includes("envío") || n.includes("envio") || n.includes("despacho")
    );
  };
  const conceptosSet = new Set();
  for (const x of [...equipos, ...accesorios]) {
    if (!x || x.tipo === "Arriendo" || Number(x.subtotalUF || 0) <= 0) continue;
    if (esEnvioItem(x.codigo, x.nombre)) conceptosSet.add("envío");
    else conceptosSet.add("equipos");
  }
  for (const s of serviciosAsoc) {
    if (!s || Number(s.subtotalUF || 0) <= 0) continue;
    if (CODIGOS_INSTALACION_PDF.has(String(s.codigo || ""))) conceptosSet.add("instalación");
    else if (esEnvioItem(s.codigo, s.nombre)) conceptosSet.add("envío");
    else conceptosSet.add("servicios");
  }
  const ORDEN_CONCEPTOS = ["equipos", "instalación", "envío", "servicios"];
  const conceptosUnico = ORDEN_CONCEPTOS.filter((c) => conceptosSet.has(c));
  const etiquetaUnico = conceptosUnico.length
    ? `Pago único (${conceptosUnico.join(", ")})`
    : "Pago único";

  // Etiqueta dinámica del cobro mensual (recurrente): lista SOLO lo que el cliente
  // paga mes a mes — el software (suscripción de los módulos) y el arriendo del
  // hardware en modalidad Arriendo (reloj u otros equipos). Así el cliente entiende
  // que el "Valor mensual" incluye el arriendo del reloj y no es solo el software.
  const recHaySoftware = servicios.some((s) => s && Number(s.subtotalUF || 0) > 0);
  let recHayReloj = false;
  let recHayOtroArriendo = false;
  for (const x of [...equipos, ...accesorios]) {
    if (!x || x.tipo !== "Arriendo" || Number(x.subtotalUF || 0) <= 0) continue;
    if (String(x.nombre || "").toLowerCase().includes("reloj")) recHayReloj = true;
    else recHayOtroArriendo = true;
  }
  const conceptosRec = [];
  if (recHaySoftware) conceptosRec.push("software");
  if (recHayReloj) conceptosRec.push("arriendo del reloj");
  else if (recHayOtroArriendo) conceptosRec.push("arriendo de equipos");
  const etiquetaRec = conceptosRec.length ? ` (${conceptosRec.join(" + ")})` : "";

  let totHtml = "";
  if (grpUni || grpRec) {
    totHtml += `<div class="tot-h">Pago inicial — al aceptar</div>`;
    if (grpUni) {
      totHtml += `<div class="tr"><span>${etiquetaUnico}</span><span>${formatCLP(uniNetoCLP)}<span class="uf-ref">${formatUF(uniUF)} UF</span></span></div>`;
    }
    if (grpRec) {
      totHtml += `<div class="tr"><span>Primer mes de servicio${etiquetaRec}</span><span>${formatCLP(recNetoCLP)}<span class="uf-ref">${formatUF(recUF)} UF</span></span></div>`;
    }
    totHtml += `<div class="tr"><span>IVA (19%)</span><span>${formatCLP(iniIva)}</span></div>`;
    totHtml += `<div class="tr grand"><span>Total a pagar ahora</span><span>${formatCLP(iniTot)}<span class="uf-ref">${formatUF(iniTotUF)} UF</span></span></div>`;
  } else {
    totHtml += `<div class="tot-h">Total</div><div class="tr grand"><span>Total</span><span>${formatCLP(0)}</span></div>`;
  }
  if (grpRec) {
    totHtml += `<div class="tot-h" style="margin-top:6px">Valor mensual del servicio${etiquetaRec} — desde el 2&ordm; mes</div>`;
    totHtml += `<div class="tr"><span>Neto</span><span>${formatCLP(recNetoCLP)}<span class="uf-ref">${formatUF(recUF)} UF</span></span></div>`;
    totHtml += `<div class="tr"><span>IVA (19%)</span><span>${formatCLP(recIva)}</span></div>`;
    totHtml += `<div class="tr grand"><span>Total mensual (referencial)</span><span>${formatCLP(recTot)}/mes<span class="uf-ref">${formatUF(recTotUF)} UF</span></span></div>`;
    totHtml +=
      `<div style="margin-top:8px;font-size:8px;line-height:1.4;color:#646464">` +
      `El <b>Pago inicial</b> es lo que se cobra al aceptar e incluye los conceptos de pago &uacute;nico y el primer mes de servicio. ` +
      `El <b>Valor mensual</b> es referencial: el plan se factura en UF y se convierte a pesos con la UF del d&iacute;a de cada factura, por lo que el monto en CLP puede variar mes a mes seg&uacute;n la UF. Se factura desde el segundo mes, y la variaci&oacute;n de usuarios activos tambi&eacute;n lo ajusta en la facturaci&oacute;n del per&iacute;odo siguiente.` +
      `</div>`;
  }

  // Los porcentajes de descuento se muestran SOLO en el desglose por línea de los
  // items (arriba). En los totales no se repiten: solo el precio final. Se mantiene
  // la condición temporal del descuento del plan como disclosure (sin repetir %).
  if (descRecPct > 0) {
    totHtml += `<div style="margin-top:6px;font-size:8px;line-height:1.4;color:#646464">${escapeHtml(textoVigenciaDescuento(descuentos?.mesesPlan))}</div>`;
  }
  // Condición discursiva (ej. "paga en 24h"). No tiene enforcement técnico.
  if (condicionDiscursiva) {
    totHtml += `<div class="disc-cond">${escapeHtml(String(condicionDiscursiva))}</div>`;
  }

  const ctaHref = escapeHtml(acceptanceUrl || "#");
  const notaUf = ufValue > 0 ? formatCLP(ufValue) : "—";
  // Con UF explícita (regeneración fiel a la cotización original) la fecha
  // mostrada es la de ESA cotización, no la de hoy (caso COT334, 06-ago).
  const fechaUF = String(cotizacion.ufFecha || "").trim() || fecha;
  const notaTexto = `Valores en CLP con referencia en la UF del día de la cotización (${fechaUF}): ${notaUf}.`;

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Cotización ${cotizNumero} — ${empresa}</title>
<style>${ONEPAGER_CSS}</style></head>
<body>
<div class="page"><div class="sheet">

  <div class="hdr">
    <div class="logo">${LOGO_ORIGINAL_SVG}</div>
    <div class="org">
      <b>${ORG.nombre}</b>
      R.U.T: ${ORG.rut}<br>${ORG.matriz}<br>Teléfono: ${ORG.tel}
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
      <div class="row"><span class="l">R.U.T:</span><span>${rutEmpresa}</span></div>
      <div class="row"><span class="l">Contacto:</span><span>${contacto}</span></div>
    </div>
    <div>
      <div class="row"><span class="l">Fecha:</span><span>${fechaHora}</span></div>
      <div class="row"><span class="l">Válida hasta:</span><span>${vence}</span></div>
      <div class="row"><span class="l">Ejecutivo:</span><span>${ejecutivo}</span></div>
      <div class="row"><span class="l">E-mail:</span><span>${ejecutivoEmail}</span></div>
    </div>
  </div>

  <div class="band">Productos y Servicios</div>
  <table>
    <thead>
      <tr><th>Nombre</th><th>Modalidad</th><th>Descripción</th><th class="r">P. Unitario</th><th class="r">Cant.</th><th class="r">Total Neto</th></tr>
    </thead>
    <tbody>${rowsHtml}
      <tr class="sub"><td colspan="5">Subtotal (sin IVA)</td><td class="c-num">${formatCLP(netoCLP)}<span class="uf-ref">${formatUF(netoUF)} UF</span></td></tr>
    </tbody>
  </table>

  <div class="note">${notaTexto}</div>

  <div class="bottom">
    <div class="box">
      <h4>Términos y Condiciones</h4>
      <ul class="tyc">
        <li>Valores en CLP con referencia en UF; convertidos al valor de la UF del día de la cotización. No incluyen IVA salvo donde se indique.</li>
        ${tycArriendoHtml}
        <li>Incluye sin costo: soporte L-V 8:30-18:00, capacitación inicial, actualizaciones, app móvil y portal del colaborador.</li>
        <li>Plataforma cloud en Microsoft Azure con uptime garantizado de 99,5 %. Valores ajustables anualmente según UF/IPC.</li>
      </ul>
      <h4>Cómo continúas</h4>
      <ol class="flow">
        <li>Revisa el detalle de tu cotización.</li>
        <li>Acepta los términos y condiciones.</li>
        <li>Paga en línea de forma segura.</li>
        <li>Comienza a usar GeoVictoria en 24 horas hábiles.</li>
      </ol>
    </div>
    <div>
      <div class="tot">${totHtml}</div>
      <a class="cta-btn" href="${ctaHref}">Haz clic aquí para aceptar, pagar y comenzar…${CTA_CURSOR}</a>
      <p class="cta-sub">Paga e inicia tu onboarding en solo 15 minutos.<br>Activaremos tu servicio en 24 horas hábiles.</p>
    </div>
  </div>

  <div class="foot">
    <div>Página 1 de 1 · Cotización N° ${cotizNumero}</div>
    <div><b>Ejecutivo Comercial:</b> ${ejecutivo} · ${ejecutivoEmail} · ${ejecutivoTelefono}</div>
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
    // Escala uniforme desde el centro superior: cabe en una sola hoja, sin
    // recortar ni distorsionar (deja un margen lateral mínimo y simétrico).
    sheet.style.transform = "scale(" + k + ")";
  }
})();
</script>
</body></html>`;
}

// Exponemos el CSS del one-pager para que la variante Colombia
// (proposal-html-builder-co.js) reuse EXACTAMENTE el mismo layout/estilo sin
// mantener una copia. Cambios de estilo acá impactan ambos países a propósito.
module.exports = { buildProposalHtml, ONEPAGER_CSS };
