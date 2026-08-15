/**
 * CATASTRO de las cotizaciones espejadas en Zoho Creator.
 *
 * Pedido de Lalo (15-ago): antes de pelear con la conversión a Nota de Venta,
 * saber CUÁNTAS cotizaciones hay creadas en Creator y en qué estado están.
 * La sospecha es que faltan datos que no se pueden escribir por API porque los
 * llenan workflows de formulario o funciones Deluge — pero primero el catastro.
 *
 * Recorre el reporte ALL_DATA paginando y agrupa por los tres campos de estado
 * que el handoff escribe: `STATUS`, `FORM_STATUS` y `ESTADO_COT`, más
 * `Formulario` y `Creador` (que distingue lo que nació de Vicky de lo que un
 * ejecutivo cargó por el widget del CRM).
 *
 * Auth: x-vicky-secret (compartido con el agente) o ?secret=QUOTE_ACCEPTANCE_SECRET.
 *
 * GET /api/creator/catastro
 *   ?limite=2000      cuántos registros recorrer como máximo
 *   &detalle=1        agrega las filas (id, estado, cuenta, fecha)
 *   &creador=vicky    filtra por el campo Creador
 */

const { getCreatorConfig, creatorApiFetch } = require("../_shared/zoho-creator-auth");
const { secretoValido } = require("../_shared/secreto-vicky");

function texto(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return String(v.display_value || v.zc_display_value || v.ID || "");
  return String(v).trim();
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  const secretDiag = String(process.env.QUOTE_ACCEPTANCE_SECRET || "").trim();
  const provisto = String(req.query?.secret || req.headers["x-diag-secret"] || "").trim();
  if (!secretoValido(req) && !(secretDiag && provisto === secretDiag)) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  let config;
  try {
    config = getCreatorConfig();
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `config Creator: ${e.message}` });
  }

  const limite = Math.min(20000, Math.max(1, Number(req.query?.limite) || 2000));
  const detalle = String(req.query?.detalle || "") === "1";
  const filtroCreador = String(req.query?.creador || "").trim().toLowerCase();

  const base = `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(
    config.appLinkName
  )}/report/${encodeURIComponent(config.reportLinkName)}`;

  const porEstado = new Map();
  const porFormulario = new Map();
  const porCreador = new Map();
  const filas = [];
  let leidos = 0;
  let cursor = "";
  const cuenta = (mapa, clave) => mapa.set(clave, (mapa.get(clave) || 0) + 1);

  try {
    // La v2.1 pagina con record_cursor: se manda el que devolvió la página
    // anterior hasta que deja de venir.
    for (let pagina = 0; pagina < 200 && leidos < limite; pagina++) {
      const resp = await creatorApiFetch(`${base}?limit=200&field_config=all`, {
        method: "GET",
        headers: cursor ? { record_cursor: cursor } : {},
      });
      if (!resp.ok) {
        const cuerpo = await resp.text().catch(() => "");
        // 404 en la primera página = no hay registros; en las siguientes, fin.
        if (resp.status === 404) break;
        return sendJson(res, 200, {
          ok: false,
          error: `Creator ${resp.status}: ${cuerpo.slice(0, 300)}`,
          leidos,
        });
      }
      cursor = resp.headers.get("record_cursor") || "";
      const payload = await resp.json().catch(() => ({}));
      const data = Array.isArray(payload?.data) ? payload.data : [];
      if (!data.length) break;

      for (const r of data) {
        const creador = texto(r.Creador);
        if (filtroCreador && creador.toLowerCase() !== filtroCreador) continue;
        leidos++;
        const status = texto(r.STATUS) || "(vacío)";
        const formStatus = texto(r.FORM_STATUS) || "(vacío)";
        const estadoCot = texto(r.ESTADO_COT) || "(vacío)";
        cuenta(porEstado, `${status} | ${formStatus} | ${estadoCot}`);
        cuenta(porFormulario, texto(r.Formulario) || "(vacío)");
        cuenta(porCreador, creador || "(sin creador)");
        if (detalle) {
          filas.push({
            id: texto(r.ID),
            numero: texto(r.Numero_Cotizacion) || texto(r.Nombre_del_documento),
            cuenta: texto(r.CRM_ACCOUNT_NAME),
            status,
            formStatus,
            estadoCot,
            creador,
            creado: texto(r.Added_Time) || texto(r.Fecha),
          });
        }
      }
      if (!cursor) break;
    }
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message, leidos });
  }

  const ordenar = (m) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([clave, n]) => ({ clave, n }));

  return sendJson(res, 200, {
    ok: true,
    app: `${config.ownerName}/${config.appLinkName}`,
    reporte: config.reportLinkName,
    registros_leidos: leidos,
    por_estado: ordenar(porEstado),
    por_formulario: ordenar(porFormulario),
    por_creador: ordenar(porCreador),
    ...(detalle ? { filas: filas.slice(0, 500) } : {}),
  });
};
