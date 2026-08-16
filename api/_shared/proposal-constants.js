/**
 * Constantes del HTML de propuesta (PDF bonito de 4 páginas).
 *
 * Portado desde index.html (cliente). Mantener sincronizado si se actualizan
 * los textos de marketing, T&C, precios o SVG de marca en la cotizadora.
 */

const PROPOSAL_INTRO = [
  'GeoVictoria es una empresa de tecnología líder en Latinoamérica, especializada en soluciones de control de asistencia, gestión de tiempo y productividad laboral. Con presencia en más de 40 países y más de 6.000 clientes activos, ayudamos a organizaciones de todos los tamaños a automatizar y optimizar la gestión de su capital humano.',
  'Nuestra plataforma integral permite controlar asistencia mediante dispositivos biométricos, app móvil y marcaje web, además de gestionar turnos, vacaciones, horas extras, documentos y mucho más — todo desde un solo lugar, en tiempo real y con la seguridad de la nube Microsoft Azure.',
  'Nos diferenciamos por ofrecer un servicio integral que incluye soporte técnico continuo, capacitaciones ilimitadas, actualizaciones automáticas y un equipo dedicado a asegurar el éxito de cada implementación.',
];

const PROPOSAL_BENEFICIOS = [
  { titulo: 'Control en tiempo real', desc: 'Visualiza la asistencia de tus colaboradores al instante, desde cualquier dispositivo.' },
  { titulo: 'Reducción de costos', desc: 'Elimina el ausentismo fantasma y optimiza el pago de horas extras con datos precisos.' },
  { titulo: 'Múltiples métodos de marcaje', desc: 'Equipos biométricos, app móvil con geolocalización, marcaje web y call center.' },
  { titulo: 'Plataforma 100% cloud', desc: 'Infraestructura Microsoft Azure con 99.5% de uptime garantizado y respaldos diarios.' },
];

const PROPOSAL_TYC = [
  'El pago inicial —al aceptar esta cotización— incluye los conceptos de pago único (equipos, instalación y servicios iniciales) y el primer mes de servicio de la plataforma, cobrado por adelantado.',
  'El valor mensual indicado es referencial. El plan se factura en UF y se convierte a pesos con la UF del día de cada factura, por lo que el monto en CLP puede variar mes a mes según el valor de la UF. Además, está sujeto a mantener la cantidad de usuarios de esta cotización: cualquier variación en el número de usuarios activos modificará el cobro mensual, ajuste que se reflejará en la facturación del período siguiente.',
  'El descuento acordado sobre el plan mensual aplica durante los primeros 6 meses de servicio; a partir del séptimo mes, el plan mensual vuelve a su tarifa normal (sin descuento). El descuento de instalación, por ser un cobro único, no tiene esta limitación. Ante variaciones de usuarios, la facturación recalcula el valor mensual sobre la tarifa por usuario vigente.',
  'Los precios indicados están expresados en UF (Unidad de Fomento) y su equivalente referencial en CLP.',
  'Los valores no incluyen IVA salvo donde se indique expresamente.',
  'La capacitación inicial está incluida según las condiciones de esta propuesta.',
  'GeoVictoria garantiza un uptime del 99.5% en su plataforma cloud (Microsoft Azure).',
  'El soporte técnico está disponible de lunes a viernes de 8:30 a 18:00 hrs.',
  'Los valores de venta de equipos incluyen garantía de fábrica de 1 año bajo uso normal.',
  'GeoVictoria no se hace responsable en caso de robo, pérdida, daños físicos o defectos por manipulación de terceros.',
  'Los precios serán revisados y ajustados anualmente de acuerdo con el Índice de Precios al Consumidor (IPC) o su equivalente en UF.',
];

// Cláusulas que aplican SOLO cuando la cotización incluye al menos un reloj en
// modalidad arriendo. Se anexan a las T&C (PDF y página de aceptación) solo en
// Cláusulas de arriendo. Se incluyen SIEMPRE en las T&C (PDF y página de
// aceptación), redactadas como condición ("Para los relojes en modalidad
// arriendo…"), de modo que apliquen solo a quien arrienda sin necesidad de
// lógica de render que las muestre u oculte.
const PROPOSAL_TYC_ARRIENDO = [
  'Para los relojes en modalidad arriendo: el servicio incluye mantención y reposición por falla técnica; los equipos son propiedad de GeoVictoria y, al término del servicio, el cliente debe devolverlos en condiciones estándar, despachándolos por su cuenta y costo a Avenida Los Leones 2061, Providencia, Santiago.',
  'Para los relojes en modalidad arriendo: si al término del servicio el cliente mantiene equipos con menos de 6 mensualidades de arriendo pagadas, deberá pagar una multa de 6 UF + IVA por cada reloj en esa condición.',
];

