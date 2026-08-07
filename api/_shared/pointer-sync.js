/**
 * Sincronización del puntero de cotización y la marca "cambios sin versionar"
 * — VÍA EL AGENTE (07-ago, caso COT341).
 *
 * Principio de Lalo: "si Vicky actualiza el PDF desde el chat, debe
 * actualizarlo en TODOS lados". La v1 de este módulo escribía directo a
 * Supabase con las credenciales del cotizador… que apuntan al proyecto de
 * ALMACENAMIENTO DE PDFs, no al de Vicky — todas las escrituras fallaban con
 * 404 en silencio. Ahora las tres operaciones viajan al endpoint puente del
 * agente (vic-admin-pdf-sync), que tiene las credenciales correctas.
 *
 * Auth: el MISMO secreto compartido (VICKY_COTIZADORA_SECRET) que el agente
 * usa para llamarnos, ahora en la dirección inversa. Best-effort: su falla
 * jamás rompe el flujo que la invoca.
 */

const AGENT_BASE = String(
  process.env.VICKY_AGENT_BASE ||
    "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app",
).trim().replace(/\/$/, "");
const SECRET = String(process.env.VICKY_COTIZADORA_SECRET || "").trim();

async function llamarPuente(quoteId, accion, pdfUrl) {
  try {
    const id = String(quoteId || "").trim();
    if (!id || !SECRET) return false;
    const res = await fetch(`${AGENT_BASE}/api/vic-admin-pdf-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vicky-secret": SECRET },
      body: JSON.stringify({ quoteId: id, accion, pdfUrl: pdfUrl || undefined }),
    });
    if (!res.ok) {
      console.warn(`[pointer-sync] puente ${accion} ${res.status} quote=${id}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[pointer-sync] puente ${accion} lanzó:`, e && e.message ? e.message : e);
    return false;
  }
}

async function actualizarPunteroPdf(quoteId, pdfUrl) {
  return llamarPuente(quoteId, "pdf", pdfUrl);
}

async function marcarPdfPendiente(quoteId) {
  return llamarPuente(quoteId, "marcar");
}

async function limpiarPdfPendiente(quoteId) {
  return llamarPuente(quoteId, "limpiar");
}

module.exports = { actualizarPunteroPdf, marcarPdfPendiente, limpiarPdfPendiente };
