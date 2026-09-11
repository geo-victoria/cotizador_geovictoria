/**
 * ARREGLO DEL ESPEJO EN SITIO — actualizar en vez de anular y rehacer
 * (orden de Lalo 11-sep: "y por qué en vez de anular no actualiza? está
 * generando muchos correlativos que va a terminar eliminando").
 *
 * Contexto. El espejo de Creator (la "Cotización" en BORRADOR) nace en la
 * EMISIÓN y es la fuente de verdad de la nota: `convertirYConfirmar` la COPIA
 * verbatim (campos directos, Servicios_Recurrentes, Servicio_Recurrente_
 * Configurado y el Form_Order que apunta a sus formularios hijos). Si el
 * cliente cambia la venta después de emitir —dotación, descuento, un reloj—,
 * `actualizar_cotizacion` corrige la cotización del CRM y NO toca el espejo,
 * así que al pagar se convertía un espejo viejo y la nota nacía mal (Molinas
 * 07-sep sin reloj ni instalación; TESLA NDV-31596 con 17 usuarios en vez de
 * 14 y el arriendo en 0).
 *
 * El arreglo del 07-sep regeneraba: anular el borrador + crear uno nuevo. Es
 * correcto pero quema un correlativo COT-6#### cada vez (medidos 2 el 10-sep:
 * COT-62102 DE LA CUENCA y COT-62104 R&H, las dos ventas solo-app donde no
 * había ningún bloque que borrar, o sea donde regenerar era innecesario).
 *
 * Acá se arregla EN SITIO lo que se puede, con PATCH sobre los MISMOS campos
 * que el puente ya escribe al crear (por eso es tan seguro como crearlos):
 *   - dotación   → Cantidad_de_Usuarios / N_Empleados_Compometidos /
 *                  Cantidad_de_Usuarios_PDF del Servicio_Recurrente
 *   - tabla      → Tabla_de_Cobro
 *   - descuento  → Descuento_Ejecutivo / Cantidad_de_Meses_de_descuento
 *   - bloque de hardware SOBRANTE → se NEUTRALIZA (Monto 0, MontoHW 0,
 *     CAN_CREATE_PDF false, JsonPdf sin GlossRow): no suma al total y no
 *     imprime. Es la alternativa al borrado, que nuestro token de Creator no
 *     puede hacer (falta el scope DELETE, code 2945) y que no queremos pedir
 *     re-emitiendo el token que sostiene el puente de facturación.
 *
 * Lo que NO se arregla en sitio y sigue regenerando: cuando FALTA un servicio
 * recurrente o un bloque que la venta sí tiene. Crear un hijo y engancharlo al
 * Form_Order es exactamente lo que hace `crear-ndv-desde-cot`; replicarlo acá
 * sería duplicar la verdad, que es el origen de todos estos bugs.
 */

const { creatorApiFetch } = require("./zoho-creator-auth");

const SERVICIOS_REPORT = "SERVICES_ALL_DATA";
const HARDWARE_REPORT = "HARDWARE_ALL_DATA";
/** Tolerancia de comparación de montos en UF (Creator redondea a 5 decimales). */
const EPS = 1e-4;

