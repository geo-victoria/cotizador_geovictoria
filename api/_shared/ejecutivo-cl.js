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
  // Vendedores de la tómbola de deals 2026 (auditoría 31-jul: un PDF
  // regenerado o reenvío de una cotización de la tómbola presentaba a Eddyluz
  // por el fallback). IDs verificados contra /crm/v3/users.
  "3525045000223766001": {
    nombre: "Tamara Martínez",
    cargo: "Ejecutiva Comercial",
    email: "tmartinezq@geovictoria.com",
    telefono: "+56 9 3452 9937",
    whatsapp: "56934529937",
  },
  "3525045000126464001": {
    nombre: "Ana Paula López",
    cargo: "Ejecutiva Comercial",
    email: "alopez@geovictoria.com",
    telefono: "+56 9 6647 4270",
    whatsapp: "56966474270",
  },
  // Ejecutivas de la tómbola que FALTABAN (caso Grey/COT347, 05-ago): el PDF
  // regenerado de una cotización suya presentaba a Eddyluz por el fallback.
  // Fichas verificadas contra /crm/v3/users el 05-ago.
  "3525045000146108001": {
    nombre: "Grey Meléndez",
    cargo: "Ejecutiva Comercial",
    email: "gmelendez@geovictoria.com",
    telefono: "+56 9 3937 2060",
    whatsapp: "56939372060",
  },
  "3525045000124240013": {
    nombre: "Daniela Gálvez",
    cargo: "Ejecutiva Comercial",
    email: "dgalvez@geovictoria.com",
    telefono: "+56 9 2958 7913",
    whatsapp: "56929587913",
  },
  "3525045000000211651": {
    nombre: "Paola Díaz",
    cargo: "Ejecutiva Comercial",
    email: "pdiaz@geovictoria.com",
    telefono: "+56 9 3932 1686",
    whatsapp: "56939321686",
  },
  "3525045000308323003": {
    nombre: "Yahel Segura",
    cargo: "Ejecutiva Comercial",
    email: "ysegura@geovictoria.com",
    telefono: "+52 55 3763 6604",
    whatsapp: "525537636604",
  },
  // Aleydis Araque — dueña de la venta autónoma (Lalo 04-ago): sus
  // cotizaciones post-pago la presentan a ella.
  "3525045000583802005": {
    nombre: "Aleydis Araque",
    cargo: "Ejecutiva Comercial",
    email: "aaraque@geovictoria.com",
    telefono: "+56 9 8291 6868",
    whatsapp: "56982916868",
  },
};

// Vicky como firma (Lalo 06-ago, reemplaza el default Eddyluz y matiza la
// observación de Rodrigo del 27-jul): mientras el deal ESPERA en Vicky
// (interina oficial) no existe ejecutivo humano que mostrar — el PDF y el
// correo firman como Vicky/Equipo Comercial. Cuando el traspaso asigne al
// dueño real, el PDF regenerado lo presenta a él (mapa de arriba).
const VICKY_FIRMA = {
  nombre: "Vicky — Equipo Comercial",
  cargo: "Asistente Comercial",
  email: "vicky@geovictoria.com",
  telefono: "",
  whatsapp: "",
};

const EJECUTIVO_CL_DEFAULT = VICKY_FIRMA;

function ejecutivoPorOwner(ownerId) {
  return EJECUTIVOS_CL_POR_ID[String(ownerId || "").trim()] || EJECUTIVO_CL_DEFAULT;
}

/**
 * Resolución ASYNC con ficha de Zoho (caso Lotus Pet/COT315, 05-ago): el mapa
 * estático se queda corto cada vez que aparece un dueño nuevo (Grey, Luna...)
 * y el PDF presentaba a Eddyluz por el fallback. Orden:
 *   1. Recorre los ownerIds en orden de preferencia (deal primero, cotización
 *      después — la página de aceptación presenta al dueño del DEAL, y el PDF
 *      debe mostrar a la MISMA persona).
 *   2. Id en el mapa estático → esa ficha (sin red).
 *   3. Id desconocido → ficha de usuario en Zoho (/crm/v3/users/{id}).
 *   4. Nada resolvió → default (Eddyluz).
 * Best-effort: cualquier error de red cae al comportamiento de siempre.
 */
async function resolverEjecutivoCL(ownerIds) {
  const ids = (Array.isArray(ownerIds) ? ownerIds : [ownerIds])
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  for (const id of ids) {
    if (EJECUTIVOS_CL_POR_ID[id]) return EJECUTIVOS_CL_POR_ID[id];
  }
  try {
    const { zohoApiFetch } = require("./zoho-auth");
    for (const id of ids) {
      const r = await zohoApiFetch(`/crm/v3/users/${encodeURIComponent(id)}`);
      if (!r.ok) continue;
      const u = ((await r.json().catch(() => ({})))?.users || [])[0];
      const nombre = String(u?.full_name || "").trim();
      const email = String(u?.email || "").trim();
      if (!nombre || !email) continue;
      // Cuentas bot/genéricas jamás se presentan como ejecutivo.
      if (/vicky@|info@geovictoria/i.test(email)) continue;
      const telefono = String(u?.phone || u?.mobile || "").trim();
      const ficha = {
        nombre,
        cargo: "Ejecutivo Comercial",
        email,
        telefono,
        whatsapp: telefono.replace(/\D/g, ""),
      };
      // Cache en memoria del proceso: la próxima resolución no va a la red.
      EJECUTIVOS_CL_POR_ID[id] = ficha;
      return ficha;
    }
  } catch { /* best-effort */ }
  return EJECUTIVO_CL_DEFAULT;
}

module.exports = { ejecutivoPorOwner, resolverEjecutivoCL, EJECUTIVO_CL_DEFAULT };