const SERVICIOS_GRATIS = [
  { servicio: 'Soporte técnico', desc: 'Mesa de ayuda de lunes a viernes 8:30-18:00 hrs (teléfono, chat, email)' },
  { servicio: 'Capacitación inicial', desc: 'Capacitación online para administradores de la plataforma' },
  { servicio: 'Actualizaciones', desc: 'Actualizaciones automáticas de software sin costo adicional' },
  { servicio: 'App móvil', desc: 'Aplicación móvil para marcaje (Android e iOS)' },
  { servicio: 'Reportería básica', desc: 'Reportes estándar de asistencia, atrasos y horas extras' },
  { servicio: 'Portal del colaborador', desc: 'Acceso web para que los colaboradores consulten su asistencia' },
];

const PRICING_TIERS = [
  // Micro-plan: 1 usuario que marca (cubre marcador + 1 administrador). Desde
  // 2 que marcan, tramo fijo normal.
  // Ajuste de tramos (Lalo, 31-jul-2026): el micro-plan cubre 1-2 personas
  // y el tramo fijo estándar parte en 3. Espejo de lib/catalogo/modulos.ts
  // del agente — si cambia allá, cambiar acá en el mismo movimiento.
  //
  // DESINCRONIZACIÓN CORREGIDA (16-ago): estos dos tramos tenían los precios
  // VIEJOS (0,6 y 0,07) mientras el agente ya cotizaba con la baja (0,55 y
  // 0,055). Como esta escalera es la que completa la tabla de cobro de la nota
  // de venta, la nota habría impreso un precio distinto al que Vicky ofreció
  // por WhatsApp. El agente manda; acá se espeja.
  //
  // El agente tiene un interruptor `VICKY_PRECIOS_CLASICOS` que restaura
  // 0,6/0,07. Si algún día se prende, estos dos valores TIENEN que moverse en
  // el mismo acto o vuelve la contradicción.
  { min: 1, max: 2, type: 'fijo', uf: 0.25 },
  { min: 3, max: 10, type: 'fijo', uf: 0.55 },
  { min: 11, max: 20, type: 'por_usuario', uf: 0.055 },
  // 21-30 a 0,055 (Lalo, 16-ago). La prueba de precios bajó el 11-20 de 0,07 a
  // 0,055 y dejó este tramo en 0,065, así que la escalera IMPRESA daba un salto
  // hacia arriba: el cliente de 19 usuarios veía que crecer a 21 le subía el
  // precio unitario un 18%, y que recién en 31 volvía a bajar. Vicky no cotiza
  // este rango (su umbral son 20 usuarios), pero la nota de venta imprime la
  // escalera completa y ahí el salto quedaba a la vista.
  { min: 21, max: 30, type: 'por_usuario', uf: 0.055 },
  { min: 31, max: 50, type: 'por_usuario', uf: 0.055 },
  { min: 51, max: 100, type: 'por_usuario', uf: 0.065 },
  { min: 101, max: 200, type: 'por_usuario', uf: 0.06 },
  { min: 201, max: 500, type: 'por_usuario', uf: 0.055 },
  { min: 501, max: 1000, type: 'por_usuario', uf: 0.05 },
  { min: 1001, max: 3000, type: 'por_usuario', uf: 0.045 },
  { min: 3001, max: 5000, type: 'por_usuario', uf: 0.04 },
  { min: 5001, max: 8000, type: 'por_usuario', uf: 0.035 },
  { min: 8001, max: Infinity, type: 'por_usuario', uf: 0.03 },
];

