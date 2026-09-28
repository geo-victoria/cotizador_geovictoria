/**
 * Arnés OFFLINE de la emisión (fase 1 de la emisión única).
 *
 * - Zoho CRM simulado en memoria (ZohoSim): registros por módulo, unicidad de
 *   Account_Name / RUT_Empresa / Email, conversión de leads, búsqueda por
 *   teléfono, COQL simple, blueprint "fuera de proceso", send_mail, files.
 * - vic_kv simulado (KvSim) detrás de un `fetch` falso, con guiones por clave
 *   (para simular la carrera de la reserva).
 * - Módulos reemplazados SOLO en la frontera: zoho-auth (zohoApiFetch),
 *   pdfshift-client, supabase-pdf-upload, ndv-emitir y @vercel/functions.
 *   Todo lo demás (zoho-crm, lead-first, embudo, idempotencia, valor-deal,
 *   pointer-sync, builders de PDF, motor de descuentos) corre de verdad.
 * - Reloj congelado (Date) y nonce determinista: dos corridas idénticas dan
 *   bytes idénticos. Además `normalizar` saca nonce/iat/exp de los tokens.
 * - Cada corrida recarga los módulos de api/ desde cero (las constantes que
 *   se leen al cargar toman el env del escenario).
 *
 * Nada sale a la red: un fetch a un host desconocido revienta el test.
 */
const Module = require("module");
const path = require("path");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "..", "..");
const API = path.join(REPO, "api");
const SHARED = path.join(API, "_shared");

const IDS = {
  VICKY: "3525045000484500876",
  ADMIN: "3525045000000200013",
  GORDILLO: "3525045000203758005",
  YAHEL: "3525045000308323003",
  TAMARA: "3525045000223766001",
  ALEYDIS: "3525045000583802005",
  ARACELLI: "3525045000594735052",
};

const USUARIOS = {
  [IDS.VICKY]: { id: IDS.VICKY, name: "Vicky GeoVictoria", email: "vicky@geovictoria.com", phone: "" },
  [IDS.ADMIN]: { id: IDS.ADMIN, name: "GeoVictoria Admin", email: "info@geovictoria.com", phone: "" },
  [IDS.GORDILLO]: { id: IDS.GORDILLO, name: "Alejandro Gordillo", email: "agordillo@geovictoria.com", phone: "" },
  [IDS.YAHEL]: { id: IDS.YAHEL, name: "Yahel Segura", email: "ysegura@geovictoria.com", phone: "" },
  [IDS.TAMARA]: { id: IDS.TAMARA, name: "Tamara Martínez", email: "tmartinezq@geovictoria.com", phone: "+56 9 1111 2222" },
  [IDS.ALEYDIS]: { id: IDS.ALEYDIS, name: "Aleydis Araque", email: "aaraque@geovictoria.com", phone: "+56 9 8291 6868" },
  [IDS.ARACELLI]: { id: IDS.ARACELLI, name: "Aracelli Sepúlveda", email: "asepulveda@geovictoria.com", phone: "+56 9 3212 5672" },
};

const AHORA = new Date("2026-09-28T15:00:00.000Z");

const ENV_BASE = {
  VICKY_COTIZADORA_SECRET: "secreto-test",
  QUOTE_ACCEPTANCE_SECRET: "firma-test",
  QUOTE_ACCEPT_BASE_URL: "https://cotizacion.test",
  KV_SUPABASE_URL: "https://kv.test",
  KV_SUPABASE_SERVICE_ROLE_KEY: "kv-key",
  VICKY_AGENT_NOTIFY_URL: "https://agente.test/api/vic-notify",
  VICKY_AGENT_CRON_SECRET: "cron-test",
  VICKY_AGENT_BASE: "https://agente.test",
  ZOHO_CLIENT_ID: "x",
  ZOHO_CLIENT_SECRET: "x",
  ZOHO_REFRESH_TOKEN: "x",
};

