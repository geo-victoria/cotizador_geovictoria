/**
 * Node 24 en Vercel corre sobre Amazon Linux 2023, igual que Node 20.
 *
 * CASO (02-oct): el 01-oct pasamos a Node 24 porque Vercel dejó de aceptar
 * Node 20, y @sparticuz/chromium 131 solo reconoce "20.x" como AL2023. Con
 * "nodejs24.x" cree que está en el Amazon Linux viejo, extrae las librerías
 * equivocadas y Chromium no arranca ("libnspr4.so: cannot open shared object
 * file"). Todos los PDF cayeron al respaldo PDFShift, que se quedó sin
 * créditos a las 21:14 UTC del mismo día, y desde ahí ninguna cotización
 * tuvo PDF.
 *
 * Esto le dice a la librería lo que es cierto: el sistema es AL2023. Debe
 * correr ANTES del primer require("@sparticuz/chromium"), que decide al
 * cargarse. Se retira cuando se actualice la librería a una versión que
 * conozca Node 22/24.
 */
function prepararEntornoChromium() {
  for (const k of ["AWS_EXECUTION_ENV", "AWS_LAMBDA_JS_RUNTIME"]) {
    const v = String(process.env[k] || "");
    if (/nodejs(2[2-9]|[3-9]\d)\.x/.test(v)) process.env[k] = v.replace(/nodejs\d+\.x/, "nodejs20.x");
  }
}

module.exports = { prepararEntornoChromium };
