/**
 * Tabla de cobro de asistencia en UF: la forma que finanzas acepta (Lalo 24-sep).
 * Casos reales de la noche del 23-sep (Nailliw anuló 18 notas por el adicional vacío):
 *  - A&J 7 usuarios (NDV-31709): una fila 1..10 · 0,55 · adicional 0,055
 *  - Guzmán 2 usuarios (NDV-31787): 1..2 · 0,25 · 0,30 + 3..10 · 0,55 · 0,055
 *  - Eq cells 17 usuarios (NDV-32204): una fila por usuario 1..17 · 0,055 · 0,055
 *  - Raylú (NDV-31868): la dotación llegó mal (1) y el "hasta" salía 1 → ahora manda el precio
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChargeTables, filasAsistenciaVicky } = require("../api/_shared/ndv-charge-table");
const { PRICING_TIERS } = require("../api/_shared/proposal-constants");

const config = { quoteItemsSubformField: "Detalle_Items_Cotizacion" };
const fija = (uf) => ({
  Detalle_Items_Cotizacion: [
    { Nombre_Item: "Control de Asistencia", Codigo_Item: "asistencia", Cantidad: 1, Precio_Unitario_UF: uf, Precio_Unitario_CLP: uf * 40000, Subtotal_UF: uf, Subtotal_CLP: uf * 40000, Modalidad: "Único", Es_Recurrente: true },
  ],
});
const porUsuario = (n, uf) => ({
  Detalle_Items_Cotizacion: [
    { Nombre_Item: "Control de Asistencia", Codigo_Item: "asistencia", Cantidad: n, Precio_Unitario_UF: uf, Precio_Unitario_CLP: uf * 40000, Subtotal_UF: uf * n, Subtotal_CLP: uf * n * 40000, Modalidad: "Por usuario", Es_Recurrente: true },
  ],
});
const tabla = (quote, empleados) =>
  buildChargeTables({
    quote, config, committedEmployees: empleados, moneda: "UF", servicioPrincipal: "Control de Asistencia",
    resolveServicios: () => ["Control de Asistencia"],
  }).porServicio["Control de Asistencia"];

test("tramo fijo 3-10 (A&J, 7 usuarios): una fila 1..10 a 0,55 con adicional 0,055", () => {
  const t = tabla(fija(0.55), 7);
  assert.deepEqual(t, [{ Modalidad: "Rango Fijo", Desde: 1, Hasta: 10, Valor: 0.55, Valor_Usuario_Adicional: 0.055 }]);
});

test("tramo fijo 1-2 (Guzmán, 2 usuarios): dos filas, 1..2 con adicional 0,30 y 3..10 con 0,055", () => {
  const t = tabla(fija(0.25), 2);
  assert.deepEqual(t, [
    { Modalidad: "Rango Fijo", Desde: 1, Hasta: 2, Valor: 0.25, Valor_Usuario_Adicional: 0.3 },
    { Modalidad: "Rango Fijo", Desde: 3, Hasta: 10, Valor: 0.55, Valor_Usuario_Adicional: 0.055 },
  ]);
});

test("por usuario (Eq cells, 17 usuarios): una fila 1..17 con el unitario como valor y adicional", () => {
  const t = tabla(porUsuario(17, 0.055), 17);
  assert.deepEqual(t, [{ Modalidad: "Rango por Usuario", Desde: 1, Hasta: 17, Valor: 0.055, Valor_Usuario_Adicional: 0.055 }]);
});

test("dotación ausente o mal (Raylú): el PRECIO identifica el tramo y el hasta es el tope, nunca 1", () => {
  const t = tabla(fija(0.55), 1);
  assert.equal(t.length, 1);
  assert.equal(t[0].Hasta, 10);
  assert.equal(t[0].Valor_Usuario_Adicional, 0.055);
});

test("con escalera en memoria del agente el resultado es el mismo (no vuelven los 13 tramos)", () => {
  const r = buildChargeTables({
    quote: fija(0.55), config, committedEmployees: 7, moneda: "UF", servicioPrincipal: "Control de Asistencia",
    resolveServicios: () => ["Control de Asistencia"],
    escalerasEnMemoria: {
      asistencia: PRICING_TIERS.slice(0, 5).map((t) => ({ desde: t.min, hasta: t.max, modalidad: t.type, precioUF: t.uf })),
    },
  });
  assert.deepEqual(r.porServicio["Control de Asistencia"], [
    { Modalidad: "Rango Fijo", Desde: 1, Hasta: 10, Valor: 0.55, Valor_Usuario_Adicional: 0.055 },
  ]);
});

test("ninguna fila queda con adicional en cero", () => {
  for (const [q, n] of [[fija(0.25), 1], [fija(0.55), 9], [porUsuario(12, 0.055), 12], [porUsuario(20, 0.055), 20]]) {
    for (const fila of tabla(q, n)) assert.ok(fila.Valor_Usuario_Adicional > 0, JSON.stringify(fila));
  }
});

test("filasAsistenciaVicky: el factor de descuento incorporado aplica al valor y al adicional", () => {
  const t = filasAsistenciaVicky({ tiers: PRICING_TIERS, empleados: 7, porUsuario: false, unitarioLista: 0.55, precioListaFijo: 0.55, factor: 0.9 });
  assert.equal(t[0].Valor, 0.495);
  assert.equal(t[0].Valor_Usuario_Adicional, 0.0495);
});
