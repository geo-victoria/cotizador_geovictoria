# Emisión única de cotizaciones (fase 1)

Hoy hay cuatro endpoints que emiten la cotización formal de Vicky:
`api/quote-acceptance/create-from-vicky.js` (Chile) y `-pe.js`, `-co.js`, `-mx.js`.
Hacen lo mismo con código copiado y se fueron separando. Esta carpeta es **un solo
proceso, el de Chile**, con todo lo que cambia por país escrito como **dato** en una
ficha.

**Fase 1 = construir y probar. Ningún endpoint productivo usa esta carpeta todavía.**
Los cuatro `create-from-vicky*.js` siguen iguales.

## Qué hay en cada archivo

| Archivo | Qué es |
|---|---|
| `emitir.js` | `emitirCotizacion(req, res, { ficha, entrada, bodyCrudo })`: el cuerpo del handler chileno (pasos 3-27 del mapa) leyendo cada dato de país de la ficha. `crearEndpointEmision(ficha, { normalizar })` arma el endpoint fino: CORS → método → auth → normalizar → emitir. `TIPO_DE_COBRO_AL_NACER` = "Mensual fijo" (común a los 4 países). |
| `fichas.js` | `FICHA_CL`, `FICHA_PE`, `FICHA_CO`, `FICHA_MX` (y `construirFichas(env)`, `fichaDePais(pais)`). Territorio, moneda del deal, documento tributario, dueños (interino, adoptables, no heredables), subform, descuento, PDF, correo, Creator, token, mensajes de error, flags. Mismas variables de entorno y mismos defaults que hoy tienen escritos los endpoints. |
| `normalizar.js` | Adaptadores del body que manda el agente al contrato de Chile. Chile = identidad. PE/CO/MX pasan `ruc`/`nit`/`rfc` a `cliente.rutEmpresa`, aplican la fila especial del país (quitar Activación / agregar Capacitación MX), calculan el total con el impuesto de las líneas afectas y dejan el tipo de cambio de Perú en `extras`. **El agente no cambia.** |
| `util.js` | Utilidades idénticas en los cuatro endpoints (CORS, parseo, COQL, errores de Zoho, update conservador, picklists del subform, número del PDF…). |
| `documentos.js` | RUT, RUC/DNI, NIT, RFC: variantes para la dedup, validación y formato con que se guarda. |
| `subform.js` | Constructores del subform `Detalle_Items_Cotizacion` de Chile (UF + CLP) y de PE/CO/MX (moneda del país en los campos *_UF y *_CLP), y la capacitación MX. |
| `correo.js` | `send_mail` (con reintento sin CC), adjunto por Zoho Files y la plantilla chilena con remitente y documentos como parámetro. |

El contrato normalizado es el de Chile (`cliente` / `cotizacion` / `existing` /
`escalonDescuento` / `draft` / `sinCorreoCliente` / `leadSource` / `cc`). Fuera de Chile,
`cliente.rutEmpresa` lleva el documento del país y los ítems conservan sus campos
(`precioUnitarioPEN`, `subtotalCOP`, `afectoIgv`…), que la ficha nombra en `moneda.campos`.
La clave de idempotencia se sigue calculando sobre el **body crudo** que llegó.

## Cómo correr las pruebas

```
npm test                                   # todo el repo (node --test "tests/**/*.test.js")
node --test tests/emision/*.test.js        # solo la emisión única
EMISION_TEST_VERBOSE=1 node --test tests/emision/identidad-cl.test.js   # con los logs
```

Todo corre **sin red**: `tests/emision/harness.js` simula Zoho CRM en memoria (registros,
unicidad de Account_Name / RUT_Empresa / Email, conversión de leads, búsqueda por teléfono,
COQL, blueprint fuera de proceso, send_mail, files), vic_kv, el agente, el render y la
subida del PDF y Creator. Reemplaza solo la frontera (`zoho-auth`, `pdfshift-client`,
`supabase-pdf-upload`, `ndv-emitir`, `@vercel/functions`); `zoho-crm`, `lead-first`,
`embudo-zoho`, `idempotencia`, `valor-deal`, `pointer-sync`, los builders de PDF y el motor
de descuentos corren de verdad. Congela el reloj y hace determinista el nonce del token.
Un `fetch` a un host desconocido revienta el test.

### La prueba de identidad (`identidad-cl.test.js`)

