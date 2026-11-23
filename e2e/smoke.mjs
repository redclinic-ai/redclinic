// Browser smoke test for a running RedClinic (local, staging or production).
// Creates a throwaway clinic, walks the first-day receptionist flow, and checks security headers.
//   BASE_URL=https://staging.example npm run smoke          (needs Playwright: npx playwright install chromium)
//   CHROME_PATH=/usr/bin/google-chrome to use an installed Chrome instead.
// On production, run only with SMOKE_ALLOW_PROD=1: it creates a clinic named "Smoke test …" that RedClinic should pause afterwards.
import { chromium } from "playwright";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
if (/redclinic\.ai/.test(BASE) && process.env.SMOKE_ALLOW_PROD !== "1") { console.error("Refusing to run against production without SMOKE_ALLOW_PROD=1"); process.exit(2); }
const stamp = Date.now();
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] } : {});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const health = await (await fetch(`${BASE}/api/health`)).json().catch(() => null);
  check("health endpoint", health?.ok === true, JSON.stringify(health?.checks ?? {}));
  const head = await fetch(`${BASE}/login`);
  check("security headers", !!head.headers.get("x-frame-options") && !!head.headers.get("x-content-type-options"), head.headers.get("content-security-policy") ? "CSP on" : "CSP off (fine outside production)");

  await page.goto(`${BASE}/signup`);
  await page.fill("#f-clinicName", `Smoke test ${stamp}`); await page.fill("#f-phone", "080 4000 0000");
  await page.fill("#f-adminName", "Smoke Admin"); await page.fill("#f-adminEmail", `smoke-${stamp}@example.test`);
  await page.fill("#f-password", "smoke test password"); await page.check("input[name=acceptTerms]");
  await page.click("main button[type=submit]"); await page.waitForURL(/\/home/, { timeout: 20000 });
  check("clinic sign-up", true);
  check("setup checklist shown", await page.locator(".setup").count() === 1);

  await page.goto(`${BASE}/settings/services`);
  await page.fill("#f-name", "Check-up"); await page.fill("#f-durationMinutes", "20"); await page.click("main button:has-text('Add')");
  await page.waitForSelector("text=Service added."); check("add a service", true);

  await page.goto(`${BASE}/patients/new`);
  await page.fill("#f-name", "Smoke Patient"); await page.fill("#f-phone", "98450 99999");
  await page.click("main button:has-text('Save'):not(:has-text('book'))"); await page.waitForURL(/\/patients\/[0-9a-f-]+\?ok=registered/);
  check("register a patient", true, await page.locator("h1").innerText());

  await page.goto(`${BASE}/calls/test`);
  await page.click("main button:has-text('Start test call')"); await page.waitForURL(/call=/);
  await page.fill("#text", "Do you have parking?"); await page.click("main button:has-text('Say')");
  await page.waitForFunction(() => document.querySelectorAll(".bubble").length >= 3, null, { timeout: 15000 });
  const firstLine = await page.locator(".bubble").first().innerText();
  check("test call: NEPA says it is an AI", /AI/.test(firstLine), firstLine.slice(0, 80));

  await page.goto(`${BASE}/results`); check("results page", (await page.locator("h1").innerText()) === "Results");
  await page.goto(`${BASE}/settings/billing`); check("plan page shows trial", /trial/i.test(await page.locator("main").innerText()));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("smoke run", false, e.message.split("\n")[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
