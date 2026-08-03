const {
  getRecordWithFields,
  getRecord,
  createRecord,
  updateRecordBestEffort,
  getUserById,
  searchRecords,
  getModuleFieldNames,
  toText,
} = require("./zoho-crm");

const MODULOS_PERMITIDOS = [
  "Dashboard BI",
  "Gestor Documental",
  "Planificador Inteligente",
  "Modulo de Alertas",
  "Permisos y Vacaciones",
];

const SISTEMAS_VALIDOS = [
  "GeoVictoria BOX",
  "GeoVictoria CALL",
  "GeoVictoria APP",
  "GeoVictoria USB",
  "GeoVictoria WEB",
];

const SISTEMA_MAP = {
  "Relojes Biométricos": "GeoVictoria BOX",
  "Relojes Biometricos": "GeoVictoria BOX",
  "Marcaje por Llamada": "GeoVictoria CALL",
  "Aplicación Móvil": "GeoVictoria APP",
  "Aplicacion Movil": "GeoVictoria APP",
  "Lector USB Biométrico": "GeoVictoria USB",
  "Lector USB Biometrico": "GeoVictoria USB",
  "Portal Web": "GeoVictoria WEB",
};

const ONBOARDING_ACCOUNT_LOOKUP_CANDIDATES = [
  "Account_asociada",
  "Account_Asociada",
  "Account_Name",
  "Cuenta_Asociada",
];

const ONBOARDING_CONTACT_LOOKUP_CANDIDATES = [
  "Contacto_Ejecutor",
  "Contacto_ejecutor",
  "Contacto_Asociado",
  "Contacto_asociado",
  "Contact_Name",
  "Contacto",
];

const emptyString = "";

function uniqueStrings(values) {
  const set = new Set();
  for (const value of values || []) {
    const text = toText(value);
    if (text) set.add(text);
  }
  return Array.from(set);
}

function toZohoDateTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "");
  return `${iso}+00:00`;
}

function pickNonEmpty(...values) {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return emptyString;
}

function normalizeText(value) {
  return toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function canonicalizeSistema(value) {
  const text = toText(value);
  if (!text) return emptyString;
  if (SISTEMAS_VALIDOS.includes(text)) return text;

  const byLabel = SISTEMA_MAP[text];
  if (byLabel) return byLabel;

  const normalized = normalizeText(text);
  const normalizedMap = {
    "relojes biometricos": "GeoVictoria BOX",
    "marcaje por llamada": "GeoVictoria CALL",
    "aplicacion movil": "GeoVictoria APP",
    "lector usb biometrico": "GeoVictoria USB",
    "portal web": "GeoVictoria WEB",
    "geovictoria box": "GeoVictoria BOX",
    "geovictoria call": "GeoVictoria CALL",
    "geovictoria app": "GeoVictoria APP",
    "geovictoria usb": "GeoVictoria USB",
    "geovictoria web": "GeoVictoria WEB",
  };
  return normalizedMap[normalized] || emptyString;
}

function normalizeSistemas(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw
          .split(/[;,|]/)
          .map((item) => item.trim())
          .filter(Boolean)
      : raw && typeof raw === "object"
        ? [raw]
        : [];
  return uniqueStrings(
    list.map((item) => {
      const candidate = typeof item === "object" ? item?.display_value ?? item?.value ?? item?.name ?? item : item;
      return canonicalizeSistema(candidate);
    })
  );
}

function inferSistemasFromQuoteItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const sistemas = new Set();
  let hasAsistencia = false;

  for (const item of items) {
    const itemName = normalizeText(item?.Nombre_Item || item?.nombre || item?.name || "");
    if (!itemName) continue;

    if (itemName.includes("asistencia")) hasAsistencia = true;

    const isUsb = itemName.includes("usb") || itemName.includes("uru4500");
    const isBiometrico =
      itemName.includes("senseface") ||
      itemName.includes("speedface") ||
      itemName.includes("mb10") ||
      itemName.includes("mb560") ||
      itemName.includes("in01") ||
      itemName.includes("x628") ||
      itemName.includes("s922") ||
      itemName.includes("ct58") ||
      itemName.includes("armorpad") ||
      itemName.includes("reloj") ||
      itemName.includes("biometric") ||
      itemName.includes("biometr") ||
      itemName.includes("huella");

    if (isUsb) sistemas.add("GeoVictoria USB");
    if (isBiometrico) sistemas.add("GeoVictoria BOX");
  }

  // Regla solicitada: CALL por defecto cuando se cotiza Asistencia.
  if (hasAsistencia) sistemas.add("GeoVictoria CALL");

  return Array.from(sistemas);
}

