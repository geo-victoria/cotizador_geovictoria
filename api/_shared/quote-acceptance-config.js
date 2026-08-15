const { toText } = require("./zoho-crm");

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBaseUrl(req) {
  const envBase = toText(process.env.QUOTE_ACCEPT_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL);
  if (envBase) return envBase.replace(/\/+$/, "");

  const host = toText(req?.headers?.host);
  const proto = toText(req?.headers?.["x-forwarded-proto"]) || "https";
  if (!host) {
    return "https://cotizacion.geovictoria.com";
  }
  return `${proto}://${host}`;
}

function getAcceptanceConfig(req) {
  return {
    baseUrl: getBaseUrl(req),
    quoteModule: toText(process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria"),
    quoteDateField: toText(process.env.QUOTE_DATE_FIELD || "Fecha_Cotizacion"),
    quoteStatusField: toText(process.env.QUOTE_STATUS_FIELD || "Estado_Cotizacion"),
    quoteDealLookupField: toText(process.env.QUOTE_DEAL_LOOKUP_FIELD || "Deal_Asociado"),
    quoteContactLookupField: toText(process.env.QUOTE_CONTACT_LOOKUP_FIELD || "Contacto_Asociado"),
    quotePdfUrlField: toText(process.env.QUOTE_PDF_URL_FIELD || "PDF_URL"),
    quoteItemsSubformField: toText(process.env.QUOTE_ITEMS_SUBFORM_FIELD || "Detalle_Items_Cotizacion"),
    quoteDiscountPctField: toText(process.env.QUOTE_DISCOUNT_PCT_FIELD || "Descuento_Recurrente_Pct"),
    quoteDiscountUnlockedField: toText(process.env.QUOTE_DISCOUNT_UNLOCKED_FIELD || "Descuento_Desbloqueado"),
    quoteDiscountInstRMPctField: toText(
      process.env.QUOTE_DISCOUNT_INST_RM_PCT_FIELD || "Descuento_Instalacion_RM_Pct"
    ),
    quoteDiscountInstRegionPctField: toText(
      process.env.QUOTE_DISCOUNT_INST_REGION_PCT_FIELD || "Descuento_Instalacion_Region_Pct"
    ),
    quoteEscalonField: toText(process.env.QUOTE_ESCALON_FIELD || "Escalon_Descuento"),
    quoteEscalonNegociacionField: toText(
      process.env.QUOTE_ESCALON_NEGOCIACION_FIELD || "Escalon_Negociacion"
    ),
    quoteVersionPdfField: toText(process.env.QUOTE_VERSION_PDF_FIELD || "Version_PDF"),
    quoteItemZonaTarifaField: toText(
      process.env.QUOTE_ITEM_ZONA_TARIFA_FIELD || "Zona_Tarifa"
    ),
    // Campo de texto largo donde se guarda, en JSON, la escalera de precios que
    // el agente usó para cotizar ({ codigoItem: [{desde,hasta,modalidad,precioUF}] }).
    // Creator necesita la escalera COMPLETA para imprimir la tabla de cobro y
    // resaltar el tramo aplicable; se persiste con la cotización para que la NDV
    // refleje los precios vigentes cuando el cliente aceptó, no los de hoy.
    // Sin el campo configurado, la tabla cae al tramo único (ver ndv-charge-table).
    quotePriceLadderField: toText(process.env.QUOTE_PRICE_LADDER_FIELD || ""),
    quoteMarkingMethodsField: toText(
      process.env.QUOTE_MARKING_METHODS_FIELD || "Metodos_de_Marcaje1"
    ),
    quoteAcceptanceUrlField: toText(process.env.QUOTE_ACCEPTANCE_URL_FIELD || "URL_Aceptacion_Web"),
    quoteAcceptanceAtField: toText(process.env.QUOTE_ACCEPTED_AT_FIELD || "Fecha_Hora_Cotizacion"),
    quoteTermsAcceptedField: toText(process.env.QUOTE_TERMS_ACCEPTED_FIELD || ""),
    quoteTermsVersionField: toText(process.env.QUOTE_TERMS_VERSION_FIELD || ""),
    quoteEmailVerifiedField: toText(process.env.QUOTE_EMAIL_VERIFIED_FIELD || ""),
    quoteEmailVerifiedAtField: toText(process.env.QUOTE_EMAIL_VERIFIED_AT_FIELD || ""),
    quoteHandoffStatusField: toText(process.env.QUOTE_HANDOFF_STATUS_FIELD || "Onboarding_Status"),
    quoteHandoffErrorField: toText(process.env.QUOTE_HANDOFF_ERROR_FIELD || ""),
    quoteOnboardingLookupField: toText(process.env.QUOTE_ONBOARDING_LOOKUP_FIELD || "Auto_Onboarding_Asociado"),
    quoteOnboardingUrlField: toText(process.env.QUOTE_ONBOARDING_URL_FIELD || "Onboarding_Link"),
    quoteOnboardingTokenField: toText(process.env.QUOTE_ONBOARDING_TOKEN_FIELD || "Onboarding_Token"),
    quoteOnboardingStatusPending: toText(
      process.env.QUOTE_ONBOARDING_STATUS_PENDING || "En Curso"
    ),
    quoteOnboardingStatusReady: toText(
      process.env.QUOTE_ONBOARDING_STATUS_READY || "Cerrada"
    ),
    quoteOnboardingStatusError: toText(
      process.env.QUOTE_ONBOARDING_STATUS_ERROR || "Error"
    ),
    contactEmailField: toText(process.env.QUOTE_CONTACT_EMAIL_FIELD || "Email_Cliente"),
    contactPhoneField: toText(process.env.QUOTE_CONTACT_PHONE_FIELD || "Telefono_Cliente"),
    billingEmailField: toText(process.env.QUOTE_BILLING_EMAIL_FIELD || "Email_Facturacion"),
    billingPhoneField: toText(process.env.QUOTE_BILLING_PHONE_FIELD || "Telefono_Facturacion"),
    companyRutField: toText(process.env.QUOTE_COMPANY_RUT_FIELD || "RUT_Cliente"),
    companyGiroField: toText(process.env.QUOTE_COMPANY_GIRO_FIELD || ""),
    companyComunaField: toText(process.env.QUOTE_COMPANY_COMUNA_FIELD || ""),
    companyAddressField: toText(process.env.QUOTE_COMPANY_ADDRESS_FIELD || ""),
    onboardingModule: toText(process.env.ZOHO_ONBOARDING_MODULE || "Autoservicio_Onboarding"),
    onboardingGenerateLinkUrl: toText(
      process.env.ONBOARDING_GENERATE_LINK_URL ||
        "https://v0-v0onboardingturnosmvp2main.vercel.app/api/generate-link"
    ),
    onboardingNameField: toText(process.env.ONBOARDING_NAME_FIELD || "Name"),
    onboardingDealLookupField: toText(process.env.ONBOARDING_DEAL_LOOKUP_FIELD || "Deal_asociado"),
    onboardingAccountLookupField: toText(
      process.env.ONBOARDING_ACCOUNT_LOOKUP_FIELD || "Account_asociada"
    ),
    onboardingExecutorContactLookupField: toText(
      process.env.ONBOARDING_EXECUTOR_CONTACT_LOOKUP_FIELD || "Contacto_Ejecutor"
    ),
    onboardingQuoteLookupField: toText(process.env.ONBOARDING_QUOTE_LOOKUP_FIELD || "Cotizacion_Asociada"),
    onboardingOriginAcceptanceIdField: toText(
      process.env.ONBOARDING_ORIGIN_ACCEPTANCE_ID_FIELD || "Origen_Aceptacion_Id"
    ),
    onboardingChannelField: toText(process.env.ONBOARDING_CHANNEL_FIELD || "Canal_Entrega_Link"),
    onboardingChannelValue: toText(process.env.ONBOARDING_CHANNEL_VALUE || "redirect_web"),
    onboardingHandoffStatusField: toText(process.env.ONBOARDING_HANDOFF_STATUS_FIELD || "Estado_Handoff"),
    onboardingHandoffErrorField: toText(process.env.ONBOARDING_HANDOFF_ERROR_FIELD || "Error_Handoff"),
    onboardingUrlField: toText(process.env.ONBOARDING_URL_FIELD || "URL_de_Onboarding"),
    onboardingTokenField: toText(process.env.ONBOARDING_TOKEN_FIELD || "Token_p_blico"),
    onboardingTokenActiveField: toText(process.env.ONBOARDING_TOKEN_ACTIVE_FIELD || "Token_Activo"),
    onboardingTokenDateField: toText(process.env.ONBOARDING_TOKEN_DATE_FIELD || "Fecha_generaci_n_token"),
    onboardingRazonSocialField: toText(process.env.ONBOARDING_RAZON_SOCIAL_FIELD || "Raz_n_social"),
    onboardingNombreFantasiaField: toText(process.env.ONBOARDING_NOMBRE_FANTASIA_FIELD || "Nombre_de_fantas_a"),
    onboardingRutField: toText(process.env.ONBOARDING_RUT_FIELD || "RUT"),
    onboardingGiroField: toText(process.env.ONBOARDING_GIRO_FIELD || "Giro"),
    onboardingDireccionField: toText(process.env.ONBOARDING_DIRECCION_FIELD || "Direcci_n"),
    onboardingComunaField: toText(process.env.ONBOARDING_COMUNA_FIELD || "Comuna"),
    onboardingEmailFacturacionField: toText(
      process.env.ONBOARDING_EMAIL_FACTURACION_FIELD || "Email_Facturaci_n"
    ),
    onboardingTelefonoContactoField: toText(
      process.env.ONBOARDING_TELEFONO_CONTACTO_FIELD || "Tel_fono_contacto"
    ),
    onboardingRubroField: toText(process.env.ONBOARDING_RUBRO_FIELD || "Rubro"),
    onboardingSistemasField: toText(
      process.env.ONBOARDING_SISTEMAS_FIELD || "Sistemas_contratados"
    ),
    onboardingModulosField: toText(
      process.env.ONBOARDING_MODULOS_FIELD || "Modulos_adicionales"
    ),
    termsVersion: toText(process.env.QUOTE_TERMS_VERSION || "TYC-CL-2026-04"),
    validityDays: toInt(process.env.QUOTE_ACCEPTANCE_VALIDITY_DAYS, 30),
    verificationCodeTtlMinutes: toInt(process.env.QUOTE_VERIFICATION_CODE_TTL_MINUTES, 10),
    verificationProofTtlMinutes: toInt(process.env.QUOTE_VERIFICATION_PROOF_TTL_MINUTES, 60),
    supportContactLabel: toText(
      process.env.QUOTE_SUPPORT_CONTACT_LABEL || "Soporte Comercial"
    ),
    supportContactEmail: toText(
      process.env.QUOTE_SUPPORT_CONTACT_EMAIL || "egomez@geovictoria.com"
    ),
    handoffWebhookUrl: toText(process.env.QUOTE_HANDOFF_WEBHOOK_URL),
    ndvHandoffEnabled:
      toText(process.env.NDV_HANDOFF_ENABLED || "true").toLowerCase() === "true",
    ndvHandoffMode: toText(process.env.NDV_HANDOFF_MODE || "blocking"),
    ndvCreatorFormStatusPending: toText(
      process.env.NDV_CREATOR_FORM_STATUS_PENDING || "CREATED"
    ),
    ndvCreatorStatusPending: toText(process.env.NDV_CREATOR_STATUS_PENDING || "CONFIRMADA"),
    ndvCreatorEstadoCotAccepted: toText(process.env.NDV_CREATOR_ESTADO_COT_ACCEPTED || "Vigente"),
    // Canal telemarketing (Vicky). Override sin deploy si cambia la política.
    ndvCreatorLineaNegocio: toText(process.env.NDV_CREATOR_LINEA_NEGOCIO || "Telemarketing"),
    quoteBillingContactLookupField: toText(
      process.env.QUOTE_BILLING_CONTACT_LOOKUP_FIELD || ""
    ),
    quoteNvdLookupField: toText(process.env.QUOTE_NDV_LOOKUP_FIELD || ""),
    quoteNvdIdTextField: toText(process.env.QUOTE_NDV_ID_FIELD || ""),
  };
}

module.exports = {
  getAcceptanceConfig,
};
