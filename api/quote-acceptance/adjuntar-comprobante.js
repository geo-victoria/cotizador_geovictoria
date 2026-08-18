/**
 * Adjunta a una cotización un COMPROBANTE de transferencia como PDF, generado
 * desde los datos del aviso del banco (Lalo 18-ago, caso SURCONTROL/COT524:
 * el comprobante vivía solo en el correo de la casilla vicky@ y el registro
 * de Zoho quedaba sin respaldo).
 *
 * GET/POST /api/quote-acceptance/adjuntar-comprobante?quoteId=<id>&monto=...
 *   &comprobante=...&fecha=...&hora=...&origen=...&rutOrigen=...&bancoOrigen=...
 * Auth: Bearer ${CRON_SECRET} o x-vicky-secret == VICKY_COTIZADORA_SECRET
 * (mismo esquema de notify-paid — el proxy admin del agente pasa GET-only).
 *
 * El PDF se arma A MANO (estructura PDF mínima, Helvetica WinAnsi): sin
 * puppeteer ni dependencias — es una hoja de datos, no una pieza de diseño.
 * La subida va a la related list Attachments del módulo de cotizaciones
 * (scope de modules, NO requiere ZohoFiles como los adjuntos de send_mail).
 */
const { toText } = require("../_shared/zoho-crm");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  const vickySecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  if (vickySecret && toText(req.headers["x-vicky-secret"]) === vickySecret) return true;
  return false;
}

// PDF de una página con líneas de texto (Helvetica, WinAnsi). Suficiente y
// determinista para un comprobante de datos; los caracteres fuera de Latin-1
// se transliteran.
function pdfDeLineas(lineas) {
  const esc = (s) =>
    String(s)
      .normalize("NFC")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/—|–/g, "-")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  const cuerpo = lineas
    .map((l, i) => {
      const [texto, bold, size] = Array.isArray(l) ? l : [l, false, 11];
      const y = 780 - i * 22;
      const font = bold ? "/F2" : "/F1";
      return `BT ${font} ${size} Tf 56 ${y} Td (${esc(texto)}) Tj ET`;
    })
    .join("\n");
  const stream = Buffer.from(cuerpo, "latin1");
  const objetos = [];
  objetos.push("<< /Type /Catalog /Pages 2 0 R >>");
  objetos.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objetos.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
  );
  objetos.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objetos.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  objetos.push(`<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objetos.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objetos[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objetos.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  const q = { ...(req.query || {}), ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const quoteId = toText(q.quoteId);
  if (!quoteId) return sendJson(res, 400, { ok: false, error: "quoteId requerido" });
  try {
    const config = getAcceptanceConfig(req);
    const lineas = [
      ["Comprobante de transferencia", true, 16],
      ["(datos del aviso automático del banco)", false, 10],
      [""],
      ...(q.origen ? [[`Ordenante: ${toText(q.origen)}`]] : []),
      ...(q.rutOrigen ? [[`RUT ordenante: ${toText(q.rutOrigen)}`]] : []),
      ...(q.bancoOrigen ? [[`Banco/cuenta de origen: ${toText(q.bancoOrigen)}`]] : []),
      ...(q.monto ? [[`Monto transferido: $${toText(q.monto)}`, true, 12]] : []),
      ...(q.comprobante ? [[`N° de comprobante: ${toText(q.comprobante)}`]] : []),
      ...(q.fecha ? [[`Fecha: ${toText(q.fecha)}${q.hora ? ` · ${toText(q.hora)}` : ""}`]] : []),
      ...(q.referencia ? [[`Referencia/mensaje: ${toText(q.referencia)}`]] : []),
      [""],
      ["Destino: Victoria S.A · Banco de Chile-Edwards · Cta. 8001204108", false, 10],
      [`Adjuntado automáticamente por Vicky el ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, false, 9],
    ];
    const pdf = pdfDeLineas(lineas);
    const nombre = `comprobante_transferencia_${toText(q.referencia) || quoteId}.pdf`;
    const form = new FormData();
    form.append("file", new Blob([pdf], { type: "application/pdf" }), nombre);
    const r = await zohoApiFetch(
      `/crm/v3/${encodeURIComponent(config.quoteModule)}/${encodeURIComponent(quoteId)}/Attachments`,
      { method: "POST", body: form },
    );
    const j = await r.json().catch(() => ({}));
    const ok = r.ok && j?.data?.[0]?.status === "success";
    if (!ok) {
      return sendJson(res, 502, { ok: false, error: `Zoho ${r.status}: ${JSON.stringify(j).slice(0, 250)}` });
    }
    return sendJson(res, 200, { ok: true, quoteId, adjunto: nombre, zohoId: toText(j?.data?.[0]?.details?.id) });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: toText(err?.message || err).slice(0, 300) });
  }
};
