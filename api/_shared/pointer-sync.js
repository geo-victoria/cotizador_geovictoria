/**
 * Sincronización del puntero de cotización en Supabase (vic_v3_quote_pointers).
 *
 * Principio de Lalo (07-ago): "si Vicky es capaz de actualizar el PDF desde el
 * chat, debe actualizarlo en TODOS lados". El puntero es lo que leen el dash
 * (links "📄 cotización"), la tool de envío por WhatsApp y la propia Vicky en
 * la conversación — si solo se actualiza el PDF_URL de Zoho, esos caminos
 * quedan apuntando a la versión vieja.
 *
 * Se llama en CADA lugar donde se escribe un PDF nuevo (emisión, edición,
 * regeneración, descuentos, backfill). Best-effort: su falla jamás rompe el
 * flujo que la invoca.
 */

async function actualizarPunteroPdf(quoteId, pdfUrl) {
  try {
    const url = String(process.env.SUPABASE_URL || "").trim();
    const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    const id = String(quoteId || "").trim();
    const pdf = String(pdfUrl || "").trim();
    if (!url || !key || !id || !pdf) return false;
    const res = await fetch(
      `${url}/rest/v1/vic_v3_quote_pointers?quote_id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ pdf_url: pdf, updated_at: new Date().toISOString() }),
      },
    );
    if (!res.ok) {
      console.warn(`[pointer-sync] PATCH ${res.status} quote=${id}`);
      return false;
    }
    await limpiarPdfPendiente(id);
    return true;
  } catch (e) {
    console.warn("[pointer-sync] lanzó:", e && e.message ? e.message : e);
    return false;
  }
}

// ── Marca de "cambios sin versionar" (flujo confirmar-una-vez, Lalo 07-ago) ──
// La edición por chat NO genera PDF por cada cambio: deja esta marca. La
// confirmación (o cualquier regeneración real) la limpia. El envío por
// WhatsApp solo regenera si la marca está puesta.

function kvHeaders() {
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function marcarPdfPendiente(quoteId) {
  try {
    const url = String(process.env.SUPABASE_URL || "").trim();
    if (!url || !quoteId) return;
    await fetch(`${url}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...kvHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key: `pdf_dirty_${quoteId}`, value: new Date().toISOString() }),
    });
  } catch (e) {
    console.warn("[pointer-sync] marcarPdfPendiente:", e && e.message ? e.message : e);
  }
}

async function limpiarPdfPendiente(quoteId) {
  try {
    const url = String(process.env.SUPABASE_URL || "").trim();
    if (!url || !quoteId) return;
    await fetch(`${url}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`pdf_dirty_${quoteId}`)}`, {
      method: "DELETE",
      headers: kvHeaders(),
    });
  } catch (e) {
    console.warn("[pointer-sync] limpiarPdfPendiente:", e && e.message ? e.message : e);
  }
}

module.exports = { actualizarPunteroPdf, marcarPdfPendiente, limpiarPdfPendiente };