const LOGO_BLANCO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 321.84 56.16" width="300">   <path fill="#fff" d="M157.03,41.68l-11.44-28.81c-.07-.19-.25-.31-.45-.31h-3.24c-.27,0-.48.21-.49.47,0,.07,0,.14.04.2l13.66,33.75c.08.18.25.3.45.3h3.85c.2,0,.38-.12.45-.3l13.68-33.75c.1-.25-.02-.54-.28-.64-.06-.02-.11-.03-.17-.03h-3.24c-.2,0-.38.12-.45.31l-11.46,28.81c-.1.25-.39.37-.64.27-.12-.05-.22-.15-.27-.27h0Z"/>   <path fill="#fff" d="M179.34,11.51h0c1.18,0,2.13.95,2.13,2.13h0v.89c0,1.18-.95,2.13-2.13,2.13h0c-1.18,0-2.13-.95-2.13-2.13h0v-.89c0-1.18.95-2.13,2.13-2.13h0Z"/>   <rect fill="#fff" x="177.37" y="21.05" width="3.93" height="26.23" rx=".5" ry=".5"/>   <path fill="#fff" d="M194.89,25.57c1.5-.93,3.24-1.4,5-1.37,1.69-.06,3.36.44,4.74,1.41,1.22.85,2.18,2.01,2.77,3.37.08.18.26.31.46.31h3.21c.28,0,.5-.21.51-.49,0-.06,0-.12-.03-.18-.81-2.24-2.28-4.18-4.21-5.57-2.33-1.66-5.14-2.51-8-2.41-2.4-.06-4.76.57-6.82,1.8-1.91,1.19-3.46,2.88-4.48,4.88-1.09,2.12-1.64,4.47-1.61,6.85,0,2.37.56,4.71,1.66,6.81,1.02,2.01,2.57,3.7,4.48,4.9,2.05,1.24,4.42,1.87,6.82,1.81,2.86.1,5.67-.75,8-2.42,1.91-1.39,3.36-3.33,4.15-5.56.09-.26-.04-.55-.3-.64-.06-.02-.12-.03-.18-.03h-3.21c-.21,0-.39.13-.46.32-.59,1.35-1.53,2.51-2.73,3.36-1.39.97-3.05,1.47-4.74,1.42-1.76.03-3.49-.45-5-1.36-1.41-.89-2.56-2.15-3.3-3.65-1.55-3.13-1.55-6.81,0-9.94.75-1.48,1.89-2.73,3.3-3.62h-.03Z"/>   <path fill="#fff" d="M222.93,11.66h-3c-.28,0-.5.23-.5.51v8.89h-4.84c-.28,0-.5.21-.51.49h0v2.43c0,.28.23.51.51.51h4.94v22.31c0,.27.22.49.49.49h3c.27,0,.48-.21.48-.48v-22.29h5.55c.26,0,.47-.2.48-.46v-2.49c0-.28-.23-.51-.51-.51h-5.53v-8.91c0-.27-.22-.49-.49-.49,0,0-.07,0-.07,0Z"/>   <path fill="#fff" d="M272.24,21.45c-1.08.49-2.07,1.17-2.91,2-.71.66-1.31,1.41-1.79,2.25-.33.58-.6,1.18-.82,1.81v-6c0-.26-.2-.46-.46-.47h-3c-.26,0-.47.21-.47.47h0v25.3c0,.25.2.46.45.47h3.02c.25,0,.46-.21.46-.46h0v-11.07c0-1.87.38-3.72,1.13-5.43.7-1.64,1.82-3.07,3.25-4.14,1.46-1.09,3.24-1.65,5.06-1.61h.48v-3.93h-.26c-1.44-.04-2.86.24-4.18.82h.04Z"/>   <path fill="#fff" d="M282.89,11.51h0c1.18,0,2.13.95,2.13,2.13h0v.89c0,1.18-.95,2.13-2.13,2.13h0c-1.18,0-2.13-.95-2.13-2.13h0v-.89c0-1.18.95-2.13,2.13-2.13h0Z"/>   <rect fill="#fff" x="280.92" y="21.05" width="3.93" height="26.23" rx=".48" ry=".48"/>   <path fill="#fff" d="M65.79,30.6h0c0,.97.78,1.77,1.75,1.79h10.57c.21,0,.37.17.37.38,0,2.07-.61,4.09-1.75,5.81-1.14,1.69-2.72,3.05-4.56,3.93-4.22,1.97-9.13,1.77-13.17-.53-1.97-1.2-3.57-2.93-4.59-5-1.06-2.2-1.6-4.62-1.57-7.06-.04-2.45.51-4.88,1.6-7.08,1.05-2.07,2.66-3.8,4.64-5,2.19-1.28,4.7-1.93,7.24-1.86,2.37-.09,4.72.47,6.8,1.62,1.57.9,2.91,2.15,3.91,3.65.34.49.91.76,1.51.73h.25c.98,0,1.78-.79,1.79-1.77,0-.38-.12-.74-.34-1.05-1.22-1.69-2.75-3.14-4.5-4.28-2.89-1.87-6.28-2.83-9.73-2.75-3.16-.07-6.28.76-9,2.38-2.55,1.55-4.63,3.78-6,6.43-1.42,2.78-2.14,5.87-2.1,9-.05,3.12.66,6.21,2.05,9,1.32,2.64,3.35,4.86,5.85,6.43,2.75,1.65,5.91,2.48,9.11,2.39,1.32,0,2.64-.14,3.92-.45h0s12.13-2.33,12.29-14.76v-2c0-.99-.8-1.79-1.79-1.79h-12.74c-.99,0-1.79.8-1.79,1.79h0l-.02.05h0Z"/>   <path fill="#fff" d="M106.45,22.45c-4.31-2.41-9.56-2.41-13.87,0-1.93,1.17-3.49,2.86-4.51,4.88-1.06,2.13-1.58,4.48-1.54,6.85-.03,2.37.52,4.7,1.62,6.8,1.07,2.03,2.67,3.72,4.64,4.9,2.12,1.24,4.54,1.87,7,1.81,2.72.11,5.4-.67,7.63-2.23,1.74-1.32,3.12-3.06,4-5.06.1-.26-.02-.55-.27-.65-.06-.02-.12-.04-.19-.04h-3.28c-.17,0-.33.1-.42.25-.69,1.18-1.65,2.18-2.8,2.92-1.4.86-3.03,1.29-4.67,1.24-1.61.03-3.19-.37-4.6-1.14-1.3-.71-2.39-1.74-3.17-3-.69-1.11-1.17-2.35-1.4-3.64-.05-.27.13-.52.39-.57h20.99c.28,0,.5-.22.5-.5v-1.08c.03-2.38-.5-4.73-1.57-6.85-1.02-2.01-2.57-3.7-4.49-4.88h.01ZM91.2,32.07c-.28,0-.5-.23-.5-.5v-.09c.41-1.9,1.36-3.63,2.74-5,3.49-3.02,8.66-3.02,12.15,0,1.39,1.35,2.34,3.1,2.72,5,.06.26-.11.52-.38.58-.03,0-.07,0-.1,0h-16.64,0Z"/>   <path fill="#fff" d="M135.64,22.45c-4.31-2.41-9.57-2.41-13.88,0-1.93,1.17-3.49,2.86-4.51,4.88-1.07,2.12-1.6,4.47-1.57,6.85-.03,2.36.51,4.69,1.57,6.8,1.01,2.03,2.57,3.72,4.51,4.9,4.31,2.41,9.57,2.41,13.88,0,1.92-1.18,3.47-2.88,4.48-4.9,1.06-2.12,1.6-4.45,1.57-6.82.03-2.38-.51-4.72-1.57-6.85-1.02-2-2.57-3.68-4.48-4.86ZM136.7,39.13c-1.37,3.17-4.55,5.16-8,5-3.44.13-6.61-1.85-8-5-1.4-3.17-1.4-6.77,0-9.94,2.06-4.42,7.32-6.33,11.74-4.26,1.88.88,3.39,2.39,4.26,4.26,1.4,3.17,1.4,6.77,0,9.94Z"/>   <path fill="#fff" d="M251.54,22.45c-4.31-2.41-9.56-2.41-13.87,0-1.93,1.17-3.49,2.86-4.51,4.88-1.07,2.12-1.61,4.47-1.58,6.85-.02,2.36.54,4.69,1.61,6.8,1.01,2.03,2.57,3.72,4.51,4.9,4.31,2.41,9.56,2.41,13.87,0,1.92-1.18,3.48-2.88,4.49-4.9,1.06-2.12,1.6-4.45,1.57-6.82.03-2.38-.51-4.72-1.57-6.85-1.03-2.01-2.59-3.69-4.52-4.86ZM252.61,39.13c-1.37,3.17-4.55,5.16-8,5-3.44.13-6.61-1.85-8-5-1.4-3.17-1.4-6.77,0-9.94,2.06-4.42,7.32-6.33,11.74-4.26,1.88.88,3.39,2.39,4.26,4.26,1.4,3.17,1.4,6.77,0,9.94Z"/>   <path fill="#fff" d="M312.12,21.57v3.73c-.98-1.43-2.28-2.6-3.81-3.41-1.73-.88-3.64-1.31-5.58-1.26-4.7-.14-9.04,2.48-11.12,6.69-1.07,2.12-1.6,4.47-1.57,6.84-.03,2.37.51,4.71,1.57,6.82,2.07,4.23,6.42,6.85,11.12,6.72,1.94.06,3.86-.38,5.58-1.27,1.52-.8,2.83-1.94,3.81-3.35v3.71c0,.27.2.48.47.49h3.01c.27,0,.49-.22.49-.49v-25.23c0-.28-.22-.5-.5-.51h-2.92c-.28,0-.51.23-.51.51h-.04s0,0,0,0ZM311.29,39.13c-1.37,3.17-4.55,5.16-8,5-3.48.12-6.7-1.85-8.19-5-1.47-3.15-1.47-6.79,0-9.94,1.5-3.14,4.71-5.1,8.19-5,3.44-.14,6.62,1.85,8,5,1.4,3.17,1.4,6.77,0,9.94Z"/>   <path fill="#fff" d="M15.96,51.17s-1.42-10.73-10.21-28.8l9,2.4s4.3,9.66,4.79,13.12c2.16-2.75,10.73-9,10.73-9l9,2.41c-16.73,11.29-23.31,19.88-23.31,19.88"/>   <path fill="#fff" d="M6.46,18.2c-.08.29-.16.6-.22.9l8.57,2.29c0-.21.08-.42.13-.63,1.3-4.82,6.26-7.68,11.08-6.38s7.68,6.26,6.38,11.08c-.06.21-.12.39-.19.59l8.57,2.3c.09-.29.17-.55.25-.85,2.56-9.55-3.09-19.36-12.64-21.93-1.56-.42-3.16-.61-4.77-.59-8.04.06-15.06,5.46-17.16,13.22"/> </svg>';

