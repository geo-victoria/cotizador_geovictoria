/**
 * GET/POST /api/quote-acceptance/correos-pendientes
 *
 * BARRIDO DETERMINISTA DE CORREOS DE COTIZACIÓN (orden Lalo 01-sep: "ese
 * correo debe salir sí o sí si tenemos el correo").
 *
 * Contexto: desde la regla "el RUT basta" (31-ago) la formal se emite aunque
 * el cliente no haya dado correo — y cuando el correo llega DESPUÉS (lo manda
 * por chat, lo captura la aceptación, lo trae una actualización), nadie
 * mandaba la cotización a ese correo. Peor: el modelo llegó a AFIRMAR un
 * envío que nunca ocurrió (caso METAL ORGÁNICO / COT1063, 01-sep).
 *
 * Este barrido caza cotizaciones del canal Vicky (100% Vicky) en estado
 * "Enviada", con Email_Contacto poblado y SIN ningún correo salido hacia ese
 * email, y les dispara el correo propio (misma plantilla de continuación del
 * chat de reenviar-cotizacion). Idempotente: el correo enviado queda en la
 * related list Emails de la cotización, y esa lista es el candado — la
 * próxima pasada lo ve y salta.
 *
 * Solo canal Vicky: el canal ejecutivo suprime el correo A PROPÓSITO
 * (sinCorreoCliente) y aquí se respeta. Solo estado Enviada: una Aceptada o
 * Pagada ya no necesita el correo de cotización.
 *
 * Cron de Vercel cada 15 min (vercel.json) + disparo manual con Bearer
 * CRON_SECRET o x-vicky-secret.
 */

const { getRecordWithFields, toText } = require("../_shared/zoho-crm");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { secretoValido } = require("../_shared/secreto-vicky");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { enviarCorreoPropioDeCotizacion } = require("./reenviar-cotizacion");

const BUDGET_MS = 45000;
const MAX_ENVIOS_POR_PASADA = 8;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  if (secretoValido(req)) return true;
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  return Boolean(cronSecret) && bearer === cronSecret;
}

/** true si la cotización ya tiene ALGÚN correo salido hacia ese email. */
async function yaLeSalioCorreo(quoteModule, quoteId, email) {
  const r = await zohoApiFetch(
    `/crm/v3/${encodeURIComponent(quoteModule)}/${encodeURIComponent(quoteId)}/Emails`,
    { method: "GET" },
  );
  if (r.status === 204) return false;
  if (!r.ok) throw new Error(`Emails related list ${r.status}`);
  const data = await r.json().catch(() => ({}));
  const emails = Array.isArray(data?.Emails) ? data.Emails : [];
  const low = String(email).trim().toLowerCase();
  return emails.some((e) =>
    (Array.isArray(e?.to) ? e.to : []).some(
      (t) => String(t?.email || "").trim().toLowerCase() === low,
    ),
  );
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  const inicio = Date.now();
  try {
    const config = getAcceptanceConfig(req);
    const url = new URL(req.url, "http://x");
    const horas = Math.min(24 * 14, Math.max(1, Number(url.searchParams.get("horas")) || 48));
    const desde = new Date(Date.now() - horas * 3600 * 1000);
    // Offset fijo -04:00: COQL exige datetime con zona; una hora de holgura
    // por el cambio de hora chileno no afecta (la ventana es amplia).
    const desdeIso = desde.toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const coql = await zohoApiFetch(`/crm/v3/coql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        select_query:
          `select id, Numero_Cotizacion, ${config.contactEmailField} from ${config.quoteModule} ` +
          `where Created_Time > '${desdeIso}' and Intervenci_n_Humana = '100% Vicky' ` +
          `and ${config.quoteStatusField} = 'Enviada' and ${config.contactEmailField} is not null ` +
          `order by Created_Time desc limit 50`,
      }),
    });
    if (coql.status === 204) return sendJson(res, 200, { ok: true, revisadas: 0, enviadas: [] });
    if (!coql.ok) throw new Error(`COQL ${coql.status}`);
    const filas = ((await coql.json().catch(() => ({}))).data) || [];

    const enviadas = [];
    const saltadas = [];
    const errores = [];
    let revisadas = 0;
    for (const fila of filas) {
      if (Date.now() - inicio > BUDGET_MS || enviadas.length >= MAX_ENVIOS_POR_PASADA) break;
      revisadas += 1;
      const quoteId = String(fila.id);
      const numero = toText(fila.Numero_Cotizacion) || quoteId;
      const email = toText(fila[config.contactEmailField]).trim();
      try {
        if (await yaLeSalioCorreo(config.quoteModule, quoteId, email)) {
          saltadas.push(numero);
          continue;
        }
        const quote = await getRecordWithFields(config.quoteModule, quoteId, [
          "Numero_Cotizacion",
          config.quotePdfUrlField,
          config.contactEmailField,
          "Cuenta_Asociada",
          "Contacto_Asociado",
          "Owner",
        ]);
        if (!quote) { errores.push(`${numero}: no encontrada`); continue; }
        const r = await enviarCorreoPropioDeCotizacion({ config, quote, quoteId, email });
        if (r.ok) enviadas.push(`${numero} → ${email}`);
        else errores.push(`${numero}: ${r.error}`);
      } catch (e) {
        errores.push(`${numero}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    console.log(
      `[correos-pendientes] revisadas=${revisadas}/${filas.length} enviadas=${enviadas.length} saltadas=${saltadas.length} errores=${errores.length}`,
    );
    return sendJson(res, 200, { ok: true, horas, candidatas: filas.length, revisadas, enviadas, saltadas, errores });
  } catch (error) {
    console.error("[correos-pendientes] ERROR:", error?.message || error);
    return sendJson(res, 500, { ok: false, error: String(error?.message || error).slice(0, 300) });
  }
};