function normalizeModulos(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = uniqueStrings(
    list.map((item) => {
      const text = toText(item);
      if (text === "Dasboard BI") return "Dashboard BI";
      return text;
    })
  );
  return normalized.filter((value) => MODULOS_PERMITIDOS.includes(value));
}

function extractLookupId(value) {
  if (value && typeof value === "object") {
    return toText(value.id || value.ID);
  }
  return toText(value);
}

function pickExistingFieldName(fieldNamesSet, preferred, candidates) {
  const normalized = new Map();
  for (const name of fieldNamesSet || []) {
    const key = toText(name).toLowerCase();
    if (key) normalized.set(key, toText(name));
  }

  const preferredKey = toText(preferred).toLowerCase();
  if (preferredKey && normalized.has(preferredKey)) {
    return normalized.get(preferredKey);
  }

  for (const candidate of candidates || []) {
    const key = toText(candidate).toLowerCase();
    if (key && normalized.has(key)) return normalized.get(key);
  }
  return "";
}

async function resolveOnboardingLookupFields(config) {
  const fieldNames = await getModuleFieldNames(config.onboardingModule, false);
  return {
    accountLookupField: pickExistingFieldName(
      fieldNames,
      config.onboardingAccountLookupField,
      ONBOARDING_ACCOUNT_LOOKUP_CANDIDATES
    ),
    contactLookupField: pickExistingFieldName(
      fieldNames,
      config.onboardingExecutorContactLookupField,
      ONBOARDING_CONTACT_LOOKUP_CANDIDATES
    ),
  };
}

function buildOnboardingName(quote, deal, account, contact) {
  const empresa = pickNonEmpty(
    account?.Account_Name,
    quote?.Nombre_Fantasia,
    quote?.Razon_Social,
    quote?.Name,
    deal?.Deal_Name,
    "Empresa"
  );
  const contacto = pickNonEmpty(
    contact?.Full_Name,
    quote?.Contacto_Cliente,
    deal?.Contact_Name?.name,
    deal?.Owner?.name,
    "Contacto"
  );
  return `Auto Onboarding ${empresa} - ${contacto}`.slice(0, 120);
}

function buildGenerateLinkPayload({
  onboardingId,
  empresa,
  ejecutivoNombre,
  ejecutivoTelefono,
  sistemas,
  modulosAdicionales,
}) {
  return {
    id_zoho: onboardingId,
    empresa: {
      razonSocial: empresa.razonSocial || emptyString,
      nombreFantasia: empresa.nombreFantasia || emptyString,
      rut: empresa.rut || emptyString,
      giro: empresa.giro || emptyString,
      direccion: empresa.direccion || emptyString,
      comuna: empresa.comuna || emptyString,
      emailFacturacion: empresa.emailFacturacion || emptyString,
      telefonoContacto: empresa.telefonoContacto || emptyString,
      ejecutivoTelefono: ejecutivoTelefono || emptyString,
      ejecutivoNombre: ejecutivoNombre || emptyString,
      sistema: sistemas || [],
      modulosAdicionales: modulosAdicionales || [],
      modulosAdicionalesOtro: emptyString,
      rubro: empresa.rubro || emptyString,
    },
  };
}