const LOGO_ORIGINAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 321.84 56.16" width="150">   <path fill="#636364" d="M157.03,41.68l-11.44-28.81c-.07-.19-.25-.31-.45-.31h-3.24c-.27,0-.48.21-.49.47,0,.07,0,.14.04.2l13.66,33.75c.08.18.25.3.45.3h3.85c.2,0,.38-.12.45-.3l13.68-33.75c.1-.25-.02-.54-.28-.64-.06-.02-.11-.03-.17-.03h-3.24c-.2,0-.38.12-.45.31l-11.46,28.81c-.1.25-.39.37-.64.27-.12-.05-.22-.15-.27-.27h0Z"/>   <path fill="#636364" d="M179.34,11.51h0c1.18,0,2.13.95,2.13,2.13h0v.89c0,1.18-.95,2.13-2.13,2.13h0c-1.18,0-2.13-.95-2.13-2.13h0v-.89c0-1.18.95-2.13,2.13-2.13h0Z"/>   <rect fill="#636364" x="177.37" y="21.05" width="3.93" height="26.23" rx=".5" ry=".5"/>   <path fill="#636364" d="M194.89,25.57c1.5-.93,3.24-1.4,5-1.37,1.69-.06,3.36.44,4.74,1.41,1.22.85,2.18,2.01,2.77,3.37.08.18.26.31.46.31h3.21c.28,0,.5-.21.51-.49,0-.06,0-.12-.03-.18-.81-2.24-2.28-4.18-4.21-5.57-2.33-1.66-5.14-2.51-8-2.41-2.4-.06-4.76.57-6.82,1.8-1.91,1.19-3.46,2.88-4.48,4.88-1.09,2.12-1.64,4.47-1.61,6.85,0,2.37.56,4.71,1.66,6.81,1.02,2.01,2.57,3.7,4.48,4.9,2.05,1.24,4.42,1.87,6.82,1.81,2.86.1,5.67-.75,8-2.42,1.91-1.39,3.36-3.33,4.15-5.56.09-.26-.04-.55-.3-.64-.06-.02-.12-.03-.18-.03h-3.21c-.21,0-.39.13-.46.32-.59,1.35-1.53,2.51-2.73,3.36-1.39.97-3.05,1.47-4.74,1.42-1.76.03-3.49-.45-5-1.36-1.41-.89-2.56-2.15-3.3-3.65-1.55-3.13-1.55-6.81,0-9.94.75-1.48,1.89-2.73,3.3-3.62h-.03Z"/>   <path fill="#636364" d="M222.93,11.66h-3c-.28,0-.5.23-.5.51v8.89h-4.84c-.28,0-.5.21-.51.49h0v2.43c0,.28.23.51.51.51h4.94v22.31c0,.27.22.49.49.49h3c.27,0,.48-.21.48-.48v-22.29h5.55c.26,0,.47-.2.48-.46v-2.49c0-.28-.23-.51-.51-.51h-5.53v-8.91c0-.27-.22-.49-.49-.49,0,0-.07,0-.07,0Z"/>   <path fill="#636364" d="M272.24,21.45c-1.08.49-2.07,1.17-2.91,2-.71.66-1.31,1.41-1.79,2.25-.33.58-.6,1.18-.82,1.81v-6c0-.26-.2-.46-.46-.47h-3c-.26,0-.47.21-.47.47h0v25.3c0,.25.2.46.45.47h3.02c.25,0,.46-.21.46-.46h0v-11.07c0-1.87.38-3.72,1.13-5.43.7-1.64,1.82-3.07,3.25-4.14,1.46-1.09,3.24-1.65,5.06-1.61h.48v-3.93h-.26c-1.44-.04-2.86.24-4.18.82h.04Z"/>   <path fill="#636364" d="M282.89,11.51h0c1.18,0,2.13.95,2.13,2.13h0v.89c0,1.18-.95,2.13-2.13,2.13h0c-1.18,0-2.13-.95-2.13-2.13h0v-.89c0-1.18.95-2.13,2.13-2.13h0Z"/>   <rect fill="#636364" x="280.92" y="21.05" width="3.93" height="26.23" rx=".48" ry=".48"/>   <path fill="#636364" d="M65.79,30.6h0c0,.97.78,1.77,1.75,1.79h10.57c.21,0,.37.17.37.38,0,2.07-.61,4.09-1.75,5.81-1.14,1.69-2.72,3.05-4.56,3.93-4.22,1.97-9.13,1.77-13.17-.53-1.97-1.2-3.57-2.93-4.59-5-1.06-2.2-1.6-4.62-1.57-7.06-.04-2.45.51-4.88,1.6-7.08,1.05-2.07,2.66-3.8,4.64-5,2.19-1.28,4.7-1.93,7.24-1.86,2.37-.09,4.72.47,6.8,1.62,1.57.9,2.91,2.15,3.91,3.65.34.49.91.76,1.51.73h.25c.98,0,1.78-.79,1.79-1.77,0-.38-.12-.74-.34-1.05-1.22-1.69-2.75-3.14-4.5-4.28-2.89-1.87-6.28-2.83-9.73-2.75-3.16-.07-6.28.76-9,2.38-2.55,1.55-4.63,3.78-6,6.43-1.42,2.78-2.14,5.87-2.1,9-.05,3.12.66,6.21,2.05,9,1.32,2.64,3.35,4.86,5.85,6.43,2.75,1.65,5.91,2.48,9.11,2.39,1.32,0,2.64-.14,3.92-.45h0s12.13-2.33,12.29-14.76v-2c0-.99-.8-1.79-1.79-1.79h-12.74c-.99,0-1.79.8-1.79,1.79h0l-.02.05h0Z"/>   <path fill="#636364" d="M106.45,22.45c-4.31-2.41-9.56-2.41-13.87,0-1.93,1.17-3.49,2.86-4.51,4.88-1.06,2.13-1.58,4.48-1.54,6.85-.03,2.37.52,4.7,1.62,6.8,1.07,2.03,2.67,3.72,4.64,4.9,2.12,1.24,4.54,1.87,7,1.81,2.72.11,5.4-.67,7.63-2.23,1.74-1.32,3.12-3.06,4-5.06.1-.26-.02-.55-.27-.65-.06-.02-.12-.04-.19-.04h-3.28c-.17,0-.33.1-.42.25-.69,1.18-1.65,2.18-2.8,2.92-1.4.86-3.03,1.29-4.67,1.24-1.61.03-3.19-.37-4.6-1.14-1.3-.71-2.39-1.74-3.17-3-.69-1.11-1.17-2.35-1.4-3.64-.05-.27.13-.52.39-.57h20.99c.28,0,.5-.22.5-.5v-1.08c.03-2.38-.5-4.73-1.57-6.85-1.02-2.01-2.57-3.7-4.49-4.88h.01ZM91.2,32.07c-.28,0-.5-.23-.5-.5v-.09c.41-1.9,1.36-3.63,2.74-5,3.49-3.02,8.66-3.02,12.15,0,1.39,1.35,2.34,3.1,2.72,5,.06.26-.11.52-.38.58-.03,0-.07,0-.1,0h-16.64,0Z"/>   <path fill="#636364" d="M135.64,22.45c-4.31-2.41-9.57-2.41-13.88,0-1.93,1.17-3.49,2.86-4.51,4.88-1.07,2.12-1.6,4.47-1.57,6.85-.03,2.36.51,4.69,1.57,6.8,1.01,2.03,2.57,3.72,4.51,4.9,4.31,2.41,9.57,2.41,13.88,0,1.92-1.18,3.47-2.88,4.48-4.9,1.06-2.12,1.6-4.45,1.57-6.82.03-2.38-.51-4.72-1.57-6.85-1.02-2-2.57-3.68-4.48-4.86ZM136.7,39.13c-1.37,3.17-4.55,5.16-8,5-3.44.13-6.61-1.85-8-5-1.4-3.17-1.4-6.77,0-9.94,2.06-4.42,7.32-6.33,11.74-4.26,1.88.88,3.39,2.39,4.26,4.26,1.4,3.17,1.4,6.77,0,9.94Z"/>   <path fill="#636364" d="M251.54,22.45c-4.31-2.41-9.56-2.41-13.87,0-1.93,1.17-3.49,2.86-4.51,4.88-1.07,2.12-1.61,4.47-1.58,6.85-.02,2.36.54,4.69,1.61,6.8,1.01,2.03,2.57,3.72,4.51,4.9,4.31,2.41,9.56,2.41,13.87,0,1.92-1.18,3.48-2.88,4.49-4.9,1.06-2.12,1.6-4.45,1.57-6.82.03-2.38-.51-4.72-1.57-6.85-1.03-2.01-2.59-3.69-4.52-4.86ZM252.61,39.13c-1.37,3.17-4.55,5.16-8,5-3.44.13-6.61-1.85-8-5-1.4-3.17-1.4-6.77,0-9.94,2.06-4.42,7.32-6.33,11.74-4.26,1.88.88,3.39,2.39,4.26,4.26,1.4,3.17,1.4,6.77,0,9.94Z"/>   <path fill="#636364" d="M312.12,21.57v3.73c-.98-1.43-2.28-2.6-3.81-3.41-1.73-.88-3.64-1.31-5.58-1.26-4.7-.14-9.04,2.48-11.12,6.69-1.07,2.12-1.6,4.47-1.57,6.84-.03,2.37.51,4.71,1.57,6.82,2.07,4.23,6.42,6.85,11.12,6.72,1.94.06,3.86-.38,5.58-1.27,1.52-.8,2.83-1.94,3.81-3.35v3.71c0,.27.2.48.47.49h3.01c.27,0,.49-.22.49-.49v-25.23c0-.28-.22-.5-.5-.51h-2.92c-.28,0-.51.23-.51.51h-.04s0,0,0,0ZM311.29,39.13c-1.37,3.17-4.55,5.16-8,5-3.48.12-6.7-1.85-8.19-5-1.47-3.15-1.47-6.79,0-9.94,1.5-3.14,4.71-5.1,8.19-5,3.44-.14,6.62,1.85,8,5,1.4,3.17,1.4,6.77,0,9.94Z"/>   <path fill="#2eaae2" d="M15.96,51.17s-1.42-10.73-10.21-28.8l9,2.4s4.3,9.66,4.79,13.12c2.16-2.75,10.73-9,10.73-9l9,2.41c-16.73,11.29-23.31,19.88-23.31,19.88"/>   <path fill="#fabb0c" d="M6.46,18.2c-.08.29-.16.6-.22.9l8.57,2.29c0-.21.08-.42.13-.63,1.3-4.82,6.26-7.68,11.08-6.38s7.68,6.26,6.38,11.08c-.06.21-.12.39-.19.59l8.57,2.3c.09-.29.17-.55.25-.85,2.56-9.55-3.09-19.36-12.64-21.93-1.56-.42-3.16-.61-4.77-.59-8.04.06-15.06,5.46-17.16,13.22"/> </svg>';

