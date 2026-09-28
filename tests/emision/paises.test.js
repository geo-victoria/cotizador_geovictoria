/**
 * Humo de la emisión única con las fichas de PE/CO/MX (fase 1: NO se exige
 * identidad con sus endpoints — al migrar adoptan el proceso de Chile y las
 * diferencias esperadas están en api/_shared/emision/README.md). Se prueba
 * que el adaptador + la ficha llevan la emisión de punta a punta con los datos
 * del país: territorio, moneda, documento, token, Creator y correo.
 */
const test = require("node:test");
const assert = require("node:assert");
const { correr } = require("./harness");
const { normalizarPE, normalizarCO, normalizarMX } = require("../../api/_shared/emision/normalizar");
const { FICHA_PE, FICHA_CO, FICHA_MX } = require("../../api/_shared/emision/fichas");

const endpoint = (pais) => (req) => {
  const { crearEndpointEmision } = req("api/_shared/emision/emitir.js");
  const fichas = req("api/_shared/emision/fichas.js");
  const { NORMALIZADORES } = req("api/_shared/emision/normalizar.js");
  return crearEndpointEmision(fichas.fichaDePais(pais), { normalizar: NORMALIZADORES[pais] });
};

const bodyPais = (m, doc, docKey, afecto, extra = {}) => ({
  empresa: "Empresa Prueba", contacto: "Ana Torres", contactoEmail: "ana@prueba.com",
  [docKey]: doc, contactoTelefono: extra.fono, userCount: 12, escalonDescuento: 1,
  items: [
    { tipo: "plan", id: "plan_asistencia", nombre: "Plan", modalidad: "Por usuario", cantidad: 12, [`precioUnitario${m}`]: 10, [`subtotal${m}`]: 120, esRecurrente: true, [afecto]: afecto === "afectoIgv" },
    { tipo: "hardware", id: "reloj", nombre: "Reloj", modalidad: "Arriendo mensual", cantidad: 1, [`precioUnitario${m}`]: 80, [`subtotal${m}`]: 80, esRecurrente: true, [afecto]: true },
    { tipo: "activacion", id: "activacion", nombre: "Activación", modalidad: "Cobro único", cantidad: 1, [`precioUnitario${m}`]: 200, [`subtotal${m}`]: 200, esRecurrente: false, [afecto]: true },
  ],
  ...(extra.raiz || {}),
});

test("normalizadores: contrato de país → contrato de Chile", () => {
  const pe = normalizarPE(bodyPais("PEN", "20605842055", "ruc", "afectoIgv", { raiz: { tipoCambio: 3.4, tipoCambioFuente: "SUNAT" } }), FICHA_PE);
  assert.strictEqual(pe.cliente.rutEmpresa, "20605842055");
  assert.strictEqual(pe.cotizacion.items.length, 2, "sin fila de Activación");
  assert.strictEqual(Math.round(pe.cotizacion.totalPEN * 100) / 100, 236, "(120+80)×1,18");
  assert.deepStrictEqual(pe.extras, { tipoCambio: 3.4, tipoCambioFuente: "SUNAT" });
  assert.deepStrictEqual(normalizarPE(bodyPais("PEN", "20605842055", "ruc", "afectoIgv"), FICHA_PE).extras, { tipoCambio: undefined, tipoCambioFuente: "" });
  const co = normalizarCO(bodyPais("COP", "900.624.654-1", "nit", "afectoIva"), FICHA_CO);
  assert.strictEqual(co.cotizacion.totalCOP, 120 + 80 * 1.19);
  const mx = normalizarMX(bodyPais("MXN", "GEO200101AB1", "rfc", "afectoIva", { raiz: { cc: ["x@y.z"], escalonDescuento: 9 } }), FICHA_MX);
  assert.ok(mx.cotizacion.items.some((i) => i.id === "capacitacion_online"), "capacitación MX agregada");
  assert.deepStrictEqual(mx.cc, ["x@y.z"]);
  assert.strictEqual(mx.escalonDescuento, 2, "escalón acotado a la escalera");
});