Corre el handler chileno de hoy y `emitirCotizacion` con `FICHA_CL` sobre 29 escenarios y
exige la **misma secuencia de llamadas externas con los mismos cuerpos** (Zoho, vic_kv,
agente, hash del HTML del PDF, subida, correo completo, Creator) y la **misma respuesta
HTTP**. Cada escenario verifica además, sobre la corrida chilena, que el camino que dice
cubrir se cubrió. Escenarios: lead vivo de Vicky (Camino A) · 15 personas por Camino A y
sin lead · lead de dueño humano · lead de SDR (Aleydis y Aracelli) · lead convertido con
deal vivo · deal perdido con y sin marca de campaña `reactivar_deal_` · candado
`deal_fono_` · reserva ocupada por la otra puerta · RUT distinto en el deal del candado ·
DUPLICATE_DATA en cuenta (Capa 3 por RUT, homónima sin RUT, desambiguada + Capa 4, cuenta
"-") · falla no-duplicado con CRM degradado · DUPLICATE_DATA en contacto · borrador +
finalización con `existing.quoteId` y monotonicidad del escalón · reintento idempotente ·
`sinCorreoCliente` · dueño manual `existing.ownerId` + `leadSource` por canal · convert
fallido con recuperación · convert rechazado siempre (deal fresco marcado) · convert con
respuesta parcial · sin email + escalón 2 · adjunto con token de Zoho Files y CC rechazado ·
`CRM_STRICT=1` · validaciones y puerta (400/401/405/OPTIONS).

Una mutación de cualquier dato de `FICHA_CL` (territorio, CC, token, adjunto, documento en
el deal, nota en la cuenta, formato del PDF, no heredables) hace fallar al menos uno de los
escenarios: la prueba no es decorativa.

**Diferencias aceptadas** (decisión del dueño, 28-sep; son las únicas):
1. `Tipo_de_Cobro` del deal al nacer = "Mensual fijo" en los 4 países (Chile hoy: ≤10 fijo
   / >10 por usuario). El test lo aplica campo a campo sobre la corrida chilena.
2. La SDR no hereda el deal (en ningún país). Con un lead de SDR la emisión única hace
   exactamente lo que hoy hace Chile con un lead de dueño robot (GeoVictoria Admin); el
   test compara contra esa corrida y comprueba que hoy Chile sí heredaba la SDR.

### Otras pruebas
- `fichas.test.js`: cada ficha tiene todos los campos y sus valores son los que hoy están
  escritos en los endpoints (se leen sus fuentes).
- `subform-correo.test.js`: las copias de subform, capacitación MX, plantilla de correo y
  variantes de documento son idénticas a las funciones que exportan los endpoints.
- `paises.test.js`: normalizadores y humo de punta a punta con `FICHA_PE/CO/MX`.

## Hallazgos del arnés en el handler chileno de HOY (no corregidos: identidad)

1. **La reserva anti-carrera anula la guarda de RUT del deal del candado.** La guarda suelta
   el deal de `deal_fono_` cuando es de otra empresa, pero `reservarDealPorFono` vuelve a
   leer la misma llave (que tiene `dealId`) y lo re-adopta: la cotización de la segunda
   empresa cuelga del deal de la primera. Escenario "RUT distinto en el deal del candado".
2. **Lead-first puede fusionar en la cuenta "-".** Si la cuenta "-" tiene el RUT, la Capa 3
   la ignora bien, pero después el convert de lead-first choca por RUT (DUPLICATE_DATA) y el
   reintento fusiona el lead en esa cuenta. Simulado, no verificado en Zoho en vivo.

Corregirlos cambia la conducta de Chile: va en commits aparte, con VB.

## Fase 2: qué hay que hacer

Orden: **México → Colombia → Perú → Chile (último, en sombra)**. Para cada país:

1. El endpoint queda fino: `module.exports = crearEndpointEmision(FICHA_XX, { normalizar: normalizarXX })`.
   Mismo archivo, así `vercel.json` (300 s / 1536 MB) no cambia.
2. Mantener los exports que otros endpoints importan: `buildSubformItemsPE/CO/MX` (los usa
   `pais-cotizacion.js`, que a su vez usan `actualizar-cotizacion`, `backfill-pdf`,
   `aplicar-siguiente-descuento`) → re-exportar desde `emision/subform.js`; `buildEmailHtmlMX`
   → moverla a `emision/correo.js` (hoy la ficha MX la carga perezosa desde el endpoint; al
   adelgazarlo habría un ciclo). Chile: `buildSubformItems`, `buildEmailHtml`,
   `sendQuoteEmailViaZoho` (los importan `actualizar-cotizacion`, `backfill-pdf`,
   `consultar-descuento-referencial`, `reenviar-cotizacion` y los de país).
3. Agregar al arnés los escenarios del país y aceptar a mano, una por una, las diferencias
   esperadas de abajo. Probar con un sintético por simulación del agente y limpiar.
4. Colombia: `flags.convertFirst` pasa a `true` (hoy lee `VICKY_CO_CONVERT_FIRST` / kv
   `co_convert_first`); dejar el kv como rollback.
5. Perú: la nota de hardware en USD ya está en `emitir.js` (`creator.notaHardwareUsd`).
6. Chile al final: el endpoint nuevo corre en modo sombra (el viejo responde; el nuevo corre
   con un grabador sin escribir y se loguea el diff) sobre 1-2 emisiones reales antes de
   cambiar. Rollback = revertir un archivo. Ojo: en sombra las cachés de módulo (token de
   Zoho Files) quedan duplicadas por instancia.

