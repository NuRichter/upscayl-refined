// End-to-end check of the packaged app through the Chrome DevTools Protocol.
// node e2e.mjs <exe> <outDir>
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const [, , exe, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "upscayl-e2e-"));
const port = 9333;
const app = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${info}`);
};

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("file:"));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("no page target");
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiters = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiters.has(msg.id)) {
    waiters.get(msg.id)(msg);
    waiters.delete(msg.id);
  }
};
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    waiters.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, "base64"));
};

function tree(rootPid) {
  const raw = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress"`,
    { encoding: "utf8", maxBuffer: 64 << 20 },
  );
  const all = JSON.parse(raw);
  const ids = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); grew = true; }
  }
  const procs = all.filter((p) => ids.has(p.ProcessId));
  const label = (c = "") => (c.match(/--type=([a-z-]+)/)?.[1] ?? "main") + (/utility-sub-type=node/.test(c) || /Refined Engine/.test(c) ? ":engine" : "");
  return {
    count: procs.length,
    mb: Math.round(procs.reduce((a, p) => a + p.WorkingSetSize, 0) / 1048576),
    detail: procs.map((p) => `${label(p.CommandLine ?? "")}:${Math.round(p.WorkingSetSize / 1048576)}`).join(", "),
    hasEngine: procs.some((p) => /utility-sub-type=node/.test(p.CommandLine ?? "")),
  };
}

await cdp("Runtime.enable");
await cdp("Page.enable");
await sleep(4000);

// --- UI loads -------------------------------------------------------------
const title = await evaluate("document.title");
record("window title", title === "Upscayl Refined", title);
await evaluate(`localStorage.setItem("showOnboarding","false"); location.reload(); true`);
await sleep(3000);
const ui = await evaluate(`({
  model: [...document.querySelectorAll("button")].map(b=>b.innerText).find(t=>/Refined Auto/.test(t)) || null,
  detail: !!document.querySelector('input[type=range]'),
  header: document.body.innerText.includes("NuRichter"),
  noTelemetry: !("posthog" in window) && !document.querySelector('iframe'),
})`);
record("default model is Refined Auto", !!ui.model, ui.model ?? "");
record("detail slider visible", ui.detail);
record("edition shown in header", ui.header);
record("no analytics or embeds", ui.noTelemetry);
await shot("ui_main.png");

// --- idle footprint (no engine) ---------------------------------------------
await sleep(20000);
const idle1 = tree(app.pid);
record("idle: engine not running", !idle1.hasEngine, `${idle1.count} procs ${idle1.mb} MB (${idle1.detail})`);

// listeners
await evaluate(`
  window.__ev = [];
  const C = ${JSON.stringify({
    done: "Upscaling Done", err: "Upscaling Error", prog: "Send Progress from Main to Renderer",
    fdone: "Folder upscaling successful", fprog: "Send Folder Upscaling Progress from Main to Renderer",
    ddone: "Double Upscaling Done", dprog: "Send Double Upscayl Progress from Main to Renderer",
    dlp: "Refined model download progress",
  })};
  for (const [k, v] of Object.entries(C)) window.electron.on(v, (_e, d) => window.__ev.push([k, d]));
  true`);
const waitFor = async (kinds, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ev = await evaluate("window.__ev");
    const hit = ev.find(([k]) => kinds.includes(k));
    if (hit) return { hit, ev };
    await sleep(500);
  }
  return { hit: null, ev: await evaluate("window.__ev") };
};
const clear = () => evaluate("window.__ev.length = 0; true");

const base = (img, model, extra = {}) => ({
  imagePath: img, outputPath: outDir, scale: "4", model, gpuId: null, saveImageAs: "png",
  overwrite: true, noImageProcessing: false, compression: "0", customWidth: null, useCustomWidth: false,
  tileSize: null, ttaMode: false, copyMetadata: false, refined: { detail: -1, chromaLock: true, backend: "auto" }, ...extra,
});
const ART = process.env.QA_ART ?? path.resolve("data/lr/clean/kodim23.png");
const PHOTO = process.env.QA_PHOTO ?? path.resolve("data/hr/kodak/kodim01.png");

// --- single image, Refined Auto (+ metadata copy) ------------------------------
await clear();
let t0 = Date.now();
await evaluate(`window.electron.send("Upscale the Image", ${JSON.stringify(base(ART, "refined-auto", { copyMetadata: true }))}); true`);
let r = await waitFor(["done", "err"], 180000);
let progressCount = r.ev.filter(([k]) => k === "prog").length;
record("refined auto single", r.hit?.[0] === "done" && fs.existsSync(r.hit[1]), `${Date.now() - t0} ms, ${progressCount} progress events, ${r.hit?.[1] ?? JSON.stringify(r.hit)}`);
const during = tree(app.pid);
record("engine process spawned on demand", during.hasEngine, `${during.count} procs ${during.mb} MB`);
await shot("ui_after_auto.png");

