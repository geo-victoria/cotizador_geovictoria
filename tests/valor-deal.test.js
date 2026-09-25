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

test("Chile en UF (25-sep): recurrente desde Subtotal_UF con 2 decimales", () => {
  const items = [
    { Codigo_Item: "asistencia", Es_Recurrente: true, Subtotal_UF: 0.55, Subtotal_CLP: 22550 },
    { Codigo_Item: "senseface_2a", Es_Recurrente: true, Subtotal_UF: 0.35, Subtotal_CLP: 14350 },
    { Codigo_Item: "envio_reloj", Es_Recurrente: false, Subtotal_UF: 0.5, Subtotal_CLP: 20500 },
  ];
  assert.equal(recurrenteNetoDesdeItems(items, 10, "UF"), 0.81);
  assert.equal(recurrenteNetoDesdeItems([{ Codigo_Item: "plan_anual", Subtotal_UF: 6.6 }], 0, "UF"), 0.55);
});
