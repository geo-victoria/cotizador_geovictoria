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

function recurrenteNetoDesdeItems(items, pct, moneda) {
  // CHILE EN UF (Lalo 25-sep, "para futuro en el deal para chile mantengamos
  // todo en UF, valor y moneda"): en Chile el recurrente sale de Subtotal_UF
  // con 2 decimales (el campo de Zoho no acepta más); fuera de Chile,
  // Subtotal_CLP guarda la moneda del país (soles/COP/MXN) y va entero.
  const enUf = moneda === "UF";
  const campo = enUf ? "Subtotal_UF" : "Subtotal_CLP";
  const redondear = (n) => (enUf ? Math.round(n * 100) / 100 : Math.round(n));
  const filas = Array.isArray(items) ? items : [];
  const anual = filas.find((i) => toText(i?.Codigo_Item) === "plan_anual");
  if (anual && Number(anual[campo]) > 0) return redondear(Number(anual[campo]) / 12);
  const base = filas
    .filter((i) => i?.Es_Recurrente || ["asistencia", "plan_asistencia"].includes(toText(i?.Codigo_Item)))
    .reduce((a, i) => a + (Number(i?.[campo]) || 0), 0);
  return redondear(base * (1 - (Number(pct) || 0) / 100));
}

// SOLO TRATOS DE VICKY (25-sep, reclamo de Christian/Juan Carlos: CASA SAL,
// trato de Aracelli trabajado por Grey en la convención del equipo — "Por
// usuario" en UF —, quedó en "Mensual fijo" CLP porque Grey emitió desde la
// cotizadora y este estampado corría para TODA emisión). La convención
// CLP/Mensual fijo es la de Vicky: si la cotización es del canal ejecutivo o el
// deal no lo creó el usuario Vicky, no se toca nada.
const VICKY_USER_ID = toText(process.env.VICKY_ZOHO_USER_ID) || "3525045000484500876";

const MONEDA_POR_TERRITORIO = { Chile: "UF", "Perú": "SOL", Peru: "SOL", Colombia: "COP", "México": "MXN", Mexico: "MXN" };

async function estamparValorDeal({ quoteModule, quoteId, dealId, empleados }) {
  if (!quoteId) return { ok: false, motivo: "sin_ids" };
  try {
    const q = await getRecordWithFields(quoteModule, quoteId, ["Detalle_Items_Cotizacion", "Descuento_Recurrente_Pct", "Deal_Asociado", "Intervenci_n_Humana"]);
    if (/intervenci/i.test(toText(q?.Intervenci_n_Humana))) return { ok: false, motivo: "canal_ejecutivo" };
    // Ediciones (actualizar, descuento, anualidad) no traen el deal: sale de la cotización.
    dealId = dealId || toText(q?.Deal_Asociado?.id);
    if (!dealId) return { ok: false, motivo: "sin_deal" };
    // MONEDA DEL TRATO junto con el valor (Victoria Luna + Dave 24-sep: el
    // trato nacía con "Moneda del trato" en UF por defecto y el valor en CLP →
    // 36.900 UF en el pipe/forecast hasta que el pase de limpieza de 6 h lo
    // corregía). Subtotal_CLP guarda la moneda del país (soles en PE, pesos en
    // CO/MX), así que la moneda sale del Territorio del deal.
    const deal = await getRecordWithFields("Deals", dealId, ["Territorio", "Created_By"]).catch(() => null);
    if (!deal) return { ok: false, motivo: "deal_ilegible" };
    if (toText(deal?.Created_By?.id) !== VICKY_USER_ID) return { ok: false, motivo: "deal_de_ejecutivo" };
    const moneda = MONEDA_POR_TERRITORIO[toText(deal?.Territorio)] || "UF";
    const valor = recurrenteNetoDesdeItems(q?.Detalle_Items_Cotizacion, q?.Descuento_Recurrente_Pct, moneda);
    if (!(valor > 0)) return { ok: false, motivo: "sin_recurrente" };
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

module.exports = { estamparValorDeal, recurrenteNetoDesdeItems, MONEDA_POR_TERRITORIO };
