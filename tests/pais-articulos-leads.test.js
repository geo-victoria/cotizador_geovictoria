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

test("la instalación y el envío resuelven al artículo de servicio del país según la zona del punto (29-sep)", () => {
  const { articuloDeServicio } = require("../api/_shared/creator-articulos");
  assert.equal(articuloDeServicio("instalacion_reloj", "base", "pe"), "390 - [PER] Instalación Lima-Callao");
  assert.equal(articuloDeServicio("instalacion_reloj", "resto", "pe"), "391 - [PER] Instalación Provicia");
  assert.equal(articuloDeServicio("envio_reloj", "intermedia", "pe"), "397 - [PER] Envío Provincia");
  assert.equal(articuloDeServicio("instalacion_reloj", "base", "co"), "290.1 - [COL] Instalación Asistencia Bogotá");
  assert.equal(articuloDeServicio("envio_reloj", "resto", "co"), "294.2 - [COL] Envío Regiones");
  assert.equal(articuloDeServicio("instalacion_reloj", "resto", "mx"), "192 - [MEX] Instalación de biométrico");
  assert.equal(articuloDeServicio("envio_reloj", "base", "mx"), "191 - [MEX] Envío vía terrestre");
  // Sin zona (cotizaciones anteriores): la tarifa mayor del país, nunca el artículo chileno.
  assert.equal(articuloDeServicio("instalacion_reloj", "", "pe"), "391 - [PER] Instalación Provicia");
  // Chile sigue igual.
  assert.equal(articuloDeServicio("instalacion_reloj", "RM", "cl"), "901 - [CHI] Instalación RM");
  assert.equal(articuloDeServicio("instalacion_reloj", "RM"), "901 - [CHI] Instalación RM");
  // Todos los artículos nuevos tienen id y SKU de Books.
  for (const a of ["390 - [PER] Instalación Lima-Callao", "391 - [PER] Instalación Provicia", "396 - x", "397 - x", "290.1 - x", "290.2- [COL] Instalación Asistencia Regiones", "294.1 - x", "294.2 - x", "190 - x", "191 - x", "192 - x"]) {
    assert.ok(idBooksDeArticulo(a), `sin id Books: ${a}`);
    assert.ok(skuDeArticulo(a), `sin SKU: ${a}`);
  }
  assert.equal(bodegaDeArticulo("390 - [PER] Instalación Lima-Callao").nombre.includes("Per"), true);
});

test("getZonaTarifa entiende las zonas del motor único además de RM/regiones", () => {
  const { getZonaTarifa } = require("../api/_shared/quote-pricing");
  assert.equal(getZonaTarifa({ zonaTarifa: "RM" }), "RM");
  assert.equal(getZonaTarifa({ zonaTarifa: "base" }), "base");
  assert.equal(getZonaTarifa({ zonaTarifa: "Resto" }), "resto");
  assert.equal(getZonaTarifa({ zonaTarifa: "" }), null);
});
