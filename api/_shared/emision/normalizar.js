/**
 * Adaptadores del CONTRATO del agente al contrato normalizado de la emisión.
 *
 * El contrato normalizado ES el de Chile (anidado: cliente / cotizacion /
 * existing / escalonDescuento / draft / sinCorreoCliente / leadSource / cc).
 * Diferencias deliberadas respecto del chileno para los otros países:
 *   - `cliente.rutEmpresa` lleva el documento tributario del país (RUC/DNI,
 *     NIT, RFC) tal como lo mandó el agente; la ficha decide cómo se guarda.
 *   - Los ítems conservan SUS campos de monto (precioUnitarioPEN/COP/MXN,
 *     subtotal…, esRecurrente, afectoIgv/afectoIva): la ficha los nombra en
 *     `moneda.campos` y el constructor del subform del país los entiende.
 *   - `cotizacion.total<MONEDA>` se calcula acá como hoy lo calcula cada
 *     endpoint (con el impuesto de las líneas afectas), después de aplicar la
 *     fila especial del país (quitar Activación / agregar Capacitación MX).
 *   - `extras` = datos del país que no son del contrato chileno (tipo de
 *     cambio del reloj en Perú).
 *
 * El agente NO cambia: cada endpoint normaliza lo que ya recibe. La clave de
 * idempotencia se sigue calculando sobre el body CRUDO (emitir.js).
 */
const { toText } = require("../zoho-crm");
const { DISCOUNT_LADDER } = require("../proposal-constants");

/** Chile: el contrato ya es el normalizado (misma referencia, sin copia). */
function normalizarCL(body) {
  return body;
}

function escalonAcotado(v) {
  return Math.max(0, Math.min(DISCOUNT_LADDER.length, Math.floor(Number(v) || 0)));
}

function totalConImpuesto(items, { subtotal, afecto }, impuesto) {
  return items.reduce((acc, it) => {
    const s = Number(it[subtotal] || 0);
    return acc + s + (it[afecto] === true ? s * impuesto : 0);
  }, 0);
}

function crearNormalizadorPais({ campoDocumento, redondearTotal = (n) => n }) {
  return function normalizarPais(body, ficha) {
    const crudos = Array.isArray(body.items) ? body.items : [];
    const items = ficha.subform.prepararItems ? ficha.subform.prepararItems(crudos) : crudos;
    const total = redondearTotal(
      totalConImpuesto(items, { subtotal: ficha.moneda.campos.subtotal, afecto: ficha.moneda.afecto }, ficha.moneda.impuesto),
    );
    return {
      cliente: {
        empresa: toText(body.empresa),
        contacto: toText(body.contacto),
        contactoEmail: toText(body.contactoEmail) || undefined,
        rutEmpresa: toText(body[campoDocumento]),
        ...(body.tipoDocumento ? { tipoDocumento: toText(body.tipoDocumento) } : {}),
        contactoTelefono: toText(body.contactoTelefono),
        userCount: Number(body.userCount) > 0 ? Number(body.userCount) : undefined,
      },
      cotizacion: {
        items,
        [ficha.moneda.campos.total]: total,
      },
      existing: {},
      escalonDescuento: escalonAcotado(body.escalonDescuento),
      ...(Array.isArray(body.cc) ? { cc: body.cc } : {}),
      extras: {
        ...(Number(body.tipoCambio) > 0 ? { tipoCambio: Number(body.tipoCambio) } : {}),
        ...(toText(body.tipoCambioFuente) ? { tipoCambioFuente: toText(body.tipoCambioFuente) } : {}),
      },
    };
  };
}

const normalizarPE = crearNormalizadorPais({ campoDocumento: "ruc" });
const normalizarCO = crearNormalizadorPais({ campoDocumento: "nit" });
const normalizarMX = crearNormalizadorPais({
  campoDocumento: "rfc",
  redondearTotal: (n) => Math.round(Number(n || 0) * 100) / 100,
});

const NORMALIZADORES = { cl: normalizarCL, pe: normalizarPE, co: normalizarCO, mx: normalizarMX };

module.exports = { normalizarCL, normalizarPE, normalizarCO, normalizarMX, NORMALIZADORES, escalonAcotado };
