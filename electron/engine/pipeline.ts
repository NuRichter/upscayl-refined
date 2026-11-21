import fs from "fs";
import path from "path";
import { analyzeImage } from "./analyze";
import { decodeImage, encodeImage, resizeRaw, type RgbImage } from "./image-io";
import { dropSession, getSession } from "./session-pool";
import { CancelledError, upscaleTiled } from "./tiler";
import type {
  Analysis,
  ExecutionProvider,
  JobOptions,
  JobStats,
  ModelManifestEntry,
  ProgressFn,
} from "./types";

export const AUTO_MODEL_ID = "refined-auto";

/**
 * Routing table for "Refined Auto". Values come from the scenario QA run
 * (see docs/REFINED_ENGINE.md): detail is the HEART/NERVE fidelity->GAN mix,
 * fidelity is [chroma, luma] low-frequency lock.
 */
export const AUTO_TUNING = {
  heavyModel: "refined-heart-4x",
  fastModel: "refined-nerve-4x",
  /** above this many input megapixels Auto switches to the fast model */
  heavyMaxMegapixels: 8,
  /**
   * QA (30 images x 4 degradations): on photos LPIPS keeps improving up to
   * detail 1.0 while PSNR drops ~0.45 dB per 0.25 step; painted art is best
   * at 0.5-0.75. 0.85 keeps both groups within 0.01 LPIPS of their optimum.
   */
  detail: { clean: 0.85, soft: 0.95, compressed: 0.85, noisy: 0.9, heavy: 0.95, art: 0.6 },
  fidelity: [1, 0] as [number, number],
  artThreshold: 0.7,
};

export type Plan = {
  model: ModelManifestEntry;
  modelPath: string;
  detail?: number;
  fidelity?: [number, number];
  reason: string;
};

