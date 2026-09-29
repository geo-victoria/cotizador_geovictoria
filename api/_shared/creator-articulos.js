/**
 * Códigos del catálogo de artículos de Zoho Creator.
 *
 * Las grillas de Formulario_de_Equipos identifican cada línea con un valor de
 * picklist del catálogo de artículos ("006.10 - Reloj…", "901 - [CHI] Instalación
 * RM"). Nuestro catálogo usa ids propios (senseface_2a, instalacion_reloj), así
 * que acá se traduce de uno al otro.
 *
 * OJO: al elegir el Item en el formulario manual, Creator autorellena el resto de
 * la fila con un script Deluge de tipo "on user input". Ese script NO corre
 * cuando el registro entra por API, así que todas las columnas de precio hay que
 * mandarlas explícitamente. Ver buildFormularioEquiposRecord.
 */

/**
 * Hardware: id del catálogo → artículo de Creator.
 * Vicky tiene habilitados (`disponibleParaVicky` en lib/catalogo/hardware.ts
 * del agente): Senseface 2A, huellero URU4500, tarjetas de proximidad,
 * impresora térmica y el kit QR (07-sep). El resto del catálogo existe pero no
 * es vendible por ella.
 *
 * Si algún día se habilita otro, agregar su código acá — sin eso la línea queda
 * fuera del PDF y de la orden de venta, y solo se avisa por log.
 */
