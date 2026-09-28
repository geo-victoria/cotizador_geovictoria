/**
 * EMISIÓN ÚNICA — el proceso de Chile, parametrizado por la ficha del país.
 *
 * `emitirCotizacion(req, res, { ficha, entrada, bodyCrudo })` es el CUERPO
 * del handler `api/quote-acceptance/create-from-vicky.js` (pasos 3-27 del
 * mapa de la emisión) con cada dato de país leído de la ficha (fichas.js).
 * Con FICHA_CL hace EXACTAMENTE lo mismo que el handler chileno: lo prueba
 * tests/emision/identidad-cl.test.js comparando llamada por llamada.
 *
 * `crearEndpointEmision(ficha, { normalizar })` arma el endpoint fino:
 * CORS → método → auth (ficha.secretEnvs) → normalizar el body del país al
 * contrato de Chile → emitirCotizacion.
 *
 * FASE 1: ningún endpoint productivo lo usa todavía. Ver README.md.
 *
 * Los comentarios de negocio de cada paso siguen en el handler chileno (es la
 * referencia); acá se deja el porqué solo donde la parametrización lo pide.
 */
const crypto = require("crypto");
const { codigoCortoDeCotizacion, linkCortoDeCotizacion } = require("../codigo-corto");
const { repararMojibake } = require("../mojibake");
const { signAcceptancePayload } = require("../acceptance-token");
const { actualizarPunteroPdf } = require("../pointer-sync");
const { createRecord, updateRecord, getRecord, getRecordWithFields, toText } = require("../zoho-crm");
const { getAcceptanceConfig } = require("../quote-acceptance-config");
const {
  claveIdempotencia, getIdempotente, setIdempotente, getDealPorFono, setDealPorFono,
  reservarDealPorFono, getLeadCandadoPorFono,
} = require("../idempotencia");
const { nacerDealDesdeLead } = require("../lead-first");
const { conEmbudoDeCampanas } = require("../embudo-zoho");
const { zohoApiFetch } = require("../zoho-auth");
const { htmlToPdfBuffer } = require("../pdfshift-client");
const { uploadPdfToSupabase } = require("../supabase-pdf-upload");
const { descuentosHasta } = require("../discount-engine");
const { DISCOUNT_LADDER } = require("../proposal-constants");
const { emitirCotizacionEnCreator } = require("../ndv-emitir");
const {
  setCors, sendJson, parseBody, splitFullName, cargarWaitUntil,
  isInvalidIdError, isDuplicateDataError, executeCoqlQuery, findContactIdByEmail,
  tryReuseRecord, recoverConvertedIds, dealAReactivarEnAgente, numeroParaPdf, collectEscalerasPrecio,
} = require("./util");
const { sendQuoteEmailViaZoho, subirArchivoZohoParaAdjunto } = require("./correo");

const waitUntil = cargarWaitUntil();

