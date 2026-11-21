import fs from "fs";
import path from "path";
import { ELECTRON_COMMANDS } from "../../common/electron-commands";
import type {
  BatchUpscaylPayload,
  DoubleUpscaylPayload,
  ImageUpscaylPayload,
  RefinedOptions,
} from "../../common/types/types";
import decodePath from "../../common/decode-path";
import getFilenameFromPath from "../../common/get-file-name";
import { imageFormats } from "../../common/image-formats";
import type { JobOptions, ModelManifestEntry } from "../engine/types";
import { getMainWindow } from "../main-window";
import { savedCustomModelsPath, setStopped, stopped } from "../utils/config-variables";
import { copyMetadata } from "../utils/copy-metadata";
import logit from "../utils/logit";
import { cancelRefined, runRefinedJob } from "../utils/refined-engine-host";
import {
  customOnnxEntries,
  getRefinedManifest,
  refinedModelDirs,
} from "../utils/refined-models";
import showNotification from "../utils/show-notification";

type Mode = "single" | "double";

export function isRefinedPayloadModel(model: string): boolean {
  if (model === "refined-auto") return true;
  if (getRefinedManifest().some((m) => m.id === model)) return true;
  return customOnnxEntries(savedCustomModelsPath).some((m) => m.id === model);
}

function fullManifest(): ModelManifestEntry[] {
  return [...getRefinedManifest(), ...customOnnxEntries(savedCustomModelsPath)];
}

function engineOptions(o?: RefinedOptions): Pick<JobOptions, "detail" | "fidelity" | "ep"> {
  const fidelity: [number, number] = o?.chromaLock === false ? [0, 0] : [1, 0];
  return {
    detail: typeof o?.detail === "number" && o.detail >= 0 ? o.detail : undefined,
    fidelity,
    ep: o?.backend ?? "auto",
  };
}

const activeJobs = new Set<string>();

export function stopRefined() {
  for (const id of activeJobs) cancelRefined(id);
}

export async function refinedImageUpscayl(payload: ImageUpscaylPayload | DoubleUpscaylPayload, mode: Mode) {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;
  const PROGRESS = mode === "double" ? ELECTRON_COMMANDS.DOUBLE_UPSCAYL_PROGRESS : ELECTRON_COMMANDS.UPSCAYL_PROGRESS;
  const DONE = mode === "double" ? ELECTRON_COMMANDS.DOUBLE_UPSCAYL_DONE : ELECTRON_COMMANDS.UPSCAYL_DONE;

  const imagePath = decodePath(payload.imagePath);
  const outputDir = decodePath(payload.outputPath);
  const fileName = path.parse(getFilenameFromPath(imagePath)).name;
  const customWidth = payload.useCustomWidth ? payload.customWidth : "";
  const outFile = path.join(
    outputDir,
    `${fileName}_upscayl_${customWidth ? `${customWidth}px_` : `${payload.scale}x_`}${payload.model}.${payload.saveImageAs}`,
  );
  const overwrite = (payload as ImageUpscaylPayload).overwrite;
  if (mode === "single" && fs.existsSync(outFile) && !overwrite) {
    logit("✅ Already upscayled at: ", outFile);
    mainWindow.webContents.send(DONE, outFile);
    return;
  }

  setStopped(false);
  const job: JobOptions = {
    input: imagePath,
    output: outFile,
    model: payload.model,
    modelDirs: refinedModelDirs(savedCustomModelsPath),
    scale: parseFloat(payload.scale) || 4,
    customWidth: customWidth ? parseInt(customWidth, 10) : undefined,
    format: payload.saveImageAs as JobOptions["format"],
    compression: parseInt(payload.compression, 10) || 0,
    tile: payload.tileSize || undefined,
    gpuId: payload.gpuId ? parseInt(payload.gpuId, 10) || 0 : 0,
    passes: mode === "double" ? 2 : 1,
    tta: payload.ttaMode,
    ...engineOptions(payload.refined),
  };
  logit("🧠 Refined job:", JSON.stringify({ model: job.model, out: outFile, detail: job.detail, ep: job.ep }));
  try {
    const { id, done } = await runRefinedJob(job, fullManifest(), (pct, stage) => {
      mainWindow.setProgressBar(pct / 100);
      if (stage === "finish") mainWindow.webContents.send(ELECTRON_COMMANDS.SCALING_AND_CONVERTING);
      else mainWindow.webContents.send(PROGRESS, `${pct.toFixed(2)}%`);
    });
    activeJobs.add(id);
    const stats = await done.finally(() => activeJobs.delete(id));
    logit("💯 Refined done:", JSON.stringify(stats));
    mainWindow.setProgressBar(-1);
    if (payload.copyMetadata) {
      try {
        await copyMetadata(imagePath, outFile, { uprightPixels: true });
      } catch (error) {
        mainWindow.webContents.send(ELECTRON_COMMANDS.METADATA_ERROR, String(error));
      }
    }
    mainWindow.webContents.send(DONE, outFile);
    showNotification("Upscayl", "Image upscayled successfully!");
  } catch (e: any) {
    mainWindow.setProgressBar(-1);
    if (stopped || e?.message === "cancelled") {
      logit("🛑 Refined job cancelled");
      return;
    }
    logit("❌ Refined error:", e?.message ?? e);
    mainWindow.webContents.send(ELECTRON_COMMANDS.UPSCAYL_ERROR, `Refined engine error: ${e?.message ?? e}`);
  }
}

