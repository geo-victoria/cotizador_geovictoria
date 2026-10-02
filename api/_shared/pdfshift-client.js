/**
 * Render de HTML -> PDF (Buffer).
 *
 * Por defecto usa **Chromium** (puppeteer-core + @sparticuz/chromium), que no
 * tiene costo por documento. Si Chromium falla por cualquier motivo, cae de
 * forma automatica a **PDFShift** (si hay API key), de modo que la generacion
 * de PDF nunca se rompe durante la migracion.
 *
 * Control por entorno:
 *   - PDF_RENDERER = "chromium" (default) | "pdfshift"
 *   - PUPPETEER_EXECUTABLE_PATH = ruta a Chrome local (solo para dev local)
 *   - PDFSHIFT_API_KEY = credencial PDFShift (respaldo / modo pdfshift)
 *   - PDFSHIFT_SANDBOX = "true" => PDF con marca de agua, sin gastar creditos
 *
 * La firma `htmlToPdfBuffer(html, options) -> Promise<Buffer>` se mantiene
 * identica a la anterior, por lo que ningun llamador necesita cambios.
 */

function marginToObject(margin) {
  const value = margin === undefined || margin === null ? "20mm" : String(margin);
  return { top: value, bottom: value, left: value, right: value };
}

// ── Render con Chromium (sin costo por PDF) ───────────────────────────────
async function renderWithChromium(html, options = {}) {
  // require perezoso: solo se carga si efectivamente usamos Chromium.
  // Antes del require: Node 24 es AL2023 (ver chromium-runtime.js).
  require("./chromium-runtime").prepararEntornoChromium();
  const chromium = require("@sparticuz/chromium");
  const puppeteer = require("puppeteer-core");
  const path = require("path");

  const localExecutable = String(process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();

  if (!localExecutable) {
    // Sin GPU/swiftshader: más liviano y evita libs extra en serverless.
    try { chromium.setGraphicsMode = false; } catch (_e) {}
  }

  const executablePath = localExecutable || (await chromium.executablePath());

  if (!localExecutable) {
    // CRÍTICO en Vercel/Lambda (AL2023): que el loader encuentre libnss3.so y
    // demás librerías que @sparticuz extrae junto al binario.
    try {
      process.env.LD_LIBRARY_PATH = [path.dirname(executablePath), process.env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(":");
    } catch (_e) {}
  }

  const browser = await puppeteer.launch({
    args: localExecutable ? ["--no-sandbox", "--disable-setuid-sandbox"] : chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    // PDFShift usa media "screen" por defecto (use_print=false): replicamos.
    await page.emulateMediaType("screen");
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: options.format || "Letter",
      landscape: options.landscape === true,
      printBackground: true,
      margin: marginToObject(options.margin),
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── Render con PDFShift (respaldo / modo legacy) ──────────────────────────
async function renderWithPdfShift(html, options = {}) {
  const apiKey = String(process.env.PDFSHIFT_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Falta PDFSHIFT_API_KEY en environment variables");
  }

  // Sandbox = true genera PDF con marca de agua sin gastar creditos (pruebas).
  const isSandbox = options.sandbox === true || process.env.PDFSHIFT_SANDBOX === "true";

  const body = {
    source: html,
    format: options.format || "Letter",
    margin: options.margin || "20mm",
    landscape: options.landscape === true,
    use_print: options.use_print === true,
    delay: typeof options.delay === "number" ? options.delay : 0,
    timeout: typeof options.timeout === "number" ? options.timeout : 30,
    sandbox: isSandbox,
  };

  let response;
  try {
    response = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`PDFShift network error: ${err?.message || String(err)}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`PDFShift HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Dispatcher ────────────────────────────────────────────────────────────
async function htmlToPdfBuffer(html, options = {}) {
  if (!html || typeof html !== "string") {
    throw new Error("htmlToPdfBuffer requiere un HTML string como primer argumento");
  }

  const renderer = String(process.env.PDF_RENDERER || "chromium").toLowerCase();

  if (renderer === "pdfshift") {
    return renderWithPdfShift(html, options);
  }

  try {
    return await renderWithChromium(html, options);
  } catch (chromiumError) {
    // Respaldo: si hay PDFShift configurado, no rompemos la generacion de PDF.
    if (String(process.env.PDFSHIFT_API_KEY || "").trim()) {
      console.error(
        "[pdf] Chromium fallo, usando PDFShift como respaldo:",
        chromiumError?.message || chromiumError
      );
      return renderWithPdfShift(html, options);
    }
    throw chromiumError;
  }
}

module.exports = { htmlToPdfBuffer, renderWithChromium, renderWithPdfShift };
