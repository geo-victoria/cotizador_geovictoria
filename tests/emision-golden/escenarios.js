"use strict";
/**
 * Escenarios de la prueba de identidad de las emisiones por país.
 * Cada uno es {nombre, req, escenario, env} y se corre contra el handler del
 * país. Los cuerpos son los CONTRATOS reales del agente (claves *PEN/*COP/*MXN,
 * afectoIgv/afectoIva, ruc/nit/rfc).
 */

const PLAN = {
  pe: { tipo: "plan", id: "plan_asistencia", nombre: "Plan Asistencia (16 personas)", modalidad: "Por usuario", cantidad: 16, precioUnitarioPEN: 5.5, subtotalPEN: 88, esRecurrente: true, afectoIgv: true },
  co: { tipo: "plan", id: "plan_asistencia", nombre: "Plan Asistencia (14 personas)", modalidad: "Por usuario", cantidad: 14, precioUnitarioCOP: 13700, subtotalCOP: 191800, esRecurrente: true, afectoIva: false },
  mx: { tipo: "plan", id: "plan_asistencia", nombre: "Plan Asistencia (8 personas)", modalidad: "Fijo", cantidad: 1, precioUnitarioMXN: 1200, subtotalMXN: 1200, esRecurrente: true, afectoIva: true },
};
const RELOJ = {
  pe: [
    { tipo: "hardware", id: "reloj_pe", nombre: "Reloj de control (arriendo)", modalidad: "Arriendo", cantidad: 1, precioUnitarioPEN: 67, subtotalPEN: 67, esRecurrente: true, afectoIgv: true },
    { tipo: "servicio", id: "instalacion_reloj", nombre: "Instalación técnica (Miraflores)", modalidad: "Cobro único", cantidad: 1, precioUnitarioPEN: 0, subtotalPEN: 0, esRecurrente: false, afectoIgv: true, descuentoPct: 100, zonaTarifa: "base" },
  ],
  co: [
    { tipo: "hardware", id: "reloj_arriendo", nombre: "Equipo biométrico (alquiler)", modalidad: "Arriendo", cantidad: 1, precioUnitarioCOP: 86000, subtotalCOP: 86000, esRecurrente: true, afectoIva: true },
    { tipo: "servicio", id: "instalacion_reloj", nombre: "Instalación técnica (Bogotá)", modalidad: "Cobro único", cantidad: 1, precioUnitarioCOP: 175000, subtotalCOP: 0, esRecurrente: false, afectoIva: false, descuentoPct: 100, zonaTarifa: "base" },
  ],
  mx: [
    { tipo: "hardware", id: "reloj_renta", nombre: "Reloj checador (renta)", modalidad: "Arriendo", cantidad: 1, precioUnitarioMXN: 350, subtotalMXN: 350, esRecurrente: true, afectoIva: true },
    { tipo: "servicio", id: "envio_reloj", nombre: "Envío (CDMX)", modalidad: "Cobro único", cantidad: 1, precioUnitarioMXN: 0, subtotalMXN: 0, esRecurrente: false, afectoIva: true, zonaTarifa: "base" },
  ],
};
const ACTIVACION = {
  pe: { tipo: "activacion", id: "activacion", nombre: "Activación", modalidad: "Cobro único", cantidad: 1, precioUnitarioPEN: 88, subtotalPEN: 88, esRecurrente: false, afectoIgv: true },
  co: { tipo: "activacion", id: "activacion", nombre: "Activación", modalidad: "Cobro único", cantidad: 1, precioUnitarioCOP: 191800, subtotalCOP: 191800, esRecurrente: false, afectoIva: false },
};

const BASE = {
  pe: { empresa: "PRUEBA VICKY PE SAC", contacto: "Ana Prueba", contactoTelefono: "51900000777", ruc: "20605842055", userCount: 16 },
  co: { empresa: "PRUEBA VICKY CO SAS", contacto: "Ana Prueba", contactoTelefono: "579000000777", nit: "901.367.959-1", userCount: 14 },
  mx: { empresa: "PRUEBA VICKY MX SA DE CV", contacto: "Ana Prueba", contactoTelefono: "5290000007777", rfc: "PVM200528AB1", userCount: 8 },
};

function cuerpo(cc, extra = {}, items) {
  return { ...BASE[cc], items: items || [PLAN[cc]], ...extra };
}

function escenariosDe(cc) {
  const docMalo = { pe: { ruc: "20605842050" }, co: {}, mx: { rfc: "XX" } }[cc];
  const lista = [
    { nombre: "plan_solo", req: { body: cuerpo(cc) } },
    {
      nombre: "reloj_descuento_correo",
      req: { body: cuerpo(cc, { contactoEmail: "cliente@prueba.test", escalonDescuento: 1, ...(cc === "pe" ? { tipoCambio: 3.372, tipoCambioFuente: "sunat" } : {}) }, [PLAN[cc], ...RELOJ[cc]]) },
    },
    {
      nombre: "activacion_legada",
      req: { body: cuerpo(cc, {}, ACTIVACION[cc] ? [PLAN[cc], ACTIVACION[cc]] : [PLAN[cc]]) },
    },
    {
      nombre: "reintento_idempotente",
      req: { body: cuerpo(cc) },
      escenario: { idempotente: { quoteId: "q-previa", dealId: "d-previo", accountId: "a-previa", contactId: "c-previo" } },
    },
    { nombre: "cuenta_existente_por_documento", req: { body: cuerpo(cc) }, escenario: { cuentaPorDocumento: "acc-existente" } },
    { nombre: "cuenta_duplicada_al_crear", req: { body: cuerpo(cc) }, escenario: { duplicarCuenta: true } },
    { nombre: "lead_first_falla", req: { body: cuerpo(cc) }, escenario: { leadFirst: null } },
    { nombre: "deal_del_candado_kv", req: { body: cuerpo(cc) }, escenario: { dealPorFono: { dealId: "deal-kv", origen: "hito" } } },
    { nombre: "faltan_campos", req: { body: { ...cuerpo(cc), contacto: "" } } },
    { nombre: "item_invalido", req: { body: cuerpo(cc, {}, [{ ...PLAN[cc], cantidad: 0 }]) } },
    { nombre: "sin_items", req: { body: cuerpo(cc, {}, []) } },
    { nombre: "sin_secreto", req: { body: cuerpo(cc), headers: { "x-vicky-secret": "malo" } } },
    { nombre: "metodo_get", req: { method: "GET", body: {} } },
    { nombre: "options", req: { method: "OPTIONS", body: {}, headers: { origin: "https://cotizacion.geovictoria.com" } } },
  ];
  if (cc === "pe") {
    lista.push({ nombre: "ruc_invalido", req: { body: cuerpo(cc, docMalo) } });
    lista.push({ nombre: "dni_persona", req: { body: cuerpo(cc, { ruc: "12345678", tipoDocumento: "DNI", empresa: "Ana Prueba" }) } });
  }
  if (cc === "mx") lista.push({ nombre: "rfc_raro_se_acepta", req: { body: cuerpo(cc, docMalo) } });
  return lista;
}

const HANDLERS = {
  pe: "api/quote-acceptance/create-from-vicky-pe.js",
  co: "api/quote-acceptance/create-from-vicky-co.js",
  mx: "api/quote-acceptance/create-from-vicky-mx.js",
};

module.exports = { escenariosDe, HANDLERS, PAISES: ["pe", "co", "mx"] };