const HARDWARE_A_ARTICULO = {
  // ── PERÚ (17-sep, Lalo: "para los documentos internos como NDV dejémoslo
  // como se viene manejando de siempre") ──
  // El reloj de Vicky PE es el MISMO Senseface 2A, pero en Perú el artículo es
  // el [PER] 304 y se FACTURA EN DÓLARES, en una nota de venta aparte de la
  // del plan (golden NDV-32020 de Mónica traía Valor_Mensual 24; Lalo 21-sep fijó el arriendo en US$20, la opción más barata de la tabla de Mónica).
  // Books: rate 90, SKU PER-BIO-SF2A-ZKT-LW-HTF, id 1758661000080530243.
  // `moneda` marca que los valores de acá van en USD: ndv-charge-table los usa
  // en vez del subtotal en soles del subform cuando la nota es en USD.
  reloj_pe: {
    item: "304 - [PER] Reloj Gama Estándar FACIAL LAN WIFI",
    modelo: "Senseface 2A",
    // Venta US$150 + IGV con instalación incluida en Lima (Lalo 27-sep).
    valorListaUF: 150,
    valorMensual: 20,
    moneda: "USD",
  },
  // EL RELOJ ESTÁNDAR DE VICKY CHILE (23-sep-2026): el slot `senseface_2a`
  // pasó a despachar el Senseface 4A (correo de Valeria Barbano 22-sep "hasta
  // agotar stock", orden de Lalo: mismo precio de Vicky, otra ficha). Artículo
  // Books "006.11 - Reloj Gama Media Facial WIFI/LAN", SKU
  // CHL-BIO-SF4A-ZKT-WL-FHT, id 1758661000086449007 (leído de Books el 23-sep).
  // El 006.10 (2A) queda en las tablas de ids/SKU por las notas ya emitidas.
  senseface_2a: {
    item: "006.11 - Reloj Gama Media Facial WIFI/LAN",
    modelo: "Senseface 4A",
    // Precio de LISTA de venta. La grilla lo lleva en `Valor` incluso cuando la
    // línea es de arriendo (ahí `Valor_Mensual` lleva la mensualidad), y de ahí
    // sale el `rate` de la orden de venta. Verificado en 59 bloques de arriendo
    // de agosto: los 8 revisados traen Valor=5.000 sin excepción.
    // 23-sep: lista del Senseface 4A = 4 UF (correo Valeria 22-sep; Vicky vende
    // a ese mismo precio por orden de Lalo). Las notas viejas del 2A quedan en 5.
    valorListaUF: 4,
  },
  // Lector de huella USB, la alternativa económica al reloj de pared. Está
  // habilitado para Vicky (`disponibleParaVicky: true` en el catálogo, venta 3
  // UF y arriendo 0,25) y NO estaba acá: una venta con huellero perdía su línea
  // en Creator y no llegaba a la orden de venta. Verificado en Books el 16-ago:
  // "012 - Huellero URU4500", SKU CHL-BIO-U4500-HID-USB-HI, rate 3, IVA 19%.
  uru4500: {
    item: "012 - Huellero URU4500",
    modelo: "URU4500",
    valorListaUF: 3,
  },
  // ── Habilitados el 07-sep (cierre de objeciones, Lalo). Nombres y SKU
  // leídos de Books ese día (misma convención que 006.10/012: el Item de la
  // grilla es el nombre del artículo de Books).
  // Tarjeta de proximidad (Vicky la vende desde el 01-sep; hasta hoy la línea
  // quedaba FUERA de Creator — caso Valuaciones, 20 tarjetas sin registrar).
  // Books: "026.1 - Tarjeta ID (delgada)", SKU CHL-ACC-IDCTN-ZKT, rate 1.200 CLP
  // (~0,03 UF, que es el precio de lista de Vicky).
  tarjeta_id: {
    item: "026.1 - Tarjeta ID (delgada)",
    modelo: "ID CardThin",
    valorListaUF: 0.03,
  },
  // Impresora térmica de comprobantes (accesorio del reloj; venta 7 / arriendo
  // 1,2 según lista de Nacho). Books: "013 - Impresora Termica (Fiscal)",
  // SKU CHL-ACC-SLKT-SWO-SER, rate 7.
  impresora_termica: {
    item: "013 - Impresora Termica (Fiscal)",
    modelo: "SLK-TL202II",
    valorListaUF: 7,
  },
  // Kit QR (arriendo 1,8 UF/mes del kit completo): en Books NO existe como un
  // artículo único — es Senseface 3A + gabinete lector CI (019) + lector
  // Vuquest 3320g (024). La línea se registra sobre el reloj (006.9) con el
  // detalle del kit en el modelo; el gabinete y el lector no mueven
  // inventario por esta vía (pendiente Nacho: artículo "Kit QR" o
  // desglose en 3 filas).
  kit_qr: {
    item: "006.9 - Reloj Gama Estándar Facial WIFI/LAN",
    modelo: "Senseface 3A — Kit QR (incluye gabinete lector CI 019 y lector Vuquest 3320g 024)",
    valorListaUF: 8,
  },
  // ── COLOMBIA y MÉXICO (29-sep): el equipo de Vicky es el Senseface 2A y en
  // Books existe por país (leído el 29-sep). Hasta hoy ninguna nota CO/MX con
  // equipo llevaba artículo: nacía "INCOMPLETA" y sin orden de venta. Los
  // valores van en la moneda de la nota (COP / MXN), como el plan; nada de
  // conversión. Colombia: alquiler $86.000/mes base ($98.000 fuera), compra
  // $620.000 + IVA. México: renta $350/mes, venta $2.100 + IVA.
  reloj_co: {
    item: "218.1 - [COL] EQUIPO FACIAL SENSEFACE 2A WIFI",
    modelo: "Senseface 2A",
    valorListaUF: 620000,
    valorMensual: 86000,
    moneda: "COP",
  },
  reloj_mx: {
    item: "123.1 - [MEX] Senseface 2A",
    modelo: "Senseface 2A",
    valorListaUF: 2100,
    valorMensual: 350,
    moneda: "MXN",
  },
};

/**
 * Códigos GENÉRICOS que las emisiones de Colombia y México comparten
 * ("reloj_arriendo" / "reloj_venta", los ids del subform de ambos países): el
 * artículo depende del PAÍS de la nota, no del código. `articuloDeHardware`
 * recibe el país (derivado de la moneda de la nota) y resuelve acá primero.
 */
const ARTICULO_GENERICO_POR_PAIS = {
  co: { reloj_arriendo: "reloj_co", reloj_venta: "reloj_co", reloj: "reloj_co" },
  mx: { reloj_arriendo: "reloj_mx", reloj_venta: "reloj_mx", reloj_renta: "reloj_mx", reloj: "reloj_mx" },
  pe: { reloj_arriendo: "reloj_pe", reloj_venta: "reloj_pe", reloj: "reloj_pe" },
};
const CODIGOS_HARDWARE_GENERICOS = new Set(["reloj_arriendo", "reloj_venta", "reloj_renta", "reloj"]);

/**
 * Servicios no recurrentes: id del catálogo (+ zona cuando aplica) → artículo.
 * La instalación se cobra distinto según la zona del punto, y esa zona ya viaja
 * en la línea del subform (campo Zona_Tarifa).
 */
