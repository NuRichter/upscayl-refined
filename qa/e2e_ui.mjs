// UI-level flows: real drag-and-drop (CDP), button click, result viewer,
// clipboard paste. node e2e_ui.mjs <exe> <outDir>
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , exe, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "upscayl-ui-"));
const port = 9355;
const app = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${info}`);
};

let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
  await sleep(500);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiters = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); waiters.get(msg.id)?.(msg); waiters.delete(msg.id); };
const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => fs.writeFileSync(path.join(outDir, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await evaluate(expr); if (v) return v; await sleep(400); } return null; };

await cdp("Page.enable");
await sleep(3000);
await evaluate(`
  localStorage.setItem("showOnboarding","false");
  localStorage.setItem("savedOutputPath", ${JSON.stringify(JSON.stringify(outDir))});
  localStorage.setItem("rememberOutputFolder","true");
  localStorage.setItem("selectedModelId", JSON.stringify("refined-nerve-4x"));
  location.reload(); true`);
await sleep(3500);

const ver = await evaluate(`document.body.innerText.match(/Upscayl v([0-9.]+)/)?.[1] ?? null`);
record("version label", ver === "3.0.0", String(ver));

// --- drag and drop a real file -------------------------------------------------
const art = process.env.QA_ART ?? path.resolve("data/lr/clean/kodim23.png");
const at = { x: 1000, y: 500 };
for (const type of ["dragEnter", "dragOver", "drop"]) {
  await cdp("Input.dispatchDragEvent", { type, ...at, data: { items: [{ mimeType: "image/jpeg", data: "" }], files: [art], dragOperationsMask: 1 } });
  await sleep(150);
}
const shown = await until(`[...document.images].some(i => i.src.startsWith("media:") && i.complete && i.naturalWidth === 1200)`, 8000);
record("drag-and-drop loads image (webUtils path)", !!shown);

// --- click the Upscayl button --------------------------------------------------
const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll("button")].find(b => /^Upscayl/.test(b.innerText.trim()) && b.className.includes("btn-secondary")); if (!b) return false; b.click(); return true; })()`);
record("click Upscayl button", clicked);
const result = await until(`[...document.images].find(i => i.src.includes("_upscayl_") && i.complete && i.naturalWidth > 0)?.naturalWidth`, 60000);
record("result shown in viewer", result === 4800, String(result));
await sleep(1000);
await shot("ui_result_view.png");

// --- clipboard paste ---------------------------------------------------------
const clipB64 = fs.readFileSync(path.resolve("data/lr/clean/kodim23.png")).toString("base64");
const pasted = await evaluate(`(async () => {
  try {
    const bytes = Uint8Array.from(atob(${JSON.stringify(clipB64)}), (c) => c.charCodeAt(0)).buffer;
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "clip.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return "ok " + bytes.byteLength + " files=" + ev.clipboardData?.files?.length;
  } catch (e) { return "ERR " + e; }
})()`);
const pastedShown = await until(`[...document.images].some(i => i.src.includes(".temp-") && i.complete && i.naturalWidth === 192)`, 8000);
record("clipboard paste saved + shown", !!pastedShown, `${pasted} bytes`);
const temps = fs.readdirSync(outDir).filter((f) => f.startsWith(".temp-"));
record("paste wrote file into output folder", temps.length >= 1, temps.join(","));

fs.writeFileSync(path.join(outDir, "e2e_ui_results.json"), JSON.stringify(results, null, 2));
ws.close();
try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" }); } catch {}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
