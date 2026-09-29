"use strict";
/**
 * ARNÉS DE IDENTIDAD de las emisiones create-from-vicky (paso 3 del plan,
 * 29-sep): corre un handler de emisión con TODA la red apagada (Zoho, kv,
 * PDF, Supabase, Creator, correo) y devuelve la respuesta HTTP y la lista
 * ORDENADA de llamadas que hizo hacia afuera. Con el reloj congelado y el
 * nonce fijo, dos handlers que hacen lo mismo producen exactamente la misma
 * lista — así se comparó la emisión única contra los tres handlers viejos
 * antes de retirarlos (mismo patrón que la prueba de identidad del prompt).
 *
 * NO toca módulos puros (escaleras, constantes, builders de PDF): esos corren
 * de verdad. Lo que se reemplaza es la FRONTERA.
 */
const Module = require("module");
const path = require("path");
const crypto = require("crypto");

const FIXED_MS = Date.UTC(2026, 8, 29, 12, 0, 0);

function instalarReloj() {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_MS);
      else super(...args);
    }
    static now() {
      return FIXED_MS;
    }
  }
  global.Date = FakeDate;
  const realRandom = crypto.randomBytes;
  crypto.randomBytes = (n) => Buffer.alloc(n, 7);
  return () => {
    global.Date = RealDate;
    crypto.randomBytes = realRandom;
  };
}

const ENV_BASE = {
  VICKY_COTIZADORA_SECRET: "secreto-test",
  QUOTE_ACCEPTANCE_SECRET: "acc-secret-test",
  QUOTE_ACCEPT_BASE_URL: "https://cotizador.test",
  CRM_STRICT: "",
  VICKY_AGENT_NOTIFY_URL: "https://agente.test/notify",
  VICKY_AGENT_CRON_SECRET: "cron-test",
};

/**
 * Construye el entorno falso. `escenario` controla las respuestas:
 *   - idempotente: objeto previo que devuelve getIdempotente (o null)
 *   - leadFirst: null (falla) | {dealId, accountId, contactId}
 *   - duplicarCuenta: true → el primer createRecord("Accounts") lanza DUPLICATE
 *     y la búsqueda por documento posterior encuentra "acc-dup"
 *   - cuentaPorDocumento: id que devuelve la COQL de Accounts por documento
 *     antes de crear (null = no existe)
 */
