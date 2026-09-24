// ── EMBUDO DE CONVERSIÓN PARA LA MEDICIÓN DE CAMPAÑAS (David García 24-sep) ──
// Google Ads recibe las conversiones desde los CAMBIOS de estado de Zoho:
//   1. el lead tiene que pasar por "4. Calificado" ANTES de convertirse
//      (hoy se convertía desde "3. Contactado" y la señal de lead calificado
//      no existía para los leads de Vicky);
//   2. el deal tiene que NACER en "1. Trato Creado" y recién después avanzar
//      a su etapa (3, 4, 6…). Si nace directo en 4, Google no ve el trato
//      creado.
// Este módulo envuelve CUALQUIER conversión lead→deal de las emisiones
// (Chile, Perú, Colombia, México): califica el lead, convierte con el deal en
// etapa 1 y lo avanza por el blueprint a la etapa que la emisión pedía.
// Todo es best-effort: si Zoho rechaza un paso, la conversión sigue (jamás se
// pierde una cotización por la medición) y queda el log con el motivo.
const { zohoApiFetch } = require("./zoho-auth");
const { toText } = require("./zoho-crm");

const ETAPA_TRATO_CREADO = "1. Trato Creado";
const STATUS_CALIFICADO = "4. Calificado";

function numeroEtapa(stage) {
  const m = /^\s*(\d+)\s*\./.exec(toText(stage));
  return m ? Number(m[1]) : null;
}

function normal(s) {
  return toText(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function leerJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * Deja el lead en "4. Calificado" justo antes de convertirlo. En el blueprint
 * de Leads la transición "4. Calificado" es la de conversión: se ejecuta por
 * API (queda Calificado) y el convert viene inmediatamente después. Fuera del
 * blueprint (lead en "1." / "2.") se escribe el status directo.
 */
async function calificarLeadAntesDeConvertir(leadId) {
  if (!leadId) return { ok: false, motivo: "sin_lead" };
  try {
    const g = await zohoApiFetch(`/crm/v3/Leads/${encodeURIComponent(leadId)}?fields=Lead_Status`);
    const statusActual = toText((await leerJson(g))?.data?.[0]?.Lead_Status);
    if (/^\s*4\./.test(statusActual)) return { ok: true, motivo: "ya_calificado" };

    const bp = await zohoApiFetch(`/crm/v2/Leads/${encodeURIComponent(leadId)}/actions/blueprint`);
    const bpJson = await leerJson(bp);
    const transiciones = bpJson?.blueprint?.transitions || [];
    const t = transiciones.find((x) => /^\s*4\./.test(toText(x?.next_field_value)));
    if (t) {
      const data = { ...(t.data || {}) };
      const campos = (t.fields || []).map((f) => f?.api_name).filter(Boolean);
      // El convert decide el dueño (herencia/interino): la tómbola de la
      // transición NO debe correr acá.
      if (campos.includes("Tombola") && !data.Tombola) data.Tombola = "Mantener propietario";
      const exec = await zohoApiFetch(`/crm/v2/Leads/${encodeURIComponent(leadId)}/actions/blueprint`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blueprint: [{ transition_id: t.id, data }] }),
      });
      const ej = await leerJson(exec);
      const okExec = exec.ok && !/partial/i.test(toText(ej?.message));
      console.warn(`[embudo] lead ${leadId}: ${statusActual} → 4. Calificado por blueprint (${exec.status} ${toText(ej?.code || ej?.message)})`);
      if (okExec) return { ok: true, motivo: "blueprint" };
    }
    // Fuera de proceso (o la transición no movió el status): PUT directo.
    const put = await zohoApiFetch(`/crm/v3/Leads`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [{ id: leadId, Lead_Status: STATUS_CALIFICADO }],
        trigger: ["blueprint"],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    });
    const pj = await leerJson(put);
    const fila = pj?.data?.[0] || {};
    console.warn(`[embudo] lead ${leadId}: ${statusActual} → 4. Calificado por PUT (${put.status} ${toText(fila.code)})`);
    return { ok: put.ok && fila.code === "SUCCESS", motivo: `put:${toText(fila.code) || put.status}` };
  } catch (e) {
    console.warn(`[embudo] lead ${leadId}: no se pudo calificar antes de convertir — ${toText(e?.message || e).slice(0, 200)}`);
    return { ok: false, motivo: "error" };
  }
}

/**
 * Avanza un deal recién nacido en "1. Trato Creado" hasta `etapaObjetivo`
 * por las transiciones del blueprint (forward-only, hasta 4 saltos: si no hay
 * transición directa, toma la que más se acerca sin pasarse). Los campos que
 * la transición declara se completan con lo que ya trae la emisión
 * (`dealData`: Tipo_de_Cobro, Monda_del_trato, N_Empleados_que_marcan…).
 * Deal fuera de proceso → PUT directo del Stage.
 */
