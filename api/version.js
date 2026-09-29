/**
 * GET /api/version — qué commit está sirviendo este deployment.
 *
 * Misma forma que /api/version del agente (24-sep): sirve para verificar un
 * deploy sin sondear una funcionalidad que el build anterior también contesta
 * (cicatriz 12/13-sep). Público y sin secretos: NO expone el mensaje del
 * commit (lleva nombres de clientes).
 */
const ARRANQUE = new Date().toISOString();

module.exports = function handler(req, res) {
  const sha = String(process.env.VERCEL_GIT_COMMIT_SHA || "");
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(
    JSON.stringify({
      ok: true,
      app: "cotizador",
      commit: sha || null,
      commitCorto: sha ? sha.slice(0, 7) : null,
      rama: process.env.VERCEL_GIT_COMMIT_REF || null,
      entorno: process.env.VERCEL_ENV || "local",
      region: process.env.VERCEL_REGION || null,
      arranque: ARRANQUE,
      ahora: new Date().toISOString(),
    }),
  );
};
