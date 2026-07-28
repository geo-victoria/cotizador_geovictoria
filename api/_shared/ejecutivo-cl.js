/**
 * Ejecutivo comercial CL según el OWNER de la cotización.
 *
 * Observación de Rodrigo (27-jul, sobre el PDF N° 283): el campo EJECUTIVO
 * mostraba la identidad genérica "Vicky - Equipo Comercial GeoVictoria". Debe
 * mostrar SIEMPRE al ejecutivo HUMANO — y con el relevo del mismo día (lo
 * nuevo es de Eddyluz, lo anterior queda con Anderson), ese humano depende de
 * cada cotización: un PDF regenerado de un deal de Anderson debe seguir
 * mostrando a Anderson.
 *
 * Los datos vienen de las fichas de usuario en Zoho (verificadas 27-jul).
 */

const EJECUTIVOS_CL_POR_ID = {
  // Eddyluz Mujica — ejecutiva de cotizaciones desde el 27-jul (lo nuevo).
  "3525045000000211283": {
    nombre: "Eddyluz Mujica",
    cargo: "Ejecutiva Comercial",
    email: "emujica@geovictoria.com",
    telefono: "+56 9 3932 1687",
    whatsapp: "56939321687",
  },
  // Anderson Díaz — dueño de los deals anteriores al relevo.
  "3525045000426432190": {
    nombre: "Anderson Díaz",
    cargo: "Ejecutivo Comercial",
    email: "adiazg@geovictoria.com",
    telefono: "+56 9 3937 2058",
    whatsapp: "56939372058",
  },
  // Alejandro Gordillo — ejecutivo Colombia (las cotizaciones CO que pasan
  // por los endpoints compartidos, p.ej. el reenvío, le responden a él).
  "3525045000203758005": {
    nombre: "Alejandro Gordillo",
    cargo: "Ejecutivo Comercial",
    email: "agordillo@geovictoria.com",
    telefono: "+57 314 267 7765",
    whatsapp: "573142677765",
  },
};

const EJECUTIVO_CL_DEFAULT = EJECUTIVOS_CL_POR_ID["3525045000000211283"];

function ejecutivoPorOwner(ownerId) {
  return EJECUTIVOS_CL_POR_ID[String(ownerId || "").trim()] || EJECUTIVO_CL_DEFAULT;
}

module.exports = { ejecutivoPorOwner, EJECUTIVO_CL_DEFAULT };