async function avanzarDealDesdeTratoCreado(dealId, etapaObjetivo, dealData = {}) {
  const objetivoNum = numeroEtapa(etapaObjetivo);
  if (!dealId || !etapaObjetivo || objetivoNum === null || objetivoNum <= 1) return { ok: true, motivo: "sin_avance" };
  const objetivoNorm = normal(etapaObjetivo);
  try {
    for (let salto = 0; salto < 4; salto++) {
      const g = await zohoApiFetch(`/crm/v3/Deals/${encodeURIComponent(dealId)}?fields=Stage`);
      const stage = toText((await leerJson(g))?.data?.[0]?.Stage);
      const actualNum = numeroEtapa(stage);
      if (normal(stage) === objetivoNorm || (actualNum !== null && actualNum >= objetivoNum)) {
        return { ok: true, motivo: `en_${stage}` };
      }
      const bp = await zohoApiFetch(`/crm/v2/Deals/${encodeURIComponent(dealId)}/actions/blueprint`);
      const bpJson = await leerJson(bp);
      if (bpJson?.code === "RECORD_NOT_IN_PROCESS" || !bp.ok) {
        const put = await zohoApiFetch(`/crm/v3/Deals`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: [{ id: dealId, Stage: etapaObjetivo }],
            trigger: ["blueprint"],
            skip_feature_execution: [{ name: "assignment_rules" }],
          }),
        });
        const fila = (await leerJson(put))?.data?.[0] || {};
        console.warn(`[embudo] deal ${dealId}: ${stage} → ${etapaObjetivo} por PUT (fuera de blueprint, ${toText(fila.code) || put.status})`);
        return { ok: fila.code === "SUCCESS", motivo: "put" };
      }
      const transiciones = (bpJson?.blueprint?.transitions || []).filter((t) => {
        const n = numeroEtapa(t?.next_field_value);
        return n !== null && n > (actualNum ?? 0) && n <= objetivoNum;
      });
      if (!transiciones.length) {
        console.warn(`[embudo] deal ${dealId}: sin transición de ${stage} hacia ${etapaObjetivo}`);
        return { ok: false, motivo: "sin_transicion" };
      }
      const t =
        transiciones.find((x) => normal(x.next_field_value) === objetivoNorm) ||
        transiciones.sort((a, b) => numeroEtapa(b.next_field_value) - numeroEtapa(a.next_field_value))[0];
      const data = { ...(t.data || {}) };
      for (const f of t.fields || []) {
        const api = f?.api_name;
        if (!api || data[api] !== undefined && data[api] !== null && data[api] !== "") continue;
        if (dealData[api] !== undefined && dealData[api] !== null && dealData[api] !== "") data[api] = dealData[api];
        if (f?.data_type === "multiselectpicklist" && typeof data[api] === "string") {
          data[api] = data[api].split(";").map((v) => v.trim()).filter(Boolean);
        }
      }
      const exec = await zohoApiFetch(`/crm/v2/Deals/${encodeURIComponent(dealId)}/actions/blueprint`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blueprint: [{ transition_id: t.id, data }] }),
      });
      const ej = await leerJson(exec);
      console.warn(`[embudo] deal ${dealId}: ${stage} → ${toText(t.next_field_value)} (${exec.status} ${toText(ej?.code)} ${toText(ej?.message).slice(0, 80)})`);
      if (!exec.ok) return { ok: false, motivo: `transicion_${exec.status}` };
    }
    return { ok: false, motivo: "demasiados_saltos" };
  } catch (e) {
    console.warn(`[embudo] deal ${dealId}: no se pudo avanzar a ${etapaObjetivo} — ${toText(e?.message || e).slice(0, 200)}`);
    return { ok: false, motivo: "error" };
  }
}

/**
 * Envuelve una función de conversión (leadId, dealData, existingIds) → ids.
 * Califica el lead, convierte con el deal en "1. Trato Creado" y lo avanza a
 * la etapa pedida. Kill switch: env VICKY_EMBUDO_CAMPANAS=off.
 */
function conEmbudoDeCampanas(convertir) {
  return async function convertirConEmbudo(leadId, dealData, existingIds = {}) {
    if (!dealData || toText(process.env.VICKY_EMBUDO_CAMPANAS).toLowerCase() === "off") {
      return convertir(leadId, dealData, existingIds);
    }
    const etapaObjetivo = toText(dealData.Stage) || ETAPA_TRATO_CREADO;
    await calificarLeadAntesDeConvertir(leadId);
    const ids = await convertir(leadId, { ...dealData, Stage: ETAPA_TRATO_CREADO }, existingIds);
    if (ids?.dealId && numeroEtapa(etapaObjetivo) !== 1) {
      await avanzarDealDesdeTratoCreado(ids.dealId, etapaObjetivo, dealData);
    }
    return ids;
  };
}

module.exports = {
  ETAPA_TRATO_CREADO,
  calificarLeadAntesDeConvertir,
  avanzarDealDesdeTratoCreado,
  conEmbudoDeCampanas,
  numeroEtapa,
};
