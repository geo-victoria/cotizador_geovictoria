const test = require("node:test");
const assert = require("node:assert/strict");
const { RFC_GENERICO_MX, esRfcGenerico, rfcParaFacturar } = require("../api/_shared/rfc-mx");
const { PERFIL_MX } = require("../api/quote-acceptance/create-from-vicky-mx");

test("el RFC genérico no sirve para facturar; uno real sí", () => {
  assert.equal(esRfcGenerico(RFC_GENERICO_MX), true);
  assert.equal(esRfcGenerico("xaxx-010101-000"), true);
  assert.equal(rfcParaFacturar(RFC_GENERICO_MX), false);
  assert.equal(rfcParaFacturar("CEC2005286R4"), true);
  assert.equal(rfcParaFacturar("VARA700101AB1"), true);
  assert.equal(rfcParaFacturar("12345"), false);
});

test("el perfil MX declara el genérico y el PDF no lo imprime como RFC", () => {
  assert.equal(PERFIL_MX.documento.generico, RFC_GENERICO_MX);
  assert.equal(PERFIL_MX.documento.clientePdf(RFC_GENERICO_MX).rfc, "Se solicita al aceptar");
  assert.equal(PERFIL_MX.documento.clientePdf("CEC2005286R4").rfc, "CEC2005286R4");
  assert.match(PERFIL_MX.documento.descripcionCuenta(RFC_GENERICO_MX, "RFC", true), /pendiente/);
});
