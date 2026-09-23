// ── LEAD-FIRST (regla de oro, GLOBAL — Lalo 29-jul / 23-sep) ────────────────
// Todo deal nace de un LEAD CONVERTIDO. Si el contacto tiene un lead vivo se
// convierte ESE (el dueño humano previo se respeta: el deal nace a su nombre);
// si no tiene ninguno, se crea el lead y se convierte en el mismo acto. Solo
// si la conversión falla se cae al deal fresco, y queda marcado.
//
// Medido el 23-sep: Perú creaba el deal directo (0 de 10 con lead convertido)
// y Chile caía al deal fresco cuando el lead vivo era de un ejecutivo (4 de
// 103). Este módulo lo cierra para las tres emisiones con una sola lógica.
const { zohoApiFetch } = require("./zoho-auth");
const { toText } = require("./zoho-crm");
const { getLeadCandadoPorFono } = require("./idempotencia");

const OWNER_VICKY_ID = "3525045000484500876";
// Dueños que NO son personas: un lead suyo es "sin dueño humano".
const OWNERS_ROBOT = new Set([
  OWNER_VICKY_ID,
  "3525045000000200013", // GeoVictoria Admin
  ...toText(process.env.VICKY_OWNERS_ROBOT).split(",").map((s) => s.trim()).filter(Boolean),
]);

function estaConvertido(l) {
  return Boolean(
    l?.Converted_Deal?.id || l?.Converted_Account?.id || l?.Converted_Contact?.id || l?.["$converted_detail"]?.deal,
  );
}

/**
 * Lead VIVO (sin convertir) del teléfono, de CUALQUIER dueño. Prefiere el
 * candado kv del agente; si no, busca en Zoho. Devuelve null si no hay.
 */
async function buscarLeadVivoPorFono(telefono) {
  const fono = toText(telefono).replace(/\D/g, "");
  if (!fono) return null;
  const leer = async (id) => {
    const g = await zohoApiFetch(
      `/crm/v3/Leads/${encodeURIComponent(id)}?fields=Owner,Lead_Source,Company,Converted_Deal,Converted_Account,Converted_Contact,Lead_Status,N_Empleados_que_marcan`,
    );
    if (!g.ok) return null;
    return ((await g.json())?.data || [])[0] || null;
  };
  let lead = null;
  try {
    const candado = await getLeadCandadoPorFono(fono);
    if (candado) {
      const l = await leer(candado);
      if (l && !estaConvertido(l)) lead = l;
    }
  } catch { /* best-effort */ }
  if (!lead) {
    try {
      const r = await zohoApiFetch(`/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=5`);
      if (r.ok && r.status !== 204) {
        const leads = (await r.json())?.data || [];
        const abiertos = leads.filter((l) => !estaConvertido(l));
        // Un lead "No Calificado" por motivo terminal no se revive acá: se
        // prefiere uno en proceso; si solo hay descartados, se toma el más nuevo.
        lead =
          abiertos.find((l) => !/no calificado/i.test(toText(l?.Lead_Status))) || abiertos[0] || null;
      }
    } catch { /* best-effort */ }
  }
  if (!lead?.id) return null;
  const ownerId = toText(lead?.Owner?.id);
  return {
    id: toText(lead.id),
    ownerId,
    ownerEmail: toText(lead?.Owner?.email),
    ownerName: toText(lead?.Owner?.name),
    humano: Boolean(ownerId) && !OWNERS_ROBOT.has(ownerId),
    leadSource: toText(lead?.Lead_Source),
    company: toText(lead?.Company),
    empleados: Number(lead?.N_Empleados_que_marcan || 0) || 0,
  };
}

function partirNombre(nombreCompleto) {
  const clean = toText(nombreCompleto).replace(/\s+/g, " ").trim();
  if (!clean) return { firstName: "Prospecto", lastName: "WhatsApp" };
  const parts = clean.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts.slice(-1).join(" ") };
}

/**
 * Crea el lead que se va a convertir EN EL MISMO ACTO (la excepción
 * "instantánea" que la regla admite). Nace con el usuario Vicky, en
 * "3. Contactado" (tope de entrega, Lalo 09-sep) y con trigger
 * ["workflow","blueprint"] (regla 21-ago). Devuelve el id o "".
 */