const ISO_ORIGINAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="50" height="50">   <path fill="#00AFF2" d="M35.54,92.94s-2.7-20.42-19.43-54.8l17.13,4.57s8.18,18.38,9.11,24.97c4.11-5.23,20.42-17.13,20.42-17.13l17.13,4.59c-31.84,21.48-44.36,37.83-44.36,37.83"/>   <path fill="#FFBB00" d="M16.73,31.2c-.15.55-.3,1.14-.42,1.71l16.31,4.36c0-.4.15-.8.25-1.2,2.47-9.17,11.91-14.61,21.08-12.14,9.17,2.47,14.61,11.91,12.14,21.08-.11.4-.23.74-.36,1.12l16.31,4.38c.17-.55.32-1.05.48-1.62,4.87-18.17-5.88-36.84-24.05-41.73-2.97-.8-6.01-1.16-9.08-1.12-15.3.11-28.66,10.39-32.65,25.16"/> </svg>';

// ───────────────────────────────────────────────────────────────────────────
// Escalones de descuento (Vicky V3)
//
// Orden de aplicación cuando el prospecto objeta el precio. La cotizadora
// avanza un solo paso por llamada de aplicar_siguiente_descuento, decidiendo
// el próximo según el estado actual del quote:
//
//   - Los escalones de recurrente se aplican secuencialmente: 10 → 20 %
//     (tope 20%), cada uno con una ventana de contratación más corta.
//   - condicionDiscursiva es texto que Vicky comunica al cliente; no tiene
//     enforcement técnico (el descuento queda aplicado aunque se venza).
//
// CAMBIO DE TARIFAS jul-2026: los escalones de instalación (RM 50% / regiones
// 25%) se ELIMINARON de la escalera — los reemplazó la tarifa plana de
// instalación por zona (RM 1 UF / IV-V-VI 3 UF / resto 5 UF, igual para
// arriendo y compra), que ya viene en el precio del ítem. Las cotizaciones
// antiguas con un descuento de instalación ya COMITEADO lo conservan:
// descuentosHasta (discount-engine) lee los campos Descuento_Instalacion_*_Pct
// del quote y los preserva al negociar y regenerar.
// ───────────────────────────────────────────────────────────────────────────
const DISCOUNT_LADDER = [
  {
    tipo: "recurrente_10",
    pct: 10,
    condicionDiscursiva:
      "Este descuento aplica si la cotización se paga dentro de las próximas 24 horas.",
    label: "10 % de descuento sobre el plan mensual",
  },
  {
    tipo: "recurrente_20",
    pct: 20,
    condicionDiscursiva:
      "Es el mejor precio que te puedo dejar; aplica si pagas dentro de las próximas 2 horas.",
    label: "20 % de descuento sobre el plan mensual",
  },
];