const SERVICIO_A_ARTICULO = {
  instalacion_reloj: {
    RM: "901 - [CHI] Instalación RM",
    regiones: "902 - [CHI] Instalación Regiones",
  },
  envio_reloj: "907 - [CHI] Envío/Despacho Asistencia",
};

/**
 * Servicios de PE/CO/MX (29-sep): la zona viene del motor único como
 * base | intermedia | resto (Zona_Tarifa del subform) y cada país tiene sus
 * artículos de Books ([PER] 390-397 · [COL] 290.x/294.x · [MEX] 190-192, leídos
 * de Books el 29-sep). `base` = Lima-Callao / Bogotá / CDMX; el resto va al
 * artículo de provincia/regiones. México tiene UNA instalación para todo el
 * país y el envío se parte en terrestre (CDMX) y paquetería (resto).
 */
const SERVICIO_A_ARTICULO_PAIS = {
  pe: {
    instalacion_reloj: { base: "390 - [PER] Instalación Lima-Callao", fuera: "391 - [PER] Instalación Provicia" },
    envio_reloj: { base: "396 - [PER] Envío Lima-Callao", fuera: "397 - [PER] Envío Provincia" },
  },
  co: {
    instalacion_reloj: { base: "290.1 - [COL] Instalación Asistencia Bogotá", fuera: "290.2- [COL] Instalación Asistencia Regiones" },
    envio_reloj: { base: "294.1 - [COL] Envío Bogotá", fuera: "294.2 - [COL] Envío Regiones" },
  },
  mx: {
    instalacion_reloj: { base: "192 - [MEX] Instalación de biométrico", fuera: "192 - [MEX] Instalación de biométrico" },
    envio_reloj: { base: "191 - [MEX] Envío vía terrestre", fuera: "190 - [MEX] Envío por paquetería" },
  },
};

/**
 * Alias de código → id de nuestro catálogo.
 *
 * El canal EJECUTIVO no manda ids: la calculadora comercial arma su snapshot
 * solo con nombres visibles y `itemsDesdeSnapshot` los convierte en código
 * haciendo slug de ese nombre ("Senseface 2A (Promoción)" →
 * `senseface_2a_promocion`). Como esos códigos no existían acá, la línea del
 * equipo se degradaba a un Servicio_Recurrente genérico —sin equipo, sin bodega
 * y sin orden de venta— y la del servicio desaparecía sin ruido.
 * Caso que lo destapó: COT575 / NDV-30762 (MASTERDENT SPA, 17-ago).
 */
const ALIAS_CODIGO = {
  // Promo del Senseface 2A: es el MISMO equipo, cambia solo la tarifa.
  senseface_2a_promocion: "senseface_2a",
  senseface_2a_promo: "senseface_2a",
  huellero_uru4500: "uru4500",
  uru_4500: "uru4500",
  // Accesorios y kit QR: ids de la calculadora comercial y variantes.
  tarjeta_id_1: "tarjeta_id",
  tarjeta_id_2: "tarjeta_id",
  tarjeta_de_proximidad: "tarjeta_id",
  slk_tl202ii: "impresora_termica",
  impresora: "impresora_termica",
  impresora_termica_de_comprobantes: "impresora_termica",
  kit_qr_arriendo: "kit_qr",
  reloj_con_lector_qr: "kit_qr",
  // Servicios asociados: la Cotizadora de Ejecutivos usa ids cortos
  // ("envio", "instalacion") y la calculadora el slug del nombre con zona.
  envio: "envio_reloj",
  envio_region: "envio_reloj",
  envio_regiones: "envio_reloj",
  envio_rm: "envio_reloj",
  envio_despacho: "envio_reloj",
  instalacion: "instalacion_reloj",
  instalacion_rm: "instalacion_reloj",
  instalacion_region: "instalacion_reloj",
  instalacion_regiones: "instalacion_reloj",
};

/** Resuelve alias del canal ejecutivo al id de nuestro catálogo. */
function normalizarCodigo(codigoItem) {
  const codigo = String(codigoItem || "").trim().toLowerCase();
  return ALIAS_CODIGO[codigo] || codigo;
}