// ─────────────────────────────── Zoho simulado ──
const soloDigitos = (v) => String(v || "").replace(/\D/g, "");

class ZohoSim {
  constructor(semilla = {}) {
    this.mods = {};
    this.seq = 0;
    this.reglas = semilla.reglas || {};
    for (const [mod, filas] of Object.entries(semilla.registros || {})) {
      for (const f of filas) this.poner(mod, { ...f });
    }
  }
  tabla(mod) {
    if (!this.mods[mod]) this.mods[mod] = {};
    return this.mods[mod];
  }
  poner(mod, rec) {
    if (rec.Owner && rec.Owner.id && USUARIOS[rec.Owner.id]) rec.Owner = { ...USUARIOS[rec.Owner.id] };
    this.tabla(mod)[rec.id] = rec;
    return rec;
  }
  nuevoId() {
    this.seq += 1;
    return String(9900000000000000000n + BigInt(this.seq));
  }
  dupDe(mod, data, idPropio) {
    const unicos = { Accounts: ["Account_Name", "RUT_Empresa"], Contacts: ["Email"] }[mod] || [];
    for (const campo of unicos) {
      const v = data[campo];
      if (v === undefined || v === null || v === "") continue;
      const otro = Object.values(this.tabla(mod)).find(
        (r) => r.id !== idPropio && String(r[campo] || "").toLowerCase() === String(v).toLowerCase(),
      );
      if (otro) return { campo, id: otro.id };
    }
    return null;
  }
  crear(mod, data, extra = {}) {
    const dup = this.dupDe(mod, data, null);
    if (dup) return { error: dup };
    const id = this.nuevoId();
    const rec = { id, ...data, Created_By: { id: IDS.VICKY }, ...extra };
    if (!rec.Owner) rec.Owner = { id: IDS.VICKY };
    this.poner(mod, rec);
    return { id, rec };
  }
  actualizar(mod, id, data) {
    const rec = this.tabla(mod)[id];
    if (!rec) return { noExiste: true };
    const dup = this.dupDe(mod, data, id);
    if (dup) return { error: dup };
    for (const [k, v] of Object.entries(data)) {
      if (k === "id") continue;
      rec[k] = v && v.id && k === "Owner" && USUARIOS[v.id] ? { ...USUARIOS[v.id] } : v;
    }
    return { rec };
  }
  estaConvertido(l) {
    return Boolean(l.Converted_Deal || l.$converted_detail);
  }

