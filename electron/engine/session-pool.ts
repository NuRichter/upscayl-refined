import type { InferenceSession } from "onnxruntime-node";
import type { ExecutionProvider } from "./types";

type Ort = typeof import("onnxruntime-node");
let ortModule: Ort | null = null;

/**
 * onnxruntime-node is imported on first use only. Node >= 26 and recent
 * Electron expose a native Float16Array that the ORT N-API binding does not
 * recognise yet (float16 tensors arrive with 0 bytes). All forged models use
 * float32 I/O, and for third-party fp16-I/O graphs we fall back to the
 * Uint16Array code path by hiding Float16Array before ORT initialises.
 */
export function getOrt(): Ort {
  if (!ortModule) {
    const g = globalThis as any;
    if (typeof g.Float16Array !== "undefined") {
      g.__nativeFloat16Array = g.Float16Array;
      delete g.Float16Array;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ortModule = require("onnxruntime-node") as Ort;
  }
  return ortModule;
}

export type PooledSession = {
  key: string;
  session: InferenceSession;
  ep: ExecutionProvider;
  inputName: string;
  outputName: string;
  inputType: string;
  extraInputs: Set<string>;
  lastUsed: number;
};

const pool = new Map<string, PooledSession>();
const MAX_SESSIONS = 2;

function providerOptions(ep: ExecutionProvider, gpuId: number) {
  if (ep === "dml") return [{ name: "dml", deviceId: gpuId }] as any;
  if (ep === "webgpu") return [{ name: "webgpu" }] as any;
  return ["cpu"];
}

/**
 * Open (or reuse) a session, walking the provider list until one works.
 * DML needs sequential execution and no memory pattern.
 */
export async function getSession(
  modelPath: string,
  providers: ExecutionProvider[],
  gpuId: number,
  log: (m: string) => void,
): Promise<PooledSession> {
  const ort = getOrt();
  for (const ep of providers) {
    const key = `${modelPath}|${ep}|${gpuId}`;
    const hit = pool.get(key);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit;
    }
  }
  let lastErr: unknown = null;
  for (const ep of providers) {
    const key = `${modelPath}|${ep}|${gpuId}`;
    try {
      const t0 = Date.now();
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: providerOptions(ep, gpuId),
        graphOptimizationLevel: "all",
        executionMode: "sequential",
        enableMemPattern: ep === "cpu",
        enableCpuMemArena: ep === "cpu",
        logSeverityLevel: 3,
      });
      const meta: any[] = (session as any).inputMetadata ?? [];
      const inputName = session.inputNames[0];
      const extra = new Set(session.inputNames.slice(1));
      const entry: PooledSession = {
        key,
        session,
        ep,
        inputName,
        outputName: session.outputNames[0],
        inputType: meta[0]?.type ?? "float32",
        extraInputs: extra,
        lastUsed: Date.now(),
      };
      log(`session ${short(modelPath)} on ${ep} in ${Date.now() - t0} ms`);
      await evict(1);
      pool.set(key, entry);
      return entry;
    } catch (err) {
      lastErr = err;
      log(`provider ${ep} failed for ${short(modelPath)}: ${String(err).split("\n")[0]}`);
    }
  }
  throw new Error(`No execution provider could load ${short(modelPath)}: ${String(lastErr)}`);
}

/** Drop a session (e.g. after a device-lost error) so the next call reopens it. */
export async function dropSession(s: PooledSession): Promise<void> {
  pool.delete(s.key);
  try {
    await s.session.release();
  } catch {
    /* already gone */
  }
}

async function evict(room: number): Promise<void> {
  while (pool.size + room > MAX_SESSIONS) {
    let oldest: PooledSession | null = null;
    for (const s of pool.values()) if (!oldest || s.lastUsed < oldest.lastUsed) oldest = s;
    if (!oldest) return;
    await dropSession(oldest);
  }
}

export async function releaseAll(): Promise<void> {
  for (const s of [...pool.values()]) await dropSession(s);
}

export function sessionCount(): number {
  return pool.size;
}

function short(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
