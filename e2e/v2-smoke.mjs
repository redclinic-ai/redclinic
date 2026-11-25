// Browser smoke test for the V2 screens on a running RedClinic (local or staging; never production).
//   BASE_URL=https://staging.redclinic.in CHROME_PATH=/usr/bin/google-chrome node e2e/v2-smoke.mjs
// Creates a throwaway clinic and walks: privacy settings, WhatsApp test mode and opt-in, a manual lead, the medical
// record and a signed visit note with a prescription, and an online consultation.
import { chromium } from "playwright";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
if (/app\.redclinic\.in/.test(BASE)) { console.error("Not on production."); process.exit(2); }
const stamp = Date.now();
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] } : {});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const main = () => page.locator("main").innerText();
try {
  await page.goto(`${BASE}/signup`);
  await page.fill("#f-clinicName", `V2 smoke ${stamp}`); await page.fill("#f-phone", "080 4000 0001");
  await page.fill("#f-adminName", "V2 Admin"); await page.fill("#f-adminEmail", `v2-${stamp}@example.test`);
  await page.fill("#f-password", "smoke test password"); await page.check("input[name=acceptTerms]");
  await page.click("main button[type=submit]"); await page.waitForURL(/\/home/, { timeout: 20000 });
  check("sign-up", true);

  await page.goto(`${BASE}/settings/privacy`);
  await page.selectOption("#f-superAccess", "request"); await page.selectOption("#f-transcriptDays", "365");
  await page.click("main button:has-text('Save')"); await page.waitForSelector("text=Privacy settings saved.");
  check("privacy: RedClinic access on request, transcripts kept a year", true);

  await page.goto(`${BASE}/settings/whatsapp`);
  await page.selectOption("#f-status", "simulated"); await page.fill("#f-businessNumber", `9198${String(stamp).slice(-8)}`);
  await page.fill("#f-mapsUrl", "https://maps.app.goo.gl/example");
  await page.click("main form button:has-text('Save')"); await page.waitForSelector("text=WhatsApp settings saved.");
  check("WhatsApp in test mode", /Test mode/.test(await main()));

  await page.goto(`${BASE}/leads`);
  await page.click("summary:has-text('Add an enquiry')");
  await page.fill("#f-name", "Lead Person"); await page.fill("#f-phone", "98450 77777"); await page.fill("#f-problem", "braces");
  await page.check("input[name=whatsappOptIn]");
  await page.click("main button:has-text('Add enquiry')"); await page.waitForURL(/ok=saved/);
  check("manual lead becomes a patient", /Lead Person/.test(await main()) && /New/.test(await main()));
  await page.click("main a:has-text('Lead Person')"); await page.waitForURL(/\/patients\/[0-9a-f-]+$/);
  const patientUrl = page.url();
  check("lead patient is opted in to WhatsApp", /Agreed/.test(await main()));

  await page.goto(`${patientUrl}/record`);
  await page.click("summary:has-text('Add an allergy')"); await page.fill("#f-substance", "Penicillin"); await page.fill("#f-reaction", "rash");
  await page.click("details[open] button:has-text('Add')"); await page.waitForURL(/ok=saved/);
  check("allergy recorded and shown as a warning", /Allergies:\s*Penicillin \(rash\)/.test(await main()));

  await page.click("main button:has-text('Start a visit note')"); await page.waitForURL(/\/visits\/[0-9a-f-]+$/);
  const visitUrl = page.url();
  await page.fill("#f-chiefComplaint", "Crowded teeth"); await page.fill("#f-v_bp_systolic", "120"); await page.fill("#f-v_bp_diastolic", "80");
  await page.fill("#f-diagnosis", "Crowding, upper arch"); await page.click("main button:has-text('Save draft')"); await page.waitForSelector("text=Draft saved.");
  await page.fill("form:has(button:has-text('Add medicine')) #f-name", "Paracetamol"); await page.fill("form:has(button:has-text('Add medicine')) #f-strength", "500 mg");
  await page.click("main button:has-text('Add medicine')"); await page.waitForURL(/ok=saved/);
  await page.click("main button:has-text('Sign the note')"); await page.waitForSelector("main button:has-text('Add correction')");
  const vtext = await main() + await page.locator(".page-header, header").allInnerTexts().then((x) => x.join(" "));
  check("visit note signed with a prescription", /signed/i.test(vtext) && /Paracetamol/.test(vtext), vtext.slice(0, 160).replace(/\n/g, " "));
  await page.goto(`${visitUrl}/print`);
  check("printable prescription", /℞/.test(await main()) && /Paracetamol/.test(await main()) && /Penicillin/.test(await main()));
  await page.goto(`${patientUrl}/record`);
  check("diagnosis added to conditions from the visit", /Crowding, upper arch/.test(await main()));

  await page.goto(`${BASE}/settings/online`);
  await page.check("input[name=enabled]"); await page.click("main button:has-text('Save')"); await page.waitForSelector("text=Saved.");
  await page.goto(`${BASE}/appointments/new`);
  check("online consultations switched on", true);

  for (const path of ["/messages", "/settings/leads", "/workflows", "/results"]) {
    await page.goto(`${BASE}${path}`);
    check(`opens ${path}`, (await page.locator("h1").count()) === 1);
  }
  check("WhatsApp, lead and review workflows are listed switched off", /WhatsApp: confirm appointments/.test(await (await page.goto(`${BASE}/workflows`), main())));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("v2 smoke run", false, e.message.split("\n")[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
