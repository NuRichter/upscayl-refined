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
};

let child: UtilityProcess | null = null;
let ready: Promise<void> | null = null;
const pending = new Map<string, Pending>();
let keepWarmSec = 45;
let seq = 0;

function spawn(): Promise<void> {
  if (child && ready) return ready;
  const entry = path.join(__dirname, "..", "engine", "worker.js");
  child = utilityProcess.fork(entry, [], {
    serviceName: "Upscayl Refined Engine",
    stdio: "pipe",
  });
  child.stdout?.on("data", (d) => logit("🧠 engine:", d.toString().trim()));
  child.stderr?.on("data", (d) => logit("🧠 engine!", d.toString().trim()));
  ready = new Promise((resolve) => {
    child!.on("message", (msg: WorkerResponse) => {
      switch (msg.type) {
        case "ready":
          logit(`🧠 Refined engine up (pid ${msg.pid})`);
          child!.postMessage({ type: "config", keepWarmSec } satisfies WorkerRequest);
          resolve();
          break;
        case "progress":
          pending.get(msg.id)?.onProgress(msg.pct, msg.stage, msg.detail);
          break;
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
          break;
      }
    });
  });
  child.on("exit", (code) => {
    logit(`🧠 Refined engine exited (${code})`);
    child = null;
    ready = null;
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new Error(code === 0 ? "cancelled" : `Engine process stopped unexpectedly (code ${code}).`));
    }
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
    pending.set(id, { onProgress, resolve, reject });
  });
  child!.postMessage({ type: "job", id, job, manifest } satisfies WorkerRequest);
  return { id, done };
}

export function cancelRefined(id?: string) {
  if (!child) return;
  const ids = id ? [id] : [...pending.keys()];
  for (const i of ids) child.postMessage({ type: "cancel", id: i } satisfies WorkerRequest);
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