/**
 * @param {string} codigoItem  Codigo_Item de la línea
 * @param {string} [pais]      "cl" | "pe" | "co" | "mx" — resuelve los códigos
 *                             genéricos de CO/MX/PE; sin país, solo el catálogo.
 * @returns {{item: string, modelo: string} | null}
 */
function articuloDeHardware(codigoItem, pais) {
  const codigo = normalizarCodigo(codigoItem);
  const porPais = ARTICULO_GENERICO_POR_PAIS[String(pais || "").toLowerCase()];
  if (porPais && porPais[codigo]) return HARDWARE_A_ARTICULO[porPais[codigo]] || null;
  return HARDWARE_A_ARTICULO[codigo] || null;
}

/** ¿El código es de un equipo? Incluye los genéricos de CO/MX/PE aunque no se
 * sepa el país (para clasificar filas, no para elegir artículo). */
function esCodigoHardware(codigoItem) {
  const codigo = normalizarCodigo(codigoItem);
  return Boolean(HARDWARE_A_ARTICULO[codigo]) || CODIGOS_HARDWARE_GENERICOS.has(codigo);
}

/** País de una nota según su moneda ("UF"→cl, "PEN"/"USD"→pe, "COP"→co, "MXN"→mx). */
function paisDeMonedaNota(moneda) {
  const m = String(moneda || "").trim().toUpperCase();
  if (m === "COP") return "co";
  if (m === "MXN") return "mx";
  if (m === "PEN" || m === "SOL" || m === "USD") return "pe";
  return "cl";
}

/**
 * @param {string} codigoItem  Codigo_Item de la línea
 * @param {string} [zona]      "RM" | "regiones", solo para instalación
 * @returns {string} valor de picklist, o "" si no hay correspondencia
 */
function articuloDeServicio(codigoItem, zona, pais) {
  const crudo = String(codigoItem || "").trim().toLowerCase();
  const codigo = normalizarCodigo(crudo);
  const p = String(pais || "").trim().toLowerCase();
  if (p && p !== "cl") {
    const porPais = SERVICIO_A_ARTICULO_PAIS[p]?.[codigo];
    if (!porPais) return "";
    const z = String(zona || "").trim().toLowerCase();
    if (z === "base") return porPais.base;
    if (z === "intermedia" || z === "resto") return porPais.fuera;
    // Sin zona (cotizaciones anteriores al 29-sep): la tarifa mayor, igual que
    // en Chile — errar cobrando de más y que el ejecutivo lo baje.
    console.warn(`[creator-articulos] Servicio ${codigo} sin Zona_Tarifa (pais=${p}); se usa el artículo de provincia/regiones.`);
    return porPais.fuera;
  }
  const entrada = SERVICIO_A_ARTICULO[codigo];
  if (!entrada) return "";
  if (typeof entrada === "string") return entrada;

  // Cuando el código del canal ejecutivo ya trae la zona en el nombre
  // ("instalacion_rm"), vale como respaldo si la línea no la declaró.
  const zonaDelCodigo = /_rm$/.test(crudo) ? "rm" : /_regi/.test(crudo) ? "regiones" : "";
  const z = String(zona || zonaDelCodigo || "").trim().toLowerCase();
  if (z === "rm") return entrada.RM;
  if (z === "regiones" || z === "region") return entrada.regiones;
  // Instalación sin zona: se asume regiones, que es la tarifa mayor. Preferimos
  // errar cobrando de más y que el ejecutivo lo baje, antes que subcotizar.
  console.warn(
    `[creator-articulos] Instalación sin Zona_Tarifa (codigo=${codigo}); se usa el artículo de regiones.`
  );
  return entrada.regiones;
}

/**
 * Código de artículo → id del ítem en Zoho Books.
 *
 * NO son ids adivinados: se cosecharon del `FullSoJson` de las notas de venta
 * hechas a mano de agosto (barrido del 16-ago, 142 líneas, 30 artículos, cero
 * conflictos). Es decir, son exactamente los ids que Books YA aceptó.
 *
 * Para qué sirven: la grilla de Servicios lleva un campo `IdItemService` que la
 * interfaz rellena al elegir el artículo del desplegable, y de ahí sale el
 * `item_id` de la línea de la orden de venta. Por API ese script no corre, así
 * que las líneas de servicio nuestras llegaban a Books SIN `item_id` — entran
 * como texto libre: no se enlazan al artículo del catálogo, no suman en los
 * reportes por producto y no mueven inventario.
 *
 * Solo los artículos del catálogo de Vicky. El barrido trae 30; agregar acá los
 * que se vayan habilitando.
 */
