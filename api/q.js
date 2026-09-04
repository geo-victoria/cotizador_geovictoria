/**
 * GET /q/<quoteId>-<firma> — link corto de aceptación, para los botones de URL
 * dinámica de las plantillas de WhatsApp (el link real lleva un token JWT
 * demasiado largo para una variable de plantilla de Meta).
 *
 * La firma es HMAC-SHA256(quoteId, VICKY_COTIZADORA_SECRET) truncado a 10 hex:
 * el quoteId solo no basta para redirigir (no se puede enumerar cotizaciones),
 * y sin almacenar nada — la firma se recalcula en cada visita.
 *
 * Redirige 302 a URL_Aceptacion_Web de la cotización (el mismo link de
 * siempre: la página sigue leyendo los datos en vivo).
 *
 * ── UNA CAÍDA DE ZOHO NO PUEDE BORRARLE LA COTIZACIÓN AL CLIENTE (04-sep) ──
 *
 * Antes este archivo tenía un `catch` que respondía 404 a cualquier cosa que
 * saliera mal. Para el cliente eso es indistinguible de "tu cotización no
 * existe": abre el link que le mandamos por WhatsApp y le dice que no está.
 * Y las caídas de Zoho del 01 y del 03 de septiembre duraron horas.
 *
 * Ahora se separan tres cosas que antes eran la misma:
 *   - link mal formado o firma inválida  → 404 (nunca existió)
 *   - Zoho responde que no está          → 404 (de verdad no está)
 *   - Zoho no responde                   → 503 y una página que dice la
 *                                          verdad: es un problema nuestro,
 *                                          momentáneo, vuelve a intentar.
 *
 * Y encima un CACHÉ del destino en vic_kv: la mayoría de las visitas dejan de
 * pegarle a Zoho, y si Zoho se cae, un link ya visitado sigue funcionando con
 * lo último que sabemos (el destino de una cotización no cambia).
 */

const crypto = require("crypto");
const { zohoApiFetch } = require("./_shared/zoho-auth");
const { toText } = require("./_shared/zoho-crm");
const { getAcceptanceConfig } = require("./_shared/quote-acceptance-config");
const { kvSupabase } = require("./_shared/kv-supabase");

// El destino de una cotización no cambia salvo que se regenere el token de
// aceptación, así que 6 h es conservador. Se refresca solo al vencer.
const CACHE_HORAS = 6;
// Colchón para el modo degradado: aunque la entrada esté vencida, sirve para
// responder mientras Zoho no está. Vale mil veces más que un error.
const CACHE_RESCATE_DIAS = 30;

async function leerCache(quoteId) {
  const c = kvSupabase();
  if (!c) return null;
  try {
    const r = await fetch(
      `${c.url}/rest/v1/vic_kv?key=eq.qlink_${encodeURIComponent(quoteId)}&select=value,expires_at&limit=1`,
      { headers: c.headers },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.value) return null;
    const venceMs = Date.parse(row.expires_at);
    // `vigente` distingue el camino feliz del rescate: una entrada vencida NO
    // se usa con Zoho sano (podría estar desactualizada), pero sí con Zoho
    // caído, donde la alternativa es dejar al cliente sin nada.
    return { url: String(row.value), vigente: Number.isFinite(venceMs) && Date.now() < venceMs };
  } catch (_e) {
    return null;
  }
}

