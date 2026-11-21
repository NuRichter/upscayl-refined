// Idle footprint bench. Launches an app build with extra Chromium switches on a
// prepared profile (onboarding dismissed), waits, then samples the whole
// process tree: working set, private bytes and CPU time.
// node idle_bench.mjs <exe> <label> [--switch ...]
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , exe, label, ...extra] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), "upscayl-idle-" + label.replace(/\W+/g, "_"));
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
const port = 9400 + Math.floor(Math.random() * 400);

function ps(script) {
  const enc = Buffer.from(script, "utf16le").toString("base64");
  return JSON.parse(execSync(`powershell -NoProfile -EncodedCommand ${enc}`, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }));
}

function sample(rootPid) {
  const all = ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress");
  const stats = new Map(
    ps("Get-Process | Select-Object Id,WorkingSet64,PrivateMemorySize64,@{n='Cpu';e={$_.TotalProcessorTime.TotalMilliseconds}} | ConvertTo-Json -Compress").map((p) => [p.Id, p]),
  );
  const ids = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); grew = true; }
  }
  let ws = 0, priv = 0, cpu = 0;
  const detail = [];
  for (const p of all.filter((p) => ids.has(p.ProcessId))) {
    const s = stats.get(p.ProcessId);
    if (!s) continue;
    ws += s.WorkingSet64; priv += s.PrivateMemorySize64; cpu += s.Cpu;
    const t = (p.CommandLine ?? "").match(/--type=([a-z-]+)/)?.[1] ?? "main";
    detail.push(`${t}:${Math.round(s.WorkingSet64 / 1048576)}`);
  }
  return { n: ids.size, ws, priv, cpu, detail: detail.join(" ") };
}

async function prepare() {
  const app = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...extra], { stdio: "ignore" });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch {}
    await sleep(500);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  await sleep(3000);
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `localStorage.setItem("showOnboarding","false"); localStorage.setItem("showNewsModal","false"); true` } }));
  await sleep(1500);
  ws.close();
  execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" });
  await sleep(2000);
}

await prepare();
const app = spawn(exe, [`--user-data-dir=${profile}`, ...extra], { stdio: "ignore" });
await sleep(25000);
const s0 = sample(app.pid);
const samples = [];
for (let i = 0; i < 5; i++) {
  await sleep(6000);
  samples.push(sample(app.pid));
}
const last = samples[samples.length - 1];
const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
const cpuPct = ((last.cpu - s0.cpu) / (30000 * os.cpus().length)) * 100;
const out = {
  label,
  extra: extra.join(" "),
  processes: last.n,
  workingSetMB: Math.round(avg("ws") / 1048576),
  privateMB: Math.round(avg("priv") / 1048576),
  idleCpuPct: +cpuPct.toFixed(3),
  detail: last.detail,
};
console.log(JSON.stringify(out));
execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" });
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
