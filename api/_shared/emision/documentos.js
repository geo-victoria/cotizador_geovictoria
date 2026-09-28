/**
 * Documento tributario de la EMPRESA por país (RUT · RUC/DNI · NIT · RFC).
 *
 * Copias literales de lo que hoy hace cada endpoint: variantes para la dedup
 * de cuentas por COQL, validación y formato con que se GUARDA en cuenta y
 * cotización. Las fichas (fichas.js) eligen qué función usa cada país.
 */

// ── CHILE: RUT (espejo de lib/zoho-search.ts del agente) ──
// "18.435.922-7" → ["18.435.922-7", "184359227", "18435922-7"].
function getRutVariants(rut) {
  if (!rut) return [];
  const raw = String(rut).trim();
  if (!raw) return [];
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  if (compact.length < 2) return [raw];
  const cuerpo = compact.slice(0, -1);
  const dv = compact.slice(-1);
  const cuerpoConPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const variantes = [
    raw,
    compact,
    `${cuerpo}-${dv}`,
    `${cuerpoConPuntos}-${dv}`,
  ];
  // DV "K": variantes en minúscula por si quedó guardado como "k".
  if (dv === "K") {
    variantes.push(`${cuerpo}k`, `${cuerpo}-k`, `${cuerpoConPuntos}-k`);
  }
  return Array.from(new Set(variantes)).filter(Boolean);
}

// ── PERÚ: RUC (11 dígitos, DV SUNAT) o DNI (8 dígitos) ──
function rucValido(rucRaw) {
  const ruc = String(rucRaw || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(ruc)) return false;
  if (!/^(10|15|16|17|20)/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(ruc[i]), 0);
  const resto = 11 - (suma % 11);
  const dv = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return dv === Number(ruc[10]);
}

function esDniPE(docRaw) {
  return /^\d{8}$/.test(String(docRaw || "").replace(/\D/g, ""));
}

function rucParaGuardar(ruc) {
  return String(ruc || "").replace(/\D/g, "");
}

function getRucVariants(ruc) {
  const raw = String(ruc || "").trim();
  if (!raw) return [];
  const compact = raw.replace(/\D/g, "");
  return Array.from(new Set([raw, compact])).filter(Boolean);
}

// ── COLOMBIA: NIT (la cuenta lo guarda SIN DV, convención Ana María 30-jul) ──
function getNitVariants(nit) {
  if (!nit) return [];
  const raw = String(nit).trim();
  if (!raw) return [];
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  if (compact.length < 2) return [raw];
  const cuerpo = compact.slice(0, -1);
  const dv = compact.slice(-1);
  const cuerpoConPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const variantes = [
    raw,
    compact,
    `${cuerpo}-${dv}`,
    `${cuerpoConPuntos}-${dv}`,
    cuerpo,
    cuerpoConPuntos,
  ];
  return Array.from(new Set(variantes)).filter(Boolean);
}

function nitParaGuardarCO(nit) {
  return String(nit || "").trim().replace(/[.\s]/g, "").replace(/-[0-9kK]$/i, "");
}

// ── MÉXICO: RFC (12-13 caracteres; solo se advierte) ──
function getRfcVariants(rfc) {
  if (!rfc) return [];
  const raw = String(rfc).trim();
  if (!raw) return [];
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  return Array.from(new Set([raw, compact])).filter(Boolean);
}

function rfcPareceValido(rfc) {
  const compact = String(rfc || "").replace(/[.\s-]/g, "").toUpperCase();
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(compact);
}

// ── Claves de comparación (guardas de "¿es la misma empresa?") ──
// Guarda de RUT del deal y de la cuenta adoptada (CL): solo dígitos y K.
function claveSoloDigitosK(v) {
  return String(v || "").replace(/[^0-9kK]/g, "").toUpperCase();
}
// Capa 4 de Chile: quita puntos, espacios y guiones.
function claveSinSeparadores(v) {
  return String(v || "").replace(/[.\s-]/g, "").toUpperCase();
}

const identidad = (v) => v;

module.exports = {
  getRutVariants,
  rucValido,
  esDniPE,
  rucParaGuardar,
  getRucVariants,
  getNitVariants,
  nitParaGuardarCO,
  getRfcVariants,
  rfcPareceValido,
  claveSoloDigitosK,
  claveSinSeparadores,
  identidad,
};
