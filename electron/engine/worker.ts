/**
 * Engine process entry (Electron utilityProcess).
 *
 * Lifecycle: spawned on the first Refined job, keeps its ONNX sessions warm
 * for `keepWarmSec` after the last job, then exits so an idle app holds no
 * GPU memory, no ONNX Runtime and no libvips.
 */
import { analyzeFile, runJob } from "./pipeline";
import { releaseAll } from "./session-pool";
import type { WorkerRequest, WorkerResponse } from "./types";

const port: any = (process as any).parentPort;
let keepWarmSec = 45;
let idleTimer: NodeJS.Timeout | null = null;
let busy = 0;
const cancelled = new Set<string>();
const queue: WorkerRequest[] = [];
let draining = false;

function send(msg: WorkerResponse) {
  port?.postMessage(msg);
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (busy > 0 || queue.length) return armIdle();
    await releaseAll();
    send({ type: "idle-exit" });
    setTimeout(() => process.exit(0), 50);
  }, keepWarmSec * 1000);
}

async function handle(req: WorkerRequest) {
  if (req.type === "job") {
    busy++;
    try {
      let lastPct = -1;
      const stats = await runJob(
        req.job,
        req.manifest,
        (p) => {
          const pct = Math.round(p.pct * 100) / 100;
          if (pct - lastPct >= 0.5 || p.stage !== "upscale") {
            lastPct = pct;
            send({ type: "progress", id: req.id, pct, stage: p.stage, detail: p.detail });
          }
        },
        () => cancelled.has(req.id),
        (m) => send({ type: "log", message: m }),
      );
      send({ type: "done", id: req.id, output: req.job.output, stats });
    } catch (e: any) {
      send({ type: "error", id: req.id, message: cancelled.has(req.id) ? "cancelled" : String(e?.message ?? e) });
    } finally {
      cancelled.delete(req.id);
      busy--;
    }
  } else if (req.type === "analyze") {
    try {
      send({ type: "analysis", id: req.id, analysis: await analyzeFile(req.input) });
    } catch (e: any) {
      send({ type: "error", id: req.id, message: String(e?.message ?? e) });
    }
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const req = queue.shift()!;
    await handle(req);
  }
  draining = false;
  armIdle();
}

port?.on("message", (e: { data: WorkerRequest }) => {
  const req = e.data;
  if (req.type === "cancel") {
    cancelled.add(req.id);
    // drop queued jobs with that id too
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i] as any;
      if (q.id === req.id) queue.splice(i, 1);
    }
    return;
  }
  if (req.type === "config") {
    keepWarmSec = Math.max(5, Math.min(600, req.keepWarmSec));
    armIdle();
    return;
  }
  if (req.type === "shutdown") {
    releaseAll().finally(() => process.exit(0));
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  queue.push(req);
  void drain();
});

process.on("uncaughtException", (e) => send({ type: "log", message: `uncaught: ${e?.stack ?? e}` }));
send({ type: "ready", pid: process.pid });
armIdle();