async function guardarCache(quoteId, url) {
  const c = kvSupabase();
  if (!c) return;
  try {
    await fetch(`${c.url}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        key: `qlink_${quoteId}`,
        value: url,
        // expires_at marca la VIGENCIA para el camino feliz; la fila se borra
        // sola mucho después, para que siga sirviendo de rescate.
        expires_at: new Date(Date.now() + CACHE_HORAS * 3600e3).toISOString(),
      }),
    });
  } catch (_e) {
    /* best-effort: sin caché el link funciona igual, solo pega más a Zoho */
  }
}

function paginaCaida(res) {
  res.statusCode = 503;
  // Retry-After: le dice al navegador (y a cualquier robot) que esto se
  // resuelve solo. Un 404 en cambio invita a darse por vencido.
  res.setHeader("Retry-After", "60");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Un momento, por favor</title>
<style>
  :root{color-scheme:light}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f5f7fa;color:#1f2933;
       font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .caja{max-width:26rem;padding:2.5rem 2rem;text-align:center}
  h1{font-size:1.35rem;margin:0 0 .75rem;font-weight:650}
  p{margin:0 0 1rem;color:#52606d}
  .btn{display:inline-block;margin-top:.5rem;padding:.7rem 1.4rem;border-radius:8px;
       background:#00AFF2;color:#fff;text-decoration:none;font-weight:600}
</style></head><body><div class="caja">
<h1>Estamos teniendo un problema momentáneo</h1>
<p>Tu cotización está bien: no podemos mostrarla en este instante por una falla
temporal de nuestros sistemas.</p>
<p>Vuelve a intentar en un par de minutos. Si sigue igual, escríbenos por el
mismo WhatsApp y te la reenviamos al tiro.</p>
<a class="btn" href="">Reintentar</a>
</div></body></html>`);
}

module.exports = async function handler(req, res) {
  const code = String((req.query && req.query.c) || "").trim();
  const m = code.match(/^(\d{5,25})-([0-9a-f]{10})$/i);
  const secret = toText(process.env.VICKY_COTIZADORA_SECRET);
  // Formato o secreto ausente: no hay nada que resolver, y no es transitorio.
  if (!m || !secret) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  const quoteId = m[1];
  const firma = m[2].toLowerCase();
  const esperada = crypto.createHmac("sha256", secret).update(quoteId).digest("hex").slice(0, 10);
  if (firma !== esperada) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const redirigir = (url) => {
    res.statusCode = 302;
    res.setHeader("Location", url);
    res.setHeader("Cache-Control", "no-store");
    res.end();
  };

  const cache = await leerCache(quoteId);
  if (cache && cache.vigente) {
    redirigir(cache.url);
    return;
  }

  try {
    const config = getAcceptanceConfig(req);
    const r = await zohoApiFetch(`/crm/v3/${config.quoteModule}/${encodeURIComponent(quoteId)}`, {
      method: "GET",
    });
    // 204 = Zoho contestó bien y el registro NO está (borrado o inexistente).
    // Ese sí es un 404 honesto.
    if (r.status === 204) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (!r.ok) throw new Error(`Zoho HTTP ${r.status}`);
    const payload = await r.json().catch(() => null);
    const quote = Array.isArray(payload?.data) ? payload.data[0] : null;
    const url = toText(quote && quote.URL_Aceptacion_Web);
    if (!url) {
      // La cotización existe pero todavía no tiene link de aceptación. Ese
      // campo NO se escribe al crear la cotización: va en una actualización
      // posterior, así que hay una ventana en que existe sin destino. Si la
      // cotización es RECIÉN nacida, esto es una carrera y se resuelve sola en
      // segundos — tratarla como "no existe" sería mentirle al cliente. Si ya
      // es vieja, es un problema de datos de verdad y ahí sí 404.
      const nacida = Date.parse(toText(quote && quote.Created_Time));
      const recien = Number.isFinite(nacida) && Date.now() - nacida < 30 * 60 * 1000;
      if (recien) {
        console.warn(`[q] ${quoteId} sin URL de aceptación todavía (emitida hace poco) — se pide reintentar`);
        paginaCaida(res);
        return;
      }
      console.error(`[q] ${quoteId} existe pero no tiene URL de aceptación`);
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    await guardarCache(quoteId, url);
    redirigir(url);
  } catch (e) {
    // ZOHO NO RESPONDE. Si alguna vez resolvimos este link, ese destino sigue
    // siendo válido: se usa aunque esté vencido. Es la diferencia entre que el
    // cliente pague y que crea que su cotización desapareció.
    if (cache && cache.url) {
      console.warn(`[q] Zoho caído — se sirve destino cacheado de ${quoteId}: ${String(e && e.message || e)}`);
      redirigir(cache.url);
      return;
    }
    console.error(`[q] Zoho caído y sin caché para ${quoteId}: ${String(e && e.message || e)}`);
    paginaCaida(res);
  }
};
