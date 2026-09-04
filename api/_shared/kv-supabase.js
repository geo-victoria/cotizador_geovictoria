/**
 * CREDENCIALES DE LA BASE DONDE VIVE vic_kv (04-sep).
 *
 * El cotizador tiene DOS Supabase distintos y hasta hoy los confundía:
 *
 *  - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY apuntan al proyecto
 *    `onboarding_db`, donde está el bucket `cotizaciones-pdf` — ahí se guardan
 *    los PDF de las propuestas. Ese proyecto NO tiene la tabla vic_kv.
 *  - vic_kv vive en el proyecto del AGENTE (`geovictoria-whatsapp`), y es una
 *    tabla COMPARTIDA por los dos repos: ahí van la credencial de Zoho que se
 *    reusa entre instancias y los candados que evitan deals/cotizaciones
 *    gemelas (el agente escribe la reserva, el cotizador la lee antes de
 *    crear).
 *
 * Con las dos cosas mezcladas, todo lo que este repo escribía en vic_kv se iba
 * contra una tabla inexistente: 404 tragado por el try/catch, cero efecto. Por
 * eso la credencial compartida nunca apareció y el candado cruzado nunca vio
 * las reservas del agente.
 *
 * Ahora la parte de vic_kv usa SUS PROPIAS variables (KV_SUPABASE_*) y solo
 * cae a las de siempre si no están configuradas — así el repo sigue
 * comportándose igual mientras las variables no existan, y el día que se
 * agreguen queda apuntando a la base correcta sin más cambios.
 */

function texto(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** { url, key, headers } de la base de vic_kv, o null si no hay credenciales. */
function kvSupabase() {
  const url = (texto(process.env.KV_SUPABASE_URL) || texto(process.env.SUPABASE_URL)).replace(/\/$/, "");
  const key =
    texto(process.env.KV_SUPABASE_SERVICE_ROLE_KEY) || texto(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  return {
    url,
    key,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  };
}

/** true si vic_kv está en su propia base (no en la de los PDF). */
function kvEnBaseDedicada() {
  return Boolean(texto(process.env.KV_SUPABASE_URL) && texto(process.env.KV_SUPABASE_SERVICE_ROLE_KEY));
}

module.exports = { kvSupabase, kvEnBaseDedicada };
