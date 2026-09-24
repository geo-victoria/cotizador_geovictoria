// ── VALOR DEL DEAL AL NACER (David García 24-sep, punto 3 de la medición) ──
// El valor del trato (Valor_fijo_del_trato_Global = recurrente mensual NETO en
// la moneda del país) solo lo escribía el pase de vic-admin-deal-limpieza cada
// 3 horas: el deal existía sin monto en esa ventana y Google Ads / el forecast
// lo leían en $0. Ahora la emisión lo escribe en el acto, con la MISMA fórmula
// del pase (así nunca hay dos cálculos distintos):
//   - anualidad: fila plan_anual ÷ 12 (ya trae el descuento);
//   - si no: Σ Subtotal_CLP de las filas recurrentes (o código asistencia /
//     plan_asistencia) × (1 − % de descuento del plan).
// Subtotal_CLP guarda la moneda del país (soles/COP/MXN fuera de Chile).
// Best-effort: jamás bloquea la emisión.
const { zohoApiFetch } = require("./zoho-auth");
const { toText, getRecordWithFields } = require("./zoho-crm");

function recurrenteNetoDesdeItems(items, pct) {
  const filas = Array.isArray(items) ? items : [];
  const anual = filas.find((i) => toText(i?.Codigo_Item) === "plan_anual");
  if (anual && Number(anual.Subtotal_CLP) > 0) return Math.round(Number(anual.Subtotal_CLP) / 12);
  const base = filas
    .filter((i) => i?.Es_Recurrente || ["asistencia", "plan_asistencia"].includes(toText(i?.Codigo_Item)))
    .reduce((a, i) => a + (Number(i?.Subtotal_CLP) || 0), 0);
  return Math.round(base * (1 - (Number(pct) || 0) / 100));
}

const MONEDA_POR_TERRITORIO = { Chile: "CLP", "Perú": "SOL", Peru: "SOL", Colombia: "COP", "México": "MXN", Mexico: "MXN" };

async function estamparValorDeal({ quoteModule, quoteId, dealId, empleados }) {
  if (!quoteId) return { ok: false, motivo: "sin_ids" };
  try {
    const q = await getRecordWithFields(quoteModule, quoteId, ["Detalle_Items_Cotizacion", "Descuento_Recurrente_Pct", "Deal_Asociado"]);
    // Ediciones (actualizar, descuento, anualidad) no traen el deal: sale de la cotización.
    dealId = dealId || toText(q?.Deal_Asociado?.id);
    if (!dealId) return { ok: false, motivo: "sin_deal" };
    const valor = recurrenteNetoDesdeItems(q?.Detalle_Items_Cotizacion, q?.Descuento_Recurrente_Pct);
    if (!(valor > 0)) return { ok: false, motivo: "sin_recurrente" };
    // MONEDA DEL TRATO junto con el valor (Victoria Luna + Dave 24-sep: el
    // trato nacía con "Moneda del trato" en UF por defecto y el valor en CLP →
    // 36.900 UF en el pipe/forecast hasta que el pase de limpieza de 6 h lo
    // corregía). Subtotal_CLP guarda la moneda del país (soles en PE, pesos en
    // CO/MX), así que la moneda sale del Territorio del deal.
    const deal = await getRecordWithFields("Deals", dealId, ["Territorio"]).catch(() => null);
    const moneda = MONEDA_POR_TERRITORIO[toText(deal?.Territorio)] || "CLP";
    const data = { id: dealId, Valor_fijo_del_trato_Global: valor, Tipo_de_Cobro: "Mensual fijo", Monda_del_trato: moneda, Valor_por_usuario_Global: null };
    if (Number(empleados) > 0) data.N_Empleados_que_marcan = Number(empleados);
    const r = await zohoApiFetch(`/crm/v3/Deals`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [data], trigger: ["blueprint"], skip_feature_execution: [{ name: "assignment_rules" }] }),
    });
    const fila = (await r.json().catch(() => ({})))?.data?.[0] || {};
    console.warn(`[valor-deal] deal ${dealId} ← ${valor} ${moneda} (cotización ${quoteId}): ${toText(fila.code) || r.status}`);
    return { ok: fila.code === "SUCCESS", valor };
  } catch (e) {
    console.warn(`[valor-deal] deal ${dealId}: ${toText(e?.message || e).slice(0, 200)}`);
    return { ok: false, motivo: "error" };
  }
}

module.exports = { estamparValorDeal, recurrenteNetoDesdeItems };
