const test = require("node:test");
const assert = require("node:assert/strict");
const { recurrenteNetoDesdeItems } = require("../api/_shared/valor-deal");

test("valor del deal = recurrente neto con descuento del plan; anualidad ÷ 12", () => {
  const items = [
    { Codigo_Item: "plan_asistencia", Es_Recurrente: true, Subtotal_CLP: 55 },
    { Codigo_Item: "reloj_pe", Es_Recurrente: true, Subtotal_CLP: 68 },
    { Codigo_Item: "instalacion_reloj", Es_Recurrente: false, Subtotal_CLP: 0 },
  ];
  assert.equal(recurrenteNetoDesdeItems(items, 0), 123);
  assert.equal(recurrenteNetoDesdeItems([{ Codigo_Item: "asistencia", Es_Recurrente: false, Subtotal_CLP: 22486 }], 0), 22486);
  assert.equal(recurrenteNetoDesdeItems([{ Codigo_Item: "plan_anual", Subtotal_CLP: 98419 }, { Codigo_Item: "asistencia", Es_Recurrente: true, Subtotal_CLP: 0 }], 20), 8202);
});
