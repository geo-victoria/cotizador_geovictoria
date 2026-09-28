const test = require("node:test");
const assert = require("node:assert/strict");
const { nombreTratoConRuc } = require("../api/_shared/nombre-trato-ruc");

test("Perú: el RUC va al inicio del trato y se conserva '- Cotización Vicky'", () => {
  assert.equal(
    nombreTratoConRuc("BLESSED CONSULTING E.I.R.L. - Cotización Vicky", "20609126575"),
    "20609126575 - BLESSED CONSULTING E.I.R.L. - Cotización Vicky",
  );
  // ya lo trae: no cambia
  const ya = "20609126575 - BLESSED CONSULTING E.I.R.L. - Cotización Vicky";
  assert.equal(nombreTratoConRuc(ya, "20609126575"), ya);
  // RUC inválido: no cambia
  assert.equal(nombreTratoConRuc("X - Cotización Vicky", "123"), "X - Cotización Vicky");
  // largo: tope 120 con el sufijo intacto
  const largo = nombreTratoConRuc(`${"A".repeat(150)} - Cotización Vicky`, "20100055237");
  assert.ok(largo.length <= 120 && largo.startsWith("20100055237 - ") && largo.endsWith(" - Cotización Vicky"));
});
