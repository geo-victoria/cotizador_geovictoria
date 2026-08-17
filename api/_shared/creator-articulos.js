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
 * Vicky tiene habilitados DOS equipos (`disponibleParaVicky` en
 * lib/catalogo/hardware.ts del agente): el Senseface 2A y el huellero URU4500.
 * Los otros 14 del catálogo existen pero no son vendibles por ella.
 *
 * Si algún día se habilita otro, agregar su código acá — sin eso la línea queda
 * fuera del PDF y de la orden de venta, y solo se avisa por log.
 */
const HARDWARE_A_ARTICULO = {
  senseface_2a: {
    item: "006.10 - Reloj Gama Entrada Facial WIFI/LAN",
    modelo: "Senseface 2A",
    // Precio de LISTA de venta. La grilla lo lleva en `Valor` incluso cuando la
    // línea es de arriendo (ahí `Valor_Mensual` lleva la mensualidad), y de ahí
    // sale el `rate` de la orden de venta. Verificado en 59 bloques de arriendo
    // de agosto: los 8 revisados traen Valor=5.000 sin excepción.
    valorListaUF: 5,
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
};

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

/** @returns {{item: string, modelo: string} | null} */
function articuloDeHardware(codigoItem) {
  return HARDWARE_A_ARTICULO[normalizarCodigo(codigoItem)] || null;
}

/**
 * @param {string} codigoItem  Codigo_Item de la línea
 * @param {string} [zona]      "RM" | "regiones", solo para instalación
 * @returns {string} valor de picklist, o "" si no hay correspondencia
 */
function articuloDeServicio(codigoItem, zona) {
  const crudo = String(codigoItem || "").trim().toLowerCase();
  const codigo = normalizarCodigo(crudo);
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
  "006.10": "1758661000072468396", // Reloj Gama Entrada Facial WIFI/LAN
  "012": "1758661000001524374", // Huellero URU4500
  "907": "1758661000044939114", // Envío/Despacho Asistencia
  "901": "1758661000038441163", // Instalación RM
  "902": "1758661000038441184", // Instalación Regiones
  "903": "1758661000038441207", // Instalación Regiones extremas
  "904": "1758661000038441224", // Visita Técnica RM
  "905": "1758661000038441241", // Visita Técnica Regiones
  "909": "1758661000051361009", // Mantención equipo asistencia en Laboratorio
  "911": "1758661000053903234", // Visita Técnica Levantamiento
};

/**
 * Bodega de las líneas chilenas. Las 142 líneas del barrido usan esta y solo
 * esta, así que es una constante y no algo a resolver por artículo.
 */
const BODEGA_CHILE = { id: "1758661000005909009", nombre: "GeoVictoria Chile" };

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
  ITEM_ID_BOOKS,
  BODEGA_CHILE,
  articuloDeHardware,
  articuloDeServicio,
  idBooksDeArticulo,
  valorListaDeArticulo,
};
