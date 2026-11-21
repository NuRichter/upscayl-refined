import { app, utilityProcess, type UtilityProcess } from "electron";
import path from "path";
import type {
  JobOptions,
  JobStats,
  ModelManifestEntry,
  WorkerRequest,
  WorkerResponse,
} from "../engine/types";
import logit from "./logit";

type Pending = {
  onProgress: (pct: number, stage: string, detail?: string) => void;
  resolve: (s: JobStats) => void;
  reject: (e: Error) => void;
  lastSeen: number;
};

/** No message from a running job for this long means the GPU driver hung. */
const STALL_MS = 300_000;
/** A cancelled job must answer within this window or the engine is replaced. */
const CANCEL_GRACE_MS = 5_000;

let child: UtilityProcess | null = null;
let ready: Promise<void> | null = null;
const pending = new Map<string, Pending>();
let keepWarmSec = 45;
let seq = 0;
let watchdog: NodeJS.Timeout | null = null;

/**
 * Forget the current engine without waiting for its exit event. On a GPU
 * driver hang the process can stay half-dead in the kernel; the next job
 * must not queue behind it.
 */
function detach(reason: string, kill: boolean) {
  const c = child;
  child = null;
  ready = null;
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error(reason));
  }
  if (kill) {
    try {
      c?.kill();
    } catch {
      /* already gone */
    }
  }
}

function armWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!pending.size) {
      clearInterval(watchdog!);
      watchdog = null;
      return;
    }
    const now = Date.now();
    for (const p of pending.values()) {
      if (now - p.lastSeen > STALL_MS) {
        logit("🧠 Refined engine stopped responding; starting a fresh one next time");
        detach("The engine stopped responding (GPU driver). Please try again.", true);
        return;
      }
    }
  }, 5000);
}

function spawn(): Promise<void> {
  if (child && ready) return ready;
  const entry = path.join(__dirname, "..", "engine", "worker.js");
  const proc = utilityProcess.fork(entry, [], {
    serviceName: "Upscayl Refined Engine",
    stdio: "pipe",
  });
  child = proc;
  proc.stdout?.on("data", (d) => logit("🧠 engine:", d.toString().trim()));
  proc.stderr?.on("data", (d) => logit("🧠 engine!", d.toString().trim()));
  ready = new Promise((resolve) => {
    proc.on("message", (msg: WorkerResponse) => {
      switch (msg.type) {
        case "ready":
          logit(`🧠 Refined engine up (pid ${msg.pid})`);
          proc.postMessage({ type: "config", keepWarmSec } satisfies WorkerRequest);
          resolve();
          break;
        case "progress": {
          const p = pending.get(msg.id);
          if (p) {
            p.lastSeen = Date.now();
            p.onProgress(msg.pct, msg.stage, msg.detail);
          }
          break;
        }
        case "log":
          logit("🧠", msg.message);
          break;
        case "done": {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          p?.resolve(msg.stats);
          break;
        }
        case "error": {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          p?.reject(new Error(msg.message));
          break;
        }
        case "idle-exit":
          logit("🧠 Refined engine released (idle)");
          // do not wait for the exit event; a new job gets a new engine
          if (child === proc) detach("engine idle", false);
          break;
      }
    });
  });
  proc.on("exit", (code) => {
    logit(`🧠 Refined engine exited (${code})`);
    if (child !== proc) return;
    detach(code === 0 ? "cancelled" : `Engine process stopped unexpectedly (code ${code}).`, false);
  });
  return ready;
}

export function setKeepWarm(sec: number) {
  keepWarmSec = sec;
  child?.postMessage({ type: "config", keepWarmSec } satisfies WorkerRequest);
}

export async function runRefinedJob(
  job: JobOptions,
  manifest: ModelManifestEntry[],
  onProgress: Pending["onProgress"],
): Promise<{ id: string; done: Promise<JobStats> }> {
  await spawn();
  const id = `job-${Date.now()}-${++seq}`;
  const done = new Promise<JobStats>((resolve, reject) => {
    pending.set(id, { onProgress, resolve, reject, lastSeen: Date.now() });
  });
  child!.postMessage({ type: "job", id, job, manifest } satisfies WorkerRequest);
  armWatchdog();
  return { id, done };
}

export function cancelRefined(id?: string) {
  if (!child) return;
  const ids = id ? [id] : [...pending.keys()];
  const c = child;
  for (const i of ids) c.postMessage({ type: "cancel", id: i } satisfies WorkerRequest);
  // a hung engine never answers the cancel; replace it
  setTimeout(() => {
    if (child === c && ids.some((i) => pending.has(i))) {
      logit("🧠 Engine did not stop in time; replacing it");
      detach("cancelled", true);
    }
  }, CANCEL_GRACE_MS);
}

export function isEngineRunning() {
  return !!child;
}

app.on("before-quit", () => {
  try {
    child?.postMessage({ type: "shutdown" } satisfies WorkerRequest);
    child?.kill();
  } catch {
    /* ignore */
  }
});
