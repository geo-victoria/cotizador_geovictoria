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

  // ── Campos de un formulario ──────────────────────────────────────────────
  // Para verificar el NOMBRE DE ENLACE real de un campo recién creado: en
  // Deluge se referencia por ese nombre, no por la etiqueta visible.
  if (req.query?.campos) {
    const form = String(req.query.campos).trim();
    const r = await creatorApiFetch(`/creator/v2.1/meta/${owner}/${app}/form/${encodeURIComponent(form)}/fields`, {
      method: "GET",
    });
    const j = await r.json().catch(() => ({}));
    const fs = Array.isArray(j?.fields) ? j.fields : [];
    const filtro = String(req.query?.contiene || "").trim().toLowerCase();
    const filas = fs
      .map((f) => ({ link: f.link_name, nombre: f.display_name, tipo: f.type }))
      .filter((f) => !filtro || `${f.link} ${f.nombre}`.toLowerCase().includes(filtro));
    return sendJson(res, 200, { ok: r.ok, status: r.status, form, n: filas.length, campos: filas });
  }

  // ── Consulta libre a cualquier reporte ───────────────────────────────────
  // Para elegir a mano la cotización con la que probar la conversión.
  if (req.query?.listar) {
    const rep = String(req.query.listar).trim();
    const criteria = String(req.query?.criteria || "").trim();
    const limite = Math.min(200, Math.max(1, Number(req.query?.limite) || 20));
    const q = criteria ? `criteria=${encodeURIComponent(criteria)}&` : "";
    const r = await creatorApiFetch(
      `${base}/report/${encodeURIComponent(rep)}?${q}limit=${limite}&field_config=all`,
      { method: "GET" }
    );
    const j = await r.json().catch(() => ({}));
    const filas = Array.isArray(j?.data) ? j.data : [];
    // `crudo=1` devuelve los campos no vacíos tal cual: hace falta para copiar
    // la estructura de un registro de referencia hecho a mano.
    if (String(req.query?.crudo || "") === "1") {
      return sendJson(res, 200, {
        ok: r.ok,
        status: r.status,
        reporte: rep,
        n: filas.length,
        filas: filas.map((f) => {
          const out = {};
          for (const [k, v] of Object.entries(f)) {
            const t = texto(v);
            if (t || Array.isArray(v)) out[k] = v;
          }
          return out;
        }),
      });
    }
    return sendJson(res, 200, {
      ok: r.ok,
      status: r.status,
      reporte: rep,
      n: filas.length,
      filas: filas.map((f) => ({
        id: texto(f.ID),
        numero: texto(f.ID_NDV),
        formulario: texto(f.Formulario),
        status: texto(f.STATUS),
        formStatus: texto(f.FORM_STATUS),
        estadoCot: texto(f.ESTADO_COT),
        cuenta: texto(f.CRM_ACCOUNT_NAME),
        creado: texto(f.Added_Time),
        usuario: texto(f.Added_User),
        // Para auditar los bloques de equipos: cuántas filas quedaron de verdad.
        nEquipos: Array.isArray(f.Equipos) ? f.Equipos.length : 0,
        nServiciosAsoc: Array.isArray(f.Servicios) ? f.Servicios.length : 0,
        servicioProducto: texto(f.Servicio_Producto),
        montoHw: texto(f.MontoHW),
        pdf: texto(f.PDF_STRING) ? "sí" : "no",
        servicios: (Array.isArray(f.Form_Order) ? f.Form_Order : [])
          .map((x) => `${texto(x.Product_Name)}${x.Selected === true || texto(x.Selected) === "true" ? "" : "(off)"}`)
          .join(" + "),
      })),
      crudo: filas.length ? undefined : JSON.stringify(j).slice(0, 300),
    });
  }

  // ── Conversión + confirmación, el camino del post-pago ───────────────────
  if (req.query?.convertir) {
    const { convertirYConfirmar } = require("../_shared/ndv-conversion");
    const r = await convertirYConfirmar(String(req.query.convertir).trim()).catch((e) => ({
      ok: false,
      error: e.message,
    }));
    return sendJson(res, 200, r);
  }

  // ── Bloques Formulario_de_Equipos de una NDV ─────────────────────────────
  // Para comparar fila a fila las grillas que llena la interfaz contra las que
  // inserta el puente por API. El criterio va acá y no en la URL porque el
  // proxy del agente no deja pasar paréntesis.
  if (req.query?.bloques) {
    const idNdv = String(req.query.bloques).trim();
    const campo = String(req.query?.campo || "ID_Formulario,QuotationFormID").split(",");
    let j = {};
    let filas = [];
    let r = { ok: false, status: 0 };
    const intentos = [];
    for (const c of campo) {
      for (const valor of [`"${idNdv}"`, idNdv]) {
        const criteria = encodeURIComponent(`(${c.trim()} == ${valor})`);
        r = await creatorApiFetch(
          `${base}/report/HARDWARE_ALL_DATA?criteria=${criteria}&limit=10&field_config=all`,
          { method: "GET" }
        );
        j = await r.json().catch(() => ({}));
        filas = Array.isArray(j?.data) ? j.data : [];
        intentos.push(`${c.trim()}=${valor}:${r.status}:${filas.length}`);
        if (filas.length) break;
      }
      if (filas.length) break;
    }
    return sendJson(res, 200, {
      ok: r.ok,
      status: r.status,
      idNdv,
      intentos,
      bloques: filas.map((f) => ({
        id: texto(f.ID),
        producto: texto(f.Servicio_Producto),
        tipo: texto(f.SERVICE_TYPE),
        equipos: (Array.isArray(f.Equipos) ? f.Equipos : []).map((x) => x),
        servicios: (Array.isArray(f.Servicios) ? f.Servicios : []).map((x) => x),
      })),
      crudo: filas.length ? undefined : JSON.stringify(j).slice(0, 300),
    });
  }

  // ── BARRIDO DE BOOKS, leído desde Creator ────────────────────────────────
  // `FullSoJson` es literalmente el cuerpo que Creator le POSTea a Books al
  // generar la Sales Order. Auditarlo acá da los mismos patrones que auditar
  // Books, sin pedirle scopes nuevos a la integración de producción.
  if (String(req.query?.sojson || "") === "1") {
    const limite = Math.min(400, Math.max(1, Number(req.query?.limite) || 200));
    const criteria = encodeURIComponent('(Formulario == "Nota de Venta")');
    const r = await creatorApiFetch(
      `${reporte}?criteria=${criteria}&limit=${limite}&field_config=all`,
      { method: "GET" }
    );
    const j = await r.json().catch(() => ({}));
    const filas = Array.isArray(j?.data) ? j.data : [];

    const PRODUCTOS_VICKY = new Set([
      "Control de Asistencia", "Alertas", "Vacaciones", "Calendario Inteligente",
      "Gestión Documental", "Banco de Horas", "Arriendo de Equipos",
      "Venta de Equipos Asistencia", "Visitas y Servicios Técnicos",
    ]);
    const NUESTRAS = new Set(["zoho_info24610", "mejoracontinua_geovictoria"]);

    const grupo = { manual: [], api: [] };
    for (const f of filas) {
      if (texto(f.Pa_s_Facturaci_n) !== "Chile") continue;
      const productos = (Array.isArray(f.Form_Order) ? f.Form_Order : [])
        .map((x) => texto(x.Product_Name))
        .filter(Boolean);
      if (!productos.some((p) => PRODUCTOS_VICKY.has(p))) continue;
      let so = null;
      try {
        so = JSON.parse(texto(f.FullSoJson) || "null");
      } catch {
        so = "ilegible";
      }
      if (!so) continue;
      (NUESTRAS.has(texto(f.Added_User)) ? grupo.api : grupo.manual).push({
        ndv: texto(f.Numero_de_Nota_de_Venta) || texto(f.ID),
        idSo: texto(f.ID_SO),
        so,
      });
    }

    const resumen = (arr) => {
      const cabecera = {};
      const linea = {};
      const monedas = {};
      const impuestos = {};
      const codigos = {};
      let conLineas = 0;
      let totalCero = 0;
      let ilegibles = 0;
      let nLineas = 0;
      for (const it of arr) {
        if (it.so === "ilegible") { ilegibles += 1; continue; }
        const so = it.so && typeof it.so === "object" ? it.so : {};
        for (const k of Object.keys(so)) {
          const v = so[k];
          const tiene = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "";
          if (tiene) cabecera[k] = (cabecera[k] || 0) + 1;
        }
        const items = Array.isArray(so.line_items) ? so.line_items : [];
        if (items.length) conLineas += 1;
        const total = Number(so.total ?? so.sub_total ?? 0);
        if (!items.length || !total) totalCero += 1;
        monedas[texto(so.currency_code) || "(sin)"] = (monedas[texto(so.currency_code) || "(sin)"] || 0) + 1;
        for (const li of items) {
          nLineas += 1;
          for (const k of Object.keys(li)) {
            const v = li[k];
            const tiene = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "";
            if (tiene) linea[k] = (linea[k] || 0) + 1;
          }
          const tax = texto(li.tax_id) || texto(li.tax_name) || "(sin impuesto)";
          impuestos[tax] = (impuestos[tax] || 0) + 1;
          const cod = (texto(li.name) || texto(li.item_name)).split(" ")[0];
          if (cod) codigos[cod] = (codigos[cod] || 0) + 1;
        }
      }
      const pct = (obj, n) => Object.fromEntries(
        Object.entries(obj)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, `${v}/${n} (${n ? Math.round((v / n) * 100) : 0}%)`])
      );
      return {
        notas: arr.length,
        ilegibles,
        con_lineas: `${conLineas}/${arr.length}`,
        sin_lineas_o_total_cero: totalCero,
        lineas_totales: nLineas,
        cabecera: pct(cabecera, arr.length - ilegibles),
        linea_items: pct(linea, nLineas),
        monedas,
        impuestos_por_linea: pct(impuestos, nLineas),
        codigos_de_articulo: pct(codigos, nLineas),
      };
    };

    // Mapa código de artículo → id de Books, cosechado de líneas que Books YA
    // aceptó. Es la fuente autoritativa: no hay que adivinar ids ni bodegas.
    if (String(req.query?.mapa || "") === "1") {
      const mapa = {};
      for (const it of grupo.manual) {
        for (const li of Array.isArray(it.so?.line_items) ? it.so.line_items : []) {
          const cod = (texto(li.name) || texto(li.item_name)).split(" ")[0];
          const id = texto(li.item_id);
          if (!cod || !id) continue;
          const k = `${cod}`;
          mapa[k] = mapa[k] || { item_id: id, nombre: texto(li.name), bodegas: {}, veces: 0 };
          mapa[k].veces += 1;
          const b = `${texto(li.warehouse_id)}|${texto(li.warehouse_name)}`;
          mapa[k].bodegas[b] = (mapa[k].bodegas[b] || 0) + 1;
          if (mapa[k].item_id !== id) mapa[k].conflicto = id;
        }
      }
      return sendJson(res, 200, { ok: true, n: Object.keys(mapa).length, mapa });
    }

    if (String(req.query?.detalle || "") === "1") {
      const desnudar = (arr) =>
        arr.map((x) => ({
          ndv: x.ndv,
          idSo: x.idSo,
          lineas: (Array.isArray(x.so?.line_items) ? x.so.line_items : []).map((li) => ({
            name: texto(li.name),
            item_id: texto(li.item_id),
            rate: li.rate,
            quantity: li.quantity,
            warehouse: texto(li.warehouse_name),
          })),
        }));
      return sendJson(res, 200, {
        ok: true,
        nuestras: desnudar(grupo.api),
        muestra_manual: desnudar(grupo.manual.filter((x) => x.so?.line_items?.length).slice(0, 6)),
      });
    }

    return sendJson(res, 200, {
      ok: true,
      leidas: filas.length,
      manual: resumen(grupo.manual),
      nuestras: resumen(grupo.api),
      nuestras_detalle: grupo.api.map((x) => ({ ndv: x.ndv, idSo: x.idSo })),
    });
  }

  // ── AUDITORÍA del mes ────────────────────────────────────────────────────
  // Qué campos traen SIEMPRE las notas hechas a mano y cuáles traen las
  // nuestras. Devuelve solo estadísticas: traerse cientos de registros
  // completos no cabe en una respuesta.
  if (String(req.query?.auditoria || "") === "1") {
    const limite = Math.min(400, Math.max(1, Number(req.query?.limite) || 200));
    const criteria = encodeURIComponent('(Formulario == "Nota de Venta")');
    const r = await creatorApiFetch(
      `${reporte}?criteria=${criteria}&limit=${limite}&field_config=all`,
      { method: "GET" }
    );
    const j = await r.json().catch(() => ({}));
    const filas = Array.isArray(j?.data) ? j.data : [];

    // "Como las de Vicky": Chile, y con algún producto de su catálogo.
    const PRODUCTOS_VICKY = new Set([
      "Control de Asistencia", "Alertas", "Vacaciones", "Calendario Inteligente",
      "Gestión Documental", "Banco de Horas", "Arriendo de Equipos",
      "Venta de Equipos Asistencia", "Visitas y Servicios Técnicos",
    ]);
    const CAMPOS = [
      "PDF_STRING", "FullFormJsonPdf", "FullConfigurationJson", "JsonToFacturacion",
      "JsonCrmContacts", "FullSoJson", "ESTADOS_INTEGRACION_FACTURACION",
      "Razones_Sociales_Account", "JsonTradeNamesZoho", "Contacto_CRM", "Account_Owner",
      "SellerName", "SellerPersonalInformation", "ID_Empresa_GeoVictoria", "GeoCompanyIdCRM",
      "fecha_uf_usd", "Fecha_de_creaci_n", "CRM_REFERENCE_ID", "ID_SO", "MESES_PERIODO",
      "TOTAL_SERVICIOS_MENSUALES", "Mes_de_Inicio_de_Facturacion", "Linea_de_Negocio",
    ];
    const NUESTRAS = new Set(["zoho_info24610", "mejoracontinua_geovictoria"]);

    const grupo = { manual: [], api: [] };
    for (const f of filas) {
      if (texto(f.Pa_s_Facturaci_n) !== "Chile") continue;
      const productos = (Array.isArray(f.Form_Order) ? f.Form_Order : [])
        .map((x) => texto(x.Product_Name))
        .filter(Boolean);
      if (!productos.some((p) => PRODUCTOS_VICKY.has(p))) continue;
      (NUESTRAS.has(texto(f.Added_User)) ? grupo.api : grupo.manual).push(f);
    }

    const stats = (arr) => {
      const out = {};
      for (const c of CAMPOS) {
        const n = arr.filter((f) => texto(f[c])).length;
        out[c] = arr.length ? `${n}/${arr.length} (${Math.round((n / arr.length) * 100)}%)` : "—";
      }
      return out;
    };

    return sendJson(res, 200, {
      ok: true,
      leidas: filas.length,
      chile_con_productos_de_vicky: { manual: grupo.manual.length, api: grupo.api.length },
      presencia_manual: stats(grupo.manual),
      presencia_api: stats(grupo.api),
      productos_vistos: [
        ...new Set(
          [...grupo.manual, ...grupo.api].flatMap((f) =>
            (Array.isArray(f.Form_Order) ? f.Form_Order : []).map((x) => texto(x.Product_Name))
          )
        ),
      ].filter(Boolean),
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
