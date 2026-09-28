/**
 * Escenarios de la prueba de identidad de Chile. Cada uno declara la semilla
 * de Zoho/kv, los pedidos y una verificación de que el camino que dice
 * cubrir SE CUBRIÓ de verdad (sobre la corrida del handler chileno).
 */
const { IDS, USUARIOS } = require("./harness");

const FONO = "56912345678";
const RUT = "76.543.210-3";
const EMPRESA = "Ferretería Los Andes SpA";

function bodyBase(extra = {}) {
  return {
    cliente: {
      empresa: EMPRESA,
      contacto: "Juan Pérez Soto",
      rutEmpresa: RUT,
      contactoEmail: "juan@losandes.cl",
      contactoTelefono: FONO,
      userCount: 8,
      sectorEmpresa: "3. Construcción",
      direccionEmpresa: "Av. Siempre Viva 123",
      comunaEmpresa: "Providencia",
      regionEmpresa: "RM",
      ...(extra.cliente || {}),
    },
    cotizacion: {
      items: [
        {
          tipo: "modulo", id: "asistencia", nombre: "Control de Asistencia", modalidad: "Fijo",
          cantidad: 1, precioUnitarioUF: 0.6, subtotalUF: 0.6,
          escalera: [{ desde: 1, hasta: 10, modalidad: "fijo", precioUF: 0.6 }, { desde: 11, hasta: 20, modalidad: "por_usuario", precioUF: 0.055 }],
        },
        { tipo: "hardware", id: "senseface_2a", nombre: "Reloj control físico", modalidad: "Arriendo mensual", cantidad: 1, precioUnitarioUF: 0.35, subtotalUF: 0.35 },
        { tipo: "servicio", id: "envio_reloj", nombre: "Envío de reloj (Providencia)", modalidad: "Cobro único", cantidad: 1, precioUnitarioUF: 0.5, subtotalUF: 0, descuentoPct: 100, zonaTarifa: "rm" },
      ],
      totalUF: 0.95,
      totalCLP: 38809,
      ufActual: 40851.5,
      ...(extra.cotizacion || {}),
    },
    ...(extra.raiz || {}),
  };
}

const kvJson = (o) => JSON.stringify({ at: "2026-09-28T14:59:00.000Z", ...o });

const lead = (id, ownerId, extra = {}) => ({
  id, First_Name: "Juan", Last_Name: "Pérez Soto", Company: "Prospecto WhatsApp", Phone: `+${FONO}`,
  Email: "juan@losandes.cl", Lead_Source: "Google Ads", Lead_Status: "3. Contactado", Owner: { id: ownerId }, ...extra,
});

const llamadas = (r, canal, metodo, re) =>
  r.log.filter((x) => x.canal === canal && (!metodo || x.metodo === metodo) && re.test(x.ruta));