// Duración (en meses) del descuento sobre el PLAN mensual (recurrente). El
// descuento del plan aplica solo los primeros N meses; desde el mes N+1 el plan
// vuelve a su tarifa normal. (El descuento de instalación es un cobro único y NO
// tiene esta limitación.) Cambiar acá si la política cambia.
const MESES_DESCUENTO_PLAN = 6;

// VIGENCIA POR COTIZACIÓN (Lalo 10-ago, caso Cigpa/Anderson): los 6 meses eran
// una constante global y el ejecutivo NO podía moverla — ni acortarla ni
// dejarla indefinida. Ahora cada cotización puede llevar su propia vigencia:
//   null / undefined → política por defecto (MESES_DESCUENTO_PLAN)
//   0                → INDEFINIDO (el descuento no vence)
//   1..N             → esos meses
// Estas dos funciones son la ÚNICA fuente del texto, para que PDF, correo y
// página de aceptación digan exactamente lo mismo.
function mesesDescuentoNormalizados(meses) {
  if (meses === null || meses === undefined || meses === "") return MESES_DESCUENTO_PLAN;
  const n = Math.trunc(Number(meses));
  if (!Number.isFinite(n) || n < 0) return MESES_DESCUENTO_PLAN;
  return Math.min(n, 120);
}

