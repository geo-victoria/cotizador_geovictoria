// Artículos de Books por país y filtro de leads por país (29-sep).
const test = require("node:test");
const assert = require("node:assert/strict");
const { articuloDeHardware, esCodigoHardware, paisDeMonedaNota, idBooksDeArticulo, skuDeArticulo, bodegaDeArticulo } = require("../api/_shared/creator-articulos");
const { leadsDelPaisDeFono, territorioDeFono } = require("../api/_shared/lead-first");

test("el código genérico reloj_arriendo resuelve al artículo del país de la nota", () => {
  assert.equal(articuloDeHardware("reloj_arriendo", "co").item, "218.1 - [COL] EQUIPO FACIAL SENSEFACE 2A WIFI");
  assert.equal(articuloDeHardware("reloj_venta", "mx").item, "123.1 - [MEX] Senseface 2A");
  assert.equal(articuloDeHardware("reloj_venta", "pe").item, "304 - [PER] Reloj Gama Estándar FACIAL LAN WIFI");
  // Chile no usa códigos genéricos: sin país el genérico no inventa artículo.
  assert.equal(articuloDeHardware("reloj_arriendo"), null);
  assert.equal(articuloDeHardware("senseface_2a", "cl").item, "006.11 - Reloj Gama Media Facial WIFI/LAN");
});

test("el país de la nota sale de su moneda", () => {
  assert.equal(paisDeMonedaNota("COP"), "co");
  assert.equal(paisDeMonedaNota("MXN"), "mx");
  assert.equal(paisDeMonedaNota("PEN"), "pe");
  assert.equal(paisDeMonedaNota("USD"), "pe");
  assert.equal(paisDeMonedaNota("UF"), "cl");
  assert.equal(paisDeMonedaNota(""), "cl");
});

test("los genéricos cuentan como equipo para clasificar filas, y los ids/SKU de Books existen", () => {
  assert.equal(esCodigoHardware("reloj_arriendo"), true);
  assert.equal(esCodigoHardware("plan_asistencia"), false);
  assert.equal(idBooksDeArticulo("218.1 - [COL] EQUIPO FACIAL SENSEFACE 2A WIFI"), "1758661000073776163");
  assert.equal(idBooksDeArticulo("123.1 - [MEX] Senseface 2A"), "1758661000080555782");
  assert.equal(skuDeArticulo("218.1 - [COL] EQUIPO FACIAL SENSEFACE 2A WIFI"), "COL-BIO-SENSEFACE2A-ZKT-WL-HFT");
  assert.equal(bodegaDeArticulo("218.1 - [COL] EQUIPO FACIAL SENSEFACE 2A WIFI").id, "");
  assert.equal(bodegaDeArticulo("006.11 - Reloj Gama Media Facial WIFI/LAN").nombre, "GeoVictoria Chile");
});

test("un celular chileno no adopta el lead peruano con los mismos 9 dígitos", () => {
  const leads = [
    { id: "pe", Phone: "+51987654321", Territorio: "Perú", Converted_Deal: { id: "d1" } },
    { id: "cl", Phone: "+56987654321", Territorio: "Chile", Converted_Deal: { id: "d2" } },
  ];
  assert.deepEqual(leadsDelPaisDeFono("56987654321", leads).map((l) => l.id), ["cl"]);
  assert.deepEqual(leadsDelPaisDeFono("51987654321", leads).map((l) => l.id), ["pe"]);
  // Sin calce exacto, manda el Territorio; sin Territorio no se descarta.
  const soloTerr = [
    { id: "x", Phone: "987654321", Territorio: "Perú" },
    { id: "y", Phone: "987654321", Territorio: null },
  ];
  assert.deepEqual(leadsDelPaisDeFono("56987654321", soloTerr).map((l) => l.id), ["y"]);
  assert.equal(territorioDeFono("57300000000"), "colombia");
  assert.equal(territorioDeFono("52155000000"), "mexico");
});
