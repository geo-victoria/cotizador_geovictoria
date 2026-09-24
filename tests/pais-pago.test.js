// Ficha de pago por país (24-sep): un país nuevo es una entrada de tabla.
const test = require("node:test");
const assert = require("node:assert/strict");

const { fichaPago, paisesConCuentaPropia, paisPorTerritorio, paisDeToken, presentacionPago } = require("../api/_shared/pais-pago");
const { computePaymentAmountsPais, computeTotalsMX } = require("../api/_shared/quote-pricing");
const mp = require("../api/_shared/mercadopago-config");

test("ficha: países con cuenta propia y resolución de país", () => {
  assert.deepEqual(paisesConCuentaPropia().sort(), ["co", "mx", "pe"]);
  assert.equal(paisPorTerritorio("México"), "mx");
  assert.equal(paisPorTerritorio("Perú"), "pe");
  assert.equal(paisPorTerritorio("Colombia"), "co");
  assert.equal(paisPorTerritorio("Chile"), "cl");
  assert.equal(paisDeToken({ pais: "mx" }), "mx");
  assert.equal(paisDeToken({ pais: "cl" }), "");
  assert.equal(paisDeToken({ pais: "zz" }), "");
  assert.equal(fichaPago("zz").codigo, "cl");
  const pres = presentacionPago("mx");
  assert.equal(pres.moneda, "MXN");
  assert.equal(pres.decimales, 2);
  assert.equal(fichaPago("cl").recargoTarjeta, true);
  assert.equal(fichaPago("mx").recargoTarjeta, false);
});

test("MX: pago inicial = pagos únicos + primer mes, IVA 16 % a centavos", () => {
  const items = [
    { codigo: "plan_asistencia", modalidad: "Recurrente", subtotalClp: 1328, afectoIva: true },
    { codigo: "capacitacion_online", modalidad: "Venta", subtotalClp: 0, afectoIva: true },
    { codigo: "reloj_venta", modalidad: "Venta", subtotalClp: 2100, afectoIva: true },
  ];
  const a = computePaymentAmountsPais("mx", items, 0);
  assert.equal(a.oneShotItemsClp, 2436);
  assert.equal(a.firstMonthClp, 1540.48);
  assert.equal(a.oneShotClp, 3976.48);
  assert.equal(a.recurringClp, 1540.48);
  // Solo software: antes $0 en línea; ahora se cobra el primer mes.
  const solo = computePaymentAmountsPais("mx", items.slice(0, 1), 0);
  assert.equal(solo.oneShotClp, 1540.48);
  // Claves que lee la página de aceptación.
  const t = computeTotalsMX(items, 0);
  assert.equal(t.pagoInicialMxn, 3976.48);
  assert.equal(t.mensualidadMxn, 1540.48);
});

test("config MP por país: sin access token del país el cobro en línea queda apagado", () => {
  const prev = { ...process.env };
  try {
    process.env.MP_PAYMENTS_ENABLED = "true";
    delete process.env.MP_ACCESS_TOKEN_MX;
    assert.equal(mp.conPagoEnLinea("mx"), false);
    process.env.MP_ACCESS_TOKEN_MX = "APP_USR-x";
    process.env.MP_WEBHOOK_SECRET_MX = "sec";
    const c = mp.getMercadoPagoConfigPais(null, "mx");
    assert.equal(c.enabled, true);
    assert.equal(c.currencyId, "MXN");
    assert.equal(c.webhookSecret, "sec");
    assert.equal(c.pais, "mx");
    // Carril de prueba MX: RFC genérico → sandbox; sin sandbox, error explícito.
    const quotePrueba = { RUT_Cliente: "XAXX010101000" };
    delete process.env.MP_TEST_ACCESS_TOKEN_MX;
    assert.throws(() => mp.getMercadoPagoConfigForQuotePais(null, quotePrueba, {}, "mx"), /sandbox/);
    process.env.MP_TEST_ACCESS_TOKEN_MX = "TEST-y";
    const t = mp.getMercadoPagoConfigForQuotePais(null, quotePrueba, {}, "mx");
    assert.equal(t.accessToken, "TEST-y");
    assert.equal(t.testLane, true);
    // Cliente real → producción.
    assert.equal(mp.getMercadoPagoConfigForQuotePais(null, { RUT_Cliente: "ABC010101AB1" }, {}, "mx").accessToken, "APP_USR-x");
    // Alias antiguos siguen funcionando.
    assert.equal(mp.isTestLaneQuotePE({ RUT_Cliente: "20605842055" }, {}), true);
    assert.equal(mp.isTestLaneQuoteCO({ RUT_Cliente: "901.234.567-8" }, {}), true);
  } finally {
    process.env = prev;
  }
});
