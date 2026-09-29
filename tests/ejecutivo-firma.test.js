// Firmante del PDF/correo: una regla para los 4 países (29-sep).
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../api/_shared/ejecutivo-firma");

const roster = {
  ok: true,
  telemarketing: [],
  equipo: [
    { email: "mmendozav@geovictoria.com", zohoId: "3525045000323383015", nombre: "Mónica Mendoza", telefono: "+51 906 239 544", pais: "pe", rol: "telemarketing" },
    { email: "mcorredor@geovictoria.com", zohoId: "3525045000276182050", nombre: "María Paula Corredor", telefono: "", pais: "co", rol: "telemarketing" },
  ],
};

test("dueño en la ficha operativa → firma con su nombre, correo y teléfono (sin ir a Zoho)", async () => {
  F._resetParaTests();
  const f = await F.resolverFirmante(["3525045000323383015"], { roster, buscarZoho: async () => { throw new Error("no debía ir a Zoho"); } });
  assert.equal(f.nombre, "Mónica Mendoza");
  assert.equal(f.telefono, "+51 906 239 544");
  assert.equal(f.esVicky, false);
  // El primer id manda (dueño del trato antes que el de la cotización).
  const g = await F.resolverFirmante(["", "3525045000276182050"], { roster });
  assert.equal(g.nombre, "María Paula Corredor");
});

test("dueño robot o desconocido → Vicky; humano fuera de la ficha → su ficha de Zoho", async () => {
  F._resetParaTests();
  const robot = await F.resolverFirmante(["3525045000484500876"], { roster, buscarZoho: async () => ({ full_name: "Vicky GeoVictoria", email: "vicky@geovictoria.com" }) });
  assert.equal(robot.esVicky, true);
  const humano = await F.resolverFirmante(["999"], { roster, buscarZoho: async () => ({ full_name: "Grey Meléndez", email: "gmelendez@geovictoria.com", phone: "+56 9 1111 1111" }) });
  assert.equal(humano.nombre, "Grey Meléndez");
  assert.equal(humano.whatsapp, "56911111111");
  // Y queda en caché para la lectura síncrona.
  assert.equal(F.firmantePorOwner("999").nombre, "Grey Meléndez");
  assert.equal(F.firmantePorOwner("no-existe").esVicky, true);
  const nadie = await F.resolverFirmante([], { roster });
  assert.equal(nadie.esVicky, true);
});

test("la firma del PDF de país: humano tal cual, Vicky con la línea de WhatsApp del país; el correo recibe vacío con Vicky", () => {
  const v = F.firmaParaPdf(F.FIRMA_VICKY, "pe");
  assert.equal(v.nombre, "Vicky — Equipo Comercial");
  assert.equal(v.telefono, "+51 922 067 167");
  assert.equal(F.firmaParaPdf(null, "co").telefono, "+57 318 107 0737");
  assert.equal(F.firmaParaPdf(undefined, "mx").telefono, "+52 1 56 5977 8486");
  const h = { nombre: "Mónica Mendoza", cargo: "Ejecutivo Comercial", email: "m@x", telefono: "1", esVicky: false };
  assert.equal(F.firmaParaPdf(h, "pe"), h);
  assert.equal(F.ejecutivoParaCorreo(F.FIRMA_VICKY), undefined);
  assert.deepEqual(F.ejecutivoParaCorreo(h), { nombre: "Mónica Mendoza", cargo: "Ejecutivo Comercial", email: "m@x", telefono: "1" });
});

test("ejecutivo-cl.js sigue exportando lo de siempre (alias) y ya no trae el mapa estático", () => {
  const cl = require("../api/_shared/ejecutivo-cl");
  assert.equal(typeof cl.ejecutivoPorOwner, "function");
  assert.equal(typeof cl.resolverEjecutivoCL, "function");
  assert.equal(cl.EJECUTIVO_CL_DEFAULT.email, "vicky@geovictoria.com");
  const src = require("node:fs").readFileSync(require.resolve("../api/_shared/ejecutivo-cl"), "utf8");
  assert.ok(!/EJECUTIVOS_CL_POR_ID\s*=/.test(src), "el mapa estático volvió");
});

test("los PDF de PE/CO/MX firman con el humano recibido y con Vicky (+ línea del país) sin él", () => {
  const { buildProposalHtmlPE } = require("../api/_shared/proposal-html-builder-pe");
  const { buildProposalHtmlCO } = require("../api/_shared/proposal-html-builder-co");
  const { buildProposalHtmlMX } = require("../api/_shared/proposal-html-builder-mx");
  const base = { items: [], acceptanceUrl: "https://x/y", cotizacionId: "1", validezHasta: new Date().toISOString(), descuentos: { recurrentePct: 0 } };
  const humano = { nombre: "Mónica Mendoza", cargo: "Ejecutivo Comercial", email: "mmendozav@geovictoria.com", telefono: "+51 906 239 544", esVicky: false };
  const pe = buildProposalHtmlPE({ ...base, cliente: { empresa: "E", contacto: "C", ruc: "20605842055" }, ejecutivo: humano });
  assert.ok(pe.includes("Mónica Mendoza") && pe.includes("+51 906 239 544"));
  const peV = buildProposalHtmlPE({ ...base, cliente: { empresa: "E", contacto: "C", ruc: "20605842055" } });
  assert.ok(peV.includes("Vicky — Equipo Comercial") && peV.includes("+51 922 067 167") && !peV.includes("Mónica"));
  const co = buildProposalHtmlCO({ ...base, cliente: { empresa: "E", contacto: "C", nit: "900123456-8" } });
  assert.ok(co.includes("Vicky — Equipo Comercial") && !co.includes("Gordillo"));
  const mx = buildProposalHtmlMX({ ...base, cliente: { empresa: "E", contacto: "C", rfc: "XAXX010101000" } });
  assert.ok(mx.includes("Vicky — Equipo Comercial") && !mx.includes("Yahel"));
});
