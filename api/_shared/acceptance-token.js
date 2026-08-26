const crypto = require("crypto");

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function getTokenSecret() {
  const secret = String(process.env.QUOTE_ACCEPTANCE_SECRET || "").trim();
  if (!secret) {
    throw new Error("Missing QUOTE_ACCEPTANCE_SECRET");
  }
  return secret;
}

function signAcceptancePayload(payload) {
  const secret = getTokenSecret();
  const json = JSON.stringify(payload || {});
  const body = base64UrlEncode(json);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${body}.${signature}`;
}

function verifyAcceptanceToken(token) {
  const secret = getTokenSecret();
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid token format");
  }

  const [body, signature] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (
    signatureBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    throw new Error("Invalid token signature");
  }

  let payload = {};
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch (_error) {
    throw new Error("Invalid token payload");
  }

  // CADUCIDAD RETIRADA (Lalo 26-ago, campaña de reactivación: "quiero que
  // esos links vencidos vuelvan a estar disponibles"): el link que el cliente
  // tiene en su chat debe funcionar siempre — la FIRMA sigue siendo la
  // seguridad (nadie puede forjar un token), y los estados de la cotización
  // (pagada/actualizada) siguen mandando en la página. Se deja el log para
  // ver cuánta gente vuelve por links antiguos. Para reponer la caducidad
  // sin deploy: env QUOTE_ACCEPTANCE_ENFORCE_EXP=1.
  const exp = Number(payload.exp || 0);
  if (Date.now() >= exp && Number.isFinite(exp) && exp > 0) {
    if (String(process.env.QUOTE_ACCEPTANCE_ENFORCE_EXP || "").trim() === "1") {
      const expired = new Error("Token expired");
      expired.code = "TOKEN_EXPIRED";
      throw expired;
    }
    console.warn(
      `[acceptance-token] token vencido ACEPTADO (caducidad retirada 26-ago) quoteId=${payload.quoteId || "?"} exp=${new Date(exp).toISOString()}`,
    );
  }

  return payload;
}

module.exports = {
  signAcceptancePayload,
  verifyAcceptanceToken,
};