const ITEM_ID_BOOKS = {
  "304": "1758661000080530243", // [PER] Reloj Gama Estándar FACIAL LAN WIFI (Senseface 2A, Perú)
  "218.1": "1758661000073776163", // [COL] EQUIPO FACIAL SENSEFACE 2A WIFI (Colombia, 29-sep)
  "123.1": "1758661000080555782", // [MEX] Senseface 2A (México, 29-sep)
  "006.10": "1758661000072468396", // Reloj Gama Entrada Facial WIFI/LAN (Senseface 2A, histórico)
  "006.11": "1758661000086449007", // Reloj Gama Media Facial WIFI/LAN (Senseface 4A, reloj estándar CL desde 23-sep)
  "006.9": "1758661000071719207", // Reloj Gama Estándar Facial WIFI/LAN (Senseface 3A, kit QR)
  "012": "1758661000001524374", // Huellero URU4500
  "013": "1758661000001962344", // Impresora Termica (Fiscal) SLK-TL202II
  "019": "1758661000006232024", // Gabinete para Lector CI (parte del kit QR)
  "024": "1758661000006049431", // Lector de Cédula/barras Vuquest 3320g (parte del kit QR)
  "026.1": "1758661000011723057", // Tarjeta ID (delgada)
  "907": "1758661000044939114", // Envío/Despacho Asistencia
  // Servicios de Perú, Colombia y México (Books, 29-sep)
  "390": "1758661000054636009", // [PER] Instalación Lima-Callao
  "391": "1758661000054636027", // [PER] Instalación Provicia (sic, así se llama en Books)
  "396": "1758661000054636077", // [PER] Envío Lima-Callao
  "397": "1758661000054636087", // [PER] Envío Provincia
  "290.1": "1758661000046214676", // [COL] Instalación Asistencia Bogotá
  "290.2-": "1758661000046214685", // [COL] Instalación Asistencia Regiones (el nombre en Books trae el guion pegado)
  "290.2": "1758661000046214685",
  "294.1": "1758661000046214748", // [COL] Envío Bogotá
  "294.2": "1758661000046214757", // [COL] Envío Regiones
  "190": "1758661000048975641", // [MEX] Envío por paquetería
  "191": "1758661000048975650", // [MEX] Envío vía terrestre
  "192": "1758661000048975672", // [MEX] Instalación de biométrico
  "901": "1758661000038441163", // Instalación RM
  "902": "1758661000038441184", // Instalación Regiones
  "903": "1758661000038441207", // Instalación Regiones extremas
  "904": "1758661000038441224", // Visita Técnica RM
  "905": "1758661000038441241", // Visita Técnica Regiones
  "909": "1758661000051361009", // Mantención equipo asistencia en Laboratorio
  "911": "1758661000053903234", // Visita Técnica Levantamiento
};

/**
 * SKU de Books por artículo. Es lo que el JsonPdf de cada bloque de equipos
 * lleva en `Sku` (los bloques hechos desde la interfaz lo traen siempre; se
 * copian de las órdenes de venta SO-28148 / SO-28162 y del barrido del 16-ago).
 * Sin SKU conocido va "", igual que las líneas de servicio de la interfaz.
 */
