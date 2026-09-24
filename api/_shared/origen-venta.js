// ORIGEN DE LA VENTA — regla única (Lalo 08/09/24-sep).
//
// Una cotización es "iniciada por Vicky" cuando:
//   (a) la emitió Vicky (Intervenci_n_Humana = "100% Vicky"; sin marca = emisión
//       de Vicky en PE/CO/MX o anterior al 19-ago → se trata como de Vicky), o
//   (b) la emitió un ejecutivo como REEMISIÓN/ACTUALIZACIÓN de una cotización
//       '100% Vicky' anterior del mismo deal o del mismo teléfono (caso UDES,
//       Clínica Talca), o
//   (c) Vicky MOSTRÓ PRECIO en el chat antes de la emisión ejecutiva (caso GSL).
// Todo lo demás es venta del ejecutivo "desde cero".
//
// La usan el correo ACEPTADA/PAGADA (sufijo de canal) y la página de pago
// (qué correo se muestra para la transferencia: Vicky si la inició ella, el
// ejecutivo si cotizó desde cero — Lalo 24-sep). Best-effort: si una consulta
// falla, se queda con lo que dice la marca de la emisión.

const { toText, getRecordWithFields, coqlQuery } = require("./zoho-crm");

const AGENT_NOTIFY_URL = toText(process.env.VICKY_AGENT_NOTIFY_URL);
const AGENT_CRON_SECRET = toText(process.env.VICKY_AGENT_CRON_SECRET);

const CAMPOS = ["Intervenci_n_Humana", "Deal_Asociado", "Tel_fono_Contacto", "Created_Time"];
const _cache = new Map(); // pago.html hace poll de /status: se cachea 10 min por cotización.

/**
 * @returns {Promise<{deVicky: boolean, canal: "vicky"|"ejecutivo"|"", reemision: boolean, motivo: string}>}
 */
async function origenDeVenta({ quoteModule, quote, quoteId }) {
  const id = toText(quoteId || quote?.id);
  const hit = id ? _cache.get(id) : null;
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.r;

  let q = quote || {};
  if (id && CAMPOS.some((c) => q[c] === undefined)) {
    const fresco = await getRecordWithFields(quoteModule, id, CAMPOS).catch(() => null);
    if (fresco) q = { ...fresco, ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)) };
  }
  const marca = toText(q?.Intervenci_n_Humana);
  const canalMarca = /100%\s*Vicky/i.test(marca) ? "vicky" : /intervenci/i.test(marca) ? "ejecutivo" : "";

  let r;
  if (canalMarca !== "ejecutivo") {
    r = { deVicky: true, canal: canalMarca, reemision: false, motivo: canalMarca ? "emision_vicky" : "sin_marca" };
  } else {
    r = { deVicky: false, canal: "ejecutivo", reemision: false, motivo: "ejecutivo_desde_cero" };
    const dealId = toText(q?.Deal_Asociado?.id || q?.Deal_Asociado).replace(/\D/g, "");
    const tel9 = toText(q?.Tel_fono_Contacto).replace(/\D/g, "").slice(-9);
    if (dealId || tel9.length === 9) {
      try {
        const creadaMs = Date.parse(toText(q?.Created_Time));
        const partes = [
          dealId ? `Deal_Asociado = '${dealId}'` : "",
          tel9.length === 9 ? `Tel_fono_Contacto like '%${tel9}%'` : "",
        ].filter(Boolean);
        const cond = partes.length === 2 ? `(${partes[0]} or ${partes[1]})` : partes[0];
        const res = await coqlQuery(
          `select id, Numero_Cotizacion, Created_Time from ${quoteModule} where (${cond} and Intervenci_n_Humana = '100% Vicky') limit 20`,
        );
        const filas = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
        const previas = filas.filter((x) => {
          if (String(x.id) === id) return false;
          const cMs = Date.parse(toText(x.Created_Time));
          return !Number.isFinite(creadaMs) || !Number.isFinite(cMs) || cMs <= creadaMs;
        });
        if (previas.length) {
          r = {
            deVicky: true,
            canal: "vicky",
            reemision: true,
            motivo: `reemision_de_${previas.map((x) => x.Numero_Cotizacion || x.id).join(",")}`,
          };
        }
      } catch (e) {
        console.warn(`[origen-venta] reemisión no verificable para ${id}: ${e.message}`);
      }
      if (!r.deVicky && tel9.length === 9 && AGENT_NOTIFY_URL && AGENT_CRON_SECRET) {
        try {
          const base = new URL(AGENT_NOTIFY_URL).origin;
          const tel = toText(q?.Tel_fono_Contacto).replace(/\D/g, "").replace(/^5656/, "56");
          const rp = await fetch(
            `${base}/api/vic-precio-mostrado?tel=${encodeURIComponent(tel)}&antes=${encodeURIComponent(toText(q?.Created_Time))}`,
            { headers: { "x-cron-secret": AGENT_CRON_SECRET }, signal: AbortSignal.timeout(6000) },
          );
          const jp = rp.ok ? await rp.json().catch(() => ({})) : {};
          if (jp && jp.mostrado === true) {
            r = { deVicky: true, canal: "vicky", reemision: true, motivo: `precio_mostrado_${toText(jp.at)}` };
          }
        } catch (e) {
          console.warn(`[origen-venta] precio mostrado no verificable para ${id}: ${e.message}`);
        }
      }
    }
  }
  if (id) _cache.set(id, { r, at: Date.now() });
  return r;
}

module.exports = { origenDeVenta };
