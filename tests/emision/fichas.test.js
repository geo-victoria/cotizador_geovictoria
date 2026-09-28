/**
 * Fichas de emisión: cada país tiene todos los campos, y los valores son los
 * que HOY están escritos en los cuatro endpoints (se leen sus fuentes).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { construirFichas, FICHA_CL, FICHA_PE, FICHA_CO, FICHA_MX, IDS } = require("../../api/_shared/emision/fichas");

const QA = path.join(__dirname, "..", "..", "api", "quote-acceptance");
const fuente = (f) => fs.readFileSync(path.join(QA, f), "utf8");
const SRC = {
  cl: fuente("create-from-vicky.js"),
  pe: fuente("create-from-vicky-pe.js"),
  co: fuente("create-from-vicky-co.js"),
  mx: fuente("create-from-vicky-mx.js"),
};
const FICHAS = { cl: FICHA_CL, pe: FICHA_PE, co: FICHA_CO, mx: FICHA_MX };

// Forma de la ficha: todas las rutas que emitir.js lee.
const RUTAS = [
  "pais", "etiquetaLog", "secretEnvs", "territorio", "monedaDeal",
  "deal.etapaInicial", "deal.leadSourceDefault", "deal.tombola", "deal.producto", "deal.pipeline",
  "deal.nombre", "deal.nombreDesdePlaceholder", "deal.amount", "deal.descripcionTotal",
  "sector.fallback", "sector.expansionRegional",
  "cuentas.internas", "cuentas.esNoAdoptable", "cuentas.esCompanyPlaceholder", "cuentas.esPlaceholderRegistro",
  "documento.etiqueta", "documento.variantes", "documento.paraCuenta", "documento.paraCotizacion",
  "documento.paraLead", "documento.paraCreator", "documento.clave", "documento.claveCapa4",
  "moneda.campos.total", "moneda.campos.precioUnitario", "moneda.campos.subtotal",
  "owners.interino.id", "owners.adoptables", "owners.interinosLectura",
  "subform.construir", "descuento.motor", "pdf.construir", "pdf.opciones",
  "correo.fromEmail", "correo.ccFijos", "correo.ccPais", "correo.plantilla", "correo.asunto",
  "creator.motivo", "token", "respuesta", "mensajes.faltanCampos", "mensajes.itemsRequerido", "flags",
  "cotizacion.marcarIntervencionHumana",
];
const leer = (o, ruta) => ruta.split(".").reduce((a, k) => (a == null ? a : a[k]), o);

for (const [pais, f] of Object.entries(FICHAS)) {
  test(`ficha ${pais}: tiene todos los campos`, () => {
    for (const r of RUTAS) assert.notStrictEqual(leer(f, r), undefined, `${pais}.${r}`);
    assert.strictEqual(f.pais, pais);
  });
}

// Default de env tal como está escrito en el endpoint: `process.env.X) || "valor"`.
function defaultEnv(src, env) {
  const m = new RegExp(`process\\.env\\.${env}\\)?\\s*\\|\\|\\s*"([^"]*)"`).exec(src);
  return m ? m[1] : null;
}

test("territorio, moneda del deal y comunes = defaults de los endpoints", () => {
  const casos = [
    ["cl", "VICKY_TERRITORIO", FICHA_CL.territorio], ["cl", "VICKY_MONEDA_CL", FICHA_CL.monedaDeal],
    ["pe", "VICKY_TERRITORIO_PE", FICHA_PE.territorio], ["pe", "VICKY_MONEDA_PE", FICHA_PE.monedaDeal],
    ["co", "VICKY_TERRITORIO_CO", FICHA_CO.territorio], ["co", "VICKY_MONEDA_CO", FICHA_CO.monedaDeal],
    ["mx", "VICKY_TERRITORIO_MX", FICHA_MX.territorio], ["mx", "VICKY_MONEDA_MX", FICHA_MX.monedaDeal],
  ];
  for (const [p, env, valor] of casos) assert.strictEqual(valor, defaultEnv(SRC[p], env), `${p} ${env}`);
  for (const p of Object.keys(SRC)) {
    const f = FICHAS[p];
    assert.strictEqual(f.deal.etapaInicial, defaultEnv(SRC[p], "VICKY_DEAL_STAGE_INICIAL"), p);
    assert.strictEqual(f.deal.leadSourceDefault, defaultEnv(SRC[p], "VICKY_LEAD_SOURCE"), p);
    assert.strictEqual(f.deal.tombola, defaultEnv(SRC[p], "VICKY_TOMBOLA"), p);
    assert.strictEqual(f.deal.producto, defaultEnv(SRC[p], "VICKY_PRODUCTO_DEFAULT"), p);
    assert.strictEqual(f.sector.fallback, defaultEnv(SRC[p], "VICKY_SECTOR_FALLBACK"), p);
    assert.strictEqual(f.sector.expansionRegional, defaultEnv(SRC[p], "VICKY_EXPANSION_REGIONAL"), p);
    assert.ok(SRC[p].includes('Pipeline: "Standard (Standard)"'), p);
    assert.strictEqual(f.deal.pipeline, "Standard (Standard)");
  }
});

test("secretos por país (con respaldo al secreto base)", () => {
  assert.deepStrictEqual(FICHA_CL.secretEnvs, ["VICKY_COTIZADORA_SECRET"]);
  for (const [p, f] of Object.entries({ pe: FICHA_PE, co: FICHA_CO, mx: FICHA_MX })) {
    const env = `VICKY_COTIZADORA_SECRET_${p.toUpperCase()}`;
    assert.ok(SRC[p].includes(`process.env.${env}) || toText(process.env.VICKY_COTIZADORA_SECRET)`), p);
    assert.deepStrictEqual(f.secretEnvs, [env, "VICKY_COTIZADORA_SECRET"]);
  }
});

test("dueños: interino, adoptables y no heredables = los del código", () => {
  assert.strictEqual(FICHA_CL.owners.interino.id, IDS.VICKY_USER_ID);
  assert.ok(SRC.cl.includes(`VICKY_BOT_OWNER = { id: "${IDS.VICKY_USER_ID}" }`));
  assert.deepStrictEqual([...FICHA_CL.owners.adoptables].sort(), [IDS.VICKY_USER_ID, IDS.GORDILLO_ID, IDS.YAHEL_ID].sort());
  for (const id of FICHA_CL.owners.adoptables) assert.ok(SRC.cl.includes(`"${id}"`), id);
  assert.deepStrictEqual([...FICHA_PE.owners.adoptables].sort(), [IDS.VICKY_USER_ID, IDS.MONICA_ID].sort());
  assert.ok(SRC.pe.includes(`VICKY_PE_OWNER_ID) || "${IDS.MONICA_ID}"`));
  assert.strictEqual(FICHA_PE.owners.interino.id, defaultEnv(SRC.pe, "VICKY_PE_OWNER_INTERINO_ID"));
  for (const id of IDS.SDR_CO_IDS) assert.ok(SRC.co.includes(`"${id}"`), id);
  assert.deepStrictEqual([...FICHA_CO.owners.adoptables].sort(), [IDS.VICKY_USER_ID, IDS.GORDILLO_ID, ...IDS.SDR_CO_IDS].sort());
  assert.deepStrictEqual([...FICHA_MX.owners.noHeredables].sort(), ["3525045000391904256", "3525045000434395001"]);
  assert.ok(SRC.mx.includes('VICKY_SDR_MX_IDS || "3525045000391904256,3525045000434395001"'));
  assert.deepStrictEqual([...FICHA_MX.owners.adoptables].sort(), [IDS.VICKY_USER_ID, IDS.YAHEL_ID].sort());
  for (const f of Object.values(FICHAS)) assert.deepStrictEqual(f.owners.interinosLectura, [IDS.VICKY_USER_ID, IDS.GEOVICTORIA_ADMIN_ID]);
});

test("SDR no heredan el deal en NINGÚN país (decisión 28-sep)", () => {
  const rutaAgente = "/home/user/geovictoria-whatsapp-agent/lib/paises/ficha-operativa.ts";
  const ficha = require("fs").existsSync(rutaAgente) ? require("fs").readFileSync(rutaAgente, "utf8") : null;
  assert.deepStrictEqual([...FICHA_CL.owners.noHeredables].sort(), [...IDS.SDR_CL_IDS].sort());
  assert.deepStrictEqual([...FICHA_PE.owners.noHeredables].sort(), [...IDS.SDR_PE_IDS].sort());
  assert.deepStrictEqual([...FICHA_CO.owners.noHeredables].sort(), [...IDS.SDR_CO_IDS].sort());
  for (const f of Object.values(FICHAS)) assert.ok(f.owners.noHeredables && f.owners.noHeredables.size > 0, f.pais);
  // Los ids de CL y PE son los rosters SDR de la ficha operativa del agente
  // (solo si el repo del agente está al lado; si no, se omite este cruce).
  if (ficha) for (const id of [...IDS.SDR_CL_IDS, ...IDS.SDR_PE_IDS]) assert.ok(ficha.includes(`"${id}"`), id);
});

test("dueño fijo opcional de CO y MX (VICKY_*_OWNER_FIJO)", () => {
  const f1 = construirFichas({ VICKY_CO_OWNER_FIJO: "on", VICKY_CO_OWNER_ID: "123", VICKY_MX_OWNER_FIJO: "1" });
  assert.strictEqual(f1.co.owners.interino.id, "123");
  assert.strictEqual(f1.mx.owners.interino.id, IDS.YAHEL_ID);
  const f2 = construirFichas({});
  assert.strictEqual(f2.co.owners.interino.id, IDS.VICKY_USER_ID);
  assert.strictEqual(f2.mx.owners.interino.id, IDS.VICKY_USER_ID);
});

test("token, Creator y correo por país", () => {
  assert.strictEqual(FICHA_CL.token.pais, null);
  for (const p of ["pe", "co", "mx"]) {
    assert.strictEqual(FICHAS[p].token.pais, p);
    assert.ok(SRC[p].includes(`pais: "${p}"`), p);
  }
  assert.strictEqual(FICHA_CL.creator.overrides, null);
  assert.deepStrictEqual(FICHA_PE.creator.overrides, { moneda: "PEN", pais: "Perú" });
  assert.deepStrictEqual(FICHA_CO.creator.overrides, { moneda: "COP", pais: "Colombia" });
  assert.deepStrictEqual(FICHA_MX.creator.overrides, { moneda: "MXN", pais: "México" });
  assert.ok(SRC.co.includes('creatorOverrides: { moneda: "COP", pais: "Colombia" }'));
  assert.ok(SRC.mx.includes('creatorOverrides: { moneda: "MXN", pais: "México" }'));
  assert.ok(SRC.pe.includes('moneda: "PEN", pais: "Perú"'));
  assert.strictEqual(FICHA_PE.creator.notaHardwareUsd, true);
  const esc = require("../../api/_shared/escaleras-pais");
  assert.strictEqual(FICHA_PE.creator.escaleras(), esc.ESCALERA_ASISTENCIA_PE);
  assert.strictEqual(FICHA_CO.creator.escaleras(), esc.ESCALERA_ASISTENCIA_CO);
  assert.strictEqual(FICHA_MX.creator.escaleras(), esc.ESCALERA_ASISTENCIA_MX);
  assert.deepStrictEqual(FICHA_CL.correo.ccFijos, ["egomez@geovictoria.com", "rlewit@geovictoria.com"]);
  assert.deepStrictEqual(FICHA_MX.correo.ccFijos, FICHA_CL.correo.ccFijos);
  assert.deepStrictEqual(FICHA_PE.correo.ccPais, [defaultEnv(SRC.pe, "VICKY_PE_QUOTE_CC")]);
  assert.deepStrictEqual(FICHA_CO.correo.ccPais, [defaultEnv(SRC.co, "VICKY_CO_QUOTE_CC")]);
  for (const f of Object.values(FICHAS)) assert.strictEqual(f.correo.fromEmail, "vicky@geovictoria.com");
  assert.strictEqual(FICHA_CL.correo.adjuntoPdf, true);
  for (const p of ["pe", "co", "mx"]) assert.strictEqual(FICHAS[p].correo.adjuntoPdf, false);
});

test("tipo de cobro al nacer: COMÚN (\"Mensual fijo\"), no es dato de la ficha; Amount por país", () => {
  const { TIPO_DE_COBRO_AL_NACER } = require("../../api/_shared/emision/emitir");
  assert.strictEqual(TIPO_DE_COBRO_AL_NACER, "Mensual fijo");
  for (const f of Object.values(FICHAS)) assert.strictEqual(f.deal.tipoDeCobro, undefined);
  // Es también lo que valor-deal escribe después en los cuatro países.
  assert.ok(require("fs").readFileSync(require("path").join(__dirname, "..", "..", "api", "_shared", "valor-deal.js"), "utf8").includes('Tipo_de_Cobro: "Mensual fijo"'));
  assert.strictEqual(FICHA_CL.deal.amount({ totalCLP: 38809 }), 38809);
  assert.strictEqual(FICHA_PE.deal.amount({ totalPEN: 118.4 }), 118);
  assert.strictEqual(FICHA_MX.deal.amount({ totalMXN: 1392 }), undefined);
});

test("documento por país: validación, formato de cuenta y cotización", () => {
  assert.strictEqual(FICHA_CL.documento.validar, null);
  assert.strictEqual(FICHA_CL.documento.paraCuenta("76.543.210-3"), "76.543.210-3");
  assert.deepStrictEqual(FICHA_PE.documento.validar("20605842055", {}), { ok: true, tipo: "RUC" });
  assert.strictEqual(FICHA_PE.documento.validar("20605842056", {}).ok, false);
  assert.deepStrictEqual(FICHA_PE.documento.validar("12345678", {}), { ok: true, tipo: "DNI" });
  assert.strictEqual(FICHA_PE.documento.paraCotizacion("20.605.842.055"), "20605842055");
  assert.strictEqual(FICHA_CO.documento.paraCuenta("900.624.654-1"), "900624654");
  assert.strictEqual(FICHA_CO.documento.paraCotizacion("900.624.654-1"), "900.624.654-1");
  assert.ok(FICHA_CO.documento.variantes("900.624.654-1").includes("900624654"));
  assert.strictEqual(FICHA_MX.documento.validar("XAXX010101000").ok, true);
  assert.ok(FICHA_MX.documento.validar("raro").advertencia);
  assert.strictEqual(FICHA_MX.documento.paraCuenta("GEO-200101-AB1"), "GEO-200101-AB1");
  // Mismos mensajes de 400 que hoy.
  assert.ok(SRC.pe.includes(`"${FICHA_PE.mensajes.faltanCampos}"`));
  assert.ok(SRC.co.includes(`"${FICHA_CO.mensajes.faltanCampos}"`));
  assert.ok(SRC.mx.includes(`"${FICHA_MX.mensajes.faltanCampos}"`));
  assert.ok(SRC.cl.includes(`"${FICHA_CL.mensajes.faltanCampos}"`));
});

test("sectores válidos de Chile = SECTORES_VALIDOS del endpoint", () => {
  for (const s of FICHA_CL.sector.validos) assert.ok(SRC.cl.includes(`"${s}"`), s);
  assert.strictEqual(FICHA_CL.sector.validos.size, 22);
  for (const p of ["pe", "co", "mx"]) assert.strictEqual(FICHAS[p].sector.validos, null);
});

test("etiqueta de canal \"100% Vicky\" en los 4 países (común desde c827413)", () => {
  for (const [p, f] of Object.entries(FICHAS)) {
    assert.strictEqual(f.cotizacion.marcarIntervencionHumana, true, p);
    assert.ok(SRC[p].includes('"100% Vicky"'), p);
  }
});