async function fetchDealContext(config, dealId) {
  const deal = await getRecordWithFields("Deals", dealId, [
    "id",
    "Deal_Name",
    "Owner",
    "Account_Name",
    "Contact_Name",
    "M_todo_de_Marcaje",
    "Modulos_adicionales",
    "Rut_ID_Account",
    "Rubro",
    "Rubro_Account",
    "Contact_Email",
    "Contact_Phone",
  ]);

  const accountId = toText(deal?.Account_Name?.id);
  const contactId = toText(deal?.Contact_Name?.id);
  const ownerId = toText(deal?.Owner?.id);

  const account = accountId
    ? await getRecordWithFields("Accounts", accountId, [
        "id",
        "Account_Name",
        "RUT_Empresa",
        "Comuna",
        "Rubro_econ_mico",
      ])
    : null;

  const contact = contactId
    ? await getRecordWithFields("Contacts", contactId, [
        "id",
        "Full_Name",
        "Email",
        "Phone",
        "Mailing_City",
        "Mailing_Street",
      ])
    : null;

  const owner = ownerId ? await getUserById(ownerId) : null;

  return {
    deal,
    account,
    contact,
    owner,
  };
}

function buildOnboardingDraft({
  config,
  quote,
  dealContext,
  acceptanceData,
}) {
  const { deal, account, contact, owner } = dealContext;

  const empresa = {
    razonSocial: pickNonEmpty(account?.Account_Name, quote?.Razon_Social, quote?.Name),
    nombreFantasia: pickNonEmpty(account?.Account_Name, quote?.Razon_Social, quote?.Name),
    rut: pickNonEmpty(
      acceptanceData?.companyRut,
      quote?.RUT_Cliente,
      deal?.Rut_ID_Account,
      account?.RUT_Empresa
    ),
    giro: pickNonEmpty(acceptanceData?.companyGiro, quote?.Giro, account?.Rubro_econ_mico),
    direccion: pickNonEmpty(acceptanceData?.companyAddress, quote?.Direccion, contact?.Mailing_Street),
    comuna: pickNonEmpty(acceptanceData?.companyComuna, quote?.Comuna, account?.Comuna, contact?.Mailing_City),
    emailFacturacion: pickNonEmpty(
      acceptanceData?.billingEmail,
      quote?.[config.billingEmailField],
      contact?.Email,
      deal?.Contact_Email
    ),
    telefonoContacto: pickNonEmpty(
      acceptanceData?.billingPhone,
      quote?.[config.billingPhoneField],
      contact?.Phone,
      deal?.Contact_Phone
    ),
    rubro: pickNonEmpty(quote?.Rubro, deal?.Rubro, account?.Rubro_econ_mico),
  };

  const ejecutivoNombre = pickNonEmpty(owner?.full_name, owner?.name, deal?.Owner?.name);
  const ejecutivoTelefono = pickNonEmpty(owner?.phone, owner?.mobile);
  const sistemasDesdeCotizacion = normalizeSistemas(
    quote?.[config.quoteMarkingMethodsField] ??
      quote?.Metodos_de_Marcaje1 ??
      quote?.Metodos_de_Marcaje
  );
  const sistemasInferidosItems = inferSistemasFromQuoteItems(quote?.[config.quoteItemsSubformField]);
  const sistemasDesdeDeal = normalizeSistemas(deal?.M_todo_de_Marcaje);
  let sistemas = uniqueStrings([
    ...sistemasDesdeCotizacion,
    ...sistemasInferidosItems,
    ...sistemasDesdeDeal,
  ]);
  if (sistemas.length === 0) {
    // Respaldo para evitar handoff sin métodos cuando no llegan valores desde CRM.
    sistemas = ["GeoVictoria CALL"];
  }
  const modulosAdicionales = normalizeModulos(deal?.Modulos_adicionales);

  return {
    onboardingName: buildOnboardingName(quote, deal, account, contact),
    accountId: pickNonEmpty(account?.id, deal?.Account_Name?.id),
    executorContactId: pickNonEmpty(
      contact?.id,
      deal?.Contact_Name?.id,
      extractLookupId(quote?.[config.quoteContactLookupField]),
      extractLookupId(quote?.Contacto_Asociado),
      extractLookupId(quote?.Contact_Name)
    ),
    empresa,
    ejecutivoNombre,
    ejecutivoTelefono,
    // Dueño del deal (= ejecutivo del país): el registro de onboarding debe
    // heredarlo — sin esto, la regla por defecto de Zoho lo asignaba a
    // Anderson (CL) y el correo de bienvenida/widget salían a su nombre
    // aunque el deal fuera de Yahel (MX). Detectado 22-jul en la prueba MX.
    ownerId: toText(owner?.id || deal?.Owner?.id),
    sistemas,
    modulosAdicionales,
  };
}

