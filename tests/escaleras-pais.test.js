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
      { Nombre_Item: "Control de Asistencia", Codigo_Item: "plan_asistencia", Cantidad: 1, Precio_Unitario_UF: 100, Precio_Unitario_CLP: 100, Subtotal_UF: 100, Subtotal_CLP: 100, Modalidad: "Único", Es_Recurrente: true },
    ],
  };
  const r = buildChargeTables({
    quote, config, committedEmployees: 8, moneda: "PEN", servicioPrincipal: "Control de Asistencia",
    resolveServicios: () => ["Control de Asistencia"],
    escalerasEnMemoria: escalerasDefaultPorMoneda("PEN"),
  });
  const filas = r.porServicio["Control de Asistencia"];
  assert.ok(Array.isArray(filas) && filas.length === 4, `esperaba 4 tramos PE, hay ${filas && filas.length}`);
  assert.equal(filas[0].Valor, 100); // 1-10 fijo (Lalo 25-sep)
  assert.equal(filas[1].Valor, 9);
  assert.equal(filas[1].Hasta, 50);
  assert.equal(filas[2].Valor, 5);
  assert.equal(filas[3].Valor, 4.5);
  assert.equal(filas[3].Hasta, 500);
  assert.equal(r.diagnostico.moneda, "PEN");
  assert.equal(r.diagnostico.fallback, false);
});

test("México (24-sep): la nota de venta lleva la escalera en pesos mexicanos", () => {
  const { escalerasDefaultPorMoneda, monedaYPais } = require("../api/_shared/escaleras-pais");
  const e = escalerasDefaultPorMoneda("MXN");
  assert.deepEqual(e.plan_asistencia[0], { desde: 1, hasta: 15, modalidad: "fijo", precioUF: 1200 });
  assert.equal(e.plan_asistencia[1].precioUF, 83);
  assert.deepEqual(monedaYPais({ deal: { Territorio: "México" } }).moneda, "MXN");
});

test("Colombia (28-sep): 1-20 fijo $315.000, 21+ $13.700/usuario; la tabla anterior solo para cotizaciones que ya la mostraron", () => {
  const { escaleraCOPara, escalerasDefaultPorMoneda } = require("../api/_shared/escaleras-pais");
  const vigente = escalerasDefaultPorMoneda("COP").plan_asistencia;
  assert.deepEqual(vigente[0], { desde: 1, hasta: 20, modalidad: "fijo", precioUF: 315000 });
  assert.deepEqual(vigente[1], { desde: 21, hasta: 50, modalidad: "por_usuario", precioUF: 13700 });
  // COT1742 (20 × $13.700): conserva la tabla con la que se cotizó.
  const legado = escaleraCOPara([{ Codigo_Item: "plan_asistencia", Cantidad: 20, Precio_Unitario_UF: 13700 }]);
  assert.equal(legado[0].hasta, 10);
  assert.equal(legado[1].modalidad, "por_usuario");
  // Plan fijo nuevo (cantidad 1) → vigente.
  assert.equal(escaleraCOPara([{ Codigo_Item: "plan_asistencia", Cantidad: 1, Precio_Unitario_UF: 315000 }])[0].hasta, 20);
});

test("la NDV fuera de Chile cobra el precio de la cotización, no la lista (COT1735 S/55 vs lista S/100)", () => {
  const { alinearEscaleraConCotizacion, ESCALERA_ASISTENCIA_PE } = require("../api/_shared/escaleras-pais");
  const fijo = alinearEscaleraConCotizacion(ESCALERA_ASISTENCIA_PE, [{ Codigo_Item: "plan_asistencia", Cantidad: 1, Precio_Unitario_UF: 55, Subtotal_UF: 55 }]);
  assert.equal(fijo[0].precioUF, 55);
  assert.equal(fijo[1].precioUF, ESCALERA_ASISTENCIA_PE[1].precioUF);
  const porU = alinearEscaleraConCotizacion(ESCALERA_ASISTENCIA_PE, [{ Codigo_Item: "plan_asistencia", Cantidad: 15, Precio_Unitario_UF: 7, Subtotal_UF: 105 }]);
  assert.equal(porU[1].precioUF, 7);
  assert.equal(porU[0].precioUF, ESCALERA_ASISTENCIA_PE[0].precioUF);
  assert.deepEqual(alinearEscaleraConCotizacion(ESCALERA_ASISTENCIA_PE, []), ESCALERA_ASISTENCIA_PE.map((t) => ({ ...t })));
});
