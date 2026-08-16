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
  },
  // Lector de huella USB, la alternativa económica al reloj de pared. Está
  // habilitado para Vicky (`disponibleParaVicky: true` en el catálogo, venta 3
  // UF y arriendo 0,25) y NO estaba acá: una venta con huellero perdía su línea
  // en Creator y no llegaba a la orden de venta. Verificado en Books el 16-ago:
  // "012 - Huellero URU4500", SKU CHL-BIO-U4500-HID-USB-HI, rate 3, IVA 19%.
  uru4500: {
    item: "012 - Huellero URU4500",
    modelo: "URU4500",
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

/** @returns {{item: string, modelo: string} | null} */
function articuloDeHardware(codigoItem) {
  const codigo = String(codigoItem || "").trim().toLowerCase();
  return HARDWARE_A_ARTICULO[codigo] || null;
}

/**
 * @param {string} codigoItem  Codigo_Item de la línea
 * @param {string} [zona]      "RM" | "regiones", solo para instalación
 * @returns {string} valor de picklist, o "" si no hay correspondencia
 */
function articuloDeServicio(codigoItem, zona) {
  const codigo = String(codigoItem || "").trim().toLowerCase();
  const entrada = SERVICIO_A_ARTICULO[codigo];
  if (!entrada) return "";
  if (typeof entrada === "string") return entrada;

  const z = String(zona || "").trim().toLowerCase();
  if (z === "rm") return entrada.RM;
  if (z === "regiones" || z === "region") return entrada.regiones;
  // Instalación sin zona: se asume regiones, que es la tarifa mayor. Preferimos
  // errar cobrando de más y que el ejecutivo lo baje, antes que subcotizar.
  console.warn(
    `[creator-articulos] Instalación sin Zona_Tarifa (codigo=${codigo}); se usa el artículo de regiones.`
  );
  return entrada.regiones;
}

module.exports = { HARDWARE_A_ARTICULO, SERVICIO_A_ARTICULO, articuloDeHardware, articuloDeServicio };