/** Frase de vigencia del descuento del plan. `meses` = 0 → indefinido. */
function textoVigenciaDescuento(meses) {
  const n = mesesDescuentoNormalizados(meses);
  if (n === 0) {
    return "El descuento sobre el plan mensual no tiene vencimiento: se mantiene mientras dure el servicio. El descuento de instalación, por ser cobro único, tampoco tiene limitación.";
  }
  if (n === 1) {
    return "El descuento sobre el plan mensual aplica el primer mes; desde el mes 2 el plan vuelve a su tarifa normal. El descuento de instalación, por ser cobro único, no tiene esta limitación.";
  }
  return `El descuento sobre el plan mensual aplica durante los primeros ${n} meses; desde el mes ${n + 1} el plan vuelve a su tarifa normal. El descuento de instalación, por ser cobro único, no tiene esta limitación.`;
}

/** Versión corta para mensajes de chat/WhatsApp. */
function textoVigenciaCorto(meses) {
  const n = mesesDescuentoNormalizados(meses);
  if (n === 0) return "sin vencimiento (se mantiene mientras dure el servicio)";
  if (n === 1) return "aplica el primer mes";
  return `aplica los primeros ${n} meses`;
}

module.exports = {
  PROPOSAL_INTRO,
  PROPOSAL_BENEFICIOS,
  PROPOSAL_TYC,
  PROPOSAL_TYC_ARRIENDO,
  SERVICIOS_GRATIS,
  PRICING_TIERS,
  LOGO_BLANCO_SVG,
  LOGO_ORIGINAL_SVG,
  ISO_ORIGINAL_SVG,
  DISCOUNT_LADDER,
  MESES_DESCUENTO_PLAN,
  mesesDescuentoNormalizados,
  textoVigenciaDescuento,
  textoVigenciaCorto,
};
