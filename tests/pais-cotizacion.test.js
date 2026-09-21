const test = require("node:test");
const assert = require("node:assert/strict");
const {
  paisDeCotizacion,
  paisConPerfil,
  subformAItemsPais,
  validarItemsPais,
  descuentoDisponible,
  errorDescuentoNoDisponible,
  buildMensajeNegociacionPais,
  fmtMonto,
} = require("../api/_shared/pais-cotizacion");

const config = {
  quoteAcceptanceUrlField: "URL_Aceptacion_Web",
  quoteItemsSubformField: "Detalle_Items_Cotizacion",
};

function tokenCon(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `https://cotizacion.geovictoria.com/quote-acceptance.html?token=${encodeURIComponent(`${b64}.firma`)}`;
}

test("paisDeCotizacion: el país sale del token; sin país es Chile", () => {
  assert.equal(paisDeCotizacion({ URL_Aceptacion_Web: tokenCon({ quoteId: "1", pais: "pe" }) }, config), "pe");
  assert.equal(paisDeCotizacion({ URL_Aceptacion_Web: tokenCon({ quoteId: "1", pais: "co" }) }, config), "co");
  assert.equal(paisDeCotizacion({ URL_Aceptacion_Web: tokenCon({ quoteId: "1" }) }, config), "cl");
  assert.equal(paisDeCotizacion({}, config), "cl");
  assert.equal(paisConPerfil("pe"), true);
  assert.equal(paisConPerfil("cl"), false);
  assert.equal(paisConPerfil("mx"), false);
});

test("subformAItemsPais PE: filas del CRM → ítems en soles con la forma del contrato PE (ocultas fuera)", () => {
  const quote = {
    Detalle_Items_Cotizacion: [
      { id: "a", Codigo_Item: "plan_asistencia", Nombre_Item: "Plan de asistencia (16 personas)", Cantidad: 16, Precio_Unitario_UF: 5.5, Subtotal_UF: 88, Modalidad: "Recurrente", Es_Recurrente: true, Afecto_IVA: true, Categoria_Item: "Plataforma Asistencia" },
      { id: "b", Codigo_Item: "reloj_pe", Nombre_Item: "Reloj de control (arriendo)", Cantidad: 1, Precio_Unitario_UF: 67, Subtotal_UF: 67, Modalidad: "Arriendo", Es_Recurrente: true, Afecto_IVA: true, Categoria_Item: "Equipos Biometricos" },
      { id: "c", Codigo_Item: "plan_anual", Nombre_Item: "Oculta", Cantidad: 1, Precio_Unitario_UF: 0, Subtotal_UF: 0, Modalidad: "Recurrente", Es_Recurrente: true, Afecto_IVA: true, Metadata_Item_JSON: "{\"oculto\":true}" },
    ],
  };
  const items = subformAItemsPais("pe", quote, config);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    tipo: "plan", id: "plan_asistencia", nombre: "Plan de asistencia (16 personas)", descripcion: "", modalidad: "por usuario",
    cantidad: 16, esRecurrente: true, precioUnitarioPEN: 5.5, subtotalPEN: 88, afectoIgv: true,
  });
  assert.equal(items[1].tipo, "hardware");
  assert.equal(items[1].modalidad, "arriendo");
  assert.equal(items[1].subtotalPEN, 67);
  assert.equal(validarItemsPais("pe", items), null);
});

test("subformAItemsPais CO: COP enteros y afectoIva", () => {
  const quote = {
    Detalle_Items_Cotizacion: [
      { Codigo_Item: "plan_asistencia", Nombre_Item: "Plan", Cantidad: 14, Precio_Unitario_UF: 13700, Subtotal_UF: 191800, Modalidad: "Recurrente", Es_Recurrente: true, Afecto_IVA: false, Categoria_Item: "Plataforma Asistencia" },
      { Codigo_Item: "activacion", Nombre_Item: "Activación", Cantidad: 1, Precio_Unitario_UF: 191800, Subtotal_UF: 191800, Modalidad: "Único", Es_Recurrente: false, Afecto_IVA: false },
    ],
  };
  const items = subformAItemsPais("co", quote, config);
  assert.equal(items[0].precioUnitarioCOP, 13700);
  assert.equal(items[0].afectoIva, false);
  assert.equal(items[1].tipo, "activacion");
  assert.equal(validarItemsPais("co", items), null);
});

test("validarItemsPais: nombra el campo que falta en la moneda del país", () => {
  assert.match(validarItemsPais("pe", [{ nombre: "x", cantidad: 1, esRecurrente: true, afectoIgv: true }]), /precioUnitarioPEN/);
  assert.match(validarItemsPais("co", [{ nombre: "x", cantidad: 1, precioUnitarioCOP: 1, subtotalCOP: 1, esRecurrente: true }]), /afectoIva/);
  assert.match(validarItemsPais("pe", []), /items requerido/);
});

