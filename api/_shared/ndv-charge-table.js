/**
 * Tabla_de_Cobro para Zoho Creator, construida desde los ítems que Vicky cotizó.
 *
 * POR QUÉ EXISTE ESTE MÓDULO
 * La Tabla_de_Cobro es lo que Creator lee para armar el JsonPdf (workflow
 * UpdatePdfJson1) y, con eso, el PDF de la cotización. Antes se derivaba de UNA
 * sola línea del subform y en pesos, mientras el registro declaraba Moneda=UF:
 * el PDF salía con un único ítem y con el valor inflado ~39.000x. Acá se arma
 * desde TODAS las líneas, en la moneda del registro y con los descuentos
 * negociados ya aplicados — los mismos números que el cliente vio en el chat y
 * en la página de aceptación.
 *
 * SEMÁNTICA DE LA TABLA (receta verificada en COT-56717, ver api/creator-ndv-test.js)
 * Cada fila es un TRAMO de precio de UN servicio:
 *   { Modalidad, Desde, Hasta, Valor, Valor_Usuario_Adicional }
 *   · "Rango por Usuario" → Valor es el precio POR USUARIO dentro del tramo.
 *   · "Rango Fijo"        → Valor es el monto FIJO del tramo.
 * Una cotización de Vicky tiene una dotación concreta (N usuarios), así que la
 * escalera de cada servicio colapsa a un solo tramo 1..N.
 *
 * DESCUENTOS
 * Se replica línea por línea la MISMA regla que cobra Mercado Pago y que muestra
 * la página de aceptación (`computePaymentAmounts` en quote-pricing.js):
 *   · el descuento recurrente aplica al plan de software, NO al arriendo de hardware;
 *   · los descuentos de instalación aplican solo a las líneas de instalación de su zona.
 * El descuento se DELEGA a Creator cuando todas las líneas de un servicio
 * comparten el mismo %: la Tabla_de_Cobro va a precio de LISTA y el % viaja en
 * `Descuento_Ejecutivo`, que es como lo declaran las notas de venta reales
 * (Creator agrega solo las columnas `Dcto` y `Valor_Ad_con_Dcto`, sin tocar
 * `Valor`). Solo si en un mismo servicio conviven dos porcentajes distintos el
 * descuento se incorpora al precio y el campo va en 0 — un PDF sin la línea de
 * descuento es preferible a uno que cobre mal.
 */

const {
  DEFAULT_FIELD_MAP,
  sanitizeItems,
  clampDescuentoPct,
  clampInstalacionPct,
  isRecurrentModalidad,
  isInstalacionItem,
  getZonaTarifa,
} = require("./quote-pricing");
const { PRICING_TIERS, MESES_DESCUENTO_PLAN, mesesDescuentoNormalizados } = require("./proposal-constants");
const { articuloDeHardware, articuloDeServicio } = require("./creator-articulos");

/** Servicios de Creator cuyo registro va al Formulario_de_Equipos, no a un Servicio_Recurrente. */
const SERVICIOS_ARRIENDO_HARDWARE = new Set([
  "Arriendo de Equipos",
  "Arriendo de Equipos Asistencia",
  "Arriendo de Chip de Datos",
]);

// Creator no acepta un tramo abierto: el último de una tabla bien formada llega
// hasta 9999 (ver las notas de venta de referencia).
const TOPE_ULTIMO_TRAMO = 9999;