function crearEntorno(escenario = {}) {
  const calls = [];
  const bg = [];
  let seq = 0;
  const nextId = (p) => `${p}-${++seq}`;
  const rec = (tipo, data) => calls.push({ tipo, ...data });
  let cuentasCreadas = 0;
  const cuentaPorDoc = () => {
    if (escenario.duplicarCuenta && cuentasCreadas >= 1) return "acc-dup";
    return escenario.cuentaPorDocumento || null;
  };

  const stubs = {
    "zoho-crm": {
      toText: (v) => (v === null || v === undefined ? "" : String(v).trim()),
      createRecord: async (mod, payload, silent) => {
        rec("createRecord", { mod, payload, silent: Boolean(silent) });
        if (mod === "Accounts") {
          cuentasCreadas += 1;
          if (escenario.duplicarCuenta && cuentasCreadas === 1) throw new Error("Zoho: duplicate data (RUT_Empresa)");
        }
        return { id: nextId(mod.toLowerCase()) };
      },
      updateRecord: async (mod, id, payload, silent) => {
        rec("updateRecord", { mod, id, payload, silent: Boolean(silent) });
        return { id };
      },
      getRecordWithFields: async (mod, id, fields) => {
        rec("getRecordWithFields", { mod, id, fields });
        if (mod === "Deals") return { Deal_Name: "EMPRESA - Cotización Vicky" };
        return { Numero_Cotizacion: "COT9001" };
      },
      getRecord: async (mod, id) => {
        rec("getRecord", { mod, id });
        return null;
      },
      updateRecordBestEffort: async (mod, id, payload) => {
        rec("updateRecordBestEffort", { mod, id, payload });
        return true;
      },
      coqlQuery: async (q) => {
        rec("coql", { q });
        return [];
      },
    },
    "zoho-auth": {
      zohoApiFetch: async (p, init = {}) => {
        const method = init.method || "GET";
        let body = null;
        if (init.body) {
          try { body = JSON.parse(init.body); } catch { body = String(init.body); }
        }
        rec("zohoApiFetch", { path: p, method, body });
        const json = (status, data) => ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => data,
          text: async () => JSON.stringify(data),
        });
        if (p.includes("/coql")) {
          const q = String(body?.select_query || "");
          if (/from Accounts where RUT_Empresa in/.test(q)) {
            const id = cuentaPorDoc();
            return id ? json(200, { data: [{ id, Account_Name: "EMPRESA S.A.C." }] }) : json(204, {});
          }
          if (/from Accounts where Account_Name/.test(q)) return json(204, {});
          if (/from Contacts where Email/.test(q)) {
            return escenario.contactoPorEmail ? json(200, { data: [{ id: escenario.contactoPorEmail }] }) : json(204, {});
          }
          return json(204, {});
        }
        if (/\/Leads\/search/.test(p)) return json(204, {});
        if (/\/Deals\/[^/?]+\?fields=Stage/.test(p)) return json(200, { data: [{ Stage: "4. Propuesta Enviada / En Negociación" }] });
        return json(204, {});
      },
    },
    idempotencia: {
      claveIdempotencia: (body) => "idem:" + crypto.createHash("sha1").update(JSON.stringify(body || {})).digest("hex").slice(0, 16),
      getIdempotente: async (clave) => {
        rec("getIdempotente", { clave });
        return escenario.idempotente || null;
      },
      setIdempotente: async (clave, ids) => {
        rec("setIdempotente", { clave, ids });
      },
      getDealPorFono: async (fono) => {
        rec("getDealPorFono", { fono });
        return escenario.dealPorFono || null;
      },
      setDealPorFono: async (fono, dealId, origen) => {
        rec("setDealPorFono", { fono, dealId, origen });
      },
      reservarDealPorFono: async () => null,
      getLeadCandadoPorFono: async () => "",
      getKvFlag: async () => null,
    },
    "pdfshift-client": {
      htmlToPdfBuffer: async (html, opts) => {
        rec("htmlToPdfBuffer", { htmlSha: crypto.createHash("sha1").update(String(html)).digest("hex"), opts });
        return Buffer.from("PDF");
      },
    },
    "supabase-pdf-upload": {
      uploadPdfToSupabase: async ({ quoteId, empresa }) => {
        rec("uploadPdfToSupabase", { quoteId, empresa });
        return { pdfUrl: `https://pdf.test/${quoteId}.pdf` };
      },
    },
    "pointer-sync": {
      actualizarPunteroPdf: async (quoteId, pdfUrl) => {
        rec("actualizarPunteroPdf", { quoteId, pdfUrl });
      },
    },
    "ndv-emitir": {
      emitirCotizacionEnCreator: async (args) => {
        const { config, ...resto } = args || {};
        rec("emitirCotizacionEnCreator", { args: resto });
        return { status: "ok", ndvId: nextId("creator") };
      },
    },
    "valor-deal": {
      estamparValorDeal: async (args) => {
        rec("estamparValorDeal", { args });
      },
    },
    "embudo-zoho": {
      conEmbudoDeCampanas: (fn) => fn,
    },
    "create-from-vicky": {
      sendQuoteEmailViaZoho: async (args) => {
        rec("sendQuoteEmailViaZoho", { args });
        return { ok: true };
      },
      buildEmailHtml: (args) => "EMAIL_CL:" + JSON.stringify(args),
    },
    "@vercel/functions": {
      waitUntil: (p) => {
        bg.push(Promise.resolve(p).catch(() => {}));
      },
    },
  };

  const realLoad = Module._load;
  const loadPatched = function (request, parent, isMain) {
    const base = request.replace(/\.js$/, "");
    for (const key of Object.keys(stubs)) {
      if (key === "create-from-vicky") {
        if (/(^|\/)create-from-vicky$/.test(base) && !/tests/.test(String(parent?.filename || ""))) return stubs[key];
        continue;
      }
      if (key === "@vercel/functions") {
        if (base === "@vercel/functions") return stubs[key];
        continue;
      }
      if (new RegExp(`(^|/)${key}$`).test(base)) return stubs[key];
    }
    const mod = realLoad.apply(this, arguments);
    if (/(^|\/)lead-first$/.test(base)) {
      return {
        ...mod,
        nacerDealDesdeLead: async (args) => {
          const { dealData, ...resto } = args || {};
          rec("nacerDealDesdeLead", { args: { ...resto, noHeredables: args?.noHeredables ? [...args.noHeredables].sort() : undefined, dealData } });
          if (escenario.leadFirst === null) return null;
          const r = escenario.leadFirst || {};
          return { dealId: r.dealId || nextId("deal"), accountId: r.accountId, contactId: r.contactId };
        },
      };
    }
    if (/(^|\/)ejecutivo-firma$/.test(base)) {
      return {
        ...mod,
        firmanteDeDeal: async (dealId) => {
          rec("firmanteDeDeal", { dealId });
          return { esVicky: true, nombre: "Vicky", email: "vicky@geovictoria.com", cargo: "Asistente comercial", telefono: "" };
        },
      };
    }
    return mod;
  };

  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = String(init.body); }
    rec("fetch", { url: String(url), method: init.method || "GET", body });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };

  return {
    calls,
    bg,
    instalar() {
      Module._load = loadPatched;
    },
    restaurar() {
      Module._load = realLoad;
      global.fetch = realFetch;
    },
  };
}

function limpiarCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}api${path.sep}`)) delete require.cache[k];
  }
}

function fakeReqRes({ method = "POST", body = {}, headers = {} } = {}) {
  const req = { method, body, headers: { "x-vicky-secret": "secreto-test", host: "cotizador.test", ...headers } };
  const out = { status: null, headers: {}, body: null };
  const res = {
    setHeader(k, v) { out.headers[k] = v; },
    end(s) { out.body = s === undefined ? null : String(s); },
    get statusCode() { return out.status; },
    set statusCode(v) { out.status = v; },
  };
  return { req, res, out };
}

function normalizarToken(token) {
  try {
    const [p] = String(token).split(".");
    const payload = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
    delete payload.nonce;
    return payload;
  } catch {
    return String(token);
  }
}

function normalizarSalida(out) {
  let json = null;
  try { json = JSON.parse(out.body); } catch { json = out.body; }
  if (json && typeof json === "object") {
    if (json.acceptanceUrl) {
      const u = new URL(json.acceptanceUrl);
      json.acceptanceUrl = { base: u.origin + u.pathname, token: normalizarToken(u.searchParams.get("token")) };
    }
  }
  return { status: out.status, json };
}

function normalizarCalls(calls) {
  return calls.map((c) => {
    const clone = JSON.parse(JSON.stringify(c));
    const visit = (o) => {
      if (!o || typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === "string" && /^EMAIL_CL:/.test(v)) {
          o[k] = JSON.parse(v.slice(9));
          visit(o[k]);
        } else if (typeof v === "string" && /^https?:\/\/[^\s"]+quote-acceptance\.html\?token=/.test(v)) {
          const u = new URL(v);
          o[k] = { base: u.origin + u.pathname, token: normalizarToken(u.searchParams.get("token")) };
        } else visit(v);
      }
    };
    visit(clone);
    return clone;
  });
}

/**
 * Corre el handler en `rutaHandler` (relativa a la raíz del repo) con el
 * escenario dado. Devuelve {salida, calls}.
 */
async function correr(rutaHandler, { escenario = {}, req: reqOpts = {}, env = {} } = {}) {
  const envPrevio = {};
  for (const [k, v] of Object.entries({ ...ENV_BASE, ...env })) {
    envPrevio[k] = process.env[k];
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  const restaurarReloj = instalarReloj();
  const consolaPrevia = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  const ent = crearEntorno(escenario);
  ent.instalar();
  limpiarCache();
  try {
    const handler = require(path.resolve(__dirname, "../..", rutaHandler));
    const { req, res, out } = fakeReqRes(reqOpts);
    await handler(req, res);
    // Trabajo en segundo plano (PDF, correo, Creator) también cuenta.
    await Promise.all(ent.bg);
    return { salida: normalizarSalida(out), calls: normalizarCalls(ent.calls) };
  } finally {
    ent.restaurar();
    limpiarCache();
    restaurarReloj();
    Object.assign(console, consolaPrevia);
    for (const [k, v] of Object.entries(envPrevio)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

module.exports = { correr, FIXED_MS };
