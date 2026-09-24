const test = require("node:test");
const assert = require("node:assert");
const { numeroEtapa, conEmbudoDeCampanas, ETAPA_TRATO_CREADO } = require("../api/_shared/embudo-zoho");

test("numeroEtapa lee el prefijo de la etapa", () => {
  assert.strictEqual(numeroEtapa("4. Propuesta Enviada / En Negociación"), 4);
  assert.strictEqual(numeroEtapa("1. Trato Creado"), 1);
  assert.strictEqual(numeroEtapa("Cierre Perdido"), null);
});

test("kill switch y conversión sin deal no tocan nada", async () => {
  const llamadas = [];
  const conv = conEmbudoDeCampanas(async (l, d) => { llamadas.push(d); return { dealId: "" }; });
  await conv("1", null);
  process.env.VICKY_EMBUDO_CAMPANAS = "off";
  await conv("1", { Stage: "4. Propuesta Enviada / En Negociación" });
  delete process.env.VICKY_EMBUDO_CAMPANAS;
  assert.deepStrictEqual(llamadas, [null, { Stage: "4. Propuesta Enviada / En Negociación" }]);
  assert.strictEqual(ETAPA_TRATO_CREADO, "1. Trato Creado");
});