// ── Convert Lead → Account + Contact + Deal (copia de convertLeadCrudo CL) ──
async function convertLeadCrudo(leadId, dealData, existingIds = {}) {
  const path = `/crm/v3/Leads/${encodeURIComponent(leadId)}/actions/convert`;
  const payload = {
    overwrite: true,
    notify_lead_owner: true,
    notify_new_entity_owner: true,
    ...(dealData ? { Deals: dealData } : {}),
  };
  if (existingIds.accountId) payload.Accounts = { id: existingIds.accountId };
  if (existingIds.contactId) payload.Contacts = { id: existingIds.contactId };
  const response = await zohoApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [payload] }),
  });
  const text = await response.text();
  if (!response.ok) {
    let dup = null;
    try { dup = JSON.parse(text)?.data?.[0]; } catch { /* noop */ }
    if (dup?.code === "DUPLICATE_DATA" && dup?.details?.duplicate_record?.id) {
      const dupModule = toText(dup?.details?.duplicate_record?.module?.api_name);
      const dupId = toText(dup.details.duplicate_record.id);
      const puedeReintentar =
        (dupModule === "Contacts" && !existingIds.contactId) ||
        (dupModule !== "Contacts" && !existingIds.accountId);
      if (puedeReintentar) {
        console.warn(`[emision] convert duplicado en ${dupModule} (${dupId}); reintento fusionando.`);
        const retryIds =
          dupModule === "Contacts"
            ? { ...existingIds, contactId: dupId }
            : { ...existingIds, accountId: dupId };
        return convertLeadCrudo(leadId, dealData, retryIds);
      }
    }
    throw new Error(`Zoho convert Lead failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text);
  const result = parsed?.data?.[0];
  if (!result) throw new Error("Respuesta de convert Lead sin data");
  const idFrom = (v) => toText(v && typeof v === "object" ? v.id : v);
  const det = result.details || {};
  const ids = {
    accountId: idFrom(result.Accounts) || idFrom(det.Accounts),
    contactId: idFrom(result.Contacts) || idFrom(det.Contacts),
    dealId: idFrom(result.Deals) || idFrom(det.Deals),
  };
  if (ids.accountId && ids.contactId && (ids.dealId || !dealData)) return ids;
  const recovered = await recoverConvertedIds(leadId);
  return {
    accountId: ids.accountId || recovered.accountId,
    contactId: ids.contactId || recovered.contactId,
    dealId: ids.dealId || recovered.dealId,
  };
}
const convertLead = conEmbudoDeCampanas(convertLeadCrudo);

// ── Lead vivo del teléfono, solo de dueños "del bot" (ficha.owners.adoptables) ──
async function findOpenLeadIdByPhone(ficha, telefono) {
  const fono = String(telefono || "").replace(/\D/g, "");
  if (!fono) return "";
  let candidato = "";
  try {
    candidato = await getLeadCandadoPorFono(fono);
  } catch { /* best-effort */ }
  if (!candidato) {
    try {
      const response = await zohoApiFetch(
        `/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=3`,
      );
      if (response.ok && response.status !== 204) {
        const leads = (await response.json())?.data || [];
        const abierto = leads.find(
          (l) =>
            !(
              l?.Converted_Deal?.id ||
              l?.Converted_Account?.id ||
              l?.Converted_Contact?.id ||
              l?.["$converted_detail"]?.deal
            ),
        );
        candidato = toText(abierto?.id);
      }
    } catch { /* best-effort */ }
  }
  if (!candidato) return "";
  try {
    const g = await zohoApiFetch(`/crm/v3/Leads/${encodeURIComponent(candidato)}?fields=Owner`);
    if (!g.ok) return "";
    const lead = (await g.json())?.data?.[0];
    const ownerId = toText(lead?.Owner?.id);
    if (!ficha.owners.adoptables.has(ownerId)) {
      console.warn(`[${ficha.etiquetaLog}] lead ${candidato} tiene dueño humano (${ownerId}) — no se adopta, gestión intocable.`);
      return "";
    }
    return candidato;
  } catch {
    return "";
  }
}

// ── Lead ya convertido por teléfono (lead-first; excepción de campaña) ──
async function findConvertedIdsByPhone(ficha, telefono) {
  const fono = toText(telefono).replace(/\D/g, "");
  if (!fono) return {};
  try {
    const res = await zohoApiFetch(
      `/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=3`,
    );
    if (!res.ok || res.status === 204) return {};
    const lead = ((await res.json())?.data || []).find(
      (l) => l?.["$converted_detail"]?.deal || l?.Converted_Deal?.id || l?.Converted_Account?.id,
    );
    if (!lead) return {};
    const detail = lead["$converted_detail"] || {};
    const ids = {
      accountId: toText(detail.account || lead?.Converted_Account?.id),
      contactId: toText(detail.contact || lead?.Converted_Contact?.id),
      dealId: toText(detail.deal || lead?.Converted_Deal?.id),
    };
    if (ids.dealId) {
      const deal = await getRecord("Deals", ids.dealId);
      if (["Cierre Perdido", "8. Facturando"].includes(toText(deal?.Stage))) {
        const marcado = toText(deal?.Stage) === "Cierre Perdido" ? await dealAReactivarEnAgente(fono) : "";
        if (marcado && marcado === ids.dealId) {
          console.warn(`[${ficha.etiquetaLog}] ${fono}: deal ${ids.dealId} en Cierre Perdido marcado por campaña de reactivación — se reusa`);
        } else {
          ids.dealId = "";
        }
      }
    }
    if (ids.accountId || ids.contactId || ids.dealId) {
      console.warn(
        `[${ficha.etiquetaLog}] lead-first: contacto ${fono} ya convertido — se reusa account=${ids.accountId || "-"} contact=${ids.contactId || "-"} deal=${ids.dealId || "-"}`,
      );
    }
    return ids;
  } catch {
    return {};
  }
}

// ── Guarda de documento del deal: otro RUT/RUC/NIT/RFC = otra empresa ──
async function guardaRutDeal(ficha, dealId, documentoCliente) {
  const compact = ficha.documento.clave;
  const rutNuevo = compact(documentoCliente);
  if (!dealId || !rutNuevo) return null;
  try {
    const deal = await getRecord("Deals", dealId);
    const rutDeal = compact(deal?.Rut_ID_Account);
    if (!rutDeal || rutDeal === rutNuevo) return null;
    const ownerId = toText(deal?.Owner?.id);
    const ownerEsHumano = Boolean(ownerId) && !ficha.owners.adoptables.has(ownerId);
    console.warn(
      `[${ficha.etiquetaLog}] GUARDA DOCUMENTO DEAL: deal ${dealId} es de ${rutDeal} y la emisión trae ${rutNuevo} — ` +
        `empresas distintas, nace un deal propio${ownerEsHumano ? ` (hereda dueño ${ownerId})` : ""}.`,
    );
    return { ownerHeredadoId: ownerEsHumano ? ownerId : "" };
  } catch {
    return null;
  }
}

// ── Payloads completos de cuenta/contacto (el update conservador los filtra) ──
function buildAccountFullPayload(ficha, cliente, sectorParaZoho) {
  return {
    Phone: cliente.contactoTelefono || undefined,
    Industry: sectorParaZoho,
    Territorio: ficha.territorio,
    N_Empleados_dependientes: cliente.userCount,
    Tiene_potencial_de_expansi_n_Regional: ficha.sector.expansionRegional,
    RUT_Empresa: ficha.documento.paraCuenta(cliente.rutEmpresa),
    Billing_Street: cliente.direccionEmpresa || undefined,
    Billing_City: cliente.comunaEmpresa || undefined,
    Billing_State: cliente.regionEmpresa || undefined,
  };
}

function buildContactFullPayload(ficha, cliente) {
  const { firstName, lastName } = splitFullName(cliente.contacto);
  return {
    First_Name: firstName,
    Last_Name: lastName,
    Email: cliente.contactoEmail,
    Phone: cliente.contactoTelefono || undefined,
    Lead_Source: cliente.leadSource || ficha.deal.leadSourceDefault,
    Territorio: ficha.territorio,
  };
}

// ── Capa 3: cuenta por documento (variantes de la ficha, sin internas) ──
async function findAccountIdByDocumento(ficha, documento, empresaName) {
  const variants = ficha.documento.variantes(documento);
  if (variants.length === 0) return null;
  const escaped = variants.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const query = `select id, Account_Name from Accounts where RUT_Empresa in (${escaped}) limit 10`;
  const rows = await executeCoqlQuery(query);
  if (!rows.length) return null;
  const externas = rows.filter((r) => !ficha.cuentas.esNoAdoptable(r.Account_Name));
  if (!externas.length) {
    console.warn(
      `[${ficha.etiquetaLog}] dedup por ${ficha.documento.etiqueta} '${documento}' solo matcheó cuenta(s) interna(s); se ignora.`,
    );
    return null;
  }
  if (empresaName) {
    const norm = (s) => String(s || "").trim().toLowerCase();
    const target = norm(empresaName);
    const byName = externas.find((r) => norm(r.Account_Name) === target);
    if (byName) return toText(byName.id);
  }
  return toText(externas[0]?.id) || null;
}

function validarSector(ficha, valorRecibido) {
  const v = toText(valorRecibido);
  if (v && ficha.sector.validos && ficha.sector.validos.has(v)) return v;
  return ficha.sector.fallback;
}

// Descuento inicial del escalón negociado: motor chileno (descuentosHasta
// sobre las filas del subform) o escalera simple (PE/CO/MX: % del plan).
function calcularDescuentos(ficha, subformItems, config, escalon) {
  if (ficha.descuento.motor === "cl") {
    const pseudoQuote = { [config.quoteItemsSubformField]: subformItems };
    const acum = descuentosHasta(pseudoQuote, config, escalon - 1);
    return {
      descuentos: acum.descuentos,
      condicionDiscursiva: acum.lastEscalon ? acum.lastEscalon.condicionDiscursiva : null,
    };
  }
  const pct = escalon > 0 && DISCOUNT_LADDER[escalon - 1] ? Number(DISCOUNT_LADDER[escalon - 1].pct) : 0;
  return { descuentos: { recurrentePct: pct, instalacionRMPct: 0, instalacionRegionPct: 0 }, condicionDiscursiva: null };
}

function camposDescuento(ficha, config, escalon, desc) {
  if (!ficha.descuento.escribirSiempre && !(escalon > 0)) return {};
  return {
    [config.quoteEscalonField]: escalon,
    [config.quoteEscalonNegociacionField]: escalon,
    [config.quoteDiscountUnlockedField]: escalon > 0,
    [config.quoteDiscountPctField]: desc.recurrentePct,
    [config.quoteDiscountInstRMPctField]: desc.instalacionRMPct,
    [config.quoteDiscountInstRegionPctField]: desc.instalacionRegionPct,
  };
}

function firmarToken(ficha, { quoteId, dealId, iat, exp, nonce }) {
  const pais = ficha.token && ficha.token.pais;
  return signAcceptancePayload({
    quoteId, dealId,
    ...(pais ? { pais } : {}),
    iat, exp,
    nonce,
    v: 1,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Cuerpo de la emisión (pasos 3-27 del handler chileno).
// ════════════════════════════════════════════════════════════════════════════
async function emitirCotizacion(req, res, { ficha, entrada, bodyCrudo }) {
  const tag = ficha.etiquetaLog;
  const campos = ficha.moneda.campos;
  const INTERINO = ficha.owners.interino;
  let stage = "init";
  try {
    const body = entrada;
    const cliente = body.cliente || {};
    const leadSourceEmision = toText(body.leadSource).trim() || ficha.deal.leadSourceDefault;
    cliente.leadSource = leadSourceEmision;
    const cotizacion = body.cotizacion || {};
    const existing = body.existing || {};
    const sinCorreoCliente = body.sinCorreoCliente === true;
    const escalonDescuento = Math.max(0, Number(body.escalonDescuento || 0));
    const draft = body.draft === true;

    const mensajes = ficha.mensajes || {};
    if (!cliente.empresa || !cliente.contacto || !cliente.rutEmpresa) {
      return sendJson(res, 400, {
        ok: false,
        error: mensajes.faltanCampos || "Faltan campos en cliente: empresa, contacto, rutEmpresa",
      });
    }
    if (ficha.documento.validar) {
      const v = ficha.documento.validar(cliente.rutEmpresa, cliente);
      if (v && v.ok === false) return sendJson(res, 400, { ok: false, error: v.error });
      if (v && v.advertencia) console.warn(`[${tag}] ${v.advertencia} (se acepta igual).`);
    }
    if (!cotizacion.items || !Array.isArray(cotizacion.items) || cotizacion.items.length === 0) {
      return sendJson(res, 400, { ok: false, error: mensajes.itemsRequerido || "cotizacion.items requerido (no vacío)" });
    }
    if (ficha.moneda.validarItem) {
      for (let i = 0; i < cotizacion.items.length; i++) {
        const err = ficha.moneda.validarItem(cotizacion.items[i], i);
        if (err) return sendJson(res, 400, { ok: false, error: err });
      }
    }
    if (typeof cotizacion[campos.total] !== "number") {
      return sendJson(res, 400, { ok: false, error: `cotizacion.${campos.total} requerido` });
    }
    if (existing.leadId && (existing.accountId || existing.contactId)) {
      return sendJson(res, 400, {
        ok: false,
        error: "existing.leadId no puede venir junto con existing.accountId o existing.contactId",
      });
    }

    const config = getAcceptanceConfig(req);
    const sectorParaZoho = validarSector(ficha, cliente.sectorEmpresa);

    // ── IDEMPOTENCIA: clave = hash del body CRUDO del país ──
    const idemClave = claveIdempotencia(bodyCrudo);
    if (!draft) {
      const previo = await getIdempotente(idemClave);
      if (previo && previo.quoteId) {
        console.warn(
          `[${tag}] reintento idempotente: mismo body ya creó quote ${previo.quoteId} / deal ${previo.dealId || "-"} — no se duplica.`,
        );
        const expMsIdem = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
        const tokenIdem = firmarToken(ficha, {
          quoteId: previo.quoteId, dealId: previo.dealId || "",
          iat: Date.now(), exp: expMsIdem,
          nonce: crypto.randomBytes(8).toString("hex"),
        });
        const acceptanceUrlIdem = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(tokenIdem)}`;
        await updateRecord(config.quoteModule, previo.quoteId, {
          [config.quoteAcceptanceUrlField]: acceptanceUrlIdem,
          [config.quoteStatusField]: "Enviada",
        }, true).catch(() => {});
        return sendJson(res, 200, {
          ok: true,
          quoteId: previo.quoteId,
          dealId: previo.dealId || "",
          accountId: previo.accountId || "",
          contactId: previo.contactId || "",
          acceptanceUrl: acceptanceUrlIdem,
          ...(ficha.respuesta.linkCortoEnReintento ? { linkCorto: linkCortoDeCotizacion(previo.quoteId, config.baseUrl) } : {}),
          pdfUrl: "",
          pdfPendiente: true,
          reuse: { retryIdempotente: true },
          expiresAt: new Date(expMsIdem).toISOString(),
        });
      }
    }

    let accountId, contactId, dealId;
    const reuse = {
      accountReused: false,
      contactReused: false,
      leadConverted: false,
      dealReused: false,
      quoteReused: false,
    };

    // Candado cruzado hito↔cotización (vic_kv deal_fono_).
    stage = "check_deal_kv";
    let dealCruzado = null;
    try {
      dealCruzado = await getDealPorFono(cliente.contactoTelefono);
      if (dealCruzado) {
        console.warn(
          `[${tag}] candado kv: deal ${dealCruzado.dealId} recién creado (origen=${dealCruzado.origen || "?"}) para ${cliente.contactoTelefono} — se reusa, no se crea gemelo.`,
        );
      }
    } catch { /* best-effort */ }
    let ownerHeredadoRutSplit = "";
    if (dealCruzado) {
      const g = await guardaRutDeal(ficha, dealCruzado.dealId, cliente.rutEmpresa);
      if (g) {
        ownerHeredadoRutSplit = g.ownerHeredadoId || ownerHeredadoRutSplit;
        dealCruzado = null;
      }
    }

    // Candado anti-carrera: reserva "creando".
    if (!dealCruzado && !existing.dealId) {
      try {
        const reserva = await reservarDealPorFono(cliente.contactoTelefono, "cotizacion");
        if (!reserva.ok) {
          const otra = reserva.dealId
            ? { dealId: reserva.dealId, origen: reserva.origen || "" }
            : await getDealPorFono(cliente.contactoTelefono);
          if (otra) {
            dealCruzado = otra;
            console.warn(`[${tag}] candado anti-carrera: creación en curso por la otra puerta — se reusa deal ${otra.dealId}.`);
          }
        }
      } catch { /* best-effort */ }
    }

    // Adopción del lead vivo (dueño del bot) → Camino A. Colombia lo tiene
    // gateado (ficha.flags.convertFirst puede ser una función async).
    const convertFirst = typeof ficha.flags.convertFirst === "function"
      ? await ficha.flags.convertFirst()
      : ficha.flags.convertFirst !== false;
    if (convertFirst && !existing.leadId && !existing.accountId && !existing.contactId && !existing.dealId) {
      stage = "adopt_lead_by_phone";
      const leadVivo = await findOpenLeadIdByPhone(ficha, cliente.contactoTelefono).catch(() => "");
      if (leadVivo) {
        existing.leadId = leadVivo;
        console.warn(`[${tag}] lead vivo ${leadVivo} adoptado por teléfono ${cliente.contactoTelefono} — el deal nace de su conversión.`);
      }
    }

    // ── CAMINO A: convertir el lead ──
    if (existing.leadId) {
      let leadSourceHeredada = "";
      try {
        const leadSrc = await getRecord("Leads", existing.leadId).catch(() => null);
        leadSourceHeredada = toText(leadSrc?.Lead_Source).trim();
      } catch { /* sin fuente: default */ }
      const leadSourceDeal = leadSourceHeredada || leadSourceEmision;
      stage = "lead_company_pre_convert";
      try {
        const empresaReal = toText(cliente.empresa).trim();
        if (empresaReal && !ficha.cuentas.esCompanyPlaceholder.test(empresaReal)) {
          const leadPrev = await getRecord("Leads", existing.leadId).catch(() => null);
          const companyPrev = toText(leadPrev?.Company).trim();
          if (leadPrev && (!companyPrev || ficha.cuentas.esCompanyPlaceholder.test(companyPrev))) {
            const rutPrev = toText(leadPrev?.RUT_Empresa).trim();
            const docLead = ficha.documento.paraLead(cliente.rutEmpresa);
            await updateRecord("Leads", existing.leadId, {
              Company: empresaReal,
              ...(cliente.rutEmpresa && !rutPrev ? { RUT_Empresa: docLead } : {}),
            }, false);
            console.warn(`[${tag}] lead ${existing.leadId}: Company "${companyPrev || "∅"}" → "${empresaReal}" antes de convertir.`);
          }
        }
      } catch (e) {
        console.warn(`[${tag}] pre-convert Company falló (se sigue): ${toText(e?.message || e).slice(0, 150)}`);
      }
      stage = "convert_lead";
      try {
        const dealDataForConvert = {
          Deal_Name: ficha.deal.nombre(repararMojibake(cliente.empresa)),
          ...(ficha.documento.enDeal && cliente.rutEmpresa ? { Rut_ID_Account: cliente.rutEmpresa } : {}),
          Stage: ficha.deal.etapaInicial,
          Pipeline: ficha.deal.pipeline,
          Closing_Date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          Amount: ficha.deal.amount(cotizacion),
          Territorio: ficha.territorio,
          Tombola: ficha.deal.tombola,
          Monda_del_trato: ficha.monedaDeal,
          Sector: sectorParaZoho,
          N_Empleados_que_marcan: cliente.userCount,
          Tipo_de_Cobro: ficha.deal.tipoDeCobro(cliente.userCount),
          Producto_Soluci_n: ficha.deal.producto,
          Lead_Source: leadSourceDeal,
          Owner: ownerHeredadoRutSplit ? { id: ownerHeredadoRutSplit } : INTERINO,
        };
        const convertResult = await convertLead(existing.leadId, dealCruzado ? null : dealDataForConvert);
        accountId = convertResult.accountId;
        contactId = convertResult.contactId;
        dealId = convertResult.dealId || (dealCruzado ? dealCruzado.dealId : undefined);
        if (dealCruzado && dealId === dealCruzado.dealId) reuse.dealReused = true;

        if (!accountId || !contactId || !dealId) {
          throw new Error("Conversión de Lead no devolvió todos los IDs");
        }
        reuse.leadConverted = true;

        stage = "update_account_after_convert";
        await updateRecord("Accounts", accountId, buildAccountFullPayload(ficha, cliente, sectorParaZoho), true).catch((e) =>
          console.warn(`[${tag}] update Account post-convert falló (no tumba el convert): ${toText(e?.message || e).slice(0, 150)}`)
        );

        stage = "update_contact_after_convert";
        await updateRecord("Contacts", contactId, buildContactFullPayload(ficha, cliente), true).catch((e) =>
          console.warn(`[${tag}] update Contact post-convert falló (no tumba el convert): ${toText(e?.message || e).slice(0, 150)}`)
        );

        stage = "update_deal_after_convert";
        if (!reuse.dealReused) {
          await updateRecord("Deals", dealId, {
            Owner: ownerHeredadoRutSplit ? { id: ownerHeredadoRutSplit } : INTERINO,
            Account_Name: { id: accountId },
            Contact_Name: { id: contactId },
            Territorio: ficha.territorio,
            Tombola: ficha.deal.tombola,
            Monda_del_trato: ficha.monedaDeal,
            Sector: sectorParaZoho,
            N_Empleados_que_marcan: cliente.userCount,
            Producto_Soluci_n: ficha.deal.producto,
            Lead_Source: leadSourceDeal,
            Description: `Deal creado por Vicky desde Lead convertido.\nUsuarios: ${cliente.userCount}\nTotal: ${ficha.deal.descripcionTotal(cotizacion)}\nSector: ${sectorParaZoho}`,
          }, true);
        } else {
          await updateRecord("Deals", dealId, {
            Amount: ficha.deal.amount(cotizacion),
            N_Empleados_que_marcan: cliente.userCount,
          }, true);
        }
      } catch (convErr) {
        console.error(`[${tag}] CONVERT FALLÓ lead=${existing.leadId} (${toText(convErr?.message || convErr).slice(0, 250)})`);
        accountId = undefined;
        contactId = undefined;
        dealId = undefined;
        reuse.leadConverted = false;
        try {
          const recovered = await recoverConvertedIds(existing.leadId, tag);
          if (recovered.dealId) {
            const g = await guardaRutDeal(ficha, recovered.dealId, cliente.rutEmpresa);
            if (g) {
              ownerHeredadoRutSplit = g.ownerHeredadoId || ownerHeredadoRutSplit;
              recovered.dealId = "";
            }
          }
          if (recovered.dealId) {
            if (recovered.accountId && !existing.accountId) existing.accountId = recovered.accountId;
            if (recovered.contactId && !existing.contactId) existing.contactId = recovered.contactId;
            dealId = recovered.dealId;
            reuse.dealReused = true;
            console.warn(`[${tag}] lead=${existing.leadId} ya estaba convertido — se reusa su deal=${dealId} (adiós gemelo).`);
          }
        } catch (recErr) {
          console.warn(`[${tag}] recuperación post-convert falló: ${toText(recErr?.message || recErr).slice(0, 120)}`);
        }
      }
    }

    // ── Bloque CRM degradable (la cotización SIEMPRE se entrega) ──
    let crmIncompleto = false;
    try {
    if (!reuse.leadConverted) {
      if (!accountId && !contactId && !dealId) {
        stage = "find_converted_by_phone";
        const convertidos = await findConvertedIdsByPhone(ficha, cliente.contactoTelefono);
        if (convertidos.accountId && !existing.accountId) existing.accountId = convertidos.accountId;
        if (convertidos.contactId && !existing.contactId) existing.contactId = convertidos.contactId;
        if (convertidos.dealId) {
          const g = await guardaRutDeal(ficha, convertidos.dealId, cliente.rutEmpresa);
          if (g) {
            ownerHeredadoRutSplit = g.ownerHeredadoId || ownerHeredadoRutSplit;
            convertidos.dealId = "";
          }
        }
        if (convertidos.dealId) {
          dealId = convertidos.dealId;
          reuse.dealReused = true;
        }
        if (!dealId && dealCruzado) {
          const dealKv = await getRecord("Deals", dealCruzado.dealId).catch(() => null);
          if (dealKv) {
            dealId = dealCruzado.dealId;
            reuse.dealReused = true;
            const accKv = toText(dealKv?.Account_Name?.id);
            const ctKv = toText(dealKv?.Contact_Name?.id);
            if (accKv && !existing.accountId) existing.accountId = accKv;
            if (ctKv && !existing.contactId) existing.contactId = ctKv;
          }
        }
      }
      // Guarda de documento de la cuenta adoptada.
      if (existing.accountId && toText(cliente.rutEmpresa)) {
        const soloDoc = ficha.documento.clave;
        const accAdoptada = await getRecord("Accounts", existing.accountId).catch(() => null);
        const rutAcc = soloDoc(accAdoptada?.RUT_Empresa);
        const rutCli = soloDoc(cliente.rutEmpresa);
        if (accAdoptada && rutAcc && rutCli && rutAcc !== rutCli) {
          console.warn(
            `[${tag}] cuenta adoptada ${existing.accountId} ("${toText(accAdoptada.Account_Name)}", ${ficha.documento.etiqueta} ${toText(accAdoptada.RUT_Empresa)}) ≠ declarado ${cliente.rutEmpresa} — no se reusa`
          );
          existing.accountId = "";
        }
      }
      // ── CAMINO B: cuenta ──
      let needCreateAccount = !existing.accountId;

      if (existing.accountId) {
        stage = "update_existing_account";
        const accountPayload = buildAccountFullPayload(ficha, cliente, sectorParaZoho);
        const reuseResult = await tryReuseRecord("Accounts", existing.accountId, accountPayload, tag);
        if (reuseResult.ok) {
          accountId = reuseResult.recordId;
          reuse.accountReused = true;
        } else if (reuseResult.invalidId) {
          needCreateAccount = true;
        }
      }

      if (needCreateAccount) {
        stage = "create_account";
        const createAccountPayload = {
          Account_Name: repararMojibake(cliente.empresa),
          RUT_Empresa: ficha.documento.paraCuenta(cliente.rutEmpresa),
          Phone: cliente.contactoTelefono || undefined,
          Billing_Street: cliente.direccionEmpresa || undefined,
          Billing_City: cliente.comunaEmpresa || undefined,
          Billing_State: cliente.regionEmpresa || undefined,
          Description: `Cuenta creada por Vicky (WhatsApp). ${ficha.documento.etiqueta}: ${cliente.rutEmpresa}`,
          Industry: sectorParaZoho,
          Territorio: ficha.territorio,
          N_Empleados_dependientes: cliente.userCount,
          Tiene_potencial_de_expansi_n_Regional: ficha.sector.expansionRegional,
          Owner: INTERINO,
        };
        try {
          const accountResult = await createRecord("Accounts", createAccountPayload, true);
          accountId = toText(accountResult?.id);
          if (!accountId) throw new Error("No se obtuvo accountId");
        } catch (createError) {
          if (!isDuplicateDataError(createError)) throw createError;
          // ── Capa 3: dedup por documento ──
          stage = "dedupe_account_by_rut";
          const existingAccountId = await findAccountIdByDocumento(ficha, cliente.rutEmpresa, cliente.empresa);
          let adoptadaSinRut = false;
          if (!existingAccountId) {
            const homonimas = await executeCoqlQuery(
              `select id, RUT_Empresa, Account_Name from Accounts where Account_Name = '${cliente.empresa.replace(/'/g, "''")}' limit 5`,
            ).catch(() => []);
            const sinRut = (homonimas || []).find(
              (r) => !String(r.RUT_Empresa || "").trim() && !ficha.cuentas.esNoAdoptable(r.Account_Name),
            );
            if (sinRut) {
              accountId = toText(sinRut.id);
              reuse.accountReused = true;
              adoptadaSinRut = true;
              console.warn(`[${tag}] Capa 3 Account: homónima sin documento id=${accountId}; se adopta y se completa.`);
              await tryReuseRecord("Accounts", accountId, buildAccountFullPayload(ficha, cliente, sectorParaZoho), tag).catch(
                () => ({ ok: false }),
              );
            }
          }
          if (!existingAccountId && !adoptadaSinRut) {
            stage = "create_account_disambiguated";
            const nombreDesambiguado = `${cliente.empresa} (${cliente.rutEmpresa})`;
            try {
              const retryResult = await createRecord(
                "Accounts",
                { ...createAccountPayload, Account_Name: nombreDesambiguado },
                true,
              );
              accountId = toText(retryResult?.id);
              if (!accountId) throw new Error("No se obtuvo accountId (cuenta desambiguada)");
            } catch (retryError) {
              if (!isDuplicateDataError(retryError)) throw retryError;
              // ── Capa 4 ──
              stage = "reuse_account_capa4";
              const porNombre = await executeCoqlQuery(
                `select id, RUT_Empresa from Accounts where Account_Name = '${nombreDesambiguado.replace(/'/g, "''")}' limit 5`,
              ).catch(() => []);
              const compactar = ficha.documento.claveCapa4;
              const rutNorm = compactar(cliente.rutEmpresa);
              const matchRut = (porNombre || []).find((r) => compactar(r.RUT_Empresa) === rutNorm);
              if (matchRut) {
                accountId = toText(matchRut.id);
                reuse.accountReused = true;
              } else {
                accountId = undefined;
                console.error(`[${tag}] Capa 4 Account: sin salida de dedupe (${cliente.rutEmpresa}). Sigue SIN cuenta.`);
              }
            }
          } else if (existingAccountId) {
          const fullPayload = buildAccountFullPayload(ficha, cliente, sectorParaZoho);
          const reuseResult = await tryReuseRecord("Accounts", existingAccountId, fullPayload, tag);
          if (!reuseResult.ok) {
            console.warn(`[${tag}] Capa 3 Account: tryReuseRecord falló para id=${existingAccountId}; se usa sin actualizar.`);
          }
          accountId = existingAccountId;
          reuse.accountReused = true;
          }
        }
      }

      // ── Contacto ──
      let needCreateContact = !existing.contactId;

      if (existing.contactId) {
        stage = "update_existing_contact";
        const contactPayload = buildContactFullPayload(ficha, cliente);
        const reuseResult = await tryReuseRecord("Contacts", existing.contactId, contactPayload, tag);
        if (reuseResult.ok) {
          contactId = reuseResult.recordId;
          reuse.contactReused = true;
        } else if (reuseResult.invalidId) {
          needCreateContact = true;
        }
      }

      if (needCreateContact) {
        stage = "create_contact";
        const { firstName, lastName } = splitFullName(cliente.contacto);
        const createContactPayload = {
          First_Name: firstName,
          Last_Name: lastName,
          Email: cliente.contactoEmail,
          Phone: cliente.contactoTelefono || undefined,
          Account_Name: { id: accountId },
          Lead_Source: leadSourceEmision,
          Territorio: ficha.territorio,
          Owner: INTERINO,
        };
        try {
          const contactResult = await createRecord("Contacts", createContactPayload, true);
          contactId = toText(contactResult?.id);
          if (!contactId) throw new Error("No se obtuvo contactId");
        } catch (createError) {
          if (!isDuplicateDataError(createError)) throw createError;
          stage = "dedupe_contact_by_email";
          const existingContactId = await findContactIdByEmail(cliente.contactoEmail);
          if (!existingContactId) {
            throw new Error(
              `Zoho reportó duplicate data pero no se encontró Contact con Email ${cliente.contactoEmail}`,
            );
          }
          const fullPayload = buildContactFullPayload(ficha, cliente);
          const reuseResult = await tryReuseRecord("Contacts", existingContactId, fullPayload, tag);
          if (!reuseResult.ok) {
            console.warn(`[${tag}] Capa 3 Contact: tryReuseRecord falló para id=${existingContactId}; se usa sin actualizar.`);
          }
          contactId = existingContactId;
          reuse.contactReused = true;
        }
      }

      // Deal del Borrador en curso.
      if (existing.dealId) {
        stage = "reuse_existing_deal";
        const reuseDeal = await tryReuseRecord("Deals", existing.dealId, {}, tag);
        if (reuseDeal.ok) {
          dealId = reuseDeal.recordId;
          reuse.dealReused = true;
        }
      }

      if (!dealId) {
        const dealDataFresco = {
          Deal_Name: ficha.deal.nombre(repararMojibake(cliente.empresa)),
          ...(ficha.documento.enDeal && cliente.rutEmpresa ? { Rut_ID_Account: cliente.rutEmpresa } : {}),
          Stage: ficha.deal.etapaInicial,
          Pipeline: ficha.deal.pipeline,
          Lead_Source: leadSourceEmision,
          Amount: ficha.deal.amount(cotizacion),
          Description: `Deal creado por Vicky para cotización WhatsApp.\nUsuarios: ${cliente.userCount}\nTotal: ${ficha.deal.descripcionTotal(cotizacion)}\nSector: ${sectorParaZoho}`,
          Territorio: ficha.territorio,
          Tombola: ficha.deal.tombola,
          Monda_del_trato: ficha.monedaDeal,
          Sector: sectorParaZoho,
          N_Empleados_que_marcan: cliente.userCount,
          Tipo_de_Cobro: ficha.deal.tipoDeCobro(cliente.userCount),
          Producto_Soluci_n: ficha.deal.producto,
          Owner: ownerHeredadoRutSplit ? { id: ownerHeredadoRutSplit } : INTERINO,
        };
        // LEAD-FIRST (regla de oro global, Lalo 23-sep).
        stage = "lead_first";
        const nacido = await nacerDealDesdeLead({
          telefono: cliente.contactoTelefono, contacto: cliente.contacto, empresa: repararMojibake(cliente.empresa),
          email: cliente.contactoEmail, territorio: ficha.territorio, leadSource: leadSourceEmision,
          empleados: cliente.userCount, documento: ficha.documento.paraLead(cliente.rutEmpresa),
          dealData: dealDataFresco, ownerDefault: dealDataFresco.Owner,
          existingIds: { accountId, contactId }, etiqueta: tag,
          ...(ficha.owners.noHeredables ? { noHeredables: ficha.owners.noHeredables } : {}),
        }).catch(() => null);
        if (nacido?.dealId) {
          dealId = nacido.dealId;
          if (!accountId && nacido.accountId) { accountId = nacido.accountId; reuse.accountReused = true; }
          if (!contactId && nacido.contactId) contactId = nacido.contactId;
        } else {
          stage = "create_deal";
          const dealResult = await createRecord("Deals", {
            ...dealDataFresco,
            ...(accountId ? { Account_Name: { id: accountId } } : {}),
            ...(contactId ? { Contact_Name: { id: contactId } } : {}),
            Description: `${dealDataFresco.Description}\n⚠️ Nació SIN lead convertido: lead-first falló (revisar).`,
          }, true);
          dealId = toText(dealResult?.id);
          if (!dealId) throw new Error("No se obtuvo dealId");
          console.error(`[${tag}] deal ${dealId} nació SIN lead convertido (lead-first falló).`);
        }
      }
    }
    } catch (plumbingError) {
      if (String(process.env.CRM_STRICT || "") === "1") throw plumbingError;
      crmIncompleto = true;
      console.error(
        `[${tag}] CRM DEGRADADO en stage=${stage}: ${toText(plumbingError?.message || plumbingError).slice(0, 300)}. ` +
          `La cotización continúa (accountId=${accountId || "∅"}, contactId=${contactId || "∅"}, dealId=${dealId || "∅"}).`,
      );
    }
    if (dealId) await setDealPorFono(cliente.contactoTelefono, dealId, "cotizacion").catch(() => {});
    if (!accountId || !contactId || !dealId) crmIncompleto = true;

    // ── Datos reales pisan placeholders ──
    stage = "corregir_placeholders";
    const ES_PLACEHOLDER = ficha.cuentas.esPlaceholderRegistro;
    try {
      if (accountId && cliente.empresa && !ES_PLACEHOLDER.test(cliente.empresa)) {
        const acc = await getRecord("Accounts", accountId).catch(() => null);
        if (acc && ES_PLACEHOLDER.test(toText(acc.Account_Name))) {
          await updateRecord("Accounts", accountId, {
            Account_Name: repararMojibake(cliente.empresa),
            ...(cliente.rutEmpresa ? { RUT_Empresa: ficha.documento.paraCuenta(cliente.rutEmpresa) } : {}),
          }, true);
        }
      }
      if (dealId) {
        const dl = await getRecord("Deals", dealId).catch(() => null);
        const patchDeal = {};
        if (dl && accountId && !toText(dl.Account_Name?.id)) {
          patchDeal.Account_Name = { id: accountId };
        }
        if (dl && contactId && !toText(dl.Contact_Name?.id)) {
          patchDeal.Contact_Name = { id: contactId };
        }
        if (
          dl &&
          cliente.empresa &&
          !ES_PLACEHOLDER.test(cliente.empresa) &&
          ES_PLACEHOLDER.test(toText(dl.Deal_Name))
        ) {
          patchDeal.Deal_Name = ficha.deal.nombreDesdePlaceholder(cliente.empresa);
          if (cliente.userCount) patchDeal.N_Empleados_que_marcan = cliente.userCount;
        }
        if (dl && ficha.documento.enDeal && cliente.rutEmpresa && !toText(dl.Rut_ID_Account)) {
          patchDeal.Rut_ID_Account = cliente.rutEmpresa;
        }
        if (Object.keys(patchDeal).length) {
          await updateRecord("Deals", dealId, patchDeal, true);
        }
      }
      if (contactId && (cliente.contactoEmail || cliente.contacto)) {
        const ct = await getRecord("Contacts", contactId).catch(() => null);
        if (ct) {
          const patch = {};
          if (!toText(ct.Email) && cliente.contactoEmail) patch.Email = cliente.contactoEmail;
          if (!toText(ct.Phone) && cliente.contactoTelefono) patch.Phone = cliente.contactoTelefono;
          if (/prospecto/i.test(toText(ct.Last_Name)) && cliente.contacto) {
            const partes = splitFullName(cliente.contacto);
            if (partes.lastName && !/prospecto/i.test(partes.lastName)) {
              patch.First_Name = partes.firstName;
              patch.Last_Name = partes.lastName;
            }
          }
          if (Object.keys(patch).length) await updateRecord("Contacts", contactId, patch, true);
        }
      }
    } catch (phErr) {
      console.warn(`[${tag}] corrección de placeholders falló (no bloquea): ${toText(phErr?.message || phErr).slice(0, 150)}`);
    }

    // ── Dueño: la emisión NO sortea; lee el dueño real del deal ──
    stage = "tombola_deal";
    let quoteOwner = INTERINO;
    let quoteOwnerEmail = "";
    let quoteOwnerNombre = "";
    let quoteOwnerTelefono = "";
    const ownerManualId = toText(existing.ownerId);
    if (dealId) {
      try {
        const DUENOS_INTERINOS = new Set(ficha.owners.interinosLectura);
        if (ownerManualId && !ficha.owners.interinosLectura.includes(ownerManualId)) {
          DUENOS_INTERINOS.delete(ownerManualId);
        }
        if (ownerManualId) {
          let ownerActualId = "";
          try {
            const rPre = await zohoApiFetch(`/crm/v3/Deals/${dealId}?fields=Owner`);
            if (rPre.ok) ownerActualId = toText((((((await rPre.json())?.data) || [])[0] || {}).Owner || {}).id);
          } catch (_e) { /* best-effort */ }
          const actualEsHumano = Boolean(ownerActualId) && !DUENOS_INTERINOS.has(ownerActualId);
          if (actualEsHumano && ownerActualId !== ownerManualId) {
            console.warn(`[${tag}] deal ${dealId} ya tiene dueño humano ${ownerActualId} — la herencia (${ownerManualId}) NO lo pisa.`);
          } else {
            await zohoApiFetch(`/crm/v3/Deals`, {
              method: "PUT",
              body: JSON.stringify({
                data: [{ id: dealId, Owner: { id: ownerManualId } }],
                skip_feature_execution: [{ name: "assignment_rules" }],
              }),
            });
          }
        }
        const rOwner = await zohoApiFetch(`/crm/v3/Deals/${dealId}?fields=Owner`);
        if (rOwner.ok) {
          const ownerDeal = (((await rOwner.json())?.data || [])[0] || {}).Owner;
          if (ownerDeal && ownerDeal.id && !DUENOS_INTERINOS.has(toText(ownerDeal.id))) {
            quoteOwner = { id: toText(ownerDeal.id) };
            if (ownerDeal.email) quoteOwnerEmail = toText(ownerDeal.email);
            if (ownerDeal.name) quoteOwnerNombre = toText(ownerDeal.name);
            try {
              const rU = await zohoApiFetch(`/crm/v3/users/${toText(ownerDeal.id)}`);
              if (rU.ok) {
                const u = (((await rU.json())?.users || [])[0] || {});
                const tel = toText(u.phone) || toText(u.mobile);
                quoteOwnerTelefono = tel || "";
              }
            } catch (_e) { /* best-effort */ }
          }
        }
      } catch (tombolaErr) {
        console.warn(`[${tag}] lectura de owner falló para deal=${dealId}: ${toText(tombolaErr?.message || tombolaErr).slice(0, 150)} — cotización queda con el interino.`);
      }
      if (toText(quoteOwner.id) && quoteOwner.id !== INTERINO.id) {
        const seguirDueno = async (mod, id) => {
          try {
            await zohoApiFetch(`/crm/v3/${mod}`, {
              method: "PUT",
              body: JSON.stringify({
                data: [{ id, Owner: quoteOwner }],
                skip_feature_execution: [{ name: "assignment_rules" }],
              }),
            });
          } catch (e) {
            console.warn(`[${tag}] owner de ${mod} no siguió al deal: ${toText(e?.message || e).slice(0, 100)}`);
          }
        };
        if (accountId && !reuse.accountReused) await seguirDueno("Accounts", accountId);
        if (contactId && !reuse.contactReused) await seguirDueno("Contacts", contactId);
      }
    }

    // ── Cotización: nueva o reuso del Borrador ──
    const ufActual = Number(cotizacion.ufActual || 0);
    const subformItems = ficha.subform.construir(cotizacion.items, { ufActual, config });
    const escalerasPrecio = collectEscalerasPrecio(cotizacion.items);

    let descIniciales = { recurrentePct: 0, instalacionRMPct: 0, instalacionRegionPct: 0 };
    let condicionDiscursivaInicial = null;
    if (escalonDescuento > 0) {
      const d = calcularDescuentos(ficha, subformItems, config, escalonDescuento);
      descIniciales = d.descuentos;
      condicionDiscursivaInicial = d.condicionDiscursiva;
    }

    const quoteDiscountFields = camposDescuento(ficha, config, escalonDescuento, descIniciales);

    let quoteId;
    if (existing.quoteId) {
      stage = "update_existing_quote";
      try {
        const existingQuote = await getRecord(config.quoteModule, existing.quoteId);
        if (existingQuote) {
          // Monotonicidad: el escalón del Borrador NUNCA retrocede.
          const escalonExistente = Math.max(0, Number(existingQuote[config.quoteEscalonField] || 0));
          let fieldsToUpdate = quoteDiscountFields;
          if (escalonExistente > escalonDescuento) {
            const d = calcularDescuentos(ficha, subformItems, config, escalonExistente);
            fieldsToUpdate = {
              [config.quoteEscalonField]: escalonExistente,
              [config.quoteEscalonNegociacionField]: escalonExistente,
              [config.quoteDiscountUnlockedField]: escalonExistente > 0,
              [config.quoteDiscountPctField]: d.descuentos.recurrentePct,
              [config.quoteDiscountInstRMPctField]: d.descuentos.instalacionRMPct,
              [config.quoteDiscountInstRegionPctField]: d.descuentos.instalacionRegionPct,
            };
            console.warn(`[${tag}] Monotonicidad escalón: Borrador ${existing.quoteId} ya estaba en ${escalonExistente}, llegó ${escalonDescuento}; se conserva ${escalonExistente}.`);
          }
          await updateRecord(config.quoteModule, existing.quoteId, fieldsToUpdate, true);
          quoteId = existing.quoteId;
          reuse.quoteReused = true;
        }
      } catch (quoteErr) {
        if (!isInvalidIdError(quoteErr)) throw quoteErr;
        console.warn(`[${tag}] Borrador ${existing.quoteId} inválido, se crea cotización nueva. Detalle: ${quoteErr.message?.slice(0, 150)}`);
      }
    }

    if (!quoteId) {
      stage = "create_quote";
      const quoteFields = {
        Name: `Cotización ${repararMojibake(String(cliente.empresa || "").trim())}`.slice(0, 107) + ` - ${new Date().toISOString().slice(0, 10)}`,
        Owner: quoteOwner,
        ...(dealId ? { [config.quoteDealLookupField]: { id: dealId } } : {}),
        ...(contactId ? { [config.quoteContactLookupField]: { id: contactId } } : {}),
        ...(accountId ? { Cuenta_Asociada: { id: accountId } } : {}),
        CRM_Incompleto: crmIncompleto,
        ...(ficha.cotizacion.marcarIntervencionHumana
          ? { Intervenci_n_Humana: sinCorreoCliente ? "Con intervención humana" : "100% Vicky" }
          : {}),
        [config.quoteDateField]: new Date().toISOString().slice(0, 10),
        [config.quoteStatusField]: "Borrador",
        [config.contactEmailField]: cliente.contactoEmail,
        [config.contactPhoneField]: cliente.contactoTelefono || undefined,
        [config.companyRutField]: ficha.documento.paraCotizacion(cliente.rutEmpresa),
        [config.quoteItemsSubformField]: subformItems,
        [config.quoteVersionPdfField]: 1,
        ...(ficha.moneda.ufCongelada && ufActual > 0
          ? {
              UF_Valor: ufActual,
              UF_Fecha: new Date().toISOString().slice(0, 10),
            }
          : {}),
        ...quoteDiscountFields,
        ...(config.quotePriceLadderField && Object.keys(escalerasPrecio).length > 0
          ? { [config.quotePriceLadderField]: JSON.stringify(escalerasPrecio) }
          : {}),
      };
      const quoteResult = await createRecord(config.quoteModule, quoteFields, true);
      quoteId = toText(quoteResult?.id);
      if (!quoteId) throw new Error("No se obtuvo quoteId");
    }

    if (!draft) await setIdempotente(idemClave, { quoteId, dealId, accountId, contactId });

    if (draft) {
      return sendJson(res, 200, {
        ok: true,
        draft: true,
        quoteId, dealId, accountId, contactId,
        sectorAplicado: sectorParaZoho,
        reuse,
      });
    }

    // ── acceptanceUrl ──
    stage = "build_acceptance_url";
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const token = firmarToken(ficha, {
      quoteId, dealId: dealId || "",
      iat: Date.now(), exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

    if (crmIncompleto) {
      const notifyUrl = toText(process.env.VICKY_AGENT_NOTIFY_URL);
      const notifySecret = toText(process.env.VICKY_AGENT_CRON_SECRET);
      if (notifyUrl && notifySecret) {
        fetch(notifyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": notifySecret },
          body: JSON.stringify({ evento: "crm_incompleto", empresa: cliente.empresa, numero: quoteId, monto: "" }),
        }).catch(() => {});
      }
    }
    stage = "update_quote_acceptance";
    await updateRecord(config.quoteModule, quoteId, {
      [config.quoteAcceptanceUrlField]: acceptanceUrl,
      [config.quoteStatusField]: "Enviada",
    }, true);

    sendJson(res, 200, {
      ok: true,
      quoteId, dealId, accountId, contactId,
      acceptanceUrl,
      codigoCorto: codigoCortoDeCotizacion(quoteId),
      linkCorto: linkCortoDeCotizacion(quoteId, config.baseUrl),
      pdfUrl: "",
      pdfPendiente: true,
      sectorAplicado: sectorParaZoho,
      reuse,
      ejecutivo: { nombre: quoteOwnerNombre, email: quoteOwnerEmail },
      ...(ficha.respuesta.extras ? ficha.respuesta.extras({ reuse, descuentos: descIniciales }) : {}),
      expiresAt: new Date(expMs).toISOString(),
    });

    // ── PDF + correo + Creator en segundo plano ──
    waitUntil(
      (async () => {
        await (async () => require("../valor-deal").estamparValorDeal({ quoteModule: config.quoteModule, quoteId, dealId, empleados: Number(cliente?.userCount) || 0 }))().catch(() => {});
        const numeroCotizacion = await getRecordWithFields(config.quoteModule, quoteId, ["Numero_Cotizacion"])
          .then((r) => toText(r?.Numero_Cotizacion))
          .catch(() => "");

        if (accountId && ficha.notaEnCuenta) {
          createRecord("Notes", {
            Note_Title: "Vicky emitió cotización formal — canal digital activo",
            Note_Content:
              `Vicky generó la cotización formal ${numeroCotizacion || quoteId} para este cliente el ` +
              new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" }) +
              ". Si estás trabajando esta cuenta por otro canal, coordinar antes de avanzar (evita ventas en paralelo).",
            Parent_Id: accountId,
            $se_module: "Accounts",
          }).catch(() => {});
        }
        const html = ficha.pdf.construir({
          cliente,
          cotizacion,
          items: cotizacion.items,
          acceptanceUrl,
          cotizacionId: numeroParaPdf(numeroCotizacion, quoteId),
          validezHasta: new Date(expMs).toISOString(),
          descuentos: descIniciales,
          condicionDiscursiva: condicionDiscursivaInicial,
          ejecutivo: { nombre: quoteOwnerNombre, email: quoteOwnerEmail, telefono: quoteOwnerTelefono },
        });
        const pdfBuffer = await htmlToPdfBuffer(html, { ...ficha.pdf.opciones });
        const { pdfUrl } = await uploadPdfToSupabase({
          pdfBuffer,
          quoteId,
          empresa: cliente.empresa,
        });
        await updateRecord(config.quoteModule, quoteId, {
          [config.quotePdfUrlField]: pdfUrl,
        }, true);
        await actualizarPunteroPdf(quoteId, pdfUrl);
        const tieneReloj = (cotizacion.items || []).some(
          (it) => it && it.tipo === "hardware",
        );
        if (sinCorreoCliente) {
          console.log(`[${tag}] correo al cliente SUPRIMIDO (canal ejecutivo) quote=${quoteId}`);
        }
        const adjuntoId = ficha.correo.adjuntoPdf && cliente.contactoEmail && !sinCorreoCliente
          ? await subirArchivoZohoParaAdjunto(pdfBuffer, `cotizacion_${numeroParaPdf(numeroCotizacion, quoteId)}.pdf`)
          : "";
        if (cliente.contactoEmail && !sinCorreoCliente) {
          // Con dueño humano real se presenta él; sin él, el ejecutivo fijo
          // del país si la ficha lo define (hoy PE/CO/MX), si no Vicky.
          const ejecutivoCorreo = quoteOwnerEmail || !ficha.correo.ejecutivoFijo
            ? { nombre: quoteOwnerNombre, email: quoteOwnerEmail, telefono: quoteOwnerTelefono }
            : { ...ficha.correo.ejecutivoFijo };
          const envio = sendQuoteEmailViaZoho({
            quoteModule: config.quoteModule,
            quoteId,
            fromEmail: ficha.correo.fromEmail,
            replyToEmail: quoteOwnerEmail || ficha.correo.ccPais[0] || "",
            ccEmail: quoteOwnerEmail,
            ccEmails: [
              ...ficha.correo.ccFijos,
              ...ficha.correo.ccPais,
              ...(ficha.correo.incluirBodyCc && Array.isArray(body.cc) ? body.cc : []),
            ].filter(Boolean),
            toEmail: cliente.contactoEmail,
            toName: cliente.contacto,
            subject: ficha.correo.asunto(cliente.empresa),
            attachmentId: adjuntoId,
            htmlBody: ficha.correo.plantilla({
              contacto: cliente.contacto,
              empresa: cliente.empresa,
              pdfUrl,
              acceptanceUrl,
              tieneReloj,
              ejecutivo: ejecutivoCorreo,
              pdfAdjunto: Boolean(adjuntoId),
            }),
          });
          if (ficha.correo.tolerarFallo) {
            await envio.catch((mailErr) => console.error(`[${tag}] correo de cotización falló:`, mailErr?.message || mailErr));
          } else {
            await envio;
          }
        }

        // ── Cotización en Zoho Creator (último; best-effort) ──
        const extras = body.extras || {};
        const hayHardware = (cotizacion.items || []).some((it) => String(it?.tipo || "").toLowerCase() === "hardware");
        const escalerasCreator = ficha.creator.escaleras
          ? (() => {
              const e = ficha.creator.escaleras();
              return { plan_asistencia: e.map((t) => ({ ...t })), asistencia: e.map((t) => ({ ...t })) };
            })()
          : escalerasPrecio;
        const overrides = ficha.creator.overrides
          ? {
              ...ficha.creator.overrides,
              ...(ficha.creator.notaHardwareUsd ? { tipoCambio: extras.tipoCambio, tipoCambioFuente: extras.tipoCambioFuente } : {}),
              ...(ficha.creator.notaHardwareUsd && hayHardware ? { filtroLineas: "sin_hardware" } : {}),
            }
          : null;
        try {
          const emisionPlan = await emitirCotizacionEnCreator({
            config,
            quoteId,
            dealId,
            acceptanceData: { companyRut: ficha.documento.paraCreator(cliente?.rutEmpresa) },
            escalerasPrecio: escalerasCreator,
            userCount: Number(cliente?.userCount) || 0,
            crmIncompleto,
            motivo: ficha.creator.motivo,
            ...(overrides ? { creatorOverrides: overrides } : {}),
          });
          if (ficha.creator.notaHardwareUsd && hayHardware && emisionPlan?.status !== "skipped") {
            const emisionHw = await emitirCotizacionEnCreator({
              config,
              quoteId,
              dealId,
              acceptanceData: { companyRut: ficha.documento.paraCreator(cliente?.rutEmpresa) },
              userCount: Number(cliente?.userCount) || 0,
              crmIncompleto,
              motivo: `${ficha.creator.motivo}-hardware-usd`,
              forzarNueva: true,
              persistirReferencia: false,
              creatorOverrides: {
                moneda: "USD", pais: ficha.creator.overrides.pais, filtroLineas: "solo_hardware",
                tipoCambio: extras.tipoCambio, tipoCambioFuente: extras.tipoCambioFuente,
              },
            });
            if (emisionHw?.ndvId) {
              await createRecord("Notes", {
                Note_Title: "Cotización en Creator: hardware en USD (nota aparte)",
                Note_Content:
                  `Perú emite el plan y el hardware en notas separadas. Plan (PEN): Creator id ${emisionPlan?.ndvId || "?"}. ` +
                  `Hardware (USD, artículo 304 - [PER] Reloj Gama Estándar FACIAL LAN WIFI): Creator id ${emisionHw.ndvId}. ` +
                  `Al cliente se le cotizó el reloj en soles al dólar SUNAT ${extras.tipoCambio || "?"} (${extras.tipoCambioFuente || "?"}). ` +
                  `Convertir AMBAS a Nota de Venta al confirmar el pago.`,
                Parent_Id: quoteId,
                $se_module: config.quoteModule,
              }, true).catch(() => {});
            }
          }
        } catch (creatorErr) {
          console.error(`[${tag}] Creator falló (best-effort):`, creatorErr?.message || creatorErr);
        }
      })().catch((bgErr) =>
        console.error(`[${tag}] PDF/correo en segundo plano falló:`, bgErr?.message || bgErr),
      ),
    );
    return;

  } catch (error) {
    console.error(`[${tag}] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: `Falla en stage='${stage}'`,
      detail: String(error?.message || error).slice(0, 400),
    });
  }
}

/**
 * Endpoint fino: CORS → método → auth → normalizar → emitir. `normalizar`
 * convierte el body del país al contrato de Chile (identidad para Chile).
 */
function crearEndpointEmision(ficha, { normalizar } = {}) {
  return async function handler(req, res) {
    const corsAllowed = setCors(req, res);
    if (req.method === "OPTIONS") {
      res.statusCode = corsAllowed ? 204 : 403; res.end(); return;
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Método no permitido" });
    }
    const expectedSecret = ficha.secretEnvs.map((k) => toText(process.env[k])).find(Boolean) || "";
    const providedSecret = toText(req.headers["x-vicky-secret"]);
    if (expectedSecret && expectedSecret !== providedSecret) {
      return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    }
    const bodyCrudo = parseBody(req);
    let entrada;
    try {
      entrada = normalizar ? normalizar(bodyCrudo, ficha) : bodyCrudo;
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: toText(e?.message || e) });
    }
    return emitirCotizacion(req, res, { ficha, entrada, bodyCrudo });
  };
}

module.exports = {
  emitirCotizacion,
  crearEndpointEmision,
  // expuestas para tests
  convertLeadCrudo,
  findOpenLeadIdByPhone,
  findConvertedIdsByPhone,
  guardaRutDeal,
  findAccountIdByDocumento,
  buildAccountFullPayload,
  buildContactFullPayload,
};
