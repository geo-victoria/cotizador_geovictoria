/**
 * Alias de compatibilidad (29-sep). El mapa estático de 21 ejecutivos chilenos
 * que vivía acá MURIÓ: la fuente del equipo es la FICHA OPERATIVA del agente
 * (vía `vic-roster-tlmk`) y la ficha de usuario de Zoho, en ejecutivo-firma.js,
 * con UNA regla para los 4 países. Los llamadores viejos siguen funcionando.
 */
const { FIRMA_VICKY, firmantePorOwner, resolverFirmante } = require("./ejecutivo-firma");

module.exports = {
  ejecutivoPorOwner: firmantePorOwner,
  resolverEjecutivoCL: resolverFirmante,
  EJECUTIVO_CL_DEFAULT: FIRMA_VICKY,
};