// --- classic engine still works ---------------------------------------------
await clear();
t0 = Date.now();
await evaluate(`window.electron.send("Upscale the Image", ${JSON.stringify(base(ART, "upscayl-standard-4x"))}); true`);
r = await waitFor(["done", "err"], 180000);
record("classic engine single", r.hit?.[0] === "done" && fs.existsSync(r.hit[1]), `${Date.now() - t0} ms`);

// --- batch with NERVE ---------------------------------------------------------
const batchDir = path.join(outDir, "batch_in");
fs.mkdirSync(batchDir, { recursive: true });
for (const f of ["kodim01.png", "kodim05.png", "kodim23.png"]) fs.copyFileSync(path.join("data", "lr", "web", f), path.join(batchDir, f));
await clear();
t0 = Date.now();
await evaluate(`window.electron.send("Upscale a Folder", ${JSON.stringify({ ...base(null, "refined-nerve-4x"), batchFolderPath: batchDir, outputPath: outDir })}); true`);
r = await waitFor(["fdone", "err"], 180000);
const bdir = r.hit?.[1];
const bcount = bdir && fs.existsSync(bdir) ? fs.readdirSync(bdir).length : 0;
record("refined batch (3 files)", r.hit?.[0] === "fdone" && bcount === 3, `${Date.now() - t0} ms, ${bcount} files in ${bdir}`);

// --- double upscayl with PULSE + custom width ---------------------------------
await clear();
t0 = Date.now();
await evaluate(`window.electron.send("Double Upscale the Image", ${JSON.stringify(base(path.resolve("data/lr/clean/kodim05.png"), "refined-pulse-4x"))}); true`);
r = await waitFor(["ddone", "err"], 180000);
let dims = "";
if (r.hit?.[0] === "ddone") {
  const sharp = createRequire(path.resolve("../package.json"))("sharp");
  const m = await sharp(r.hit[1]).metadata();
  dims = `${m.width}x${m.height}`;
}
record("refined double upscayl = 16x", dims === "3072x2048", dims);

// --- model manager: real download + checksum ----------------------------------
const before = await evaluate(`window.electron.invoke("Refined models status")`);
const lite = before.find((m) => m.id === "ultrasharp-v2-lite-4x");
record("status lists all models", before.length === 7, before.map((m) => `${m.id}:${m.installed ? "Y" : "n"}`).join(" "));
t0 = Date.now();
const dl = await evaluate(`window.electron.invoke("Refined model download", "ultrasharp-v2-lite-4x")`);
const after = await evaluate(`window.electron.invoke("Refined models status")`);
record("download + sha256 verify", dl?.ok && after.find((m) => m.id === "ultrasharp-v2-lite-4x").installed && !lite.installed, `${Date.now() - t0} ms ${JSON.stringify(dl)}`);
await clear();
await evaluate(`window.electron.send("Upscale the Image", ${JSON.stringify(base(path.resolve("data/lr/web/kodim23.png"), "ultrasharp-v2-lite-4x"))}); true`);
r = await waitFor(["done", "err"], 120000);
record("downloaded model runs (fp16 I/O)", r.hit?.[0] === "done", JSON.stringify(r.hit).slice(0, 160));

// --- stop mid-job on the 12 MP photo -----------------------------------------
await clear();
await evaluate(`window.electron.send("Upscale the Image", ${JSON.stringify(base(PHOTO, "refined-heart-4x"))}); true`);
await sleep(8000);
await evaluate(`window.electron.send("Stop the current operation", null); true`);
r = await waitFor(["done", "err"], 15000);
const progAfterStop = r.ev.filter(([k]) => k === "prog").length;
await sleep(3000);
const evLater = (await evaluate("window.__ev")).filter(([k]) => k === "prog").length;
record("stop cancels refined job", !r.hit && evLater === progAfterStop, `events ${progAfterStop} -> ${evLater}, ${JSON.stringify(r.hit)}`);

// --- engine releases itself when idle -----------------------------------------
await evaluate(`window.electron.send("Refined engine config", { keepWarmSec: 5 }); true`);
await sleep(12000);
const idle2 = tree(app.pid);
record("engine exits after keep-warm", !idle2.hasEngine, `${idle2.count} procs ${idle2.mb} MB (${idle2.detail})`);

fs.writeFileSync(path.join(outDir, "e2e_results.json"), JSON.stringify({ results, idle1, during, idle2 }, null, 2));
ws.close();
try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" }); } catch {}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
