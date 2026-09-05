/**
 * CONVERTIR la cotización espejada en Creator en una NOTA DE VENTA, y
 * confirmarla — todo por API.
 *
 * Es el último tramo del camino que Lalo pidió el 15-ago: "un pago por
 * MercadoPago o transferencia debería convertir la cotización en nota de
 * venta". Hasta hoy ese paso lo hacía una ejecutiva a mano.
 *
 * La cadena tiene cuatro eslabones y NINGUNO es obvio; los tres primeros son
 * workflows que en la interfaz corren solos y por API no:
 *
 *   1. CREAR la nota copiando la cotización. El botón "Convertir a NV" solo
 *      abre el formulario; la copia la hace un `on user input`, que por API
 *      nunca corre. Acá se replica campo por campo.
 *   2. `Empresa` = "Crear desde Nota de Venta" cuando el cliente todavía no
 *      existe en la plataforma. Con el valor equivocado, `RegeneratePdfJson`
 *      revienta en un `mid()` sobre `Empresa_dropdown` vacío y la nota se queda
 *      SIN PDF — lo que a su vez impide confirmarla.
 *   3. FINALIZAR: crear el Finalizar_Formulario, que dispara GeneratePDF.
 *   4. CONFIRMAR: `Confirmar_Por_API`, el campo que Lalo agregó al formulario
 *      con un flujo *on edit → validación* que ejecuta el cuerpo de
 *      `ConfirmNDV` (totales, PDF definitivo, orden de venta, referencia CRM).
 *      Sin él no hay forma de confirmar: el botón es una acción de reporte y no
 *      se puede invocar desde fuera.
 *
 * `UpdateCheckbox: true` va en todo PATCH: el workflow `DenyEditions` cancela
 * cualquier edición de una nota de venta que no lo traiga.
 *
 * Todo es best-effort y JAMÁS bloquea la entrega post-pago: si Creator falla,
 * el cliente igual recibe su onboarding y la nota se puede convertir después.
 */

const { getCreatorConfig, creatorApiFetch } = require("./zoho-creator-auth");
const { finalizarFormulario } = require("./ndv-subforms");

const CAMPO_CONFIRMAR = String(process.env.NDV_CREATOR_CAMPO_CONFIRMAR || "Confirmar_Por_API").trim();

function texto(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return String(v.display_value || v.zc_display_value || v.ID || "");
  return String(v).trim();
}

/** Campos que el workflow de la interfaz copia de la cotización a la nota. */
const COPIAR_DIRECTO = [
  "Moneda",
  "Contact_Name",
  "Email",
  "Tel_fono",
  "Cargo_del_contacto",
  "Identificador_Tributario_Empresa",
  "Account_Owner",
  "Rubro",
  "Pa_s_Facturaci_n",
  "Linea_de_Negocio",
  "CRM_ACCOUNT_NAME",
  "Correo_Vendedor",
  "SellerName",
  "SellerPhone",
  "SellerPersonalInformation",
  "Es_agente_de_retencion",
  "RequireUpdateCrmRUT",
  "JsonTradeNamesZoho",
  "Razones_Sociales_Account",
  "MESES_PERIODO",
  "ID_Empresa_GeoVictoria",
  "GeoCompanyIdCRM",
  // La FECHA de conversión UF/USD se hereda, nunca se re-estampa: Creator no
  // guarda el valor de la UF, solo esta fecha, y con ella resuelve la conversión
  // a pesos. Re-estamparla facturaría con una UF distinta a la que el cliente
  // aceptó.
  "fecha_uf_usd",
  "dontUpdateUfDate",
  "Fecha_de_creaci_n",
];

/**
 * @param {string} cotId ID interno del registro de Creator (la COTIZACIÓN).
 * @returns {Promise<{ok: boolean, ndvId?: string, idNdv?: string, paso?: string, error?: string, confirmada?: boolean}>}
 */