export function findModelFile(entry: ModelManifestEntry, dirs: string[]): string | null {
  for (const d of dirs) {
    const p = path.join(d, entry.file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function planJob(
  job: JobOptions,
  manifest: ModelManifestEntry[],
  analysis: Analysis,
): Plan {
  const byId = new Map(manifest.map((m) => [m.id, m]));
  const available = (id: string) => {
    const m = byId.get(id);
    return m && findModelFile(m, job.modelDirs) ? m : null;
  };
  let model: ModelManifestEntry | null = null;
  let reason = "";
  let detail = job.detail;
  if (job.model === AUTO_MODEL_ID) {
    const mp = (analysis.width * analysis.height) / 1e6;
    const heavy = available(AUTO_TUNING.heavyModel);
    const fast = available(AUTO_TUNING.fastModel);
    model = mp <= AUTO_TUNING.heavyMaxMegapixels && heavy ? heavy : fast ?? heavy;
    const isArt = analysis.artScore >= AUTO_TUNING.artThreshold;
    const key = isArt ? "art" : analysis.label;
    if (detail === undefined) detail = AUTO_TUNING.detail[key];
    reason = `auto: ${key}, ${mp.toFixed(1)} MP -> ${model?.id}`;
  } else {
    model = byId.get(job.model) ?? null;
    reason = "user choice";
  }
  if (!model) throw new Error(`Model "${job.model}" is not installed.`);
  const modelPath = findModelFile(model, job.modelDirs);
  if (!modelPath) throw new Error(`Model file ${model.file} not found. Download it from the model list first.`);
  if (detail === undefined && model.detail) {
    // "Auto" detail on an explicitly chosen model follows the analyzer too
    const key = analysis.artScore >= AUTO_TUNING.artThreshold ? "art" : analysis.label;
    detail = AUTO_TUNING.detail[key];
  }
  if (detail === undefined) detail = model.defaultDetail ?? 0.5;
  const fidelity = job.fidelity ?? (job.model === AUTO_MODEL_ID ? AUTO_TUNING.fidelity : [1, 0]);
  return {
    model,
    modelPath,
    detail: model.detail ? clamp01(detail) : undefined,
    fidelity: model.fidelity ? [clamp01(fidelity[0]), clamp01(fidelity[1])] : undefined,
    reason,
  };
}

function providersFor(model: ModelManifestEntry, ep?: JobOptions["ep"]): ExecutionProvider[] {
  if (ep && ep !== "auto") return ep === "cpu" ? ["cpu"] : [ep, "cpu"];
  const list = model.ep?.length ? [...model.ep] : ["dml", "cpu"];
  if (!list.includes("cpu")) list.push("cpu");
  return list as ExecutionProvider[];
}

function isDeviceError(e: unknown): boolean {
  const s = String(e);
  return /out of memory|E_OUTOFMEMORY|887A0005|887A0006|DXGI_ERROR|device.*(lost|removed|hung)|bad allocation/i.test(s);
}

/** Run one model pass, shrinking the tile on GPU memory errors. */
async function runModel(
  img: { width: number; height: number; rgb: Buffer },
  plan: Plan,
  job: JobOptions,
  onTile: (d: number, t: number) => void,
  isCancelled: () => boolean,
  log: (m: string) => void,
) {
  const providers = providersFor(plan.model, job.ep);
  let tile = job.tile && job.tile > 0 ? job.tile : plan.model.tile;
  const mult = plan.model.multiple ?? 1;
  for (let attempt = 0; attempt < 4; attempt++) {
    const sess = await getSession(plan.modelPath, providers, job.gpuId ?? 0, log);
    try {
      const r = await upscaleTiled(
        img,
        sess,
        {
          scale: plan.model.scale,
          tile,
          overlap: plan.model.overlap,
          detail: plan.detail,
          fidelity: plan.fidelity,
          tta: job.tta,
        },
        onTile,
        isCancelled,
      );
      return { ...r, ep: sess.ep };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      if (!isDeviceError(e) || tile <= 64) throw e;
      await dropSession(sess);
      tile = Math.max(64, Math.floor(tile / 2 / mult) * mult);
      log(`GPU memory pressure, retrying with tile ${tile}`);
    }
  }
  throw new Error("Out of GPU memory even with the smallest tile size.");
}

export async function runJob(
  job: JobOptions,
  manifest: ModelManifestEntry[],
  onProgress: ProgressFn,
  isCancelled: () => boolean,
  log: (m: string) => void,
): Promise<JobStats> {
  const t0 = Date.now();
  onProgress({ pct: 0, stage: "decode" });
  const src: RgbImage = await decodeImage(job.input);
  const analysis = analyzeImage(src);
  log(
    `analysis: ${analysis.width}x${analysis.height} ${analysis.label} ` +
      `(block ${analysis.blockiness}, noise ${analysis.noiseSigma}, sharp ${analysis.sharpness}, art ${analysis.artScore})`,
  );
  const plan = planJob(job, manifest, analysis);
  log(`plan: ${plan.model.id} detail=${plan.detail ?? "-"} fidelity=${plan.fidelity?.join(",") ?? "-"} (${plan.reason})`);

  const passes = Math.max(1, Math.min(2, job.passes ?? 1));
  let cur = { width: src.width, height: src.height, rgb: src.rgb };
  let tiles = 0;
  let inferMs = 0;
  let ep: ExecutionProvider = "cpu";
  for (let p = 0; p < passes; p++) {
    const base = p / passes;
    const r = await runModel(
      cur,
      plan,
      job,
      (d, t) => onProgress({ pct: (base + (d / t) / passes) * 96, stage: "upscale", detail: `${d}/${t}` }),
      isCancelled,
      log,
    );
    cur = { width: r.width, height: r.height, rgb: r.rgb };
    tiles += r.tiles;
    inferMs += r.inferMs;
    ep = r.ep;
  }

  // final geometry
  let outW: number;
  let outH: number;
  if (job.customWidth && job.customWidth > 0) {
    outW = Math.round(job.customWidth);
    outH = Math.max(1, Math.round((job.customWidth * src.height) / src.width));
  } else {
    const s = job.scale > 0 ? job.scale : plan.model.scale;
    const total = passes > 1 ? s * s : s;
    outW = Math.max(1, Math.round(src.width * total));
    outH = Math.max(1, Math.round(src.height * total));
  }
  onProgress({ pct: 97, stage: "finish" });
  const rgb = await resizeRaw(cur.rgb, cur.width, cur.height, 3, outW, outH);
  const alpha = src.alpha ? await resizeRaw(src.alpha, src.width, src.height, 1, outW, outH) : null;
  fs.mkdirSync(path.dirname(job.output), { recursive: true });
  await encodeImage(rgb, alpha, outW, outH, job.output, job.format, job.compression);
  onProgress({ pct: 100, stage: "done" });
  return {
    model: plan.model.id,
    ep,
    analysis,
    detail: plan.detail,
    fidelity: plan.fidelity,
    tiles,
    inferenceMs: Math.round(inferMs),
    totalMs: Date.now() - t0,
    outWidth: outW,
    outHeight: outH,
  };
}

export async function analyzeFile(file: string): Promise<Analysis> {
  return analyzeImage(await decodeImage(file));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
