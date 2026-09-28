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

// ── Diferencias ACEPTADAS por decisión del dueño (28-sep) ──
// Se aplican a la corrida del handler chileno ANTES de comparar, campo por
// campo; todo lo demás debe ser idéntico.
// 1) Tipo_de_Cobro del deal al nacer = "Mensual fijo" en todos los países
//    (hoy Chile: ≤10 fijo / >10 por usuario).
// 2) El lead de una SDR se convierte pero la SDR NO hereda el deal: ver los
//    escenarios con `equivalenteChile` (comparan contra Chile con el mismo
//    lead de dueño robot).
function aceptarTipoDeCobroComun(valor) {
  if (Array.isArray(valor)) return valor.map(aceptarTipoDeCobroComun);
  if (valor && typeof valor === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = k === "Tipo_de_Cobro" ? "Mensual fijo" : aceptarTipoDeCobroComun(v);
    return out;
  }
  return valor;
}

for (const esc of ESCENARIOS) {
  test(`identidad CL: ${esc.nombre}`, async () => {
    const t = {
      ok: (v, m) => assert.ok(v, m),
      equal: (x, y, m) => assert.strictEqual(x, y, m),
      notEqual: (x, y, m) => assert.notStrictEqual(x, y, m),
      deepEqual: (x, y, m) => assert.deepStrictEqual(x, y, m),
    };
    const chileHoy = await correr(esc, handlerChile);
    const b = await correr(esc, handlerEmision);
    // El escenario cubre lo que dice cubrir (sobre el handler chileno de hoy).
    esc.verificar(chileHoy, t);
    if (esc.verificarEmision) esc.verificarEmision(b, t);
    // 2) Diferencia aceptada "SDR no hereda": la referencia es el handler
    //    chileno sobre el escenario equivalente (lead de dueño robot).
    const a = esc.equivalenteChile ? await correr(esc.equivalenteChile(), handlerChile) : chileHoy;
    assert.ok(a.log.length > 0 || a.respuestas.every((r) => r.status !== 200), "hubo llamadas");
    a.log = aceptarTipoDeCobroComun(a.log);
    assert.deepStrictEqual(b.respuestas, a.respuestas, "misma respuesta HTTP");
    assert.strictEqual(b.log.length, a.log.length, "mismo número de llamadas externas");
    for (let i = 0; i < a.log.length; i++) {
      assert.deepStrictEqual(b.log[i], a.log[i], `llamada #${i} (${a.log[i].canal} ${a.log[i].metodo} ${a.log[i].ruta})`);
    }
  });
}