### Diferencias ESPERADAS al pasar PE / CO / MX al proceso de Chile

Medidas con el arnés (endpoint de hoy vs emisión única con su ficha, con y sin lead vivo)
más el mapa (§2.5 y §4.6). Con la ficha, la cotización, el subform, el PDF, el correo y
Creator ya salen iguales; lo que cambia es proceso:

Comunes a los tres:
- **Camino A**: el lead vivo de un dueño "del bot" se convierte PRIMERO (en PE/MX no existía;
  en CO está apagado por flag). El deal nace de ese convert con `Closing_Date` +30 días, la
  empresa real se escribe en el lead antes de convertir y después hay PUT a cuenta, contacto
  y deal ("datos nuevos ganan"; cuenta y contacto no se crean antes).
- **Cuenta**: Chile crea primero y deduplica solo ante DUPLICATE_DATA; hoy PE/CO/MX consultan
  por documento ANTES de crear (una COQL menos en el camino feliz). Se suman el update
  conservador de la cuenta reusada, la homónima sin documento y la cuenta desambiguada.
- **CO y MX dejan de pisar la cuenta y de duplicar el contacto** del lead ya convertido
  (hoy la dedup de cuenta y la creación de contacto son incondicionales).
- **Candado**: guarda de documento del deal, reserva anti-carrera (escritura "creando" en
  vic_kv), excepción de campaña `reactivar_deal_`; `deal_fono_` se escribe también con deal
  reusado.
- `CRM_Incompleto` considera también el contacto faltante.
- **Corrección de placeholders** (lecturas de cuenta/deal/contacto y PUT si corresponde).
- **Dueño real del deal**: se lee el Owner; si es humano la cotización lo sigue, la cuenta y
  el contacto creados también, y el correo lo presenta. Sin dueño humano el correo sigue con
  el ejecutivo fijo del país (Mónica / Gordillo / Yahel), como hoy.
- **Nota en la cuenta** "Vicky emitió cotización formal — canal digital activo" (nueva).
- **Muere `cerrarLeadHuerfano*`** (convertía el lead sin deal y sin pasar por "4. Calificado").
- Respuesta: se agregan `codigoCorto`, `sectorAplicado`, `reuse`, `ejecutivo` (se conservan
  `linkCorto`, `accountReused` y `descuentoPlanPct` de MX).
- Descripción del deal: se agrega la línea "Sector: …".
- `Tipo_de_Cobro` al nacer "Mensual fijo" (CO hoy ≤10; PE ≤20) y la SDR del país no hereda el
  deal (PE hoy heredaba a Ana Fiori / Priscila Quispe).
- El contrato de país no trae `existing`, `draft`, `sinCorreoCliente`, `leadSource` ni `cc`
  (MX sí `cc`): esos caminos quedan disponibles pero el agente no los usa en esos países.

Por país:
- **México**: plantilla de correo propia (botón al PDF, ejecutivo fijo) — se conserva en la
  ficha; RFC solo advierte.
- **Colombia**: NIT sin DV en la cuenta y crudo en la cotización (se conserva); Camino A ON.
- **Perú**: RUC con DV SUNAT o DNI (se conserva); dos notas en Creator (PEN + USD); sin
  `Rut_ID_Account` en el deal.

## Decisiones abiertas (NO cambiadas en esta fase)

1. **`Rut_ID_Account` en el deal fuera de Chile** (`documento.enDeal`): PE/CO/MX no lo
   escriben, y la guarda de documento del deal lee ese campo → en esos países la guarda no
   actúa nunca.
2. **NIT en la cotización**: CO guarda la cuenta sin DV y la cotización con el NIT crudo.
3. **Cuenta "-" / "NO USAR" fuera de Chile**: PE/CO/MX solo excluyen cuentas internas
   (`esCuentaNoAdoptable` es chilena).
4. **Correo PE/CO**: hoy llevan la certificación de la Dirección del Trabajo chilena y no la
   ficha del reloj; no llevan las copias fijas (egomez, rlewit) ni el PDF adjunto. MX usa su
   plantilla propia. Se conservaron tal cual.
5. **`Amount` del deal**: CL total en CLP, PE pago inicial con IGV, CO total con IVA del
   equipo, MX no lo escribe.
6. **Triggers**: `createRecord`/`updateRecord` mandan solo `["workflow"]` en los cuatro
   países; la regla del 21-ago pide incluir `"blueprint"` en Leads/Deals. No se tocó.
7. **Adoptables de Chile** incluyen a Gordillo y Yahel (interinos de CO/MX).
8. **Búsqueda de leads por teléfono sin filtro de territorio** (colisión CL/PE de 9 dígitos).
9. Los dos hallazgos de arriba (reserva vs guarda de RUT; fusión en la cuenta "-").