async function crearLeadParaConvertir(datos) {
  const fono = toText(datos.telefono).replace(/\D/g, "");
  const { firstName, lastName } = partirNombre(datos.contacto);
  const empresa = toText(datos.empresa).trim() || (fono ? `Por identificar (WhatsApp +${fono})` : "Por identificar");
  const payload = {
    First_Name: firstName,
    Last_Name: lastName,
    Company: empresa,
    ...(fono ? { Phone: `+${fono}` } : {}),
    ...(toText(datos.email) ? { Email: toText(datos.email) } : {}),
    ...(toText(datos.territorio) ? { Territorio: toText(datos.territorio) } : {}),
    Lead_Source: toText(datos.leadSource) || "SEO",
    Lead_Status: "3. Contactado",
    ...(Number(datos.empleados) > 0 ? { N_Empleados_que_marcan: Number(datos.empleados) } : {}),
    ...(toText(datos.documento) ? { RUT_Empresa: toText(datos.documento) } : {}),
    Gesti_n_Vicky: "Gestión Vicky",
    Owner: { id: OWNER_VICKY_ID },
    Description: `Lead creado por Vicky al emitir la cotización formal (lead-first): el deal nace de su conversión.`,
  };
  const r = await zohoApiFetch(`/crm/v3/Leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [payload], trigger: ["workflow", "blueprint"] }),
  });
  const j = await r.json().catch(() => ({}));
  const row = Array.isArray(j?.data) ? j.data[0] : null;
  const id = toText(row?.details?.id);
  if (!r.ok || !id) {
    console.error(`[lead-first] crear lead falló (${r.status}): ${JSON.stringify(j).slice(0, 300)}`);
    return "";
  }
  console.warn(`[lead-first] lead ${id} creado para convertir (${empresa}, +${fono}).`);
  return id;
}

/**
 * Convierte el lead en Account+Contact+Deal. existingIds = cuenta/contacto
 * ya resueltos por la emisión (el lead se fusiona en ellos). Con
 * DUPLICATE_DATA reintenta UNA vez apuntando al duplicado que Zoho reporta
 * (misma mecánica de convertLead de Chile).
 */
async function convertirLeadEnDeal(leadId, dealData, existingIds = {}) {
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
        (dupModule === "Contacts" && !existingIds.contactId) || (dupModule !== "Contacts" && !existingIds.accountId);
      if (puedeReintentar) {
        const retryIds = dupModule === "Contacts" ? { ...existingIds, contactId: dupId } : { ...existingIds, accountId: dupId };
        return convertirLeadEnDeal(leadId, dealData, retryIds);
      }
    }
    throw new Error(`Zoho convert Lead failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const result = JSON.parse(text)?.data?.[0];
  if (!result) throw new Error("Respuesta de convert Lead sin data");
  const idFrom = (v) => toText(v && typeof v === "object" ? v.id : v);
  const det = result.details || {};
  return {
    accountId: idFrom(result.Accounts) || idFrom(det.Accounts),
    contactId: idFrom(result.Contacts) || idFrom(det.Contacts),
    dealId: idFrom(result.Deals) || idFrom(det.Deals),
    accountReusada: Boolean(existingIds.accountId),
    contactReusado: Boolean(existingIds.contactId),
  };
}

/** IDs de una conversión ya hecha ($converted_detail), para respuestas parciales. */
async function recuperarIdsConvertidos(leadId) {
  try {
    const g = await zohoApiFetch(`/crm/v3/Leads/${encodeURIComponent(leadId)}?fields=Converted_Deal,Converted_Account,Converted_Contact`);
    if (!g.ok) return {};
    const l = ((await g.json())?.data || [])[0] || {};
    const det = l["$converted_detail"] || {};
    return {
      accountId: toText(det.account || l?.Converted_Account?.id),
      contactId: toText(det.contact || l?.Converted_Contact?.id),
      dealId: toText(det.deal || l?.Converted_Deal?.id),
    };
  } catch {
    return {};
  }
}

/**
 * El camino completo: lead vivo o nuevo → convertir con el deal. Devuelve
 * {dealId, accountId, contactId, leadId, viaLead:"vivo"|"nuevo", ownerHeredado}
 * o null si no se pudo (el llamador cae al deal fresco y lo marca).
 * `dealData` viene SIN Owner cuando el llamador quiere que el dueño humano
 * previo del lead herede; si el lead no tiene dueño humano se usa ownerDefault.
 */
async function nacerDealDesdeLead({ telefono, contacto, empresa, email, territorio, leadSource, empleados, documento, dealData, ownerDefault, existingIds, etiqueta }) {
  const tag = etiqueta || "lead-first";
  let lead = null;
  try { lead = await buscarLeadVivoPorFono(telefono); } catch { /* sin lead */ }
  let leadId = lead?.id || "";
  let viaLead = "vivo";
  if (!leadId) {
    leadId = await crearLeadParaConvertir({ telefono, contacto, empresa, email, territorio, leadSource, empleados, documento }).catch(() => "");
    viaLead = "nuevo";
  }
  if (!leadId) return null;
  const ownerHeredado = lead?.humano && lead.ownerId ? lead.ownerId : "";
  const data = {
    ...dealData,
    Owner: ownerHeredado ? { id: ownerHeredado } : ownerDefault || dealData.Owner,
    ...(lead?.leadSource && !dealData.Lead_Source ? { Lead_Source: lead.leadSource } : {}),
  };
  if (lead?.leadSource) data.Lead_Source = lead.leadSource; // el deal hereda la fuente del lead (Lalo 09-sep)
  try {
    const conv = await convertirLeadEnDeal(leadId, data, existingIds || {});
    let { accountId, contactId, dealId } = conv;
    if (!dealId) {
      const rec = await recuperarIdsConvertidos(leadId);
      accountId = accountId || rec.accountId;
      contactId = contactId || rec.contactId;
      dealId = rec.dealId;
    }
    if (!dealId) return null;
    console.warn(
      `[${tag}] deal ${dealId} nació del lead ${leadId} (${viaLead}${ownerHeredado ? `, dueño heredado ${lead.ownerEmail}` : ""}) — account=${accountId || "∅"} contact=${contactId || "∅"}`,
    );
    return { dealId, accountId, contactId, leadId, viaLead, ownerHeredado, ownerHeredadoEmail: lead?.ownerEmail || "" };
  } catch (e) {
    console.error(`[${tag}] convertir lead ${leadId} falló: ${toText(e?.message || e).slice(0, 250)}`);
    const rec = await recuperarIdsConvertidos(leadId);
    if (rec.dealId) return { dealId: rec.dealId, accountId: rec.accountId, contactId: rec.contactId, leadId, viaLead, ownerHeredado, ownerHeredadoEmail: lead?.ownerEmail || "" };
    return null;
  }
}

module.exports = { buscarLeadVivoPorFono, crearLeadParaConvertir, convertirLeadEnDeal, recuperarIdsConvertidos, nacerDealDesdeLead, OWNER_VICKY_ID };
