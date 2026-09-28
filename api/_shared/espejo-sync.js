/**
 * COTIZACIÓN DE CREATOR AL DÍA CON LA DE VICKY (Lalo 28-sep, caso Patricio /
 * Condominio Terrazas COT1202: pasó de reloj a solo app 5 minutos antes de
 * pagar y la nota de venta salió con el reloj, porque el borrador de Creator
 * se había creado en la emisión y nadie lo tocó al actualizar).
 *
 * Cada vez que la cotización cambia (actualizar, aplicar descuento, anualizar,
 * confirmar la versión del editor), se pide en segundo plano a
 * `ndv-alta-chat` en modo `soloEspejo`: ubica el borrador, lo diagnostica
 * contra los ítems vigentes y, si no calza, lo anula y crea uno nuevo. Nunca
 * convierte nada. Si la cotización ya tiene su nota de venta enlazada, no
 * toca nada. Best-effort: jamás frena la respuesta al cliente.
 */
const { toText } = require("./zoho-crm");

function dispararSyncEspejo(quoteId, pais, origen) {
  const id = toText(quoteId).replace(/\D/g, "");
  if (!id) return Promise.resolve();
  if (String(process.env.ESPEJO_SYNC_AL_ACTUALIZAR || "on").toLowerCase() === "off") return Promise.resolve();
  const base = toText(process.env.COTIZADOR_SELF_BASE) || "https://cotizacion.geovictoria.com";
  const secreto = toText(process.env.VICKY_COTIZADORA_SECRET);
  const ctl = new AbortController();
  // El trabajo pesado corre en ndv-alta-chat (y su propio self-request);
  // acá solo se espera lo justo para que el encargo salga.
  const t = setTimeout(() => ctl.abort(), 20_000);
  return fetch(`${base}/api/creator/ndv-alta-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vicky-secret": secreto, "User-Agent": "Mozilla/5.0 vicky-espejo-sync" },
    body: JSON.stringify({ quoteId: id, soloEspejo: true, ...(pais && pais !== "cl" ? { pais } : {}) }),
    signal: ctl.signal,
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      const regen = j?.nuevo ? ` → borrador regenerado ${toText(j.nuevo?.ndvId)}` : j?.diag?.regenerar === false ? " (ya estaba al día)" : "";
      console.log(`[espejo-sync] ${origen || "?"} quote=${id} status=${r.status}${regen}`);
    })
    .catch((e) => {
      if (e?.name !== "AbortError") console.warn(`[espejo-sync] ${origen || "?"} quote=${id}: ${toText(e?.message || e).slice(0, 160)}`);
    })
    .finally(() => clearTimeout(t));
}

// Programa el sync para después de responder (waitUntil de Vercel); sin él,
// lo lanza sin esperar. Nunca lanza excepción.
function programarSyncEspejo(quoteId, pais, origen) {
  try {
    const p = dispararSyncEspejo(quoteId, pais, origen);
    let wu = null;
    try { ({ waitUntil: wu } = require("@vercel/functions")); } catch { wu = null; }
    if (typeof wu === "function") wu(p);
  } catch (e) {
    console.warn(`[espejo-sync] ${origen || "?"}: ${String(e?.message || e).slice(0, 160)}`);
  }
}

module.exports = { dispararSyncEspejo, programarSyncEspejo };