const CASOS = [
  { pais: "pe", m: "PEN", doc: "20605842055", key: "ruc", afecto: "afectoIgv", fono: "51900000501", territorio: "Perú", moneda: "SOL", creator: "PEN" },
  { pais: "co", m: "COP", doc: "900.624.654-1", key: "nit", afecto: "afectoIva", fono: "579000005011", territorio: "Colombia", moneda: "COP", creator: "COP" },
  { pais: "mx", m: "MXN", doc: "GEO200101AB1", key: "rfc", afecto: "afectoIva", fono: "529000005011", territorio: "México", moneda: "MXN", creator: "MXN" },
];

for (const c of CASOS) {
  test(`emisión única con FICHA_${c.pais.toUpperCase()}: de punta a punta con los datos del país`, async () => {
    const r = await correr(
      { pedidos: [{ body: bodyPais(c.m, c.doc, c.key, c.afecto, { fono: c.fono, raiz: { tipoCambio: 3.4 } }) }] },
      endpoint(c.pais),
    );
    const res = r.respuestas[0];
    assert.strictEqual(res.status, 200, JSON.stringify(res.cuerpo));
    const cuenta = r.log.find((x) => x.metodo === "POST" && x.ruta === "/crm/v3/Accounts");
    assert.strictEqual(cuenta.cuerpo.data[0].Territorio, c.territorio);
    const conv = r.log.find((x) => /actions\/convert/.test(x.ruta));
    assert.strictEqual(conv.cuerpo.data[0].Deals.Monda_del_trato, c.moneda);
    assert.strictEqual(conv.cuerpo.data[0].Deals.Territorio, c.territorio);
    const q = r.log.find((x) => x.metodo === "POST" && x.ruta === "/crm/v3/Cotizaciones_GeoVictoria").cuerpo.data[0];
    assert.strictEqual(q.Descuento_Recurrente_Pct, 10);
    assert.strictEqual(q.Intervenci_n_Humana, "100% Vicky");
    assert.ok(!q.UF_Valor, "sin UF congelada fuera de Chile");
    const pr = r.log.find((x) => /Cotizaciones_GeoVictoria\/\d+$/.test(x.ruta) && x.metodo === "PUT");
    assert.ok(pr, "PUT Enviada");
    const creator = r.log.filter((x) => x.canal === "creator");
    assert.strictEqual(creator[0].cuerpo.creatorOverrides.moneda, c.creator);
    assert.ok(creator[0].cuerpo.escalerasPrecio.plan_asistencia.length > 0, "escalera del país");
    if (c.pais === "pe") {
      assert.strictEqual(creator.length, 2, "PE: plan + hardware USD");
      assert.strictEqual(creator[1].cuerpo.creatorOverrides.moneda, "USD");
      assert.strictEqual(creator[0].cuerpo.creatorOverrides.filtroLineas, "sin_hardware");
    } else {
      assert.strictEqual(creator.length, 1);
    }
    assert.ok(r.log.some((x) => /send_mail/.test(x.ruta)), "correo");
    assert.ok(/<\{"quoteId":"\d+","dealId":"\d+","pais":"/.test(res.cuerpo.acceptanceUrl), "token con país");
    assert.ok(res.cuerpo.acceptanceUrl.includes(`"pais":"${c.pais}"`));
  });
}

test("emisión única PE: RUC inválido → 400 con el mensaje de hoy", async () => {
  const r = await correr({ pedidos: [{ body: bodyPais("PEN", "20605842056", "ruc", "afectoIgv") }] }, endpoint("pe"));
  assert.strictEqual(r.respuestas[0].status, 400);
  assert.match(r.respuestas[0].cuerpo.error, /El RUC '20605842056' no es válido/);
});