async function convertirYConfirmar(cotId, opciones) {
  const confirmarAhora = opciones?.confirmar !== false;
  // EMPRESA YA CREADA (Lalo 05-sep, caso Maquinarias Santa Sara / alta por
  // chat de Vicky): cuando la empresa ya existe en la plataforma, la nota
  // debe decir "Creada en Plataforma" con `Empresa_dropdown` = "NOMBRE-RUT-ID"
  // (el ID que devolvió la API de alta, p. ej. 49). Sin este dato la nota
  // sale como "Crear desde Nota de Venta" y el equipo crea una segunda empresa.
  const empresaDropdown = texto(opciones?.empresaDropdown);
  const id = texto(cotId);
  if (!id) return { ok: false, error: "sin id de cotización en Creator" };

  const config = getCreatorConfig();
  const base = `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(
    config.appLinkName
  )}`;
  const reporte = `${base}/report/${encodeURIComponent(config.reportLinkName)}`;

  const leer = async (recId) => {
    const r = await creatorApiFetch(`${reporte}/${encodeURIComponent(recId)}?field_config=all`, {
      method: "GET",
    });
    const j = await r.json().catch(() => ({}));
    return j?.data || {};
  };

  // 1. La cotización de origen.
  const cot = await leer(id);
  if (!texto(cot.ID)) return { ok: false, paso: "leer_cotizacion", error: `no se pudo leer ${id}` };
  if (texto(cot.Formulario) !== "Cotización") {
    return { ok: false, paso: "leer_cotizacion", error: `${id} no es una Cotización` };
  }
  // La app rechaza una segunda nota del mismo origen; si ya se convirtió, se
  // informa sin volver a intentarlo.
  if (texto(cot.ESTADO_COT) === "Convertida a NDV") {
    return { ok: true, paso: "ya_convertida", ndvId: "", idNdv: texto(cot.ID_NDV) };
  }

  // 2. La nota de venta, replicando lo que copia el workflow de la interfaz.
  const hoy = new Date().toLocaleDateString("es-CL", { timeZone: "America/Santiago" });
  const registro = {
    Formulario: "Nota de Venta",
    FORM_STATUS: "BEING CREATED",
    STATUS: "BORRADOR",
    Cotizacion_Origen: id,
    Nombre_del_documento: `${texto(cot.CRM_Account) || texto(cot.CRM_ACCOUNT_NAME)} / ${hoy}`,
  };
  for (const campo of COPIAR_DIRECTO) {
    const v = cot[campo];
    const t = texto(v);
    if (t) registro[campo] = Array.isArray(v) ? v : t;
  }
  const cuentaId = typeof cot.CRM_Account === "object" ? texto(cot.CRM_Account?.ID) : "";
  if (cuentaId) registro.CRM_Account = cuentaId;
  for (const campo of [
    "Servicios_Recurrentes",
    "Servicios_No_Recurrentes",
    "Servicio_Recurrente_Configurado",
    "Servicio_No_Recurrente_Configurado",
  ]) {
    if (Array.isArray(cot[campo]) && cot[campo].length) registro[campo] = cot[campo];
  }
  const filas = Array.isArray(cot.Form_Order) ? cot.Form_Order : [];
  const formOrder = filas
    .map((f) => ({
      Form_ID: texto(f.Form_ID) || texto(f.ID),
      Product_Type: texto(f.Product_Type),
      Product_Name: texto(f.Product_Name),
      Selected: f.Selected === true || texto(f.Selected) === "true",
      FormName: texto(f.FormName),
      // La fila del último paso apunta al Finalizar_Formulario de la NOTA, que
      // todavía no existe: se crea más abajo.
      Form_ID_NDV: texto(f.FormName) === "Finalizar_Formulario" ? "" : texto(f.Form_ID) || texto(f.ID),
    }))
    .filter((f) => f.Form_ID);
  if (formOrder.length) registro.Form_Order = formOrder;

  // HARDWARE → la nota nace declarando que requiere orden de venta.
  //
  // `ConfirmNDV` decide si genera el SO con `if(varRequireSO || RequireSO)`, y
  // esa condición se evalúa ANTES de que el propio script marque el campo. En
  // la interfaz no molesta porque el ejecutivo llena el formulario y `RequireSO`
  // ya viene en true al apretar el botón; por API la nota nacía en false y la
  // PRIMERA confirmación nunca entraba a la rama del SO (verificado en
  // NDV-30756: quedó CONFIRMADA, con RequireSO en true, y sin orden de venta).
  //
  // Acá lo sabemos al momento de crearla: si el pedido trae un bloque de
  // equipos, requiere orden de venta.
  const llevaEquipos = formOrder.some((f) => f.FormName === "Formulario_de_Equipos" && f.Selected);
  if (llevaEquipos) registro.RequireSO = true;

  const rPost = await creatorApiFetch(`${base}/form/Nota_de_Venta`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: registro }),
  });
  const jPost = await rPost.json().catch(() => ({}));
  const ndvId = texto(jPost?.data?.ID);
  if (!ndvId) {
    return { ok: false, paso: "crear_nota", error: JSON.stringify(jPost).slice(0, 300) };
  }

  // 3. Finalizar: dispara GeneratePDF.
  const ndvRecord = { ...registro, ID: ndvId };
  const fin = await finalizarFormulario({ ndvId, ndvRecord }).catch((e) => {
    console.warn(`[ndv-conversion] finalizar falló: ${e.message}`);
    return null;
  });

  // CORREGIR `Empresa` DESPUÉS, no antes. La aplicación reescribe ese campo en
  // sus propios workflows (`input.Empresa = "Creada en Plataforma"`), así que
  // mandarlo bien en la creación no sirve de nada: queda pisado, y con
  // `Empresa_dropdown` vacío `RegeneratePdfJson` muere en su `mid()` y la nota
  // se queda sin PDF — y sin PDF no se puede confirmar.
  //
  // Corregirlo por PATCH además VUELVE A DISPARAR GeneratePDF, porque el
  // workflow es "on add or edit". Es exactamente la secuencia que funcionó a
  // mano en NDV-30748 y NDV-30750.
  const finalizarId = texto(fin?.finalizarId);
  if (finalizarId) {
    await creatorApiFetch(`${base}/report/FINALIZE_FORM_ALL_DATA/${encodeURIComponent(finalizarId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: {
          Empresa: empresaDropdown ? "Creada en Plataforma" : "Crear desde Nota de Venta",
          ...(empresaDropdown ? { Empresa_dropdown: empresaDropdown } : {}),
          CAN_UPDATE_FIELDS: true,
          // Sin estos dos, otro workflow del mismo formulario revienta en
          // `EditNextStep` (currentIndex + 1 sobre nulo) y aborta la cadena
          // antes de llegar a GeneratePDF.
          currentEditIndex: 0,
          maxIndex: 0,
        },
      }),
    }).catch((e) => console.warn(`[ndv-conversion] corrección de Empresa falló: ${e.message}`));
  }
  // El PDF se genera en background; sin él ConfirmNDV no puede correr, porque
  // arranca leyendo FullFormJsonPdf.
  await new Promise((r) => setTimeout(r, 8000));

  // 4. Confirmar — SEGUNDA PASADA.
  //
  // La cadena completa (crear, finalizar, esperar el PDF, confirmar) no cabe en
  // el tiempo de una función serverless: la llamada se corta y quedamos ciegos,
  // sin poder distinguir un timeout inofensivo de una falla real. Por eso el
  // post-pago solo CONVIERTE, y la confirmación la hace una pasada posterior,
  // cuando el PDF ya existe. Confirmar sin PDF no sirve: `ConfirmNDV` arranca
  // leyendo `FullFormJsonPdf`.
  if (!confirmarAhora) {
    const parcial = await leer(ndvId).catch(() => ({}));
    return {
      ok: true,
      ndvId,
      idNdv: texto(parcial.ID_NDV),
      confirmada: false,
      pendienteDeConfirmar: true,
      pdf: Boolean(texto(parcial.PDF_STRING)),
    };
  }
  const rConf = await creatorApiFetch(`${reporte}/${encodeURIComponent(ndvId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { [CAMPO_CONFIRMAR]: true, UpdateCheckbox: true } }),
  }).catch((e) => ({ ok: false, _error: e.message }));

  await new Promise((r) => setTimeout(r, 5000));
  const despues = await leer(ndvId).catch(() => ({}));
  return {
    ok: true,
    ndvId,
    idNdv: texto(despues.ID_NDV),
    confirmada: texto(despues.STATUS) === "CONFIRMADA",
    pdf: Boolean(texto(despues.PDF_STRING)),
    totalMensual: texto(despues.TOTAL_SERVICIOS_MENSUALES),
    idSo: texto(despues.ID_SO),
    confirmHttp: rConf?.status || null,
  };
}

