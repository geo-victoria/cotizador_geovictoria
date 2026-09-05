/**
 * ¿Este pago sigue por el ALTA POR CHAT de Vicky o por el wizard web?
 *
 * Fuente única para los tres caminos que finalizan un pago con tarjeta:
 * el poll de pago.html (status.js), el webhook de Mercado Pago y el
 * reconciliador (maybeFinalizeQuote). Nació en status.js el 05-sep (caso
 * Josefa/COT1250) y se movió acá cuando el webhook siguió creando la sesión
 * del wizard en silencio aunque el cliente fuera por chat.
 *
 * Solo Chile y solo si el agente confirma que el contacto está habilitado
 * (piloto o flag global). Cualquier duda → false (wizard, como siempre).
 */
const { toText, getRecordWithFields } = require("./zoho-crm");

const VICKY_AGENT_BASE = toText(
  process.env.VICKY_AGENT_BASE || "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app",
).replace(/\/$/, "");
const VICKY_SHARED_SECRET = toText(process.env.VICKY_COTIZADORA_SECRET || "");
const _chatOnboardingCache = new Map();

/**
 * ¿Este pago sigue por el alta por chat de Vicky? Solo Chile y solo si el
 * agente confirma que el contacto está habilitado (piloto o flag global).
 * Cualquier duda → false (wizard, como siempre). Cache por cotización: el
 * poll de pago.html pega cada pocos segundos.
 */
async function onboardingPorChat(acceptanceConfig, quoteId, pais) {
  try {
    if (toText(pais).toLowerCase() && toText(pais).toLowerCase() !== "cl") return false;
    if (!VICKY_SHARED_SECRET) return false;
    const key = toText(quoteId);
    if (_chatOnboardingCache.has(key)) return _chatOnboardingCache.get(key);
    const q = await getRecordWithFields(acceptanceConfig.quoteModule, quoteId, ["Tel_fono_Contacto"]);
    const fono = toText(q?.Tel_fono_Contacto).replace(/\D/g, "");
    if (!/^569\d{8}$/.test(fono)) { _chatOnboardingCache.set(key, false); return false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${VICKY_AGENT_BASE}/api/vic-onboarding-activo?contact=${fono}`, {
      headers: { "x-vicky-secret": VICKY_SHARED_SECRET },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const data = res.ok ? await res.json().catch(() => ({})) : {};
    const activo = Boolean(data?.activo);
    _chatOnboardingCache.set(key, activo);
    if (activo) console.log(`[onboarding-chat] onboarding por CHAT de Vicky para quote=${key} fono=${fono}: sin wizard`);
    return activo;
  } catch (e) {
    console.warn(`[onboarding-chat] onboardingPorChat falló (sigue wizard): ${toText(e?.message || e)}`);
    return false;
  }
}

module.exports = { onboardingPorChat };