test("descuento: CL, PE y CO tienen escalera (Lalo 21-sep); MX responde claro sin afirmar rebajas", () => {
  assert.equal(descuentoDisponible("cl"), true);
  assert.equal(descuentoDisponible("pe"), true);
  assert.equal(descuentoDisponible("co"), true);
  assert.equal(descuentoDisponible("mx"), false);
  const e = errorDescuentoNoDisponible("mx");
  assert.equal(e.ok, false);
  assert.equal(e.error, "DESCUENTO_NO_DISPONIBLE_MX");
  assert.equal(e.tope_alcanzado, true);
  assert.match(e.detail, /M[eé]xico/);
});

test("Colombia: el descuento rebaja el plan y la Activación, el alquiler va a lista; mensaje en precios finales", () => {
  const { computeTotalsCO, computePaymentAmountsCO } = require("../api/_shared/quote-pricing");
  // 14 personas: plan 191.800 · Activación 191.800 · alquiler 86.000 (+IVA 19 %).
  const items = [
    { nombre: "Control de Asistencia", cantidad: 14, precioUnitarioClp: 13700, subtotalClp: 191800, modalidad: "Por usuario", afectoIva: false, codigo: "plan_asistencia" },
    { nombre: "Alquiler de equipo biométrico", cantidad: 1, precioUnitarioClp: 86000, subtotalClp: 86000, modalidad: "Arriendo mensual", afectoIva: true, codigo: "reloj_arriendo" },
    { nombre: "Activación", cantidad: 1, precioUnitarioClp: 191800, subtotalClp: 191800, modalidad: "Venta", afectoIva: false, codigo: "activacion" },
  ];
  const sin = computeTotalsCO(items);
  assert.equal(sin.pagoInicialCop, 191800);
  assert.equal(sin.mensualidadCop, 191800 + 86000 + Math.round(86000 * 0.19));
  assert.equal(sin.descuentoPct, 0);
  const con = computeTotalsCO(items, { recurrentePct: 10 });
  assert.equal(con.pagoInicialCop, 172620); // Activación con el 10 %
  assert.equal(con.mensualidadCop, 172620 + 86000 + Math.round(86000 * 0.19)); // el alquiler no baja
  assert.equal(con.descuentoPlanNetoCop, 19180);
  assert.equal(con.mensualidadListaCop, sin.mensualidadCop);
  const amounts = computePaymentAmountsCO(items, { recurrentePct: 10 });
  assert.equal(amounts.oneShotClp, 172620);
  assert.equal(amounts.descuentoPct, 10);
  const msg = buildMensajeNegociacionPais("co", { pct: 10, condicionDiscursiva: null }, amounts, false, { esPrimerDescuentoPlan: true, mesesPlan: 6 });
  assert.match(msg, /10% de descuento sobre el plan mensual/);
  assert.doesNotMatch(msg, /\+ IVA|\+ IGV/);
  assert.match(msg, /\$172\.620/);
  assert.match(msg, /primeros 6 meses; desde el mes 7/);
});

test("mensaje de negociación PE: NETO + IGV, jamás 'IVA incluido' ni aritmética del impuesto", () => {
  // Forma REAL de computePaymentAmountsPE: oneShotNetClp = solo únicos (0 en
  // solo-software) y firstMonthNetClp = el primer mes; el pago inicial neto
  // vive en pe.pagoInicialNetoPen. Sin sumar salía "pago inicial S/0".
  const amounts = {
    oneShotClp: 176.41, recurringClp: 176.41,
    descuentos: { recurrentePct: 10 },
    breakdown: { oneShotNetClp: 0, firstMonthNetClp: 149.5, recurringNetClp: 149.5 },
    pe: { pagoInicialNetoPen: 149.5 },
  };
  const msg = buildMensajeNegociacionPais("pe", { pct: 10, condicionDiscursiva: null }, amounts, false, { esPrimerDescuentoPlan: true, mesesPlan: 6 });
  assert.match(msg, /10% de descuento sobre el plan mensual/);
  assert.match(msg, /S\/149\.50 \+ IGV al mes/);
  assert.doesNotMatch(msg, /IVA incluido|IGV incluido|18%/);
  assert.match(msg, /primeros 6 meses; desde el mes 7/);
  assert.match(msg, /¿Lo cerramos\?$/);
  // Con pago inicial distinto (reloj en venta): dice ambos, en neto.
  const conUnico = { ...amounts, breakdown: { oneShotNetClp: 303, firstMonthNetClp: 149.5, recurringNetClp: 149.5 }, pe: { pagoInicialNetoPen: 452.5 } };
  const msg2 = buildMensajeNegociacionPais("pe", { pct: 20, condicionDiscursiva: "Aplica hoy." }, conUnico, true, { conciso: true, esPrimerDescuentoPlan: false });
  assert.match(msg2, /S\/149\.50 \+ IGV al mes \(pago inicial S\/452\.50 \+ IGV\)/);
  assert.match(msg2, /Aplica hoy\. De verdad es el mejor precio/);
  assert.doesNotMatch(msg2, /primeros 6 meses/);
  assert.equal(fmtMonto("pe", 82.5), "S/82.50");
  assert.equal(fmtMonto("pe", 1234), "S/1,234");
});
