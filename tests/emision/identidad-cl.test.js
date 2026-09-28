/**
 * PRUEBA DE IDENTIDAD DE CHILE (fase 1 de la emisión única).
 *
 * Corre el handler chileno actual (create-from-vicky.js) y la emisión única
 * (emitir.js con FICHA_CL) sobre los mismos escenarios, con Zoho/kv/agente
 * simulados en memoria, y exige: la MISMA secuencia de llamadas externas con
 * los MISMOS cuerpos (Zoho, vic_kv, agente, PDF, correo, Creator) y la MISMA
 * respuesta HTTP. Nada sale a la red.
 */
const test = require("node:test");
const assert = require("node:assert");
const { correr } = require("./harness");
const { ESCENARIOS } = require("./escenarios-cl");

const handlerChile = (req) => req("api/quote-acceptance/create-from-vicky.js");
const handlerEmision = (req) => {
  const { crearEndpointEmision } = req("api/_shared/emision/emitir.js");
  const { FICHA_CL } = req("api/_shared/emision/fichas.js");
  const { normalizarCL } = req("api/_shared/emision/normalizar.js");
  return crearEndpointEmision(FICHA_CL, { normalizar: normalizarCL });
};

for (const esc of ESCENARIOS) {
  test(`identidad CL: ${esc.nombre}`, async () => {
    const a = await correr(esc, handlerChile);
    const b = await correr(esc, handlerEmision);
    // El escenario cubre lo que dice cubrir (sobre el handler chileno).
    esc.verificar(a, {
      ok: (v, m) => assert.ok(v, m),
      equal: (x, y, m) => assert.strictEqual(x, y, m),
      notEqual: (x, y, m) => assert.notStrictEqual(x, y, m),
      deepEqual: (x, y, m) => assert.deepStrictEqual(x, y, m),
    });
    assert.ok(a.log.length > 0 || a.respuestas.every((r) => r.status !== 200), "hubo llamadas");
    assert.deepStrictEqual(b.respuestas, a.respuestas, "misma respuesta HTTP");
    assert.strictEqual(b.log.length, a.log.length, "mismo número de llamadas externas");
    for (let i = 0; i < a.log.length; i++) {
      assert.deepStrictEqual(b.log[i], a.log[i], `llamada #${i} (${a.log[i].canal} ${a.log[i].metodo} ${a.log[i].ruta})`);
    }
  });
}
