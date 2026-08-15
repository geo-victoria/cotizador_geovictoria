/**
 * DIAGNÓSTICO de la cadena de Nota de Venta en Creator.
 *
 * Contexto (15-ago): NDV-30748 se creó bien por API y `FinalizeForm` la dejó en
 * FORM_STATUS=CREATED, pero `RegeneratePdfJson` revienta y deja vacíos
 * `FullFormJsonPdf`, `PDF_STRING`, `FullConfigurationJson` y
 * `Mes_de_Inicio_de_Facturacion` — los cuatro se escriben juntos al final de esa
 * función. El error era invisible porque el workflow `GeneratePDF` la envuelve
 * en un catch vacío; Lalo le puso un `GenerateErrorLog` adentro.
 *
 * Este endpoint es la pinza para trabajar contra eso:
 *
 *   ?reportes=1                lista los reportes de la app (para no adivinar
 *                              link names al leer logs o tocar subformularios)
 *   ?logs=<ID_FORMULARIO>      lee el Log_NDV filtrado por formulario
 *   ?tocar=<idRegistro>&reporte=<linkName>
 *                              PATCH inocuo para volver a disparar los
 *                              workflows `on edit` de ese registro
 *   ?completar=<idNdv>         llena los campos que en la UI escriben workflows
 *                              `on user input` (y que por API nunca corren)
 *
 * GET, auth x-vicky-secret.
 */

const { getCreatorConfig, creatorApiFetch } = require("../_shared/zoho-creator-auth");
const { secretoValido } = require("../_shared/secreto-vicky");
const { resolverEmpresaGeoVictoria } = require("../_shared/empresa-gv");
const { zohoApiFetch } = require("../_shared/zoho-auth");

/**
 * Ejecutivo por correo. En la UI esto lo resuelve `on user input of Vendedor`
 * leyendo `JsonSellers`, que la app arma llamando a la API interna
 * zohointegrationapi. Acá se usa el usuario del CRM, que tiene los mismos
 * datos (nombre y teléfono) y no exige un token extra.
 */
async function usuarioPorCorreo(correo) {
  const email = String(correo || "").trim().toLowerCase();
  if (!email) return null;
  const r = await zohoApiFetch(`/crm/v3/users?type=ActiveUsers&per_page=200`, { method: "GET" }).catch(
    () => null
  );
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => ({}));
  const users = Array.isArray(j?.users) ? j.users : [];
  return users.find((u) => String(u?.email || "").trim().toLowerCase() === email) || null;
}

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

