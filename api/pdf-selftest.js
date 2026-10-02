// Diagnóstico aislado del render Chromium (@sparticuz/chromium + puppeteer-core).
// Hitéalo en: /api/pdf-selftest   → devuelve JSON con el paso que falla y el error completo.
// Es temporal: puedes borrarlo una vez resuelto.
export default async function handler(req, res) {
  const out = { ok: false, node: process.version, steps: {} };
  try {
    out.awsExecutionEnv = process.env.AWS_EXECUTION_ENV || null;
    require("./_shared/chromium-runtime").prepararEntornoChromium();
    out.awsExecutionEnvAjustado = process.env.AWS_EXECUTION_ENV || null;
    const chromium = require("@sparticuz/chromium");
    out.steps.requireChromium = true;
    const puppeteer = require("puppeteer-core");
    out.steps.requirePuppeteer = true;
    const path = require("path");

    try { chromium.setGraphicsMode = false; } catch (_e) {}

    out.steps.headless = chromium.headless;
    out.steps.argsCount = Array.isArray(chromium.args) ? chromium.args.length : null;

    const execPath = await chromium.executablePath();
    out.steps.executablePath = execPath;

    // CRÍTICO: que el loader encuentre libnss3.so (libs extraídas junto al binario).
    process.env.LD_LIBRARY_PATH = [path.dirname(execPath), process.env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":");
    out.steps.ldLibraryPath = process.env.LD_LIBRARY_PATH;

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: execPath,
      headless: chromium.headless,
    });
    out.steps.launched = true;

    const page = await browser.newPage();
    await page.setContent("<h1>pdf-selftest ok</h1>");
    const pdf = await page.pdf({ format: "Letter", printBackground: true });
    out.steps.pdfBytes = pdf.length;
    await browser.close();
    out.ok = true;
  } catch (e) {
    out.error = String((e && e.stack) || (e && e.message) || e);
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(out, null, 2));
}