async function getOrCreateOnboardingRecord({ config, quoteId, dealId, quote, draft, lookupFields }) {
  const currentLookupId = toText(quote?.[config.quoteOnboardingLookupField]?.id);
  if (currentLookupId) {
    return { onboardingId: currentLookupId, created: false };
  }

  const byOrigin = await searchRecords(
    config.onboardingModule,
    `(Origen_Aceptacion_Id:equals:${quoteId})`,
    ["id"]
  );
  if (Array.isArray(byOrigin) && byOrigin.length > 0) {
    const existingId = toText(byOrigin[0]?.id);
    if (existingId) return { onboardingId: existingId, created: false };
  }

  const createMap = {
    // Owner explícito = dueño del deal (ejecutivo del país). Si Zoho tiene
    // una regla de asignación en el módulo, este valor explícito debe primar.
    ...(draft.ownerId ? { Owner: { id: draft.ownerId } } : {}),
    [config.onboardingNameField]: draft.onboardingName,
    [config.onboardingDealLookupField]: { id: dealId },
    [config.onboardingQuoteLookupField]: { id: quoteId },
    [config.onboardingOriginAcceptanceIdField]: quoteId,
    [config.onboardingChannelField]: config.onboardingChannelValue,
    [config.onboardingHandoffStatusField]: "link_generation",
    [config.onboardingHandoffErrorField]: "",
    [config.onboardingRazonSocialField]: draft.empresa.razonSocial,
    [config.onboardingNombreFantasiaField]: draft.empresa.nombreFantasia,
    [config.onboardingRutField]: draft.empresa.rut,
    [config.onboardingGiroField]: draft.empresa.giro,
    [config.onboardingDireccionField]: draft.empresa.direccion,
    [config.onboardingComunaField]: draft.empresa.comuna,
    [config.onboardingEmailFacturacionField]: draft.empresa.emailFacturacion,
    [config.onboardingTelefonoContactoField]: draft.empresa.telefonoContacto,
    [config.onboardingRubroField]: draft.empresa.rubro,
    [config.onboardingSistemasField]: draft.sistemas,
    [config.onboardingModulosField]: draft.modulosAdicionales,
  };
  if (lookupFields?.accountLookupField && draft.accountId) {
    createMap[lookupFields.accountLookupField] = { id: draft.accountId };
  }
  if (lookupFields?.contactLookupField && draft.executorContactId) {
    createMap[lookupFields.contactLookupField] = { id: draft.executorContactId };
  }

  const createResult = await createRecord(config.onboardingModule, createMap, true);
  // RE-AFIRMAR el dueño después de crear (reporte de Grey, 03-ago): aunque el
  // create manda Owner = dueño del deal, un workflow del módulo en Zoho (era
  // pre-relevo) reasigna el registro a Anderson al nacer. Los workflows de
  // creación no re-disparan en updates, así que este segundo PUT deja al
  // dueño real. Best-effort: si falla, el registro queda como lo dejó Zoho.
  if (createResult?.id && draft.ownerId) {
    await updateRecordBestEffort(
      config.onboardingModule,
      createResult.id,
      { Owner: { id: draft.ownerId } },
      true,
    );
  }
  return { onboardingId: createResult.id, created: true };
}