const ESCENARIOS = [
  {
    nombre: "lead vivo de Vicky → Camino A (convert primero)",
    zoho: { registros: { Leads: [lead("5000000000000000001", IDS.VICKY)] } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.ok(llamadas(r, "zoho", "POST", /Leads\/5000000000000000001\/actions\/convert/).length === 1, "convert");
      t.equal(r.respuestas[0].cuerpo.reuse.leadConverted, true);
    },
  },
  {
    nombre: "15 personas (tramo por usuario) por Camino A: Tipo_de_Cobro del deal al nacer",
    zoho: { registros: { Leads: [lead("5000000000000000005", IDS.VICKY)] } },
    pedidos: [{ body: bodyBase({ cliente: { userCount: 15 } }) }],
    verificar: (r, t) => {
      const c = llamadas(r, "zoho", "POST", /actions\/convert/)[0];
      t.equal(c.cuerpo.data[0].Deals.Tipo_de_Cobro, "Por usuario");
    },
  },
  {
    nombre: "15 personas sin lead (lead-first crea el lead): Tipo_de_Cobro del deal al nacer",
    pedidos: [{ body: bodyBase({ cliente: { userCount: 15 } }) }],
    verificar: (r, t) => {
      t.ok(llamadas(r, "zoho", "POST", /^\/crm\/v3\/Leads$/).length === 1, "lead creado en el acto");
      const c = llamadas(r, "zoho", "POST", /actions\/convert/)[0];
      t.equal(c.cuerpo.data[0].Deals.Tipo_de_Cobro, "Por usuario");
    },
  },
  {
    nombre: "lead de dueño humano (Tamara) → no se adopta, lead-first hereda su dueño",
    zoho: { registros: { Leads: [lead("5000000000000000002", IDS.TAMARA)] } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.reuse.leadConverted, false);
      t.equal(r.respuestas[0].cuerpo.ejecutivo.email, "tmartinezq@geovictoria.com");
      t.ok(llamadas(r, "zoho", "GET", /users\//).length === 1, "lee teléfono del dueño");
    },
  },
  // DIFERENCIA ACEPTADA (decisión del dueño 28-sep): el lead de una SDR se
  // convierte pero la SDR NO hereda el deal. Hoy el handler chileno sí lo
  // hereda (lo verifica `verificar`). La emisión única debe tratarlo EXACTO
  // como hoy Chile trata un lead de dueño ROBOT (GeoVictoria Admin): mismo
  // lead, mismas llamadas, deal y cotización con el interino (Vicky).
  ...[["Aleydis", IDS.ALEYDIS, "5000000000000000003"], ["Aracelli", IDS.ARACELLI, "5000000000000000006"]].map(([n, id, leadId]) => ({
    nombre: `lead SDR (${n}) → la SDR NO hereda el deal (se trata como lead de dueño robot)`,
    zoho: { registros: { Leads: [lead(leadId, id)] } },
    pedidos: [{ body: bodyBase() }],
    equivalenteChile: () => ({
      zoho: { registros: { Leads: [lead(leadId, IDS.ADMIN)] } },
      pedidos: [{ body: bodyBase() }],
    }),
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.ejecutivo.email, USUARIOS[id].email, "hoy Chile hereda la SDR");
    },
    verificarEmision: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.ejecutivo.email, "", "la SDR no quedó de dueña");
      const c = r.log.find((x) => /actions\/convert/.test(x.ruta));
      t.equal(c.cuerpo.data[0].Deals.Owner.id, IDS.VICKY);
      const q = r.log.find((x) => x.metodo === "POST" && /Cotizaciones_GeoVictoria$/.test(x.ruta));
      t.equal(q.cuerpo.data[0].Owner.id, IDS.VICKY);
    },
  })),
  {
    nombre: "lead ya convertido con deal vivo → se reusa todo",
    zoho: {
      registros: {
        Accounts: [{ id: "6000000000000000001", Account_Name: EMPRESA, RUT_Empresa: RUT, Owner: { id: IDS.VICKY } }],
        Contacts: [{ id: "6100000000000000001", First_Name: "Juan", Last_Name: "Pérez Soto", Email: "juan@losandes.cl", Owner: { id: IDS.VICKY } }],
        Deals: [{ id: "6200000000000000001", Deal_Name: "Prospecto WhatsApp - Cotización Vicky", Stage: "3. En Levantamiento", Owner: { id: IDS.VICKY }, Created_By: { id: IDS.VICKY }, Territorio: "Chile" }],
        Leads: [lead("5000000000000000004", IDS.VICKY, {
          Converted_Account: { id: "6000000000000000001" }, Converted_Contact: { id: "6100000000000000001" }, Converted_Deal: { id: "6200000000000000001" },
          $converted_detail: { account: "6000000000000000001", contact: "6100000000000000001", deal: "6200000000000000001" },
        })],
      },
    },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.dealId, "6200000000000000001");
      t.equal(r.respuestas[0].cuerpo.reuse.dealReused, true);
      t.ok(llamadas(r, "zoho", "PUT", /Deals\/6200000000000000001$/).length >= 1, "corrige placeholders del deal");
    },
  },
  {
    nombre: "deal perdido marcado por campaña (reactivar_deal_) → se reusa; body.cc en el correo",
    zoho: {
      registros: {
        Accounts: [{ id: "6000000000000000011", Account_Name: EMPRESA, RUT_Empresa: RUT }],
        Contacts: [{ id: "6100000000000000011", First_Name: "Juan", Last_Name: "Pérez Soto", Email: "juan@losandes.cl" }],
        Deals: [{ id: "6200000000000000011", Deal_Name: `${EMPRESA} - Cotización Vicky`, Stage: "Cierre Perdido", Owner: { id: IDS.TAMARA }, Rut_ID_Account: RUT, Account_Name: { id: "6000000000000000011" }, Contact_Name: { id: "6100000000000000011" } }],
        Leads: [lead("5000000000000000011", IDS.TAMARA, {
          Converted_Deal: { id: "6200000000000000011" },
          $converted_detail: { account: "6000000000000000011", contact: "6100000000000000011", deal: "6200000000000000011" },
        })],
      },
    },
    agenteKv: { [`reactivar_deal_${FONO}`]: "6200000000000000011" },
    pedidos: [{ body: bodyBase({ raiz: { cc: ["copia@cliente.cl"] } }) }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.dealId, "6200000000000000011");
      const mail = llamadas(r, "zoho", "POST", /send_mail/)[0];
      t.ok(JSON.stringify(mail.cuerpo).includes("copia@cliente.cl"), "cc del body");
    },
  },
  {
    nombre: "deal perdido SIN marca de campaña → ciclo nuevo",
    zoho: {
      registros: {
        Accounts: [{ id: "6000000000000000012", Account_Name: EMPRESA, RUT_Empresa: RUT }],
        Contacts: [{ id: "6100000000000000012", First_Name: "Juan", Last_Name: "Pérez Soto", Email: "juan@losandes.cl" }],
        Deals: [{ id: "6200000000000000012", Stage: "Cierre Perdido", Owner: { id: IDS.TAMARA }, Rut_ID_Account: RUT }],
        Leads: [lead("5000000000000000012", IDS.TAMARA, {
          Converted_Deal: { id: "6200000000000000012" },
          $converted_detail: { account: "6000000000000000012", contact: "6100000000000000012", deal: "6200000000000000012" },
        })],
      },
    },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.notEqual(r.respuestas[0].cuerpo.dealId, "6200000000000000012");
      t.equal(r.respuestas[0].cuerpo.reuse.accountReused, true);
    },
  },
  {
    nombre: "candado deal_fono_ con deal de la otra puerta",
    zoho: {
      registros: {
        Accounts: [{ id: "6000000000000000021", Account_Name: "Prospecto WhatsApp", RUT_Empresa: "" }],
        Contacts: [{ id: "6100000000000000021", First_Name: "Juan", Last_Name: "Prospecto", Email: "" }],
        Deals: [{ id: "6200000000000000021", Stage: "1. Trato Creado", Owner: { id: IDS.VICKY }, Account_Name: { id: "6000000000000000021" }, Contact_Name: { id: "6100000000000000021" } }],
      },
    },
    kv: { valores: { [`deal_fono_${FONO}`]: kvJson({ dealId: "6200000000000000021", origen: "hito" }) } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.dealId, "6200000000000000021");
      t.ok(llamadas(r, "zoho", "PUT", /Accounts\/6000000000000000021$/).length >= 1, "placeholder de cuenta corregido");
      t.ok(llamadas(r, "zoho", "PUT", /Contacts\/6100000000000000021$/).length >= 1, "placeholder de contacto corregido");
    },
  },
  {
    nombre: "reserva ocupada por la otra puerta (carrera) → reusa su deal",
    zoho: {
      registros: {
        Deals: [{ id: "6200000000000000031", Stage: "1. Trato Creado", Owner: { id: IDS.VICKY } }],
      },
    },
    kv: { guion: { [`deal_fono_${FONO}`]: [undefined, kvJson({ dealId: "6200000000000000031", origen: "hito" })] } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.dealId, "6200000000000000031");
    },
  },
  {
    // HALLAZGO (28-sep, lo destapó este arnés): la guarda de RUT suelta el
    // deal del candado, pero la RESERVA anti-carrera vuelve a leer la misma
    // llave deal_fono_ (con dealId) y lo re-adopta. Hoy Chile reusa el deal de
    // la OTRA empresa. Se documenta tal cual (identidad = misma conducta).
    nombre: "RUT distinto en el deal del candado → la reserva lo re-adopta (bug conocido)",
    zoho: {
      registros: {
        Deals: [{ id: "6200000000000000041", Stage: "4. Propuesta Enviada / En Negociación", Owner: { id: IDS.TAMARA }, Rut_ID_Account: "11.111.111-1" }],
      },
    },
    kv: { valores: { [`deal_fono_${FONO}`]: kvJson({ dealId: "6200000000000000041", origen: "cotizacion" }) } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.ok(llamadas(r, "zoho", "GET", /Deals\/6200000000000000041$/).length >= 1, "la guarda leyó el deal");
      t.equal(r.respuestas[0].cuerpo.dealId, "6200000000000000041");
      t.equal(r.respuestas[0].cuerpo.ejecutivo.email, "tmartinezq@geovictoria.com");
    },
  },
  {
    nombre: "DUPLICATE_DATA en cuenta → Capa 3 encuentra la cuenta por RUT",
    zoho: { registros: { Accounts: [{ id: "6000000000000000051", Account_Name: "Ferretería Los Andes", RUT_Empresa: RUT }] } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.accountId, "6000000000000000051");
      t.ok(llamadas(r, "zoho", "POST", /coql/).length >= 1, "coql");
    },
  },
  {
    nombre: "DUPLICATE_DATA por nombre, homónima SIN RUT → se adopta y se completa",
    zoho: { registros: { Accounts: [{ id: "6000000000000000061", Account_Name: EMPRESA, RUT_Empresa: "" }] } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.accountId, "6000000000000000061");
    },
  },
  {
    nombre: "homónima con otro RUT → desambiguada; desambiguada existente → Capa 4",
    zoho: {
      registros: {
        Accounts: [
          { id: "6000000000000000071", Account_Name: EMPRESA, RUT_Empresa: "11.111.111-1" },
          { id: "6000000000000000072", Account_Name: `${EMPRESA} (${RUT})`, RUT_Empresa: "76 543 210-3" },
        ],
      },
    },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.accountId, "6000000000000000072");
    },
  },
  {
    // Capa 3 ignora la cuenta "-" y la desambiguada choca por RUT → Capa 4 sin
    // salida. HALLAZGO: después lead-first convierte el lead, Zoho responde
    // DUPLICATE_DATA por el RUT y el reintento FUSIONA el lead en la cuenta
    // "-" (la que esCuentaNoAdoptable protege). Simulado; no verificado en vivo.
    nombre: "cuenta \"-\" con el RUT → Capa 3 la ignora; lead-first termina fusionando en ella",
    zoho: { registros: { Accounts: [{ id: "6000000000000000081", Account_Name: "-", RUT_Empresa: RUT }] } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      const creates = llamadas(r, "zoho", "POST", /^\/crm\/v3\/Accounts$/);
      t.equal(creates.length, 2, "cuenta + desambiguada");
      t.ok(llamadas(r, "zoho", "POST", /coql/).length >= 2, "capa 3 y capa 4");
      t.equal(r.respuestas[0].cuerpo.accountId, "6000000000000000081");
    },
  },
  {
    nombre: "falla no-duplicado al crear cuenta → CRM degradado, cotización igual (aviso crm_incompleto)",
    zoho: { reglas: { antes: (m, ruta) => (m === "POST" && /^\/crm\/v3\/Accounts$/.test(ruta) ? { status: 400, json: { data: [{ code: "INVALID_DATA", message: "campo malo" }] } } : null) } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.ok(!r.respuestas[0].cuerpo.accountId, "sin cuenta");
      t.equal(r.respuestas[0].status, 200);
      t.ok(llamadas(r, "http", "POST", /agente\.test\/api\/vic-notify/).length === 1, "aviso crm_incompleto");
      const q = llamadas(r, "zoho", "POST", /Cotizaciones_GeoVictoria$/)[0];
      t.equal(q.cuerpo.data[0].CRM_Incompleto, true);
    },
  },
  {
    nombre: "DUPLICATE_DATA en contacto → dedup por email",
    zoho: { registros: { Contacts: [{ id: "6100000000000000091", First_Name: "J", Last_Name: "P", Email: "juan@losandes.cl" }] } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.contactId, "6100000000000000091");
    },
  },
  {
    nombre: "borrador (draft) + finalización con existing.quoteId (monotonicidad del escalón)",
    pedidos: [
      { body: bodyBase({ raiz: { draft: true, escalonDescuento: 2 } }) },
      (prev) => ({
        body: bodyBase({
          raiz: {
            escalonDescuento: 1,
            existing: { quoteId: prev[0].cuerpo.quoteId, dealId: prev[0].cuerpo.dealId, accountId: prev[0].cuerpo.accountId, contactId: prev[0].cuerpo.contactId },
          },
        }),
      }),
    ],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.draft, true);
      t.equal(r.respuestas[1].cuerpo.reuse.quoteReused, true);
      t.equal(r.respuestas[1].cuerpo.quoteId, r.respuestas[0].cuerpo.quoteId);
    },
  },
  {
    nombre: "idempotente: el mismo body dos veces no duplica",
    pedidos: [{ body: bodyBase() }, { body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[1].cuerpo.reuse.retryIdempotente, true);
      t.equal(r.respuestas[1].cuerpo.quoteId, r.respuestas[0].cuerpo.quoteId);
    },
  },
  {
    nombre: "sinCorreoCliente (canal ejecutivo): sin correo y marca de intervención humana",
    pedidos: [{ body: bodyBase({ raiz: { sinCorreoCliente: true } }) }],
    verificar: (r, t) => {
      t.equal(llamadas(r, "zoho", "POST", /send_mail/).length, 0);
      const q = llamadas(r, "zoho", "POST", /Cotizaciones_GeoVictoria$/)[0];
      t.equal(q.cuerpo.data[0].Intervenci_n_Humana, "Con intervención humana");
    },
  },
  {
    nombre: "dueño manual existing.ownerId (flujo admin)",
    pedidos: [{ body: bodyBase({ raiz: { existing: { ownerId: IDS.TAMARA }, leadSource: "Facebook" } }) }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.ejecutivo.email, "tmartinezq@geovictoria.com");
      t.ok(llamadas(r, "zoho", "PUT", /^\/crm\/v3\/Accounts$/).length === 1, "cuenta sigue al dueño");
    },
  },
  {
    nombre: "convert fallido: lead del candado ya convertido → recuperación por $converted_detail",
    zoho: {
      registros: {
        Deals: [{ id: "6200000000000000101", Stage: "3. En Levantamiento", Owner: { id: IDS.VICKY }, Rut_ID_Account: RUT }],
        Accounts: [{ id: "6000000000000000101", Account_Name: EMPRESA, RUT_Empresa: RUT }],
        Contacts: [{ id: "6100000000000000101", First_Name: "Juan", Last_Name: "Pérez Soto", Email: "juan@losandes.cl" }],
        Leads: [lead("5000000000000000101", IDS.VICKY, {
          Converted_Deal: { id: "6200000000000000101" },
          $converted_detail: { account: "6000000000000000101", contact: "6100000000000000101", deal: "6200000000000000101" },
        })],
      },
    },
    kv: { valores: { [`zoho_lead_${FONO}`]: "5000000000000000101" } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].cuerpo.dealId, "6200000000000000101");
      t.equal(r.respuestas[0].cuerpo.reuse.leadConverted, false);
    },
  },
  {
    nombre: "convert rechazado siempre → Camino B + lead-first falla → deal fresco MARCADO",
    zoho: {
      registros: { Leads: [lead("5000000000000000111", IDS.VICKY)] },
      reglas: { convertFalla: () => true },
    },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      const d = llamadas(r, "zoho", "POST", /^\/crm\/v3\/Deals$/)[0];
      t.ok(d && /Nació SIN lead convertido/.test(d.cuerpo.data[0].Description), "deal marcado");
    },
  },
  {
    nombre: "convert con respuesta parcial → ids recuperados",
    zoho: { registros: { Leads: [lead("5000000000000000121", IDS.VICKY)] }, reglas: { convertParcial: true } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.ok(llamadas(r, "zoho", "GET", /Leads\?ids=5000000000000000121/).length >= 1, "recuperación");
      t.equal(r.respuestas[0].cuerpo.reuse.leadConverted, true);
    },
  },
  {
    nombre: "sin email: no hay correo; escalón 2 con motor de descuentos",
    pedidos: [{ body: bodyBase({ cliente: { contactoEmail: undefined }, raiz: { escalonDescuento: 2 } }) }],
    verificar: (r, t) => {
      t.equal(llamadas(r, "zoho", "POST", /send_mail/).length, 0);
      const q = llamadas(r, "zoho", "POST", /Cotizaciones_GeoVictoria$/)[0];
      t.ok(q.cuerpo.data[0].Descuento_Recurrente_Pct > 0, "descuento aplicado");
    },
  },
  {
    nombre: "adjunto PDF con token de Zoho Files + CC rechazado → reintento sin CC",
    env: { ZOHO_FILES_REFRESH_TOKEN: "rt-files" },
    zoho: { reglas: { antes: (m, ruta, cuerpo) => (
      /send_mail/.test(ruta) && cuerpo?.data?.[0]?.cc
        ? { status: 400, json: { code: "NOT_ALLOWED", message: "5.4.1 Recipient address rejected" } }
        : null
    ) } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(llamadas(r, "zoho", "POST", /send_mail/).length, 2);
      t.ok(llamadas(r, "http", "POST", /www\.zohoapis\.com\/crm\/v3\/files/).length === 1, "adjunto subido");
    },
  },
  {
    nombre: "CRM_STRICT=1 + falla en cuenta → 500 con stage",
    env: { CRM_STRICT: "1" },
    zoho: { reglas: { antes: (m, ruta) => (m === "POST" && /^\/crm\/v3\/Accounts$/.test(ruta) ? { status: 400, json: { data: [{ code: "INVALID_DATA", message: "campo malo" }] } } : null) } },
    pedidos: [{ body: bodyBase() }],
    verificar: (r, t) => {
      t.equal(r.respuestas[0].status, 500);
    },
  },
  {
    nombre: "validaciones y puerta (400 · 401 · 405 · OPTIONS)",
    pedidos: [
      { body: bodyBase({ cliente: { rutEmpresa: "" } }) },
      { body: { ...bodyBase(), cotizacion: { ...bodyBase().cotizacion, items: [] } } },
      { body: { ...bodyBase(), cotizacion: { ...bodyBase().cotizacion, totalUF: "0.95" } } },
      { body: bodyBase({ raiz: { existing: { leadId: "1", accountId: "2" } } }) },
      { body: bodyBase(), headers: { "x-vicky-secret": "malo" } },
      { method: "GET", body: bodyBase() },
      { method: "OPTIONS", body: bodyBase(), headers: { origin: "https://evil.example" } },
    ],
    verificar: (r, t) => {
      t.deepEqual(r.respuestas.map((x) => x.status), [400, 400, 400, 400, 401, 405, 403]);
    },
  },
];

module.exports = { ESCENARIOS, bodyBase, FONO, RUT, EMPRESA };
