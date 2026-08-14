/**
 * Endpoint ADMIN: POST /api/quote-acceptance/backfill-nota-precios
 *
 * Deja en cada cotización una NOTA con la tabla de precios de Asistencia que
 * estaba VIGENTE el día en que se emitió (pedido de Lalo, 14-ago-2026): la
 * lista cambió al menos cinco veces entre mayo y agosto, así que mirar una
 * cotización vieja con la tabla de hoy lleva a conclusiones equivocadas. Los
 * tramos sobre 50 usuarios —fuera del rango de Vicky— se completan con la
 * calculadora del canal ejecutivo (gv-cotizador / "lista de Nacho").
 *
 * Fuente de las tablas: historial de git de lib/catalogo/modulos.ts en el repo
 * del agente, commit a commit. Cada entrada vale DESDE su fecha hasta la
 * siguiente.
 *
 * SOLO CHILE: CO/MX/PE tienen sus propias listas — sus cotizaciones se saltan
 * (se detectan por prefijo telefónico y por el país firmado en el token).
 *
 * Body: { "desde": "<ISO>", "hasta": "<ISO>", "limite": 100, "dryRun": true }
 * Auth: x-vicky-secret (del agente o de Zoho) o Bearer CRON_SECRET.
 */

const { zohoApiFetch } = require("../_shared/zoho-auth");
const { toText } = require("../_shared/zoho-crm");
const { secretoValido } = require("../_shared/secreto-vicky");

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim();
const TITULO_NOTA = "📋 Tabla de precios vigente al emitir esta cotización";

/** Tramos de Asistencia por período (UF). `desde` = fecha de despliegue. */
const HISTORIAL_ASISTENCIA = [
  {
    desde: "2026-01-01",
    etiqueta: "lista inicial",
    tramos: [["1-10", "0,75 UF fijo"], ["11-20", "0,09 UF por usuario"], ["21-30", "0,08 UF por usuario"], ["31-50", "0,07 UF por usuario"]],
  },
  {
    desde: "2026-06-17T17:58:00-04:00",
    etiqueta: "micro-plan de 1 usuario",
    tramos: [["1", "0,25 UF fijo"], ["2-10", "0,75 UF fijo"], ["11-20", "0,09 UF por usuario"], ["21-30", "0,08 UF por usuario"], ["31-50", "0,07 UF por usuario"]],
  },
  {
    desde: "2026-06-18T17:18:00-04:00",
    etiqueta: "baja general de tramos",
    tramos: [["1", "0,25 UF fijo"], ["2-10", "0,60 UF fijo"], ["11-20", "0,07 UF por usuario"], ["21-30", "0,065 UF por usuario"], ["31-50", "0,055 UF por usuario"]],
  },
  {
    desde: "2026-07-31T20:27:00-04:00",
    etiqueta: "micro-plan hasta 2 usuarios",
    tramos: [["1-2", "0,25 UF fijo"], ["3-10", "0,60 UF fijo"], ["11-20", "0,07 UF por usuario"], ["21-30", "0,065 UF por usuario"], ["31-50", "0,055 UF por usuario"]],
  },
  {
    desde: "2026-08-13T15:25:00-04:00",
    etiqueta: "prueba de precios de 1 mes (Rodrigo)",
    tramos: [["1-2", "0,25 UF fijo"], ["3-10", "0,55 UF fijo"], ["11-20", "0,055 UF por usuario"], ["21-30", "0,065 UF por usuario"], ["31-50", "0,055 UF por usuario"]],
  },
];

/** Tramos sobre 50 usuarios: calculadora del canal ejecutivo (Nacho). */
const TRAMOS_NACHO = [
  ["51-100", "0,065 UF por usuario"],
  ["101-200", "0,060 UF por usuario"],
  ["201-500", "0,055 UF por usuario"],
  ["501-1.000", "0,050 UF por usuario"],
  ["1.001-3.000", "0,045 UF por usuario"],
  ["3.001-5.000", "0,040 UF por usuario"],
  ["5.001-8.000", "0,035 UF por usuario"],
];

function tablaVigente(creadaIso) {
  const t = Date.parse(creadaIso || "");
  let elegida = HISTORIAL_ASISTENCIA[0];
  for (const periodo of HISTORIAL_ASISTENCIA) {
    if (Number.isFinite(t) && t >= Date.parse(periodo.desde)) elegida = periodo;
  }
  return elegida;
}