/**
 * SEGUNDA PASADA: confirmar una nota que ya tiene su PDF.
 *
 * Se niega si el PDF todavía no está — `ConfirmNDV` empieza leyendo
 * `FullFormJsonPdf` y sin él aborta dejando la nota a medias. Es idempotente:
 * una nota ya CONFIRMADA se informa y no se vuelve a tocar.
 */
async function confirmarNota(ndvId, opciones) {
  const id = texto(ndvId);
  if (!id) return { ok: false, error: "sin id de nota" };
  const esperadoUF = Number(opciones?.esperadoUF);
  const forzar = opciones?.forzar === true;

  const config = getCreatorConfig();
  const reporte =
    `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}` +
    `/report/${encodeURIComponent(config.reportLinkName)}`;

  const leer = async () => {
    const r = await creatorApiFetch(`${reporte}/${encodeURIComponent(id)}?field_config=all`, { method: "GET" });
    const j = await r.json().catch(() => ({}));
    return j?.data || {};
  };

  const antes = await leer();
  if (texto(antes.STATUS) === "CONFIRMADA") {
    return { ok: true, ndvId: id, idNdv: texto(antes.ID_NDV), confirmada: true, yaEstaba: true };
  }
  if (!texto(antes.PDF_STRING)) {
    return { ok: false, ndvId: id, idNdv: texto(antes.ID_NDV), error: "todavía sin PDF", reintentable: true };
  }

  // GUARDA DE MONTO (17-ago, caso Loumar NDV-30766). El espejo de Creator puede
  // traer bloques que la cotización aceptada NO tiene: COT-59555 cargaba un
  // "Arriendo de Equipos" de 0,30 UF inexistente en Zoho, y la nota se confirmó
  // en 0,85 cuando el cliente pagó 0,55. Confirmar es lo que habilita a
  // facturación, así que el total de la nota tiene que calzar con lo vendido
  // ANTES de confirmar, no después.
  if (Number.isFinite(esperadoUF) && esperadoUF > 0) {
    const total = Number(texto(antes.TOTAL_SERVICIOS_MENSUALES)) || 0;
    // Tolerancia por redondeo de Creator (5 decimales), no por diferencias reales.
    if (total > 0 && Math.abs(total - esperadoUF) > 0.005 && !forzar) {
      return {
        ok: false,
        ndvId: id,
        idNdv: texto(antes.ID_NDV),
        error: `el total mensual de la nota (${total} UF) no calza con lo vendido (${esperadoUF} UF)`,
        totalNota: total,
        esperadoUF,
        descuadre: Number((total - esperadoUF).toFixed(5)),
      };
    }
  }

  await creatorApiFetch(`${reporte}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { [CAMPO_CONFIRMAR]: true, UpdateCheckbox: true } }),
  }).catch((e) => console.warn(`[ndv-conversion] confirmar falló: ${e.message}`));

  await new Promise((r) => setTimeout(r, 6000));
  const d = await leer().catch(() => ({}));
  return {
    ok: true,
    ndvId: id,
    idNdv: texto(d.ID_NDV),
    confirmada: texto(d.STATUS) === "CONFIRMADA",
    totalMensual: texto(d.TOTAL_SERVICIOS_MENSUALES),
    idSo: texto(d.ID_SO),
  };
}

module.exports = { convertirYConfirmar, confirmarNota };
