/**
 * RESPALDO DE LA COTIZACIÓN — que una caída de Zoho no le borre la cotización
 * al cliente (04-sep).
 *
 * La página de aceptación y el estado de pago dependen de UNA lectura de Zoho:
 * la cotización. Todo lo demás (dueño, ficha del ejecutivo) ya está protegido y
 * cae a Vicky si falla. Esa única lectura, si falla, tumba la página entera: el
 * cliente ve "No se pudo cargar la cotización" y se va. Pasó 6 veces entre el
 * 31-ago y el 3-sep, y 21 veces en la página de pago, todo por el límite de
 * renovaciones de credencial de Zoho.
 *
 * ── POR QUÉ RESPALDO Y NO CACHÉ ──
 *
 * La tentación es cachear y ahorrarse la llamada. NO se hace, a propósito:
 * una cotización cambia (el ejecutivo aplica un descuento, se actualiza, se
 * anualiza) y servir un precio viejo a un cliente que está por pagar es peor
 * que la caída que queremos evitar. Además el volumen de llamadas nunca fue el
 * problema — el cupo diario de Zoho no lo rozamos.
 *
 * Entonces: SIEMPRE se le pregunta a Zoho. La copia se guarda de paso y solo
 * se usa cuando Zoho no responde. Con eso no hay precio viejo posible en
 * operación normal, y no hace falta invalidar nada en ninguna parte (que es
 * donde estos diseños se rompen: basta olvidar un punto de invalidación para
 * empezar a mentirle al cliente).
 *
 * La copia vive 45 días: más que la vigencia comercial de 30, para que una
 * cotización todavía viva jamás quede sin respaldo.
 */

const { getRecord } = require("./zoho-crm");
const { kvSupabase } = require("./kv-supabase");

const DIAS_RESPALDO = 45;

function clave(quoteId) {
  return `qcache_${String(quoteId || "").replace(/\D/g, "")}`;
}

async function leerRespaldo(quoteId) {
  const c = kvSupabase();
  if (!c) return null;
  try {
    const r = await fetch(
      `${c.url}/rest/v1/vic_kv?key=eq.${encodeURIComponent(clave(quoteId))}&select=value&limit=1`,
      { headers: c.headers },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.value) return null;
    return JSON.parse(row.value);
  } catch (_e) {
    return null;
  }
}

async function guardarRespaldo(quoteId, quote) {
  const c = kvSupabase();
  if (!c || !quote) return;
  try {
    await fetch(`${c.url}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        key: clave(quoteId),
        value: JSON.stringify(quote),
        expires_at: new Date(Date.now() + DIAS_RESPALDO * 86400e3).toISOString(),
      }),
    });
  } catch (_e) {
    /* best-effort: sin respaldo el flujo es exactamente el de antes */
  }
}

/**
 * Lee la cotización de Zoho. Si Zoho no responde y hay copia, devuelve la
 * copia. Si no hay copia, propaga el error igual que antes (no inventamos
 * nada: sin dato no hay página, y eso ya se maneja arriba).
 *
 * Devuelve { quote, degradado } — `degradado` en true significa que el dato
 * viene del respaldo, para poder medirlo en los registros.
 */
async function getQuoteConRespaldo(moduleApiName, quoteId) {
  try {
    const quote = await getRecord(moduleApiName, quoteId);
    // El guardado NO bloquea la respuesta al cliente.
    guardarRespaldo(quoteId, quote).catch(() => {});
    return { quote, degradado: false };
  } catch (error) {
    const copia = await leerRespaldo(quoteId);
    if (copia) {
      console.warn(
        `[respaldo] Zoho no respondió por ${quoteId} — se sirve la copia guardada: ${String(error && error.message || error).slice(0, 160)}`,
      );
      return { quote: copia, degradado: true };
    }
    throw error;
  }
}

module.exports = { getQuoteConRespaldo, leerRespaldo, guardarRespaldo };
