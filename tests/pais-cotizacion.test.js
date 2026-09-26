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
  assert.equal(paisConPerfil("mx"), true); // 24-sep: México entra al perfil único
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

test("descuento: los 4 países tienen escalera (CL/PE/CO 21-sep, MX 24-sep); el error sigue nombrando el país", () => {
  for (const p of ["cl", "pe", "co", "mx"]) assert.equal(descuentoDisponible(p), true);
  const e = errorDescuentoNoDisponible("mx");
  assert.equal(e.ok, false);
  assert.equal(e.error, "DESCUENTO_NO_DISPONIBLE_MX");
  assert.match(e.detail, /M[eé]xico/);
});

test("México (Lalo 24-sep): 10 % solo en el plan, renta a lista, mensaje NETO + IVA y PDF con la rebaja", () => {
  const { previewAmountsPais, renderHtmlPais } = require("../api/_shared/pais-cotizacion");
  assert.equal(paisConPerfil("mx"), true);
  const quote = {
    Detalle_Items_Cotizacion: [
      { Codigo_Item: "plan_asistencia", Nombre_Item: "Plan Asistencia", Categoria_Item: "Plataforma Asistencia", Modalidad: "Recurrente", Cantidad: 16, Precio_Unitario_UF: 83, Subtotal_UF: 1328, Precio_Unitario_CLP: 83, Subtotal_CLP: 1328, Es_Recurrente: true, Afecto_IVA: true },
      { Codigo_Item: "reloj_mx", Nombre_Item: "Reloj checador", Categoria_Item: "Equipos Biometricos", Modalidad: "Arriendo", Cantidad: 1, Precio_Unitario_UF: 350, Subtotal_UF: 350, Precio_Unitario_CLP: 350, Subtotal_CLP: 350, Es_Recurrente: true, Afecto_IVA: true },
    ],
  };
  const items = subformAItemsPais("mx", quote, config);
  assert.equal(items[0].precioUnitarioMXN, 83);
  assert.equal(validarItemsPais("mx", items), null);
  const a = previewAmountsPais("mx", quote, config, { recurrentePct: 10 });
  // 1,328 × 0.9 = 1,195.20 + 350 de renta a lista = 1,545.20 neto
  assert.equal(a.mx.mensualidadNetaMxn, 1545.2);
  const msg = buildMensajeNegociacionPais("mx", { pct: 10 }, a, false);
  assert.match(msg, /\$1,545\.20 \+ IVA al mes/);
  assert.equal(fmtMonto("mx", 1200), "$1,200");
  const html = renderHtmlPais("mx", {
    cliente: { empresa: "Prueba SA de CV", contacto: "Ana", documento: "XAXX010101000" },
    items, acceptanceUrl: "https://x", cotizacionId: "COT1", validezHasta: new Date().toISOString(), version: 2,
    descuentos: { recurrentePct: 10 }, mesesDescuento: 6,
  });
  assert.match(html, /Descuento 10 % en el plan \(6 meses\)/);
  assert.match(html, /Desde el mes 7/);
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
  assert.equal(con.pagoInicialCop, 172620); // Activación legada con el 10 % (= primer mes)
  assert.equal(con.conActivacionLegada, true);
  // SIN fila de Activación (emisión desde el 23-sep): pago inicial = únicos + primer mes,
  // con el descuento del plan, misma mecánica que Chile y Perú (computeTotalsPais).
  const sinAct = computeTotalsCO(items.filter((r) => r.codigo !== "activacion"), { recurrentePct: 10 });
  assert.equal(sinAct.conActivacionLegada, false);
  assert.equal(sinAct.unicosCop, 0);
  assert.equal(sinAct.primerMesNetoCop, 172620 + 86000);
  assert.equal(sinAct.primerMesIvaCop, Math.round(86000 * 0.19));
  assert.equal(sinAct.pagoInicialCop, 172620 + 86000 + Math.round(86000 * 0.19));
  assert.equal(sinAct.mensualidadCop, sinAct.pagoInicialCop);
  const amountsSin = computePaymentAmountsCO(items.filter((r) => r.codigo !== "activacion"), { recurrentePct: 10 });
  assert.equal(amountsSin.includeFirstMonth, true);
  assert.equal(amountsSin.firstMonthClp, sinAct.primerMesCop);
  assert.equal(amountsSin.oneShotItemsClp, 0);
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

test("anualidad PE/CO (Lalo 21-sep): el subform persiste oculto + Descuento_Pct y CO no fabrica Activación con plan_anual", () => {
  const { buildSubformItemsPais } = require("../api/_shared/pais-cotizacion");
  const itemsCO = [
    { tipo: "servicio", id: "plan_anual", nombre: "Plan anual — 12 meses anticipados (14 personas)", modalidad: "Cobro único", cantidad: 1, precioUnitarioCOP: 2301600, subtotalCOP: 2301600, esRecurrente: false, afectoIva: false },
    { tipo: "plan", id: "plan_asistencia", nombre: "Control de Asistencia", modalidad: "Por usuario", cantidad: 14, precioUnitarioCOP: 0, subtotalCOP: 0, esRecurrente: true, afectoIva: false, oculto: true },
    { tipo: "servicio", id: "envio", nombre: "Envío", modalidad: "Cobro único", cantidad: 1, precioUnitarioCOP: 20000, subtotalCOP: 20000, esRecurrente: false, afectoIva: false, descuentoPct: 100 },
  ];
  const rowsCO = buildSubformItemsPais("co", itemsCO);
  assert.equal(rowsCO.length, 3, "sin fila de Activación agregada");
  assert.ok(!rowsCO.some((r) => /activaci/i.test(r.Nombre_Item)));
  const anualCO = rowsCO.find((r) => r.Codigo_Item === "plan_anual");
  assert.equal(anualCO.Modalidad, "Venta");
  assert.equal(anualCO.Es_Recurrente, false);
  assert.equal(anualCO.Metadata_Item_JSON, undefined);
  const ocultaCO = rowsCO.find((r) => r.Codigo_Item === "plan_asistencia");
  assert.equal(ocultaCO.Metadata_Item_JSON, JSON.stringify({ oculto: true }));
  assert.equal(ocultaCO.Es_Recurrente, true);
  assert.equal(ocultaCO.Subtotal_UF, 0);
  assert.equal(rowsCO.find((r) => r.Codigo_Item === "envio").Descuento_Pct, 100);
  // Sin plan_anual, CO TAMPOCO fabrica la Activación (23-sep, patrón CL en los dos países).
  const rowsCOnormal = buildSubformItemsPais("co", [
    { tipo: "plan", id: "plan_asistencia", nombre: "Control de Asistencia", modalidad: "Por usuario", cantidad: 14, precioUnitarioCOP: 6850, subtotalCOP: 95900, esRecurrente: true, afectoIva: false },
    { tipo: "activacion", id: "activacion", nombre: "Activación", modalidad: "Cobro único", cantidad: 1, precioUnitarioCOP: 95900, subtotalCOP: 95900, esRecurrente: false, afectoIva: false },
  ]);
  assert.equal(rowsCOnormal.length, 1, "la fila de Activación que manda un agente viejo se descarta");
  assert.ok(!rowsCOnormal.some((r) => /activaci/i.test(r.Nombre_Item)));
});

test("computeTotalsPE vive (IGV 18 %): la constante IGV_RATE_PE se borró una vez y la sesión PE respondía 500", () => {
  const { computeTotalsPE, computePaymentAmountsPE } = require("../api/_shared/quote-pricing");
  // Anualidad: plan_anual único (S/792) + plan mensual oculto en 0.
  const items = [
    { nombre: "Plan anual — 12 meses anticipados", cantidad: 1, precioUnitarioClp: 792, subtotalClp: 792, modalidad: "Venta", afectoIva: true, codigo: "plan_anual" },
    { nombre: "Control de Asistencia", cantidad: 12, precioUnitarioClp: 0, subtotalClp: 0, modalidad: "Por usuario", afectoIva: true, codigo: "plan_asistencia", oculto: true },
  ];
  const t = computeTotalsPE(items, { recurrentePct: 0 });
  assert.equal(t.pagoInicialNetoPen, 792);
  assert.equal(t.pagoInicialIgvPen, 142.56);
  assert.equal(t.pagoInicialPen, 934.56);
  assert.equal(t.mensualidadPen, 0);
  const a = computePaymentAmountsPE(items, {});
  assert.equal(a.oneShotClp, 934.56);
  assert.equal(a.firstMonthClp, 0);
  // Mensual normal: 16 × 5,5 = 88 neto → 103,84 con IGV, inicial = primer mes.
  const m = computeTotalsPE([{ nombre: "Plan de asistencia (16 personas)", cantidad: 16, precioUnitarioClp: 5.5, subtotalClp: 88, modalidad: "Por usuario", afectoIva: true, codigo: "plan_asistencia" }], {});
  assert.equal(m.pagoInicialPen, 103.84);
  assert.equal(m.mensualidadPen, 103.84);
});

test("anualidad MX (26-sep, igualemos a Chile): subform con oculto y el PDF habla de pago anual", () => {
  const { buildSubformItemsPais } = require("../api/_shared/pais-cotizacion");
  const { buildProposalHtmlMX } = require("../api/_shared/proposal-html-builder-mx");
  const items = [
    { tipo: "servicio", id: "plan_anual", nombre: "Plan anual — 12 meses anticipados (12 personas)", modalidad: "Cobro único", cantidad: 1, precioUnitarioMXN: 14400, subtotalMXN: 14400, esRecurrente: false, afectoIva: true },
    { tipo: "plan", id: "plan_asistencia", nombre: "Control de Asistencia", modalidad: "Fijo", cantidad: 1, precioUnitarioMXN: 0, subtotalMXN: 0, esRecurrente: true, afectoIva: true, oculto: true },
  ];
  const rows = buildSubformItemsPais("mx", items);
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[1].Metadata_Item_JSON).oculto, true);
  assert.equal(rows[0].Metadata_Item_JSON, undefined);
  const html = buildProposalHtmlMX({ items, cliente: {}, numeroCotizacion: "1", fecha: "26-09-2026", acceptanceUrl: "#" });
  assert.match(html, /Pago anual — al aceptar \(12 meses anticipados\)/);
  assert.doesNotMatch(html, /Primer mes del servicio/);
  assert.doesNotMatch(html, /Control de Asistencia/);
});