  // Respuesta estilo Zoho: { status, json }
  async atender(metodo, ruta, cuerpo) {
    if (this.reglas.antes) {
      const r = await this.reglas.antes(metodo, ruta, cuerpo, this);
      if (r) return r;
    }
    const u = new URL(ruta, "https://zoho.test");
    const p = u.pathname;
    const q = u.searchParams;
    let m;

    if (p === "/crm/v3/coql" && metodo === "POST") return this.coql(cuerpo.select_query);
    if ((m = p.match(/^\/crm\/v3\/users\/(\d+)$/))) {
      const us = USUARIOS[m[1]];
      return us ? { status: 200, json: { users: [us] } } : { status: 204 };
    }
    if (p === "/crm/v3/files") return { status: 200, json: { data: [{ code: "SUCCESS", details: { id: "file-enc-1" } }] } };
    if ((m = p.match(/^\/crm\/v2\/(\w+)\/(\d+)\/actions\/blueprint$/))) {
      return { status: 400, json: { code: "RECORD_NOT_IN_PROCESS", message: "record not in process" } };
    }
    if ((m = p.match(/^\/crm\/v3\/Leads\/(\d+)\/actions\/convert$/))) return this.convertir(m[1], cuerpo.data[0]);
    if ((m = p.match(/^\/crm\/v3\/(\w+)\/(\d+)\/actions\/send_mail$/))) {
      if (this.reglas.sendMailFalla) return { status: 400, json: { code: "NOT_ALLOWED", message: "Recipient address rejected 5.4.1" } };
      return { status: 200, json: { data: [{ code: "SUCCESS" }] } };
    }
    if (p === "/crm/v3/Leads/search") {
      const fono = soloDigitos(q.get("phone"));
      const filas = Object.values(this.tabla("Leads")).filter(
        (l) => fono && (soloDigitos(l.Phone) === fono || soloDigitos(l.Mobile) === fono),
      );
      return filas.length ? { status: 200, json: { data: filas.map((l) => ({ ...l })) } } : { status: 204 };
    }
    if (p === "/crm/v3/Leads" && metodo === "GET" && q.get("ids")) {
      const l = this.tabla("Leads")[q.get("ids")];
      if (!l || !this.estaConvertido(l)) return { status: 204 };
      return { status: 200, json: { data: [{ id: l.id, $converted_detail: l.$converted_detail }] } };
    }
    if ((m = p.match(/^\/crm\/v3\/(\w+)$/))) {
      const mod = m[1];
      if (metodo === "POST") {
        const data = cuerpo.data[0];
        const r = this.crear(mod, data);
        if (r.error) return this.respDup(mod, r.error);
        return { status: 201, json: { data: [{ code: "SUCCESS", status: "success", details: { id: r.id } }] } };
      }
      if (metodo === "PUT") {
        const out = cuerpo.data.map((d) => {
          const r = this.actualizar(mod, d.id, d);
          if (r.error) return { code: "DUPLICATE_DATA", message: "duplicate data", details: { api_name: r.error.campo } };
          if (r.noExiste) return { code: "INVALID_DATA", message: "the id given seems to be invalid" };
          return { code: "SUCCESS", status: "success", details: { id: d.id } };
        });
        return { status: out.every((o) => o.code === "SUCCESS") ? 200 : 400, json: { data: out } };
      }
    }
    if ((m = p.match(/^\/crm\/v3\/(\w+)\/(\d+)$/))) {
      const [, mod, id] = m;
      const rec = this.tabla(mod)[id];
      if (metodo === "GET") {
        if (!rec) return { status: 204 };
        const campos = q.get("fields");
        if (!campos) return { status: 200, json: { data: [{ ...rec }] } };
        const fila = { id: rec.id };
        for (const c of campos.split(",")) if (rec[c] !== undefined) fila[c] = rec[c];
        return { status: 200, json: { data: [fila] } };
      }
      if (metodo === "PUT") {
        const r = this.actualizar(mod, id, cuerpo.data[0]);
        if (r.noExiste) return { status: 400, json: { data: [{ code: "INVALID_DATA", message: "the id given seems to be invalid" }] } };
        if (r.error) return this.respDup(mod, r.error);
        return { status: 200, json: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } };
      }
    }
    throw new Error(`ZohoSim: ruta no simulada ${metodo} ${ruta}`);
  }

  respDup(mod, dup) {
    return {
      status: 400,
      json: {
        data: [{
          code: "DUPLICATE_DATA",
          message: "duplicate data",
          status: "error",
          details: { api_name: dup.campo, duplicate_record: { id: dup.id, module: { api_name: mod } } },
        }],
      },
    };
  }

  convertir(leadId, payload) {
    const lead = this.tabla("Leads")[leadId];
    if (!lead) return { status: 400, json: { data: [{ code: "INVALID_DATA", message: "invalid lead" }] } };
    if (this.estaConvertido(lead)) {
      return { status: 400, json: { data: [{ code: "ALREADY_CONVERTED", message: "lead already converted" }] } };
    }
    if (this.reglas.convertFalla && this.reglas.convertFalla(leadId, payload, this)) {
      return { status: 400, json: { data: [{ code: "MANDATORY_NOT_FOUND", message: "convert falló (simulado)" }] } };
    }
    let accountId = payload.Accounts && payload.Accounts.id;
    if (!accountId) {
      const r = this.crear("Accounts", { Account_Name: lead.Company, RUT_Empresa: lead.RUT_Empresa, Owner: lead.Owner });
      if (r.error) return this.respDup("Accounts", r.error);
      accountId = r.id;
    }
    let contactId = payload.Contacts && payload.Contacts.id;
    if (!contactId) {
      const r = this.crear("Contacts", {
        First_Name: lead.First_Name, Last_Name: lead.Last_Name, Email: lead.Email, Phone: lead.Phone,
        Account_Name: { id: accountId }, Owner: lead.Owner,
      });
      if (r.error) return this.respDup("Contacts", r.error);
      contactId = r.id;
    }
    let dealId = "";
    if (payload.Deals) {
      const r = this.crear("Deals", { ...payload.Deals, Account_Name: { id: accountId }, Contact_Name: { id: contactId } });
      dealId = r.id;
    }
    lead.Converted_Account = { id: accountId };
    lead.Converted_Contact = { id: contactId };
    if (dealId) lead.Converted_Deal = { id: dealId };
    lead.$converted_detail = { account: accountId, contact: contactId, deal: dealId || undefined };
    const parcial = this.reglas.convertParcial;
    return {
      status: 200,
      json: {
        data: [{
          Accounts: { id: accountId, name: "a" },
          Contacts: parcial ? null : { id: contactId, name: "c" },
          Deals: dealId ? { id: dealId, name: "d" } : null,
        }],
      },
    };
  }

  coql(consulta) {
    const m = /^select (.+) from (\w+) where (\w+) (in|=) (.+?) limit (\d+)$/i.exec(String(consulta).trim());
    if (!m) return { status: 400, json: { code: "INVALID_QUERY", message: consulta } };
    const [, camposTxt, mod, campo, op, valTxt, limite] = m;
    const vals = [];
    const re = /'((?:[^']|'')*)'/g;
    let v;
    while ((v = re.exec(valTxt))) vals.push(v[1].replace(/''/g, "'"));
    const campos = camposTxt.split(",").map((s) => s.trim());
    const filas = Object.values(this.tabla(mod))
      .filter((r) => {
        const actual = String(r[campo] ?? "");
        return op.toLowerCase() === "in" ? vals.includes(actual) : actual.toLowerCase() === String(vals[0]).toLowerCase();
      })
      .slice(0, Number(limite))
      .map((r) => Object.fromEntries(campos.map((c) => [c, r[c] ?? null])));
    return filas.length ? { status: 200, json: { data: filas } } : { status: 204 };
  }
}

