"use strict";
/**
 * PRUEBA DE IDENTIDAD de la emisión única por país (paso 3, 29-sep).
 * Los goldens en tests/emision-golden/fixtures se congelaron con los TRES
 * handlers viejos (create-from-vicky-pe/co/mx) ANTES de reemplazarlos por la
 * emisión parametrizada. Cada escenario compara la respuesta HTTP y la lista
 * ordenada de llamadas hacia afuera: si algo cambia de conducta, se ve acá.
 * Para re-congelar A PROPÓSITO: node tests/emision-golden/congelar.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { correr } = require("./emision-golden/harness");
const { escenariosDe, HANDLERS, PAISES } = require("./emision-golden/escenarios");

for (const cc of PAISES) {
  for (const esc of escenariosDe(cc)) {
    const f = path.join(__dirname, "emision-golden", "fixtures", `${cc}-${esc.nombre}.json`);
    test(`emisión ${cc} · ${esc.nombre}`, { skip: fs.existsSync(f) ? false : "sin golden congelado" }, async () => {
      const golden = JSON.parse(fs.readFileSync(f, "utf8"));
      const actual = await correr(HANDLERS[cc], esc);
      assert.deepEqual(actual.salida, golden.salida, "respuesta HTTP distinta");
      assert.deepEqual(actual.calls, golden.calls, "secuencia de llamadas distinta");
    });
  }
}
