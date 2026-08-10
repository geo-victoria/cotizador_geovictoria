/**
 * VIGENCIA DEL DESCUENTO POR COTIZACIÓN (Lalo 10-ago).
 *
 * Los "6 meses" del descuento sobre el plan eran una constante global del
 * repo: el ejecutivo no podía acortarla, alargarla ni dejarla indefinida
 * (caso Cigpa/Anderson, cotización 3525045000646859011). Ahora cada
 * cotización lleva su propia vigencia.
 *
 * Dónde vive el dato:
 *   1. Campo de Zoho, si existe y está configurado por env
 *      (QUOTE_DISCOUNT_MESES_FIELD, p. ej. "Descuento_Meses"). Es el hogar
 *      natural — deja el dato a la vista del ejecutivo en el CRM.
 *   2. Si el campo no existe todavía, vic_kv del proyecto de Vicky
 *      (`descuento_meses_<quoteId>`) a través del PUENTE del agente: el
 *      cotizador no tiene credenciales de ese Supabase (cicatriz COT341),
 *      así que usa el mismo endpoint que ya sincroniza los punteros de PDF.
 *
 * Semántica: null/"" = política por defecto (6 meses) · 0 = INDEFINIDO · N =
 * N meses. Todo best-effort: si el puente falla, la cotización sigue con la
 * política por defecto y nadie ve un error.
 */

const AGENT_BASE = String(
  process.env.VICKY_AGENT_BASE ||
    "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app",
).trim().replace(/\/$/, "");
const SECRET = String(process.env.VICKY_COTIZADORA_SECRET || "").trim();

/** API name del campo de Zoho, si el equipo ya lo creó. Vacío = no se usa. */
function campoZohoMeses() {
  return String(process.env.QUOTE_DISCOUNT_MESES_FIELD || "").trim();
}

function normalizar(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Math.trunc(Number(valor));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 120);
}

/** Lee la vigencia guardada. Devuelve null si la cotización no tiene una propia. */
async function leerMesesDescuento(quoteId, quote) {
  const campo = campoZohoMeses();
  if (campo && quote && quote[campo] !== undefined && quote[campo] !== null && quote[campo] !== "") {
    const delCrm = normalizar(quote[campo]);
    if (delCrm !== null) return delCrm;
  }
  const id = String(quoteId || "").trim();
  if (!id || !SECRET) return null;
  try {
    const res = await fetch(`${AGENT_BASE}/api/vic-admin-pdf-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vicky-secret": SECRET },
      body: JSON.stringify({ quoteId: id, accion: "meses_get" }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return normalizar(data && data.meses);
  } catch (e) {
    console.warn("[descuento-meses] lectura por puente falló:", e && e.message ? e.message : e);
    return null;
  }
}

/**
 * Guarda la vigencia. `meses` null → borra la marca (vuelve a la política por
 * defecto). Devuelve los campos extra que el caller debe incluir en su
 * updateRecord de Zoho (vacío si el campo del CRM no está configurado).
 */
async function guardarMesesDescuento(quoteId, meses) {
  const id = String(quoteId || "").trim();
  const valor = meses === null || meses === undefined ? null : normalizar(meses);
  if (id && SECRET) {
    try {
      await fetch(`${AGENT_BASE}/api/vic-admin-pdf-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vicky-secret": SECRET },
        body: JSON.stringify({ quoteId: id, accion: "meses_set", meses: valor }),
      });
    } catch (e) {
      console.warn("[descuento-meses] escritura por puente falló:", e && e.message ? e.message : e);
    }
  }
  const campo = campoZohoMeses();
  if (!campo) return {};
  return { [campo]: valor === null ? null : valor };
}

module.exports = { leerMesesDescuento, guardarMesesDescuento, campoZohoMeses };
