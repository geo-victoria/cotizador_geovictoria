/**
 * REPARACIÓN DE MOJIBAKE — copia CommonJS de lib/mojibake.ts del agente
 * (14-sep, caso COTEL / NDV-31863). Misma regla, misma firma, mismos tests
 * de referencia; si cambia uno, cambia el otro.
 *
 * Capa DEFENSIVA del cotizador: aunque el agente ya repara la razón social al
 * leer el padrón SII, un nombre que ya viene roto desde Zoho (cuentas y
 * cotizaciones creadas antes del arreglo) no puede llegar al espejo de
 * Creator ni al nombre de una cuenta nueva, porque el generador de PDF de la
 * nota de venta se cuelga con el carácter de control que deja la doble
 * codificación.
 */

const CP1252_A_BYTE = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8A, "‹": 0x8B, "Œ": 0x8C, "Ž": 0x8E,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9A, "›": 0x9B, "œ": 0x9C, "ž": 0x9E, "Ÿ": 0x9F,
};
const CONTINUACIONES = "-¿" + Object.keys(CP1252_A_BYTE).join("");
const PAREJA = new RegExp(`[ÃÂ][${CONTINUACIONES}]`, "g");
const decoder = new TextDecoder("utf-8", { fatal: true });

function byteDe(ch) {
  const code = ch.codePointAt(0) || 0;
  return code <= 0xff ? code : CP1252_A_BYTE[ch] !== undefined ? CP1252_A_BYTE[ch] : -1;
}

function pareceMojibake(s) {
  PAREJA.lastIndex = 0;
  return PAREJA.test(String(s == null ? "" : s));
}

function repararMojibake(s) {
  const texto = String(s == null ? "" : s);
  if (!pareceMojibake(texto)) return texto;
  return texto.replace(PAREJA, (pareja) => {
    const b1 = byteDe(pareja[0]);
    const b2 = byteDe(pareja[1]);
    if (b1 < 0 || b2 < 0) return pareja;
    try {
      const out = decoder.decode(Uint8Array.from([b1, b2]));
      return /[-�]/.test(out) ? pareja : out;
    } catch {
      return pareja;
    }
  });
}

module.exports = { repararMojibake, pareceMojibake };
