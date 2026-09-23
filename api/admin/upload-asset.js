/**
 * Endpoint ADMIN: POST /api/admin/upload-asset
 *
 * Sube (upsert) un asset empaquetado del repo (api/_shared/assets/) al storage
 * público de Supabase (bucket cotizaciones-pdf, carpeta assets/). Sirve para
 * actualizar documentos comerciales — ej. la presentación que va linkeada en el
 * correo de la cotización formal — SIN cambiar su URL pública
 * (https://cotizacion.geovictoria.com/pdf/assets/<archivo>), de modo que los
 * links de correos YA enviados también muestren la versión nueva.
 *
 * Flujo de actualización: reemplazar el PDF en api/_shared/assets/, deployar,
 * y llamar este endpoint una vez con {"asset": "<archivo>"}.
 *
 * Auth: header x-admin-secret == env ASSETS_ADMIN_SECRET, o el secreto
 * compartido del agente (x-vicky-secret, secreto-vicky.js) — así el agente
 * puede empujar un asset por su proxy admin sin una segunda clave (23-sep).
 */
const fs = require("fs");
const path = require("path");
const { secretoValido } = require("../_shared/secreto-vicky");

// Solo los assets conocidos: nada de paths arbitrarios hacia el bucket.
const PERMITIDOS = new Set([
  "presentacion-comercial.pdf",
  "certificacion-dt.pdf",
  "ficha-reloj-senseface.pdf",
  // Senseface 4A, reloj estándar de Vicky Chile desde el 23-sep-2026.
  "ficha-reloj-senseface-4a.pdf",
]);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "método no permitido" });
  }
  const secret = String(process.env.ASSETS_ADMIN_SECRET || "").trim();
  const provided = String(req.headers["x-admin-secret"] || "").trim();
  const porAdmin = Boolean(secret) && provided === secret;
  const porVicky = String(req.headers["x-vicky-secret"] || "").trim() !== "" && secretoValido(req);
  if (!porAdmin && !porVicky) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const asset = String((req.body && req.body.asset) || "").trim();
  if (!PERMITIDOS.has(asset)) {
    return res.status(400).json({ ok: false, error: "asset no permitido", permitidos: [...PERMITIDOS] });
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(503).json({ ok: false, error: "faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY" });
  }

  let buf;
  try {
    buf = fs.readFileSync(path.join(__dirname, "..", "_shared", "assets", asset));
  } catch (e) {
    return res.status(500).json({ ok: false, error: `no se pudo leer el asset del bundle: ${e.message}` });
  }

  const uploadResp = await fetch(`${supabaseUrl}/storage/v1/object/cotizaciones-pdf/assets/${asset}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/pdf",
      // Upsert: reemplaza el objeto existente (el Smart CDN de Supabase
      // invalida la copia cacheada al detectar la nueva versión).
      "x-upsert": "true",
      "Cache-Control": "public, max-age=3600",
    },
    body: buf,
  });
  const detail = await uploadResp.text().catch(() => "");
  if (!uploadResp.ok) {
    return res.status(502).json({ ok: false, status: uploadResp.status, detail: detail.slice(0, 300) });
  }
  return res.status(200).json({ ok: true, asset, bytes: buf.length });
};