async function syncOnboardingDraft({ config, onboardingId, draft, lookupFields }) {
  const map = {
    [config.onboardingRazonSocialField]: draft.empresa.razonSocial,
    [config.onboardingNombreFantasiaField]: draft.empresa.nombreFantasia,
    [config.onboardingRutField]: draft.empresa.rut,
    [config.onboardingGiroField]: draft.empresa.giro,
    [config.onboardingDireccionField]: draft.empresa.direccion,
    [config.onboardingComunaField]: draft.empresa.comuna,
    [config.onboardingEmailFacturacionField]: draft.empresa.emailFacturacion,
    [config.onboardingTelefonoContactoField]: draft.empresa.telefonoContacto,
    [config.onboardingRubroField]: draft.empresa.rubro,
    [config.onboardingSistemasField]: draft.sistemas,
    [config.onboardingModulosField]: draft.modulosAdicionales,
    [config.onboardingHandoffErrorField]: "",
  };

  if (lookupFields?.accountLookupField && draft.accountId) {
    map[lookupFields.accountLookupField] = { id: draft.accountId };
  }
  if (lookupFields?.contactLookupField && draft.executorContactId) {
    map[lookupFields.contactLookupField] = { id: draft.executorContactId };
  }

  await updateRecordBestEffort(config.onboardingModule, onboardingId, map, true);
}

async function updateOnboardingReady({ config, onboardingId, link, token }) {
  const now = toZohoDateTime();
  const map = {
    [config.onboardingUrlField]: link,
    [config.onboardingTokenField]: token,
    [config.onboardingTokenActiveField]: true,
    [config.onboardingTokenDateField]: now,
    [config.onboardingHandoffStatusField]: "ready",
    [config.onboardingHandoffErrorField]: "",
  };
  await updateRecordBestEffort(config.onboardingModule, onboardingId, map, true);
}

async function updateOnboardingError({ config, onboardingId, errorMessage }) {
  const map = {
    [config.onboardingHandoffStatusField]: "error",
    [config.onboardingHandoffErrorField]: toText(errorMessage).slice(0, 255),
  };
  await updateRecordBestEffort(config.onboardingModule, onboardingId, map, true);
}

async function updateQuoteHandoffSuccess({ config, quoteId, onboardingId, link, token }) {
  const map = {
    [config.quoteOnboardingLookupField]: onboardingId ? { id: onboardingId } : undefined,
    [config.quoteOnboardingUrlField]: link,
    [config.quoteOnboardingTokenField]: token,
    [config.quoteHandoffStatusField]: config.quoteOnboardingStatusReady || "Cerrada",
  };
  await updateRecordBestEffort(config.quoteModule, quoteId, map, true);
}

async function updateQuoteHandoffError({ config, quoteId, errorMessage, onboardingId }) {
  const map = {
    [config.quoteOnboardingLookupField]: onboardingId ? { id: onboardingId } : undefined,
    [config.quoteHandoffStatusField]: config.quoteOnboardingStatusError || "Error",
    [config.quoteHandoffErrorField]: toText(errorMessage).slice(0, 255),
  };
  await updateRecordBestEffort(config.quoteModule, quoteId, map, true);
}

