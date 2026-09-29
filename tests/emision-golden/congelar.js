"use strict";
// Congela los goldens de las emisiones por país con el código ACTUAL.
// Uso: node tests/emision-golden/congelar.js [pe|co|mx]
const fs = require("fs");
const path = require("path");
const { correr } = require("./harness");
const { escenariosDe, HANDLERS, PAISES } = require("./escenarios");

(async () => {
  const paises = process.argv[2] ? [process.argv[2]] : PAISES;
  const dir = path.join(__dirname, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  for (const cc of paises) {
    for (const esc of escenariosDe(cc)) {
      const r = await correr(HANDLERS[cc], esc);
      const f = path.join(dir, `${cc}-${esc.nombre}.json`);
      fs.writeFileSync(f, JSON.stringify(r, null, 1) + "\n");
      console.log(`${cc} ${esc.nombre}: status ${r.salida.status} · ${r.calls.length} llamadas`);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
