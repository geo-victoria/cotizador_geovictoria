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

  // ── Modo REGISTRO / COMPARAR ────────────────────────────────────────────
  // Para la prueba de la Nota de Venta hace falta ver los campos CRUDOS de una
  // cotización sana (creada a mano) contra una de Vicky. El PDF solo muestra
  // lo que el layout imprime; la brecha real está en los campos que no salen.
  let cfg;
  try {
    cfg = getCreatorConfig();
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `config Creator: ${e.message}` });
  }
  const baseDatos = `/creator/v2.1/data/${encodeURIComponent(cfg.ownerName)}/${encodeURIComponent(
    cfg.appLinkName
  )}/report/${encodeURIComponent(cfg.reportLinkName)}`;

  const leerRegistro = async (id) => {
    const r = await creatorApiFetch(`${baseDatos}/${encodeURIComponent(id)}?field_config=all`, {
      method: "GET",
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j?.data || {} : { __error: `${r.status}`, __detalle: JSON.stringify(j).slice(0, 300) };
  };

  if (req.query?.registro) {
    const datos = await leerRegistro(String(req.query.registro));
    const vacios = String(req.query?.vacios || "") === "1";
    const salida = {};
    for (const [k, v] of Object.entries(datos)) {
      const t = texto(v);
      if (vacios || t) salida[k] = typeof v === "object" && v !== null ? { valor: t, crudo: v } : v;
    }
    return sendJson(res, 200, { ok: true, registro: String(req.query.registro), campos: Object.keys(salida).length, datos: salida });
  }

  if (req.query?.comparar) {
    const [a1, b1] = String(req.query.comparar).split(",").map((x) => x.trim());
    if (!a1 || !b1) return sendJson(res, 400, { ok: false, error: "comparar=ID_A,ID_B" });
    const [ra, rb] = await Promise.all([leerRegistro(a1), leerRegistro(b1)]);
    const claves = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
    const soloA = {}, soloB = {}, distintos = {};
    for (const k of claves) {
      const va = texto(ra[k]);
      const vb = texto(rb[k]);
      if (va === vb) continue;
      if (va && !vb) soloA[k] = va;
      else if (!va && vb) soloB[k] = vb;
      else distintos[k] = { [a1]: va, [b1]: vb };
    }
    return sendJson(res, 200, {
      ok: true,
      a: a1,
      b: b1,
      solo_en_A: soloA,
      solo_en_B: soloB,
      distintos,
    });
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
  // El cursor se puede ENCADENAR entre llamadas: cada página de Creator tarda
  // varios segundos y ~30 no entran en el tiempo de la función (504). Se
  // devuelve el cursor final y la siguiente llamada retoma desde ahí.
  let cursor = String(req.query?.cursor || "").trim();
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
    cursor_siguiente: cursor || null,
    hay_mas: Boolean(cursor),
    por_estado: ordenar(porEstado),
    por_formulario: ordenar(porFormulario),
    por_creador: ordenar(porCreador),
    ...(detalle ? { filas: filas.slice(0, 500) } : {}),
  });
};
