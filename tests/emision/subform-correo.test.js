/**
 * Las copias de emision/ (subform por país, plantilla de correo, variantes de
 * documento) son idénticas a las funciones que hoy exportan los endpoints.
 */
const test = require("node:test");
const assert = require("node:assert");
const sub = require("../../api/_shared/emision/subform");
const docs = require("../../api/_shared/emision/documentos");
const { crearPlantillaCorreoCL } = require("../../api/_shared/emision/correo");
const { FICHA_CL, DOCS } = require("../../api/_shared/emision/fichas");

const cl = require("../../api/quote-acceptance/create-from-vicky");
const pe = require("../../api/quote-acceptance/create-from-vicky-pe");
const co = require("../../api/quote-acceptance/create-from-vicky-co");
const mx = require("../../api/quote-acceptance/create-from-vicky-mx");

const itemsCL = [
  { tipo: "modulo", id: "asistencia", nombre: "Control de Asistencia", modalidad: "Por usuario", cantidad: 15, precioUnitarioUF: 0.0675, subtotalUF: 1.0125 },
  { tipo: "hardware", id: "senseface_2a", nombre: "Reloj", modalidad: "Arriendo mensual", cantidad: 2, precioUnitarioUF: 0.35, subtotalUF: 0.7 },
  { tipo: "hardware", id: "desconocido", nombre: "Otro", modalidad: "Venta única", cantidad: 1, precioUnitarioUF: 4, subtotalUF: 4 },
  { tipo: "servicio", id: "instalacion_reloj", nombre: "Instalación", modalidad: "Cobro único", cantidad: 1, precioUnitarioUF: 1, subtotalUF: 0, descuentoPct: 100, zonaTarifa: "RM" },
  { tipo: "modulo", id: "plan_anual", nombre: "Plan anual", descripcion: "12 meses", modalidad: "Fijo", cantidad: 1, precioUnitarioUF: 7.2, subtotalUF: 7.2, oculto: true },
  { tipo: "servicio", id: "envio", nombre: "Envío", modalidad: "Pago único", cantidad: 1, precioUnitarioUF: 0.7, subtotalUF: 0.7, zonaTarifa: "regiones" },
];
const cfg = { quoteItemZonaTarifaField: "Zona_Tarifa" };

test("subform CL idéntico al exportado por create-from-vicky", () => {
  for (const uf of [0, 40851.5]) {
    assert.deepStrictEqual(sub.buildSubformItemsCL(itemsCL, uf, cfg), cl.buildSubformItems(itemsCL, uf, cfg));
    assert.deepStrictEqual(sub.buildSubformItemsCL(itemsCL, uf, {}), cl.buildSubformItems(itemsCL, uf, {}));
  }
});

function itemsPais(m) {
  return [
    { tipo: "plan", id: "plan_asistencia", nombre: "Plan", modalidad: "Fijo", cantidad: 1, [`precioUnitario${m}`]: 100.456, [`subtotal${m}`]: 100.456, esRecurrente: true, afectoIgv: true, afectoIva: false },
    { tipo: "hardware", id: "reloj_pe", nombre: "Reloj", descripcion: " SenseFace ", modalidad: "Arriendo mensual", cantidad: 2, [`precioUnitario${m}`]: 67.5, [`subtotal${m}`]: 135, esRecurrente: true, afectoIgv: true, afectoIva: true, descuentoPct: 10 },
    { tipo: "servicio", id: "envio", nombre: "Envío", modalidad: "Cobro único", cantidad: 1, [`precioUnitario${m}`]: 0, [`subtotal${m}`]: 0, esRecurrente: false, afectoIgv: true, afectoIva: true, oculto: true },
    { tipo: "modulo", id: "vacaciones", nombre: "Vacaciones", modalidad: "Por usuario", cantidad: 12, [`precioUnitario${m}`]: 3.333, [`subtotal${m}`]: 39.996, esRecurrente: true, afectoIgv: false, afectoIva: false },
  ];
}

test("subform PE/CO/MX idéntico al exportado por cada endpoint", () => {
  assert.deepStrictEqual(sub.buildSubformItemsPE(itemsPais("PEN")), pe.buildSubformItemsPE(itemsPais("PEN")));
  assert.deepStrictEqual(sub.buildSubformItemsCO(itemsPais("COP")), co.buildSubformItemsCO(itemsPais("COP")));
  assert.deepStrictEqual(sub.buildSubformItemsMX(itemsPais("MXN")), mx.buildSubformItemsMX(itemsPais("MXN")));
});

test("capacitación MX idéntica a ensureCapacitacion del endpoint", () => {
  const base = itemsPais("MXN");
  assert.deepStrictEqual(sub.ensureCapacitacionMX(base), mx.ensureCapacitacion(base));
  const con = [...base, { id: "capacitacion_x", nombre: "Capacitación", tipo: "servicio" }];
  assert.deepStrictEqual(sub.ensureCapacitacionMX(con), mx.ensureCapacitacion(con));
});

test("plantilla de correo de Chile idéntica a buildEmailHtml del endpoint", () => {
  const plantilla = crearPlantillaCorreoCL({
    fromEmail: "vicky@geovictoria.com",
    docs: { certificacion: DOCS.DOC_CERTIFICACION, fichaReloj: DOCS.DOC_FICHA_RELOJ, presentacion: DOCS.DOC_PRESENTACION },
  });
  const casos = [
    { contacto: "Juan Pérez", empresa: "ACME", pdfUrl: "https://x/p.pdf", acceptanceUrl: "https://x/a", tieneReloj: true, ejecutivo: { nombre: "", email: "", telefono: "" }, pdfAdjunto: true },
    { contacto: "", empresa: "ACME", pdfUrl: "https://x/p.pdf", acceptanceUrl: "", tieneReloj: false, ejecutivo: { nombre: "Tamara", email: "t@g.com", telefono: "+56 9 1" }, pdfAdjunto: false },
    { contacto: "Ana", empresa: "B", pdfUrl: "u", acceptanceUrl: "a", tieneReloj: true, ejecutivo: { email: "x@y.z" } },
  ];
  for (const c of casos) {
    assert.strictEqual(plantilla(c), cl.buildEmailHtml(c));
    assert.strictEqual(FICHA_CL.correo.plantilla(c), cl.buildEmailHtml(c));
  }
});

test("variantes de documento idénticas a las de cada endpoint (por fuente)", () => {
  assert.deepStrictEqual(docs.getRutVariants("18.435.922-7"), ["18.435.922-7", "184359227", "18435922-7"]);
  assert.deepStrictEqual(docs.getRutVariants("12345678-k"), ["12345678-k", "12345678K", "12345678-K", "12.345.678-K", "12345678k", "12.345.678-k"]);
  assert.deepStrictEqual(docs.getNitVariants("901.367.959-1"), ["901.367.959-1", "9013679591", "901367959-1", "901367959", "901.367.959"]);
  assert.strictEqual(docs.nitParaGuardarCO("900.624.654-1"), "900624654");
  assert.deepStrictEqual(docs.getRucVariants("20 605842055"), ["20 605842055", "20605842055"]);
  assert.deepStrictEqual(docs.getRfcVariants("cec-200528-6r4"), ["cec-200528-6r4", "CEC2005286R4"]);
  assert.strictEqual(pe.rucValido("20605842055"), docs.rucValido("20605842055"));
  assert.strictEqual(pe.esDniPE("12345678"), docs.esDniPE("12345678"));
});