const MODALIDAD_POR_USUARIO = "Rango por Usuario";
const MODALIDAD_FIJA = "Rango Fijo";

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toPositiveInt(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Creator guarda montos con decimales (UF llega a 3-4); 5 posiciones cubren UF
// sin arrastrar ruido de punto flotante, y no molestan en CLP/COP/MXN.
function redondear(value) {
  return Number(toNumber(value).toFixed(5));
}

function normalizar(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Descuentos vigentes de la cotización, saneados con los mismos clamps que usa
 * el cobro. Si el registro no los trae, todo queda en 0 (precio de lista).
 */
/**
 * Meses de vigencia del descuento del plan. El dato canónico vive en el campo
 * del CRM cuando está configurado (QUOTE_DISCOUNT_MESES_FIELD); si no, rige la
 * política por defecto.
 */
function mesesVigencia(quote, config) {
  const campo = String(config?.quoteDiscountMesesField || process.env.QUOTE_DISCOUNT_MESES_FIELD || "").trim();
  const crudo = campo ? quote?.[campo] : null;
  return mesesDescuentoNormalizados(crudo);
}

function resolverDescuentos(quote, config) {
  return {
    recurrentePct: clampDescuentoPct(quote?.[config.quoteDiscountPctField]),
    instalacionRMPct: clampInstalacionPct(quote?.[config.quoteDiscountInstRMPctField]),
    instalacionRegionPct: clampInstalacionPct(quote?.[config.quoteDiscountInstRegionPctField]),
  };
}

/**
 * Descuento, en %, que corresponde a una línea. Espejo de computePaymentAmounts:
 * el de instalación va por zona, y el recurrente NO toca el arriendo de hardware
 * (regla comercial: el descuento negociado es del plan de software).
 */
function descuentoPctLinea(row, descuentos) {
  if (isInstalacionItem(row)) {
    const zona = getZonaTarifa(row);
    if (zona === "RM") return descuentos.instalacionRMPct;
    if (zona === "regiones") return descuentos.instalacionRegionPct;
    return 0;
  }

  if (isRecurrentModalidad(row?.modalidad)) {
    const esArriendoHardware = normalizar(row?.modalidad).includes("arriendo");
    return esArriendoHardware ? 0 : descuentos.recurrentePct;
  }

  return 0;
}

/** El mismo descuento expresado como factor multiplicativo. */
function factorDescuentoLinea(row, descuentos) {
  return 1 - descuentoPctLinea(row, descuentos) / 100;
}

/**
 * Montos de la línea en la moneda en que está denominada la cotización.
 *
 * Chile guarda UF en los campos *_UF y su equivalente en pesos en los *_CLP.
 * CO y MX escriben el MISMO monto local (COP / MXN) en ambos pares (ver la
 * cabecera de create-from-vicky-co.js). Por eso los campos *_UF son, en los
 * tres países, "el monto en la moneda de la cotización", y son el default.
 * La rama *_CLP queda para un registro que declare explícitamente otra moneda.
 */
function montosLinea(row, usaUf) {
  const unitario = usaUf ? toNumber(row?.precioUnitarioUf) : toNumber(row?.precioUnitarioClp);
  const subtotalDirecto = usaUf ? toNumber(row?.subtotalUf) : toNumber(row?.subtotalClp);
  const cantidad = toNumber(row?.cantidad);
  const subtotal = subtotalDirecto > 0 ? subtotalDirecto : unitario * cantidad;
  return { unitario, subtotal };
}

/**
 * Escalera de precios que el agente usó al cotizar, guardada como JSON en la
 * cotización ({ codigoItem: [{desde,hasta,modalidad,precioUF}] }). Si el campo
 * no está configurado o el JSON viene corrupto, se devuelve vacío y la tabla
 * cae al tramo único (montos correctos, PDF más pobre).
 */
function leerEscaleras(quote, config) {
  const campo = config?.quotePriceLadderField;
  if (!campo) return {};
  const crudo = quote?.[campo];
  if (!crudo) return {};
  if (typeof crudo === "object") return crudo;
  try {
    const parsed = JSON.parse(String(crudo));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    console.warn(`[ndv-charge-table] Escalera de precios ilegible en ${campo}; se usa el tramo único.`);
    return {};
  }
}

/**
 * Completa la escalera con los tramos por encima del alcance de Vicky.
 *
 * Vicky vende 1-50 y su catálogo cubre solo eso, pero una tabla de cobro bien
 * formada muestra la escalera ENTERA (las notas de venta de referencia llegan a
 * 9999). Los tramos de arriba salen de PRICING_TIERS, la escalera oficial del
 * cotizador. Esto NO cambia lo que Vicky vende: es solo lo que se imprime.
 *
 * PRICING_TIERS es la escalera de ASISTENCIA. Para los demás módulos se extiende
 * únicamente si su escalera es un múltiplo exacto de aquella en TODOS los tramos
 * compartidos — que es la regla de negocio vigente (vacaciones = asistencia ×
 * 0,30, ver lib/catalogo/modulos.ts del agente). Si la relación no es constante,
 * no se inventa nada y la tabla se queda donde llega el catálogo.
 */
function completarEscaleraSobreTope(escalera) {
  const oficiales = Array.isArray(PRICING_TIERS) ? PRICING_TIERS : [];
  if (escalera.length === 0 || oficiales.length === 0) return escalera;

  const tope = escalera.reduce((acc, t) => Math.max(acc, toPositiveInt(t?.hasta)), 0);
  if (tope <= 0) return escalera;

  // Razón contra la escalera oficial en los tramos que comparten rango.
  //
  // Orden de Lalo (15-ago): la tabla de precios SIEMPRE va completa hasta el
  // último tramo, aunque Vicky no venda sobre 20 ni sobre 50 — los tramos que
  // falten se completan con los de la calculadora. Antes, si un módulo no era
  // múltiplo exacto de la escalera oficial en todos sus tramos, la tabla se
  // cortaba en el tope del catálogo de Vicky y la nota salía con la escalera
  // trunca.
  const razones = [];
  for (const tramo of escalera) {
    const oficial = oficiales.find(
      (o) => toPositiveInt(o?.min) === toPositiveInt(tramo?.desde) && Number(o?.max) === Number(tramo?.hasta)
    );
    const precioOficial = toNumber(oficial?.uf);
    const precio = toNumber(tramo?.precioUF);
    if (precioOficial > 0 && precio > 0) razones.push(precio / precioOficial);
  }
  // Se usa la razón del ÚLTIMO tramo con correspondencia: es el que colinda con
  // la continuación, así que el precio no da un salto en la frontera. Sin
  // ninguna correspondencia se toma la escalera oficial tal cual (razón 1).
  const razon = razones.length > 0 ? razones[razones.length - 1] : 1;
  const constante = razones.every((r) => Math.abs(r - razon) < 1e-9);
  if (!constante) {
    console.warn(
      `[ndv-charge-table] La escalera no es múltiplo constante de la oficial; ` +
        `se extiende con la razón del último tramo conocido (${razon.toFixed(4)}).`
    );
  }

  const continuacion = oficiales
    .filter((o) => toPositiveInt(o?.min) > tope && toNumber(o?.uf) > 0)
    .map((o) => ({
      desde: toPositiveInt(o.min),
      // El tramo abierto (max: Infinity) se cierra en 9999, como en las NDV reales.
      hasta: Number.isFinite(Number(o.max)) ? toPositiveInt(o.max) : TOPE_ULTIMO_TRAMO,
      modalidad: normalizar(o.type) === "fijo" ? "fijo" : "por_usuario",
      precioUF: toNumber(o.uf) * razon,
    }));

  return [...escalera, ...continuacion];
}

/**
 * Convierte la escalera del catálogo en filas de Tabla_de_Cobro de Creator,
 * con el descuento aplicado a cada tramo.
 *
 * Los tramos "fijo" son un monto mensual total del tramo; los "por_usuario",
 * un precio unitario. Es la misma distinción que Creator hace entre
 * "Rango Fijo" y "Rango por Usuario".
 */
function escaleraAFilas(escalera, factorDescuento) {
  const completa = completarEscaleraSobreTope(escalera);
  const ultimoDesde = completa.reduce((acc, t) => Math.max(acc, toPositiveInt(t?.desde)), 0);
  return completa
    .map((tramo) => {
      const desde = toPositiveInt(tramo?.desde);
      const hasta = toPositiveInt(tramo?.hasta);
      const precio = toNumber(tramo?.precioUF) * factorDescuento;
      if (desde <= 0 || hasta <= 0 || precio <= 0) return null;
      return {
        Modalidad: normalizar(tramo?.modalidad) === "fijo" ? MODALIDAD_FIJA : MODALIDAD_POR_USUARIO,
        Desde: desde,
        Hasta: hasta,
        Valor: redondear(precio),
        // El último tramo repite el valor como precio del usuario adicional: es
        // el que rige de ahí en adelante, y así lo imprimen las NDV de referencia.
        Valor_Usuario_Adicional: desde === ultimoDesde ? redondear(precio) : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.Desde - b.Desde);
}

/**
 * ¿La línea se cobra por usuario? El subform ya trae la modalidad mapeada a Zoho
 * ("Recurrente" = por usuario, "Único" = tarifa fija mensual, "Arriendo", "Venta").
 * Se exige además que la cantidad coincida con la dotación comprometida: si no,
 * un precio unitario en un tramo 1..N daría un total distinto al cotizado, y
 * preferimos un tramo fijo que respete el monto que el cliente vio.
 */
function esLineaPorUsuario(row, cantidad, empleados) {
  return normalizar(row?.modalidad) === "recurrente" && cantidad === empleados;
}

/**
 * Arma las tablas de cobro de la cotización.
 *
 * @param {object}   args.quote               registro de la cotización en el CRM
 * @param {object}   args.config              config de aceptación (nombres de campo)
 * @param {number}   args.committedEmployees  dotación comprometida (N usuarios)
 * @param {string}   args.moneda              Moneda del registro NDV ("UF", "COP", "MXN"…)
 * @param {string}   args.servicioPrincipal   servicio Creator que encabeza la NDV
 * @param {(row:object) => string[]} args.resolveServicios
 *        Devuelve los servicios recurrentes de Creator a los que mapea una fila
 *        cruda del subform. Lo inyecta ndv-handoff para no duplicar el diccionario.
 *
 * @returns {{ master: object[], porServicio: Record<string, object[]>,
 *             diagnostico: { fallback: boolean, moneda: string, empleados: number,
 *                            lineasSinServicio: string[], lineasSinPrecio: string[] } }}
 */
function buildChargeTables({
  quote,
  config,
  committedEmployees,
  moneda,
  servicioPrincipal,
  resolveServicios,
  escalerasEnMemoria,
}) {
  const rawRows = Array.isArray(quote?.[config.quoteItemsSubformField])
    ? quote[config.quoteItemsSubformField]
    : [];
  // El nombre del campo de zona es configurable por env; sin esto, un override
  // dejaría los descuentos de instalación sin aplicar en silencio.
  const fieldMap = config?.quoteItemZonaTarifaField
    ? { ...DEFAULT_FIELD_MAP, zonaTarifa: config.quoteItemZonaTarifaField }
    : DEFAULT_FIELD_MAP;
  const rows = sanitizeItems(rawRows, fieldMap);
  // La escalera en memoria manda: la emisión la tiene en el propio request y no
  // depende de que se haya persistido en el CRM.
  const escaleras =
    escalerasEnMemoria && Object.keys(escalerasEnMemoria).length > 0
      ? escalerasEnMemoria
      : leerEscaleras(quote, config);
  const usaUf = normalizar(moneda) === "uf" || !moneda;
  const descuentos = resolverDescuentos(quote, config);

  const cantidadMaxima = rows.reduce((acc, row) => Math.max(acc, toPositiveInt(row?.cantidad)), 0);
  const empleados = Math.max(toPositiveInt(committedEmployees), cantidadMaxima, 1);

  // Acumulador por servicio: varias líneas pueden caer en el mismo servicio de
  // Creator (p. ej. dos módulos que mapean a Control de Asistencia).
  const acumulado = new Map();
  const lineasSinServicio = [];
  const lineasSinPrecio = [];
  // Destinadas al Formulario_de_Equipos: la venta de equipos a su grilla de
  // Items y la instalación/envío a la de Servicios Asociados.
  const lineasEquipos = [];
  const lineasServicios = [];
  const lineasSinArticulo = [];
  // Arriendo de hardware. Va aparte porque en Creator el arriendo es
  // RECURRENTE pero su registro vive en el Formulario_de_Equipos, no en un
  // Servicio_Recurrente: `data.getAllEquipmentServices()` lista
  // "Arriendo de Equipos" entre el hardware, así que cada recorrido del pedido
  // busca su id en HARDWARE_ALL_DATA. Emitiéndolo como servicio recurrente el
  // id quedaba en SERVICES_ALL_DATA, la búsqueda no encontraba nada y
  // reventaban tanto `RegeneratePdfJson` (la nota se quedaba sin PDF) como
  // `CalculateNDVTotalAmounts` (sin totales). Referencia verificada:
  // NDV-30721 / EVER CHILE, confirmada a mano, con SO-27629.
  const lineasArriendo = [];

  rows.forEach((row, index) => {
    const nombre = String(row?.nombre || "").trim();
    const cantidad = toPositiveInt(row?.cantidad);
    if (cantidad <= 0) return;

    const montos = montosLinea(row, usaUf);
    if (montos.subtotal <= 0) {
      if (nombre) lineasSinPrecio.push(nombre);
      return;
    }

    // Una fila puede mapear a más de un servicio; el cobro se imputa al PRIMERO
    // para no duplicar el monto en la tabla.
    const servicios = typeof resolveServicios === "function" ? resolveServicios(rawRows[index]) : [];
    const servicio = servicios.find(Boolean);
    if (!servicio) {
      // Venta de equipos, instalación y envío no son servicios recurrentes: van
      // al Formulario_de_Equipos, que es otro bloque de la NDV. Se clasifican
      // acá con su precio ya descontado para que ndv-subforms arme sus grillas.
      if (nombre) lineasSinServicio.push(nombre);
      const factor = factorDescuentoLinea(row, descuentos);
      const total = montos.subtotal * factor;
      const linea = {
        nombre,
        codigo: String(row?.codigo || "").trim(),
        zona: getZonaTarifa(row) || "",
        cantidad,
        valorUnitario: redondear(
          (montos.unitario > 0 ? montos.unitario : montos.subtotal / cantidad) * factor
        ),
        total: redondear(total),
        descuentoPct: descuentoPctLinea(row, descuentos),
      };
      const articulo = articuloDeHardware(linea.codigo);
      // `codigoCreator` es el prefijo del nombre del artículo ("006.10"), que es
      // lo único que Books reconoce al buscarlo. Nuestro id de catálogo
      // ("senseface_2a") no existe allá.
      const codigoDe = (nombre) => String(nombre || "").split(" - ")[0].trim();
      if (articulo) {
        lineasEquipos.push({
          ...linea,
          item: articulo.item,
          modelo: articulo.modelo,
          codigoCreator: codigoDe(articulo.item),
        });
      } else {
        const item = articuloDeServicio(linea.codigo, linea.zona);
        if (item) lineasServicios.push({ ...linea, item, codigoCreator: codigoDe(item) });
        else if (nombre) lineasSinArticulo.push(nombre);
      }
      return;
    }

    // Arriendo de equipos: su bloque es de EQUIPOS aunque el cobro sea mensual.
    // Solo se desvía cuando la línea resuelve a un artículo de hardware del
    // catálogo de Creator; si no resuelve, sigue el camino de antes y al menos
    // el cobro queda registrado en alguna parte.
    if (SERVICIOS_ARRIENDO_HARDWARE.has(servicio)) {
      const codigo = String(row?.codigo || "").trim();
      const articulo = articuloDeHardware(codigo);
      if (articulo) {
        const factor = factorDescuentoLinea(row, descuentos);
        const unitarioMensual = redondear(
          (montos.unitario > 0 ? montos.unitario : montos.subtotal / cantidad) * factor
        );
        lineasArriendo.push({
          nombre,
          codigo,
          cantidad,
          item: articulo.item,
          modelo: articulo.modelo,
          // Código con el que Creator busca el artículo en Books. NO es nuestro
          // id de catálogo ("senseface_2a"): es el prefijo del nombre del
          // artículo ("006.10"), que es lo único que Books reconoce.
          codigoCreator: String(articulo.item || "").split(" - ")[0].trim(),
          valorMensualUnitario: unitarioMensual,
          totalMensual: redondear(montos.subtotal * factor),
        });
        return;
      }
      console.warn(
        `[ndv-charge-table] arriendo "${nombre}" sin artículo de hardware en Creator; ` +
          `se emite como Servicio_Recurrente (la nota podría quedar sin PDF).`
      );
    }

    const previo = acumulado.get(servicio) || {
      subtotalLista: 0,
      unitarioLista: 0,
      todasPorUsuario: true,
      codigos: [],
      pcts: new Set(),
    };
    // Se acumulan los montos a PRECIO DE LISTA: el descuento viaja aparte, en
    // Descuento_Ejecutivo, para que Creator lo imprima como línea propia
    // ("Descuento 30%") y agregue las columnas "V. con Dcto" a la tabla.
    previo.subtotalLista += montos.subtotal;
    previo.unitarioLista += montos.unitario > 0 ? montos.unitario : montos.subtotal / cantidad;
    previo.todasPorUsuario = previo.todasPorUsuario && esLineaPorUsuario(row, cantidad, empleados);
    previo.codigos.push(String(row?.codigo || "").trim());
    previo.pcts.add(descuentoPctLinea(row, descuentos));
    acumulado.set(servicio, previo);
  });

  const porServicio = {};
  const descuentoPorServicio = {};
  const serviciosConEscalera = [];
  for (const [servicio, montos] of acumulado.entries()) {
    // Descuento del servicio. Creator lo aplica a toda la tabla, así que solo se
    // puede delegar cuando TODAS las líneas del servicio comparten el mismo %.
    // Si conviven dos (no debería pasar hoy), se incorpora al precio y el campo
    // va en 0: es preferible un PDF sin la línea de descuento a uno que cobre mal.
    const pcts = Array.from(montos.pcts);
    const descuentoDelegable = pcts.length === 1 ? pcts[0] : 0;
    const factorIncorporado = pcts.length === 1 ? 1 : Math.min(...pcts.map((p) => 1 - p / 100));
    descuentoPorServicio[servicio] = descuentoDelegable;

    // Escalera completa cuando el servicio viene de UN solo ítem del catálogo:
    // es el caso normal (asistencia → Control de Asistencia). Si dos ítems caen
    // en el mismo servicio no hay una escalera única que los represente, así que
    // se usa el tramo único, que al menos mantiene el monto correcto.
    const codigos = Array.from(new Set(montos.codigos.filter(Boolean)));
    const escalera = codigos.length === 1 ? escaleras[codigos[0]] : null;
    if (Array.isArray(escalera) && escalera.length > 0) {
      const filas = escaleraAFilas(escalera, factorIncorporado);
      if (filas.length > 0) {
        porServicio[servicio] = filas;
        serviciosConEscalera.push(servicio);
        continue;
      }
    }

    porServicio[servicio] = montos.todasPorUsuario
      ? [
          {
            Modalidad: MODALIDAD_POR_USUARIO,
            Desde: 1,
            Hasta: empleados,
            Valor: redondear(montos.unitarioLista * factorIncorporado),
            Valor_Usuario_Adicional: redondear(montos.unitarioLista * factorIncorporado),
          },
        ]
      : [
          {
            Modalidad: MODALIDAD_FIJA,
            Desde: 1,
            Hasta: empleados,
            Valor: redondear(montos.subtotalLista * factorIncorporado),
            Valor_Usuario_Adicional: 0,
          },
        ];
  }

  // Tabla del registro maestro: la del servicio que encabeza la NDV.
  const claveMaster = porServicio[servicioPrincipal]
    ? servicioPrincipal
    : Object.keys(porServicio)[0];
  let master = claveMaster ? porServicio[claveMaster] : [];
  let fallback = false;

  if (!master || master.length === 0) {
    // Sin ninguna línea con precio utilizable (caso típico: el widget del CRM,
    // que manda proposalData sin montos). Creator exige la tabla no vacía, así
    // que se manda un tramo mínimo y se deja rastro para no confundirlo con un
    // precio real.
    fallback = true;
    master = [
      {
        Modalidad: MODALIDAD_FIJA,
        Desde: 1,
        Hasta: empleados,
        Valor: 1,
        Valor_Usuario_Adicional: 0,
      },
    ];
    console.warn(
      `[ndv-charge-table] Sin líneas con precio: se envía tabla mínima (Valor=1). ` +
        `moneda=${moneda || "UF"} empleados=${empleados} filas=${rows.length}`
    );
  }

  if (lineasSinServicio.length > 0) {
    console.warn(
      `[ndv-charge-table] ${lineasSinServicio.length} línea(s) sin Servicio_Recurrente asociado, ` +
        `quedan fuera de la tabla de cobro: ${lineasSinServicio.join(", ")}`
    );
  }

  if (lineasSinArticulo.length > 0) {
    console.warn(
      `[ndv-charge-table] ${lineasSinArticulo.length} línea(s) sin artículo de Creator, quedan fuera del PDF: ` +
        lineasSinArticulo.join(", ")
    );
  }

  return {
    master,
    porServicio,
    descuentoPorServicio,
    lineasEquipos,
    lineasServicios,
    lineasArriendo,
    // Vigencia del descuento del plan, para el campo Cantidad_de_Meses_de_descuento
    // del Servicio_Recurrente. Sin campo configurado en el CRM manda la política
    // por defecto (6 meses), que es lo que ofrece Vicky.
    mesesDescuento: mesesVigencia(quote, config),
    diagnostico: {
      fallback,
      moneda: moneda || "UF",
      empleados,
      descuentos,
      serviciosConEscalera,
      lineasSinServicio,
      lineasSinPrecio,
      lineasSinArticulo,
    },
  };
}

module.exports = {
  MODALIDAD_POR_USUARIO,
  MODALIDAD_FIJA,
  buildChargeTables,
  descuentoPctLinea,
  factorDescuentoLinea,
  esLineaPorUsuario,
  resolverDescuentos,
};