async function requestOnboardingLink(config, payload) {
  const endpoint = toText(config.onboardingGenerateLinkUrl);
  if (!endpoint) {
    throw new Error("ONBOARDING_GENERATE_LINK_URL no configurado.");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch (_error) {
    parsed = { raw: text || "" };
  }

  if (!response.ok || parsed?.success !== true) {
    const message = toText(parsed?.error || parsed?.message || parsed?.raw) || `HTTP ${response.status}`;
    throw new Error(`generate-link onboarding fallo: ${message}`);
  }

  const link = toText(parsed?.link);
  const token = toText(parsed?.token);
  if (!link || !token) {
    throw new Error("generate-link onboarding respondio sin link/token.");
  }
  return { link, token, raw: parsed };
}

async function runOnboardingHandoff({ config, quoteId, dealId, acceptanceData }) {
  const quote = await getRecord(config.quoteModule, quoteId);
  const realDealId = toText(quote?.[config.quoteDealLookupField]?.id || dealId);
  if (!realDealId) {
    throw new Error("La cotizacion no tiene Deal asociado.");
  }

  const existingOnboardingUrl = toText(quote?.[config.quoteOnboardingUrlField]);
  const existingToken = toText(quote?.[config.quoteOnboardingTokenField]);
  const existingOnboardingId = toText(quote?.[config.quoteOnboardingLookupField]?.id);
  const context = await fetchDealContext(config, realDealId);
  const lookupFields = await resolveOnboardingLookupFields(config);
  const draft = buildOnboardingDraft({
    config,
    quote,
    dealContext: context,
    acceptanceData: acceptanceData || {},
  });

  if (existingOnboardingUrl && existingToken && existingOnboardingId) {
    await syncOnboardingDraft({
      config,
      onboardingId: existingOnboardingId,
      draft,
      lookupFields,
    });
    return {
      onboardingId: existingOnboardingId,
      onboardingUrl: existingOnboardingUrl,
      token: existingToken,
      reused: true,
      linkCreated: false,
    };
  }

  const onboardingRow = await getOrCreateOnboardingRecord({
    config,
    quoteId,
    dealId: realDealId,
    quote,
    draft,
    lookupFields,
  });

  // Mantiene Auto-Onboarding sincronizado con el snapshot actual usado para generar el link.
  await syncOnboardingDraft({
    config,
    onboardingId: onboardingRow.onboardingId,
    draft,
    lookupFields,
  });

  await updateRecordBestEffort(
    config.quoteModule,
    quoteId,
    {
      [config.quoteOnboardingLookupField]: { id: onboardingRow.onboardingId },
      [config.quoteHandoffStatusField]: config.quoteOnboardingStatusPending || "En Curso",
      [config.quoteHandoffErrorField]: "",
    },
    true
  );

  try {
    const linkResult = await requestOnboardingLink(
      config,
      buildGenerateLinkPayload({
        onboardingId: onboardingRow.onboardingId,
        empresa: draft.empresa,
        ejecutivoNombre: draft.ejecutivoNombre,
        ejecutivoTelefono: draft.ejecutivoTelefono,
        sistemas: draft.sistemas,
        modulosAdicionales: draft.modulosAdicionales,
      })
    );

    await updateOnboardingReady({
      config,
      onboardingId: onboardingRow.onboardingId,
      link: linkResult.link,
      token: linkResult.token,
    });
    await updateQuoteHandoffSuccess({
      config,
      quoteId,
      onboardingId: onboardingRow.onboardingId,
      link: linkResult.link,
      token: linkResult.token,
    });

    return {
      onboardingId: onboardingRow.onboardingId,
      onboardingUrl: linkResult.link,
      token: linkResult.token,
      reused: false,
      linkCreated: true,
      onboardingCreated: onboardingRow.created,
    };
  } catch (error) {
    const message = toText(error?.message || error) || "Error desconocido en handoff.";
    await updateOnboardingError({
      config,
      onboardingId: onboardingRow.onboardingId,
      errorMessage: message,
    });
    await updateQuoteHandoffError({
      config,
      quoteId,
      onboardingId: onboardingRow.onboardingId,
      errorMessage: message,
    });
    throw error;
  }
}

module.exports = {
  runOnboardingHandoff,
};