export async function refinedBatchUpscayl(payload: BatchUpscaylPayload) {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;
  const inputDir = decodeURIComponent(payload.batchFolderPath);
  const customWidth = payload.useCustomWidth ? payload.customWidth : "";
  const outDir = path.join(
    decodeURIComponent(payload.outputPath),
    `upscayl_${payload.saveImageAs}_${payload.model}_${customWidth ? `${customWidth}px` : `${payload.scale}x`}`,
  );
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => imageFormats.includes(path.extname(f).slice(1).toLowerCase() as any))
    .filter((f) => fs.statSync(path.join(inputDir, f)).isFile());
  setStopped(false);
  let errors = 0;
  const manifest = fullManifest();
  for (let i = 0; i < files.length; i++) {
    if (stopped) break;
    const f = files[i];
    const out = path.join(outDir, `${path.parse(f).name}.${payload.saveImageAs}`);
    const job: JobOptions = {
      input: path.join(inputDir, f),
      output: out,
      model: payload.model,
      modelDirs: refinedModelDirs(savedCustomModelsPath),
      scale: parseFloat(payload.scale) || 4,
      customWidth: customWidth ? parseInt(customWidth, 10) : undefined,
      format: payload.saveImageAs as JobOptions["format"],
      compression: parseInt(payload.compression, 10) || 0,
      tile: payload.tileSize || undefined,
      gpuId: payload.gpuId ? parseInt(payload.gpuId, 10) || 0 : 0,
      tta: payload.ttaMode,
      ...engineOptions(payload.refined),
    };
    try {
      const { id, done } = await runRefinedJob(job, manifest, (pct) => {
        const overall = ((i + pct / 100) / files.length) * 100;
        mainWindow.setProgressBar(overall / 100);
        mainWindow.webContents.send(ELECTRON_COMMANDS.FOLDER_UPSCAYL_PROGRESS, `${overall.toFixed(2)}%`);
      });
      activeJobs.add(id);
      await done.finally(() => activeJobs.delete(id));
      if (payload.copyMetadata) {
        try {
          await copyMetadata(job.input, out, { uprightPixels: true });
        } catch (error) {
          logit("❌ metadata:", error);
        }
      }
    } catch (e: any) {
      if (stopped || e?.message === "cancelled") break;
      errors++;
      logit(`❌ ${f}: ${e?.message ?? e}`);
    }
  }
  mainWindow.setProgressBar(-1);
  if (stopped) return;
  mainWindow.webContents.send(ELECTRON_COMMANDS.FOLDER_UPSCAYL_DONE, outDir);
  showNotification(
    "Upscayled",
    errors ? `Images were upscayled but ${errors} failed.` : "Images upscayled successfully!",
  );
}

