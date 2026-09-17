const test = require("node:test");
const assert = require("node:assert/strict");
const { monedaYPais, escalerasDefaultPorMoneda, ESCALERA_ASISTENCIA_PE } = require("../api/_shared/escaleras-pais");
const { buildChargeTables } = require("../api/_shared/ndv-charge-table");

test("monedaYPais: overrides mandan, luego el deal (Territorio / Monda_del_trato), default UF/Chile", () => {
  assert.deepEqual(monedaYPais({ overrides: { moneda: "PEN", pais: "Perú" } }), { moneda: "PEN", pais: "Perú", origen: "explicito" });
  assert.deepEqual(monedaYPais({ deal: { Territorio: "Perú", Monda_del_trato: "SOL" } }), { moneda: "PEN", pais: "Perú", origen: "deal" });
  assert.deepEqual(monedaYPais({ deal: { Territorio: "Colombia" } }), { moneda: "COP", pais: "Colombia", origen: "deal" });
  assert.deepEqual(monedaYPais({ deal: { Territorio: "México" } }), { moneda: "MXN", pais: "México", origen: "deal" });
  assert.deepEqual(monedaYPais({ deal: { Territorio: "Chile", Monda_del_trato: "CLP" } }), { moneda: "UF", pais: "Chile", origen: "deal" });
  assert.deepEqual(monedaYPais({}), { moneda: "UF", pais: "Chile", origen: "default" });
});

test("escalera PE por defecto solo en soles", () => {
  assert.deepEqual(escalerasDefaultPorMoneda("PEN").asistencia, ESCALERA_ASISTENCIA_PE);
  assert.deepEqual(escalerasDefaultPorMoneda("PEN").plan_asistencia, ESCALERA_ASISTENCIA_PE);
  assert.deepEqual(escalerasDefaultPorMoneda("UF"), {});
});

test("tabla de cobro en PEN: tramos peruanos en soles, sin extender con la escalera chilena en UF", () => {
  const config = { quoteItemsSubformField: "Detalle_Items_Cotizacion" };
  const quote = {
    Detalle_Items_Cotizacion: [
      { Nombre_Item: "Control de Asistencia", Codigo_Item: "plan_asistencia", Cantidad: 1, Precio_Unitario_UF: 55, Precio_Unitario_CLP: 55, Subtotal_UF: 55, Subtotal_CLP: 55, Modalidad: "Único", Es_Recurrente: true },
    ],
  };
  const r = buildChargeTables({
    quote, config, committedEmployees: 8, moneda: "PEN", servicioPrincipal: "Control de Asistencia",
    resolveServicios: () => ["Control de Asistencia"],
    escalerasEnMemoria: escalerasDefaultPorMoneda("PEN"),
  });
  const filas = r.porServicio["Control de Asistencia"];
  assert.ok(Array.isArray(filas) && filas.length === 4, `esperaba 4 tramos PE, hay ${filas && filas.length}`);
  assert.equal(filas[0].Valor, 55); // piso de 10 (Lalo 17-sep)
  assert.equal(filas[1].Valor, 5.5);
  assert.equal(filas[1].Hasta, 50);
  assert.equal(filas[2].Valor, 5);
  assert.equal(filas[3].Valor, 4.5);
  assert.equal(filas[3].Hasta, 500);
  assert.equal(r.diagnostico.moneda, "PEN");
  assert.equal(r.diagnostico.fallback, false);
});
