/**
 * El plan de arreglo EN SITIO del espejo (Lalo 11-sep: "por qué en vez de
 * anular no actualiza? está generando muchos correlativos").
 *
 * Casos calculados a mano contra registros reales de Creator:
 *  - TESLA NDV-31596: el espejo dice 17 usuarios y la venta quedó en 14.
 *  - DE LA CUENCA / R&H (10-sep): ventas solo-app cuyo espejo se regeneró por
 *    FECHA aunque el contenido calzaba — ahí el plan debe decir "ok".
 */
const test = require("node:test");
const assert = require("node:assert");
const { planEnSitio, tablasIguales, normalizarTabla } = require("../api/_shared/ndv-espejo-sitio");

const TABLA = [
  { From: 1, To: 2, Rate: 0.25, AdditionalUserRate: 0, Modality: "Rango Fijo" },
  { From: 3, To: 10, Rate: 0.55, AdditionalUserRate: 0, Modality: "Rango Fijo" },
];
const servicio = (over = {}) => ({
  ID: "9001",
  Servicio_Recurrente: "Control de Asistencia",
  Cantidad_de_Usuarios: 5,
  N_Empleados_Compometidos: 5,
  Descuento_Ejecutivo: 0,
  Tabla_de_Cobro: TABLA,
  ...over,
});
const deseado = (over = {}) => ({
  empleados: 5,
  descuentoPct: 0,
  tablasPorServicio: { "Control de Asistencia": TABLA },
  hayHardware: false,
  ...over,
});

test("contenido igual → no se regenera ni se parchea (caso DE LA CUENCA / R&H)", () => {
  const p = planEnSitio({ serviciosEspejo: [servicio()], bloquesEspejo: [], deseado: deseado() });
  assert.equal(p.modo, "ok");
  assert.equal(p.acciones.length, 0);
});

test("solo cambió la dotación → PATCH en sitio de los tres campos (caso TESLA 17→14)", () => {
  const p = planEnSitio({
    serviciosEspejo: [servicio({ Cantidad_de_Usuarios: 17, N_Empleados_Compometidos: 17 })],
    bloquesEspejo: [],
    deseado: deseado({ empleados: 14 }),
  });
  assert.equal(p.modo, "en_sitio");
  assert.equal(p.acciones.length, 1);
  assert.equal(p.acciones[0].tipo, "patch_servicio");
  assert.equal(p.acciones[0].data.Cantidad_de_Usuarios, 14);
  assert.equal(p.acciones[0].data.N_Empleados_Compometidos, 14);
  assert.equal(p.acciones[0].data.Cantidad_de_Usuarios_PDF, 14);
});

test("cambió el descuento → PATCH del pct, sin tocar la tabla", () => {
  const p = planEnSitio({ serviciosEspejo: [servicio()], bloquesEspejo: [], deseado: deseado({ descuentoPct: 20 }) });
  assert.equal(p.modo, "en_sitio");
  assert.equal(p.acciones[0].data.Descuento_Ejecutivo, 20);
  assert.ok(!("Tabla_de_Cobro" in p.acciones[0].data));
});

test("bloque de hardware sobrante → se NEUTRALIZA, no se borra", () => {
  const p = planEnSitio({
    serviciosEspejo: [servicio()],
    bloquesEspejo: [{ ID: "7001", Servicio_Producto: "Arriendo de Equipos", Monto: 0.35, MontoHW: 0.35, CAN_CREATE_PDF: true, Moneda: "UF" }],
    deseado: deseado({ hayHardware: false }),
  });
  assert.equal(p.modo, "en_sitio");
  const a = p.acciones.find((x) => x.tipo === "neutralizar_bloque");
  assert.ok(a);
  assert.equal(a.data.Monto, 0);
  assert.equal(a.data.MontoHW, 0);
  assert.equal(a.data.CAN_CREATE_PDF, false);
  assert.deepEqual(JSON.parse(a.data.JsonPdf).GlossRow, []);
});

test("bloque ya neutralizado → no se vuelve a parchear", () => {
  const p = planEnSitio({
    serviciosEspejo: [servicio()],
    bloquesEspejo: [{ ID: "7001", Servicio_Producto: "Arriendo de Equipos", Monto: 0, MontoHW: 0, CAN_CREATE_PDF: false }],
    deseado: deseado({ hayHardware: false }),
  });
  assert.equal(p.modo, "ok");
});

test("la venta lleva equipos y el espejo no tiene bloque → regenerar", () => {
  const p = planEnSitio({ serviciosEspejo: [servicio()], bloquesEspejo: [], deseado: deseado({ hayHardware: true }) });
  assert.equal(p.modo, "regenerar");
  assert.match(p.motivos.join(" "), /no tiene bloque de hardware/);
});

test("falta un servicio en el espejo → regenerar (crear un hijo no se hace en sitio)", () => {
  const p = planEnSitio({
    serviciosEspejo: [servicio()],
    bloquesEspejo: [],
    deseado: deseado({ tablasPorServicio: { "Control de Asistencia": TABLA, Alertas: TABLA } }),
  });
  assert.equal(p.modo, "regenerar");
  assert.match(p.motivos.join(" "), /falta el servicio "Alertas"/);
});

test("el espejo tiene un servicio que la venta ya no lleva → regenerar", () => {
  const p = planEnSitio({
    serviciosEspejo: [servicio(), servicio({ ID: "9002", Servicio_Recurrente: "Alertas" })],
    bloquesEspejo: [],
    deseado: deseado(),
  });
  assert.equal(p.modo, "regenerar");
  assert.match(p.motivos.join(" "), /que la venta ya no lleva/);
});

test("la tabla se compara por contenido, no por orden ni formato", () => {
  assert.ok(tablasIguales(TABLA, [TABLA[1], TABLA[0]]));
  assert.ok(tablasIguales(TABLA, [{ from: 1, to: 2, rate: "0.25", modalidad: "Rango Fijo" }, TABLA[1]]));
  assert.ok(!tablasIguales(TABLA, [TABLA[0], { ...TABLA[1], Rate: 0.6 }]));
  assert.equal(normalizarTabla(null).length, 0);
});

test("sin hijos legibles el plan no inventa nada", () => {
  const p = planEnSitio({ serviciosEspejo: [], bloquesEspejo: [], deseado: deseado() });
  assert.equal(p.modo, "regenerar");
});