// ─────────────────────────────── vic_kv simulado ──
class KvSim {
  constructor(valores = {}, guion = {}) {
    this.valores = { ...valores };
    this.guion = {};
    for (const [k, lista] of Object.entries(guion)) this.guion[k] = [...lista];
  }
  leer(k) {
    if (this.guion[k] && this.guion[k].length) return this.guion[k].shift();
    return this.valores[k];
  }
}

// ─────────────────────────────── utilidades ──
function respuestaHttp(status, json) {
  if (status === 204) return new Response(null, { status: 204 });
  return new Response(json === undefined ? "" : JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cuerpoLegible(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return body; }
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const partes = [];
    for (const [k, v] of body.entries()) partes.push(`${k}:${v && v.name ? v.name : typeof v}`);
    return `<FormData ${partes.join(",")}>`;
  }
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

function decodificarToken(tok) {
  try {
    const [cuerpo] = decodeURIComponent(tok).split(".");
    const json = Buffer.from(cuerpo.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const p = JSON.parse(json);
    delete p.nonce; delete p.iat; delete p.exp;
    return JSON.stringify(p);
  } catch {
    return "<token?>";
  }
}

/** Saca de un objeto los valores volátiles (nonce/iat/exp de los tokens, uuids). */
function normalizar(valor) {
  if (typeof valor === "string") {
    return valor
      .replace(/token=([A-Za-z0-9_%.-]+)/g, (_m, t) => `token=<${decodificarToken(t)}>`)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  }
  if (Array.isArray(valor)) return valor.map(normalizar);
  if (valor && typeof valor === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = normalizar(v);
    return out;
  }
  return valor;
}

function resFalso() {
  const r = {
    statusCode: 200,
    headers: {},
    cuerpo: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.cuerpo = b || ""; this.terminado = true; },
  };
  return r;
}

// ─────────────────────────────── corrida ──
/**
 * Corre un handler con el escenario y devuelve { log, respuestas }.
 * `escenario` = { zoho: semilla, kv: {valores, guion}, env, agenteKv, pedidos: [body...] }
 * `obtenerHandler(require)` recibe el require del repo ya interceptado.
 */
async function correr(escenario, obtenerHandler) {
  const log = [];
  const sim = new ZohoSim(escenario.zoho || {});
  const kv = new KvSim((escenario.kv || {}).valores, (escenario.kv || {}).guion);
  const promesasFondo = [];

  // env
  const envPrevio = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^(VICKY_|QUOTE_|KV_SUPABASE|SUPABASE|ZOHO_|CRM_STRICT|CREATOR_|NDV_)/.test(k)) delete process.env[k];
  }
  Object.assign(process.env, ENV_BASE, escenario.env || {});

  const zohoApiFetch = (ruta, opts = {}) => {
    const metodo = String(opts.method || "GET").toUpperCase();
    const cuerpo = cuerpoLegible(opts.body);
    log.push({ canal: "zoho", metodo, ruta, cuerpo });
    return Promise.resolve().then(async () => {
      const r = await sim.atender(metodo, ruta, cuerpo && typeof cuerpo === "object" ? cuerpo : {});
      return respuestaHttp(r.status, r.json);
    });
  };
  const fakes = {
    [path.join(SHARED, "zoho-auth.js")]: {
      getZohoConfig: () => ({}),
      getZohoAccessToken: async () => "tok",
      getTokenMeta: () => ({}),
      zohoApiFetch,
    },
    [path.join(SHARED, "pdfshift-client.js")]: {
      htmlToPdfBuffer: async (html, opciones) => {
        const hash = crypto.createHash("sha256").update(String(html)).digest("hex");
        log.push({ canal: "pdf", metodo: "RENDER", ruta: "htmlToPdfBuffer", cuerpo: { hash, opciones } });
        return Buffer.from(`PDF:${hash}`);
      },
      renderWithChromium: async () => { throw new Error("no"); },
      renderWithPdfShift: async () => { throw new Error("no"); },
    },
    [path.join(SHARED, "supabase-pdf-upload.js")]: {
      uploadPdfToSupabase: async ({ pdfBuffer, quoteId, empresa }) => {
        log.push({ canal: "pdf", metodo: "UPLOAD", ruta: "uploadPdfToSupabase", cuerpo: { quoteId, empresa, bytes: String(pdfBuffer) } });
        return { pdfUrl: `https://cotizacion.test/pdf/${quoteId}/cotizacion.pdf` };
      },
    },
    [path.join(SHARED, "ndv-emitir.js")]: {
      emitirCotizacionEnCreator: async (args) => {
        const { config: _c, ...resto } = args;
        log.push({ canal: "creator", metodo: "EMITIR", ruta: "emitirCotizacionEnCreator", cuerpo: JSON.parse(JSON.stringify(resto)) });
        return { status: "ok", ndvId: `ndv-${log.filter((x) => x.canal === "creator").length}` };
      },
    },
  };
  const fakeVercel = { waitUntil: (p) => { promesasFondo.push(Promise.resolve(p)); } };

  const loadOriginal = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@vercel/functions") return fakeVercel;
    let resuelto = null;
    try { resuelto = Module._resolveFilename(request, parent, isMain); } catch { /* sigue */ }
    if (resuelto && fakes[resuelto]) return fakes[resuelto];
    return loadOriginal.apply(this, arguments);
  };

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const metodo = String(opts.method || "GET").toUpperCase();
    const cuerpo = cuerpoLegible(opts.body);
    log.push({ canal: "http", metodo, ruta: `${u.host}${u.pathname}${u.search}`, cuerpo });
    if (u.host === "kv.test" && u.pathname === "/rest/v1/vic_kv") {
      if (metodo === "GET") {
        const clave = decodeURIComponent((u.searchParams.get("key") || "").replace(/^eq\./, ""));
        const v = kv.leer(clave);
        return respuestaHttp(200, v === undefined ? [] : [{ value: v }]);
      }
      kv.valores[cuerpo.key] = cuerpo.value;
      return new Response(null, { status: 201 });
    }
    if (u.host === "agente.test" && u.pathname === "/api/vic-admin-kv") {
      const k = u.searchParams.get("k");
      return respuestaHttp(200, { key: k, value: (escenario.agenteKv || {})[k] || null });
    }
    if (u.host === "agente.test") return respuestaHttp(200, { ok: true });
    if (u.host === "accounts.zoho.com") return respuestaHttp(200, { access_token: "files-token" });
    if (u.host === "www.zohoapis.com" && u.pathname === "/crm/v3/files") {
      return respuestaHttp(200, { data: [{ code: "SUCCESS", details: { id: "file-enc-2" } }] });
    }
    throw new Error(`fetch a un host no simulado: ${url}`);
  };

  // reloj congelado y nonce determinista
  const DateReal = Date;
  const ahoraMs = AHORA.getTime();
  class DateFalsa extends DateReal {
    constructor(...a) { if (a.length === 0) super(ahoraMs); else super(...a); }
    static now() { return ahoraMs; }
  }
  globalThis.Date = DateFalsa;
  const randomBytesReal = crypto.randomBytes;
  let semilla = 0;
  crypto.randomBytes = (n) => {
    semilla += 1;
    return crypto.createHash("sha256").update(`nonce-${semilla}`).digest().subarray(0, n);
  };

  const consola = { log: console.log, warn: console.warn, error: console.error };
  const mensajes = [];
  if (!process.env.EMISION_TEST_VERBOSE) {
    console.log = (...a) => mensajes.push(["log", a.join(" ")]);
    console.warn = (...a) => mensajes.push(["warn", a.join(" ")]);
    console.error = (...a) => mensajes.push(["error", a.map(String).join(" ")]);
  }

  // módulos frescos del repo
  for (const k of Object.keys(require.cache)) if (k.startsWith(API + path.sep)) delete require.cache[k];

  const respuestas = [];
  try {
    const handler = obtenerHandler((p) => require(path.join(REPO, p)));
    for (const pedidoDef of escenario.pedidos) {
      const pedido = typeof pedidoDef === "function" ? pedidoDef(respuestas) : pedidoDef;
      const req = {
        method: pedido.method || "POST",
        headers: { "x-vicky-secret": "secreto-test", ...(pedido.headers || {}) },
        body: pedido.body === undefined ? undefined : JSON.parse(JSON.stringify(pedido.body)),
      };
      const res = resFalso();
      await handler(req, res);
      // esperar el segundo plano de ESTE pedido antes del siguiente
      while (promesasFondo.length) await promesasFondo.shift();
      let cuerpo = res.cuerpo;
      try { cuerpo = JSON.parse(res.cuerpo); } catch { /* texto */ }
      respuestas.push({ status: res.statusCode, cuerpo, headers: res.headers });
    }
  } finally {
    Module._load = loadOriginal;
    globalThis.fetch = fetchOriginal;
    globalThis.Date = DateReal;
    crypto.randomBytes = randomBytesReal;
    console.log = consola.log; console.warn = consola.warn; console.error = consola.error;
    for (const k of Object.keys(process.env)) if (!(k in envPrevio)) delete process.env[k];
    Object.assign(process.env, envPrevio);
    for (const k of Object.keys(require.cache)) if (k.startsWith(API + path.sep)) delete require.cache[k];
  }
  return { log: normalizar(log), respuestas: normalizar(respuestas), sim, kv, mensajes };
}

module.exports = { correr, ZohoSim, KvSim, IDS, USUARIOS, normalizar, REPO };
