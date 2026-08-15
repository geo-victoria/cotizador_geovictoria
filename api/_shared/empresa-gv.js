/**
 * EMPRESA EN GEOVICTORIA: resuelve desde el CRM lo que en Creator llena un
 * workflow de formulario.
 *
 * Hallazgo del 15-ago (IDE de la app NDV, workflow `LoadCrmData`): el campo
 * `ID_Empresa_GeoVictoria` de la cotización lo puebla un
 * `on user input of CRM_Account` — o sea, SOLO cuando una persona elige la
 * cuenta en el formulario. Por API nunca corre, y por eso las cotizaciones de
 * Vicky nacían sin ese dato y las ejecutivas tenían que rehacerlas a mano
 * para poder convertirlas a Nota de Venta.
 *
 * Pero el dato NO vive en la plataforma GeoVictoria: vive en el CRM. El
 * Deluge hace exactamente esto —y esto es lo que replicamos acá—:
 *
 *   records   = zoho.crm.searchRecords("Accounts_Empresas_GV",
 *                                      "(Account_CRM:equals:" + idAccount + ")")
 *   companyId = records.get(0).get("Empresas_GV").get("id")
 *   records   = zoho.crm.getRecordById("Empresas_en_GeoVictoria", companyId)
 *   geoId     = records.get("Id_Empresa")
 *
 * Verificado a mano con MUEBLES CURACAUTIN SPA: la cadena devuelve 39208, el
 * mismo número que imprime el PDF de su NDV.
 *
 * Best-effort: si la empresa todavía no existe en el CRM (cliente nuevo sin
 * onboarding), devuelve vacío y la cotización nace como hasta ahora — el
 * conciliador puede completarla después.
 */

const { getRecord, searchRecords } = require("./zoho-crm");

function toText(value) {
  return typeof value === "string" ? value.trim() : value === 0 ? "0" : value ? String(value) : "";
}

/**
 * @param {string} accountId Id de la Cuenta en el CRM.
 * @returns {Promise<{idEmpresaGeoVictoria: string, geoCompanyIdCrm: string, razonesSociales: string[]}>}
 */
async function resolverEmpresaGeoVictoria(accountId) {
  const vacio = { idEmpresaGeoVictoria: "", geoCompanyIdCrm: "", razonesSociales: [] };
  const idCuenta = toText(accountId);
  if (!idCuenta) return vacio;

  let idEmpresa = "";
  try {
    // Módulo puente Cuenta ↔ Empresa GV.
    const puente = await searchRecords(
      "Accounts_Empresas_GV",
      `(Account_CRM:equals:${idCuenta})`,
      ["Empresas_GV"]
    ).catch(() => []);
    const empresaLookup = Array.isArray(puente) && puente.length ? puente[0]?.Empresas_GV : null;
    const empresaId = toText(empresaLookup?.id);
    if (empresaId) {
      const empresa = await getRecord("Empresas_en_GeoVictoria", empresaId).catch(() => null);
      idEmpresa = toText(empresa?.Id_Empresa);
    }
  } catch (e) {
    console.warn(`[empresa-gv] búsqueda falló (account=${idCuenta}): ${e.message}`);
  }

  // Segunda fuente del MISMO dato, la que usa el Deluge como respaldo: el
  // subformulario de empresas de la propia Cuenta. Si la principal no dio
  // nada, esta suele tenerlo.
  let geoCompanyIdCrm = idEmpresa;
  let razonesSociales = [];
  try {
    const cuenta = await getRecord("Accounts", idCuenta).catch(() => null);
    if (cuenta) {
      const sub3 = Array.isArray(cuenta.Subform_3) ? cuenta.Subform_3 : [];
      if (!geoCompanyIdCrm && sub3.length) geoCompanyIdCrm = toText(sub3[0]?.Id_Empresa);
      if (!idEmpresa && sub3.length) idEmpresa = toText(sub3[0]?.Id_Empresa);
      // Razones sociales: el workflow las carga del Subform_6 y con ellas
      // decide si el campo se muestra u oculta en el formulario.
      const sub6 = Array.isArray(cuenta.Subform_6) ? cuenta.Subform_6 : [];
      razonesSociales = sub6
        .map((t) => toText(t?.Raz_n_social_Empresa?.name) || toText(t?.Raz_n_social_Empresa))
        .filter(Boolean);
    }
  } catch (e) {
    console.warn(`[empresa-gv] cuenta ${idCuenta} no legible: ${e.message}`);
  }

  return { idEmpresaGeoVictoria: idEmpresa, geoCompanyIdCrm, razonesSociales };
}

module.exports = { resolverEmpresaGeoVictoria };
