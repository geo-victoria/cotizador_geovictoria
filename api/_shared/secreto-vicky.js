/**
 * Verificación del secreto compartido de los endpoints internos.
 *
 * Históricamente había UNA sola clave (VICKY_COTIZADORA_SECRET) usada por dos
 * consumidores muy distintos: el AGENTE (Vicky, servidor a servidor) y los
 * BOTONES de Zoho CRM (funciones Deluge que leen la variable de organización
 * `vicky_cotizadora_secret`). Al rotar la clave el 11-ago solo se actualizó el
 * lado del agente, así que todos los botones de Zoho quedaron devolviendo
 * Unauthorized en silencio — el caso que destapó "Regenerar PDF" el 14-ago.
 *
 * Solución (Lalo 14-ago): una clave PROPIA para Zoho —
 * VICKY_COTIZADORA_SECRET_ZOHO— aceptada en paralelo a la del agente. Así cada
 * canal se rota sin romper al otro, y una filtración en el CRM (donde la
 * variable es legible por cualquier admin) no compromete el canal del agente.
 *
 * Ambas claves dan el mismo acceso: la separación es de OPERACIÓN, no de
 * permisos. Si algún día se quiere limitar qué puede hacer Zoho, este es el
 * lugar donde discriminar por origen.
 */

function secretoValido(req) {
  const provisto = String(
    (req && req.headers && req.headers["x-vicky-secret"]) || "",
  ).trim();
  const delAgente = String(process.env.VICKY_COTIZADORA_SECRET || "").trim();
  const deZoho = String(process.env.VICKY_COTIZADORA_SECRET_ZOHO || "").trim();
  // Sin secreto configurado en el servidor, el endpoint queda abierto (mismo
  // comportamiento histórico: los entornos de prueba no definen la env).
  if (!delAgente && !deZoho) return true;
  if (!provisto) return false;
  return provisto === delAgente || (Boolean(deZoho) && provisto === deZoho);
}

/** Origen del llamado, para logs (no cambia permisos). */
function origenSecreto(req) {
  const provisto = String(
    (req && req.headers && req.headers["x-vicky-secret"]) || "",
  ).trim();
  const deZoho = String(process.env.VICKY_COTIZADORA_SECRET_ZOHO || "").trim();
  if (deZoho && provisto === deZoho) return "zoho";
  return "agente";
}

module.exports = { secretoValido, origenSecreto };