/** dd-MM-yyyy en hora de Chile, que es el formato que come Creator acá. */
function hoyCL() {
  const p = new Intl.DateTimeFormat("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value || "";
  return `${g("day")}-${g("month")}-${g("year")}`;
}

/**
 * El teléfono de la cotización viene a veces con el prefijo duplicado
 * ("+5656983659012"). El PDF lo imprime tal cual, así que se sanea acá.
 */
function saneaTelefono(valor) {
  let t = texto(valor).replace(/[^\d+]/g, "");
  if (!t) return "";
  t = t.replace(/^\+?5656/, "+56");
  if (!t.startsWith("+")) t = `+${t}`;
  return t;
}

module.exports = async function handler(req, res) {
  if (!secretoValido(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });

  let config;
  try {
    config = getCreatorConfig();
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `config Creator: ${e.message}` });
  }

  const owner = encodeURIComponent(config.ownerName);
  const app = encodeURIComponent(config.appLinkName);
  const base = `/creator/v2.1/data/${owner}/${app}`;
  const reporte = `${base}/report/${encodeURIComponent(config.reportLinkName)}`;

  const leerNdv = async (id) => {
    const r = await creatorApiFetch(`${reporte}/${encodeURIComponent(id)}?field_config=all`, {
      method: "GET",
    });
    const j = await r.json().catch(() => ({}));
    return j?.data || {};
  };

  // ── Reportes de la app ───────────────────────────────────────────────────
  if (String(req.query?.reportes || "") === "1") {
    const r = await creatorApiFetch(`/creator/v2.1/meta/${owner}/${app}/reports`, { method: "GET" });
    const j = await r.json().catch(() => ({}));
    const filas = Array.isArray(j?.reports) ? j.reports : [];
    return sendJson(res, 200, {
      ok: r.ok,
      status: r.status,
      reportes: filas.map((x) => ({ link: x.link_name, nombre: x.display_name, tipo: x.type })),
      crudo: filas.length ? undefined : JSON.stringify(j).slice(0, 400),
    });
  }

  // ── Log_NDV ──────────────────────────────────────────────────────────────
  if (req.query?.logs) {
    const idForm = String(req.query.logs).trim();
    const candidatos = String(req.query?.reporte || "Logs_NDV,Log_NDV_Report,Log_NDV,All_Log_NDV")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const campo = String(req.query?.campo || "ID_FORMULARIO").trim();
    const intentos = [];
    for (const rep of candidatos) {
      // `?logs=*` trae las últimas filas sin filtrar: sirve para descubrir cómo
      // se llaman de verdad los campos del reporte.
      const filtro = idForm === "*" ? "" : `criteria=${encodeURIComponent(`(${campo} == "${idForm}")`)}&`;
      const r = await creatorApiFetch(
        `${base}/report/${encodeURIComponent(rep)}?${filtro}limit=30&field_config=all`,
        { method: "GET" }
      );
      const j = await r.json().catch(() => ({}));
      const filas = Array.isArray(j?.data) ? j.data : [];
      intentos.push({ reporte: rep, status: r.status, filas: filas.length });
      if (filas.length) {
        return sendJson(res, 200, {
          ok: true,
          reporte: rep,
          intentos,
          campos: Object.keys(filas[0] || {}),
          logs: filas.map((f) => ({
            id: texto(f.ID),
            tipo: texto(f.TIPO),
            cuando: texto(f.Added_Time),
            usuario: texto(f.USUARIO),
            cambios: texto(f.CAMBIOS).slice(0, 900),
          })),
        });
      }
    }
    return sendJson(res, 200, { ok: false, idForm, intentos, error: "sin filas / reporte no resuelto" });
  }

  // ── Re-disparar workflows `on edit` de un registro ───────────────────────
  if (req.query?.tocar) {
    const id = String(req.query.tocar).trim();
    const rep = String(req.query?.reporte || config.reportLinkName).trim();
    // Un PATCH tiene que traer AL MENOS un campo. Se reescribe uno con su
    // propio valor para no alterar nada.
    let data = {};
    try {
      data = JSON.parse(String(req.query?.data || "{}"));
    } catch {
      return sendJson(res, 400, { ok: false, error: "data no es JSON" });
    }
    if (!Object.keys(data).length) data = { UpdateCheckbox: true };
    const r = await creatorApiFetch(`${base}/report/${encodeURIComponent(rep)}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    const j = await r.json().catch(() => ({}));
    return sendJson(res, 200, { ok: r.ok, status: r.status, reporte: rep, enviado: data, respuesta: JSON.stringify(j).slice(0, 600) });
  }

  // ── Completar los campos que la UI llena con `on user input` ─────────────
  if (req.query?.completar) {
    const ndvId = String(req.query.completar).trim();
    const ndv = await leerNdv(ndvId);
    if (!texto(ndv.ID)) return sendJson(res, 200, { ok: false, error: `no se pudo leer ${ndvId}` });

    const data = {};
    const faltaba = [];
    const poner = (campo, valor) => {
      const v = texto(valor);
      if (!v) return;
      if (texto(ndv[campo])) return; // lo que ya está no se pisa
      data[campo] = v;
      faltaba.push(campo);
    };

    // Fechas: `Fecha_de_creaci_n` y `fecha_uf_usd` las escribe la creación
    // desde la UI. Sin `fecha_uf_usd` el PDF no sabe con qué UF convertir.
    poner("Fecha_de_creaci_n", hoyCL());
    poner("fecha_uf_usd", hoyCL());
    // `Contacto_CRM` NO se toca: es un lookup al contacto del CRM, y mandarle
    // el nombre tumba el PATCH entero (code 3001, "Invalid column value").
    // Línea de negocio: lo que nace de Vicky es Telemarketing (vigencia 10 días
    // en el PDF, no 30).
    const linea = String(process.env.NDV_CREATOR_LINEA_NEGOCIO || "Telemarketing").trim();
    if (texto(ndv.Linea_de_Negocio) !== linea) {
      data.Linea_de_Negocio = linea;
      faltaba.push(`Linea_de_Negocio(${texto(ndv.Linea_de_Negocio)}→${linea})`);
    }
    // Teléfono con prefijo duplicado.
    const telOk = saneaTelefono(ndv.Tel_fono);
    if (telOk && telOk !== texto(ndv.Tel_fono)) {
      data.Tel_fono = telOk;
      faltaba.push(`Tel_fono(${texto(ndv.Tel_fono)}→${telOk})`);
    }

    // Vendedor: `on user input of Vendedor` es UI pura. Se arma el mismo texto
    // que pone el Deluge, con los datos del usuario del CRM.
    if (!texto(ndv.SellerName)) {
      const correo = texto(ndv.Correo_Vendedor);
      let nombre = "";
      let fono = "";
      if (correo) {
        const u = await usuarioPorCorreo(correo).catch(() => null);
        nombre = texto(u?.full_name) || [texto(u?.first_name), texto(u?.last_name)].filter(Boolean).join(" ");
        fono = texto(u?.mobile) || texto(u?.phone);
      }
      if (nombre) {
        data.SellerName = nombre;
        const dias = linea === "Telemarketing" ? "10 días" : "30 días";
        let notas = `Ejecutivo Comercial: ${nombre}\nCorreo: ${correo}\n`;
        if (fono) notas += `Teléfono: ${fono}\n`;
        notas += `La presente cotización tendrá una vigencia de ${dias} contadas a partir de la fecha indicada al principio del documento.`;
        data.SellerPersonalInformation = notas;
        if (fono) data.SellerPhone = fono;
        faltaba.push("SellerName", "SellerPersonalInformation");
      }
    }

    // Empresa en GeoVictoria: lo mismo que hace `LoadCrmData` en la UI.
    if (!texto(ndv.ID_Empresa_GeoVictoria) || !texto(ndv.GeoCompanyIdCRM)) {
      const cuentaId = typeof ndv.CRM_Account === "object" ? texto(ndv.CRM_Account?.ID) : texto(ndv.CRM_Account);
      if (cuentaId) {
        const emp = await resolverEmpresaGeoVictoria(cuentaId).catch(() => null);
        poner("ID_Empresa_GeoVictoria", emp?.idEmpresaGeoVictoria);
        poner("GeoCompanyIdCRM", emp?.geoCompanyIdCrm);
      }
    }

    if (String(req.query?.dryRun || "") === "1") {
      return sendJson(res, 200, { ok: true, dryRun: true, ndvId, faltaba, data });
    }
    if (!Object.keys(data).length) {
      return sendJson(res, 200, { ok: true, ndvId, nada_que_completar: true });
    }
    // LLAVE del candado. `DenyEditions` (on edit → on validate del formulario
    // Nota_de_Venta) hace `cancel submit` con el alert "Las NDV no pueden ser
    // editadas" cuando `Formulario == "Nota de Venta" && !UpdateCheckbox`. Es
    // la misma llave que usa el Deluge interno en cada updateRecord suyo, y
    // `restoreUpdateCheckbox` la vuelve a dejar en false después.
    data.UpdateCheckbox = true;

    const r = await creatorApiFetch(`${reporte}/${encodeURIComponent(ndvId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    const j = await r.json().catch(() => ({}));
    await new Promise((x) => setTimeout(x, 3000));
    const d = await leerNdv(ndvId);
    return sendJson(res, 200, {
      ok: r.ok,
      status: r.status,
      completados: faltaba,
      respuesta: JSON.stringify(j).slice(0, 400),
      despues: {
        STATUS: texto(d.STATUS),
        FORM_STATUS: texto(d.FORM_STATUS),
        Linea_de_Negocio: texto(d.Linea_de_Negocio),
        SellerName: texto(d.SellerName),
        fecha_uf_usd: texto(d.fecha_uf_usd),
        Fecha_de_creaci_n: texto(d.Fecha_de_creaci_n),
        ID_Empresa_GeoVictoria: texto(d.ID_Empresa_GeoVictoria),
        PDF_STRING: texto(d.PDF_STRING) ? "presente" : "vacío",
        FullFormJsonPdf: texto(d.FullFormJsonPdf) ? "presente" : "vacío",
      },
    });
  }

  return sendJson(res, 400, {
    ok: false,
    error: "usa ?reportes=1 | ?logs=<idFormulario> | ?tocar=<id>&reporte=<link> | ?completar=<idNdv>",
  });
};