function texto(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return String(v.display_value || v.zc_display_value || v.ID || v.id || "").trim();
  return String(v).trim();
}
function num(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function rutaReporte(cfg, reporte, id) {
  const base =
    `/creator/v2.1/data/${encodeURIComponent(cfg.ownerName)}/${encodeURIComponent(cfg.appLinkName)}` +
    `/report/${encodeURIComponent(reporte)}`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

async function filasDe(cfg, reporte, cotId) {
  try {
    const r = await creatorApiFetch(
      `${rutaReporte(cfg, reporte)}?criteria=${encodeURIComponent(`ID_Formulario==${cotId}`)}&limit=20&field_config=all`,
      { method: "GET" },
    );
    // Creator responde 404 (code 3100) cuando el criterio no trae filas.
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j?.data) ? j.data : [];
  } catch {
    return [];
  }
}

/** Servicios recurrentes (hijos) del espejo. */
async function serviciosDelEspejo(cfg, cotId) {
  return filasDe(cfg, SERVICIOS_REPORT, cotId);
}
/** Bloques Formulario_de_Equipos del espejo. */
async function bloquesDelEspejo(cfg, cotId) {
  return filasDe(cfg, HARDWARE_REPORT, cotId);
}

/** Una tabla de cobro comparable: [{from,to,rate,extra,modalidad}]. */
function normalizarTabla(tabla) {
  if (!Array.isArray(tabla)) return [];
  return tabla
    .map((t) => ({
      from: num(t?.From ?? t?.from),
      to: num(t?.To ?? t?.to),
      rate: Number(num(t?.Rate ?? t?.rate).toFixed(5)),
      extra: Number(num(t?.AdditionalUserRate ?? t?.extra).toFixed(5)),
      modalidad: texto(t?.Modality ?? t?.modalidad),
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
}
function tablasIguales(a, b) {
  const x = normalizarTabla(a);
  const y = normalizarTabla(b);
  if (x.length !== y.length) return false;
  return x.every((f, i) => {
    const g = y[i];
    return (
      f.from === g.from &&
      f.to === g.to &&
      f.modalidad === g.modalidad &&
      Math.abs(f.rate - g.rate) < EPS &&
      Math.abs(f.extra - g.extra) < EPS
    );
  });
}

/**
 * PURA. Compara lo que el espejo TIENE contra lo que la venta pagada QUIERE y
 * devuelve el plan.
 *
 * @param {object[]} serviciosEspejo  filas de SERVICES_ALL_DATA del espejo
 * @param {object[]} bloquesEspejo    filas de HARDWARE_ALL_DATA del espejo
 * @param {object}   deseado
 *   @param {number}   deseado.empleados          dotación vendida
 *   @param {number}   deseado.descuentoPct
 *   @param {number}   [deseado.mesesDescuento]
 *   @param {Record<string, object[]>} deseado.tablasPorServicio
 *   @param {boolean}  deseado.hayHardware        la venta lleva equipos
 * @returns {{ modo: "ok"|"en_sitio"|"regenerar", acciones: object[], motivos: string[] }}
 */
function planEnSitio({ serviciosEspejo, bloquesEspejo, deseado }) {
  const acciones = [];
  const motivos = [];
  const servicios = Array.isArray(serviciosEspejo) ? serviciosEspejo : [];
  const bloques = Array.isArray(bloquesEspejo) ? bloquesEspejo : [];
  const tablas = deseado?.tablasPorServicio || {};
  const nombresDeseados = Object.keys(tablas);

  // (1) Un servicio que la venta quiere y el espejo no tiene: hay que CREARLO
  //     y engancharlo al Form_Order. Eso no se hace en sitio.
  const nombresEspejo = servicios.map((s) => texto(s.Servicio_Recurrente)).filter(Boolean);
  for (const n of nombresDeseados) {
    if (!nombresEspejo.includes(n)) motivos.push(`falta el servicio "${n}" en el espejo`);
  }
  // (2) Un servicio que el espejo tiene y la venta ya no: tampoco (no se puede
  //     sacar del Form_Order sin DELETE, y dejarlo en 0 igual lo imprimiría).
  for (const n of nombresEspejo) {
    if (nombresDeseados.length > 0 && !nombresDeseados.includes(n)) {
      motivos.push(`el espejo tiene el servicio "${n}" que la venta ya no lleva`);
    }
  }
  // (3) La venta lleva equipos y el espejo no tiene ningún bloque: hay que
  //     crear el bloque (mismo caso que (1)).
  if (deseado?.hayHardware && bloques.length === 0) {
    motivos.push("la venta lleva equipos y el espejo no tiene bloque de hardware");
  }

  // (4) Diferencias de VALOR en un servicio que sí existe → PATCH en sitio.
  for (const s of servicios) {
    const nombre = texto(s.Servicio_Recurrente);
    const tablaDeseada = tablas[nombre];
    if (!tablaDeseada) continue;
    const data = {};
    const empleados = num(deseado?.empleados);
    if (empleados > 0 && num(s.Cantidad_de_Usuarios) !== empleados) {
      data.Cantidad_de_Usuarios = empleados;
      data.N_Empleados_Compometidos = empleados;
      data.Cantidad_de_Usuarios_PDF = empleados;
    }
    if (!tablasIguales(s.Tabla_de_Cobro, tablaDeseada)) data.Tabla_de_Cobro = tablaDeseada;
    const pct = num(deseado?.descuentoPct);
    if (num(s.Descuento_Ejecutivo) !== pct) data.Descuento_Ejecutivo = pct;
    const meses = num(deseado?.mesesDescuento);
    // El campo es number con maxchar 1: solo 0-9. Una vigencia de 12 o 24 no
    // cabe y se omite antes que truncarla (misma regla que al crear).
    if (pct > 0 && meses >= 1 && meses <= 9 && num(s.Cantidad_de_Meses_de_descuento) !== meses) {
      data.Cantidad_de_Meses_de_descuento = meses;
    }
    if (Object.keys(data).length > 0) {
      acciones.push({ tipo: "patch_servicio", id: texto(s.ID), servicio: nombre, data });
    }
  }

  // (5) Bloque de hardware SOBRANTE (la venta ya no lleva equipos) → NEUTRALIZAR.
  if (!deseado?.hayHardware) {
    for (const b of bloques) {
      const yaNeutro = num(b.Monto) === 0 && num(b.MontoHW) === 0 && b.CAN_CREATE_PDF !== true;
      if (yaNeutro) continue;
      acciones.push({
        tipo: "neutralizar_bloque",
        id: texto(b.ID),
        servicio: texto(b.Servicio_Producto),
        data: {
          Monto: 0,
          MontoHW: 0,
          CAN_CREATE_PDF: false,
          JsonPdf: JSON.stringify({
            Name: texto(b.Servicio_Producto),
            ProdCode: "",
            Currency: texto(b.Moneda) || "UF",
            Terms: "",
            GlossRow: [],
            OdooGlossRows: [],
          }),
        },
      });
    }
  }

  if (motivos.length > 0) return { modo: "regenerar", acciones: [], motivos };
  if (acciones.length === 0) return { modo: "ok", acciones: [], motivos: [] };
  return { modo: "en_sitio", acciones, motivos: [] };
}

/** Aplica el plan. Un solo PATCH por acción, sobre campos que el puente ya
 * escribe al crear. Devuelve el resultado de cada uno: si CUALQUIERA falla, el
 * llamador cae al camino probado (anular + regenerar). */
async function aplicarPlanEnSitio(cfg, plan) {
  const resultados = [];
  for (const a of plan.acciones || []) {
    const reporte = a.tipo === "neutralizar_bloque" ? HARDWARE_REPORT : SERVICIOS_REPORT;
    try {
      const r = await creatorApiFetch(rutaReporte(cfg, reporte, a.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { ...a.data, UpdateCheckbox: true } }),
      });
      const j = await r.json().catch(() => ({}));
      const ok = r.ok && Number(j?.code) === 3000;
      resultados.push({ ...a, data: Object.keys(a.data), ok, code: Number(j?.code) || r.status });
      if (!ok) console.warn(`[ndv-espejo-sitio] ${a.tipo} id=${a.id} falló: ${JSON.stringify(j).slice(0, 200)}`);
    } catch (e) {
      resultados.push({ ...a, data: Object.keys(a.data), ok: false, error: String(e?.message || e).slice(0, 120) });
    }
  }
  return { ok: resultados.length > 0 && resultados.every((r) => r.ok), resultados };
}

module.exports = {
  SERVICIOS_REPORT,
  HARDWARE_REPORT,
  serviciosDelEspejo,
  bloquesDelEspejo,
  normalizarTabla,
  tablasIguales,
  planEnSitio,
  aplicarPlanEnSitio,
};