function cuerpoNota(quote, creadaIso) {
  const periodo = tablaVigente(creadaIso);
  const fecha = new Date(creadaIso).toLocaleDateString("es-CL", { timeZone: "America/Santiago" });
  const filas = periodo.tramos
    .map(([rango, precio]) => `  · ${rango} trabajadores: ${precio}`)
    .join("\n");
  const nacho = TRAMOS_NACHO.map(([rango, precio]) => `  · ${rango} trabajadores: ${precio}`).join("\n");
  return [
    `Tabla de precios de CONTROL DE ASISTENCIA vigente el día en que se emitió esta cotización (${fecha}).`,
    "",
    `LISTA APLICADA — canal Vicky (${periodo.etiqueta}):`,
    filas,
    "",
    "TRAMOS SOBRE 50 TRABAJADORES — fuera del rango de Vicky, se completan con la calculadora del canal ejecutivo:",
    nacho,
    "",
    "Notas: valores netos en UF, sin IVA (19%) ni descuentos. El precio en pesos de esta cotización quedó congelado con la UF del día de emisión.",
    "En el rango 1-50 el canal ejecutivo usa su propia lista, más alta (1-10: 0,75 · 11-20: 0,09 · 21-30: 0,08 · 31-50: 0,07 UF): son dos listas oficiales por canal.",
    "",
    "Registro generado automáticamente el 14-ago-2026 a partir del historial de versiones del catálogo.",
  ].join("\n");
}

/** Cotizaciones de otros países: su lista de precios es distinta. */
function esDeChile(quote) {
  const tel = toText(quote.Tel_fono_Contacto).replace(/[^\d+]/g, "");
  if (/^\+?(57|52|51)\d/.test(tel)) return false;
  const url = toText(quote.URL_Aceptacion_Web);
  const m = url.match(/[?&]token=([^&]+)/);
  if (m) {
    try {
      const payload = JSON.parse(
        Buffer.from(decodeURIComponent(m[1]).split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
      );
      const pais = String(payload?.pais || "").toLowerCase();
      if (pais && pais !== "cl") return false;
    } catch {
      /* sin país en el token = Chile */
    }
  }
  return true;
}

async function coql(query) {
  const res = await zohoApiFetch("/crm/v3/coql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ select_query: query }),
  });
  if (res.status === 204) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body?.data) ? body.data : [];
}

/** POST /{modulo}/{id}/Notes — el sub-recurso de related records. El formato
 * global (POST /Notes con Parent_Id) falla SIEMPRE en silencio en módulos
 * custom: misma cicatriz del 25-jul con las notas de comprobante. */
async function crearNota(quoteId, contenido) {
  const res = await zohoApiFetch(
    `/crm/v3/${encodeURIComponent(QUOTE_MODULE)}/${encodeURIComponent(quoteId)}/Notes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [{ Note_Title: TITULO_NOTA, Note_Content: contenido }] }),
    },
  );
  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    console.warn(`[backfill-nota-precios] quote=${quoteId} Zoho ${res.status}: ${detalle.slice(0, 200)}`);
    return false;
  }
  return true;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });
  const bearer = toText(req.headers.authorization).replace(/^Bearer\s+/i, "");
  const cronSecret = toText(process.env.CRON_SECRET);
  if (!secretoValido(req) && !(cronSecret && cronSecret === bearer)) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return sendJson(res, 400, { ok: false, error: "body JSON inválido" });
  }
  const desde = toText(body.desde) || "2026-01-01T00:00:00-04:00";
  const hasta = toText(body.hasta) || new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const limite = Math.min(200, Math.max(1, Number(body.limite) || 100));
  const offset = Math.max(0, Number(body.offset) || 0);
  const dryRun = body.dryRun === true;

  try {
    const filas = await coql(
      `select id, Numero_Cotizacion, Estado_Cotizacion, Created_Time, Tel_fono_Contacto, URL_Aceptacion_Web ` +
        `from ${QUOTE_MODULE} where ((Created_Time >= '${desde}') and (Created_Time <= '${hasta}')) ` +
        `order by Created_Time asc limit ${offset}, ${limite}`,
    );
    const elegibles = filas.filter((q) => toText(q.Estado_Cotizacion) && esDeChile(q));
    const saltadas = filas.length - elegibles.length;
    let creadas = 0;
    if (!dryRun) {
      // De a una: el sub-recurso de notas es por registro. Con lotes de 100
      // cotizaciones por request el tiempo alcanza de sobra.
      for (const q of elegibles) {
        const ok = await crearNota(toText(q.id), cuerpoNota(q, q.Created_Time));
        if (ok) creadas += 1;
      }
    }
    return sendJson(res, 200, {
      ok: true,
      dryRun,
      leidas: filas.length,
      elegibles: elegibles.length,
      saltadas,
      creadas,
      hayMas: filas.length === limite,
      siguienteOffset: offset + filas.length,
      muestra: elegibles.slice(0, 3).map((q) => ({
        cot: toText(q.Numero_Cotizacion),
        emitida: toText(q.Created_Time),
        tabla: tablaVigente(q.Created_Time).etiqueta,
      })),
    });
  } catch (e) {
    console.error("[backfill-nota-precios] error:", e);
    return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : "error" });
  }
};
