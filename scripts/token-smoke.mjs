// Live screenshots of the three fizzl homepages (desktop and mobile).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const pages = {
  presign: "https://presign-guard.onrender.com/",
  ichimoku: "https://ichimoku-signal.onrender.com/",
  doctor: "https://x402-doctor.onrender.com/",
};
mkdirSync("research/shots", { recursive: true });
const browser = await chromium.launch();
for (const [name, url] of Object.entries(pages)) {
  for (const [kind, opts] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["mobile", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true }]]) {
    const page = await browser.newPage({ ...opts, colorScheme: "dark" });
    await page.goto(url, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => console.log(name, kind, String(e)));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `research/shots/${name}-${kind}.png`, fullPage: kind === "desktop" });
    console.log("shot", name, kind);
    await page.close();
  }
}
await browser.close();