const SKU_BOOKS = {
  "304": "PER-BIO-SF2A-ZKT-LW-HTF", // [PER] Reloj Gama Estándar FACIAL LAN WIFI
  "218.1": "COL-BIO-SENSEFACE2A-ZKT-WL-HFT", // [COL] EQUIPO FACIAL SENSEFACE 2A WIFI
  "123.1": "MEX-BIO-SENSEFACE2A-ZKT-L-RHT.", // [MEX] Senseface 2A (el punto final es parte del SKU en Books)
  "006.10": "CHL-BIO-SF2A-ZKT-WL-FHT", // Reloj Gama Entrada Facial WIFI/LAN (Senseface 2A)
  "006.11": "CHL-BIO-SF4A-ZKT-WL-FHT", // Reloj Gama Media Facial WIFI/LAN (Senseface 4A)
  "012": "CHL-BIO-U4500-HID-USB-HI", // Huellero URU4500
  "006.9": "CHL-BIO-SF3A-ZKT-WL-FHT", // Senseface 3A (kit QR)
  "013": "CHL-ACC-SLKT-SWO-SER", // Impresora Termica (Fiscal)
  "026.1": "CHL-ACC-IDCTN-ZKT", // Tarjeta ID (delgada)
  "907": "CHL-SSTT-ENV-ASCOM", // Envío/Despacho Asistencia
  "901": "CHL-SSTT-INST-ASCOM-RMET", // Instalación RM
  "390": "PER-SSTT-INST-ASCOM-LIM",
  "391": "PER-SSTT-INST-ASCOM-PRO",
  "396": "PER-SSTT-ENV-ASCOM-LIM",
  "397": "PER-SSTT-ENV-ASCOM-PRO",
  "290.1": "COL-SS-INST-ASCOM-BGT",
  "290.2-": "COL-SS-INST-ASCOM-REG",
  "290.2": "COL-SS-INST-ASCOM-REG",
  "294.1": "COL-SS-ENV-ASCOM-BGT",
  "294.2": "COL-SS-ENV-ASCOM-REG",
  "190": "MEX-SSTT-ENV-ASCOM-EST",
  "191": "MEX-SSTT-ENV-ASCOM-CDMX",
  "192": "MEX-SSTT-INST-ASCOM-RPMX",
};

/** @returns {string} SKU de Books del artículo, o "" si no está mapeado */
function skuDeArticulo(articulo) {
  const codigo = String(articulo || "").trim().split(" ")[0];
  return SKU_BOOKS[codigo] || "";
}

/**
 * Bodega de las líneas chilenas. Las 142 líneas del barrido usan esta y solo
 * esta, así que es una constante y no algo a resolver por artículo.
 */
const BODEGA_CHILE = { id: "1758661000005909009", nombre: "GeoVictoria Chile" };

/**
 * Bodega de las líneas peruanas ([PER]). No aparece en los bloques de las
 * notas hechas a mano (Bodega=null), así que solo se manda si alguien la
 * configura por env; sin env el pedido va SIN bodega y Books usa su default.
 */
const BODEGA_PERU = {
  id: String(process.env.CREATOR_BODEGA_PE_ID || "").trim(),
  nombre: String(process.env.CREATOR_BODEGA_PE_NOMBRE || "GeoVictoria Perú").trim(),
};

/** Bodega según el artículo: los [PER] van a la peruana; [COL] y [MEX] sin
 * bodega (Books usa su default, como las notas humanas de esos países); el
 * resto a Chile. */
function bodegaDeArticulo(articulo) {
  const a = String(articulo || "");
  if (/\[PER\]/i.test(a)) return BODEGA_PERU;
  if (/\[(COL|MEX)\]/i.test(a)) return { id: "", nombre: "" };
  return BODEGA_CHILE;
}

/**
 * @param {string} articulo valor de picklist ("907 - [CHI] Envío/Despacho…")
 * @returns {string} id del ítem en Books, o "" si no está mapeado
 */
function idBooksDeArticulo(articulo) {
  const codigo = String(articulo || "").trim().split(" ")[0];
  return ITEM_ID_BOOKS[codigo] || "";
}

/**
 * Precio de lista de venta a partir del código o del valor de picklist. Se usa
 * para llenar `Valor` en las filas de ARRIENDO, donde nuestra cotización solo
 * conoce la mensualidad. Sin esto la línea llega a Books con `rate: null`.
 * @returns {number} 0 si no está mapeado
 */
function valorListaDeArticulo(articulo) {
  const codigo = String(articulo || "").trim().split(" ")[0];
  const hw = Object.values(HARDWARE_A_ARTICULO).find(
    (x) => String(x.item || "").split(" ")[0] === codigo
  );
  return Number(hw?.valorListaUF) || 0;
}

module.exports = {
  HARDWARE_A_ARTICULO,
  SERVICIO_A_ARTICULO,
  SERVICIO_A_ARTICULO_PAIS,
  ITEM_ID_BOOKS,
  BODEGA_CHILE,
  BODEGA_PERU,
  bodegaDeArticulo,
  articuloDeHardware,
  esCodigoHardware,
  paisDeMonedaNota,
  articuloDeServicio,
  idBooksDeArticulo,
  valorListaDeArticulo,
  skuDeArticulo,
  SKU_BOOKS,
};
