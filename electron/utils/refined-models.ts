import { app } from "electron";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import path from "path";
import isDev from "electron-is-dev";
import type { ModelManifestEntry } from "../engine/types";
import getModelScale from "../../common/check-model-scale";
import logit from "./logit";

const appRoot = app.getAppPath();

/** Bundled models (read-only, next to app.asar in packaged builds). */
export const bundledRefinedDir = isDev
  ? path.join(appRoot, "resources", "refined-models")
  : path.join(path.dirname(appRoot), "refined-models");

/** Downloaded models live in the user profile so updates never wipe them. */
export const userRefinedDir = path.join(app.getPath("userData"), "refined-models");

let manifestCache: ModelManifestEntry[] | null = null;

export function getRefinedManifest(): ModelManifestEntry[] {
  if (manifestCache) return manifestCache;
  try {
    const raw = fs.readFileSync(path.join(bundledRefinedDir, "manifest.json"), "utf8");
    manifestCache = JSON.parse(raw).models as ModelManifestEntry[];
  } catch (e) {
    logit("❌ Could not read refined manifest:", e);
    manifestCache = [];
  }
  return manifestCache;
}

export function refinedModelDirs(customDir?: string | null): string[] {
  const dirs = [userRefinedDir, bundledRefinedDir];
  if (customDir) dirs.unshift(customDir);
  return dirs;
}

export function isRefinedModelId(id: string): boolean {
  return id === "refined-auto" || getRefinedManifest().some((m) => m.id === id);
}

export function isInstalled(entry: ModelManifestEntry): boolean {
  return refinedModelDirs().some((d) => fs.existsSync(path.join(d, entry.file)));
}

/**
 * Custom ONNX models dropped in the user's custom-models folder become
 * engine models with conservative defaults. The model id is the file name.
 */
export function customOnnxEntries(customDir?: string | null): ModelManifestEntry[] {
  if (!customDir || !fs.existsSync(customDir)) return [];
  return fs
    .readdirSync(customDir)
    .filter((f) => f.toLowerCase().endsWith(".onnx"))
    .map((f) => {
      const id = f.replace(/\.onnx$/i, "");
      return {
        id,
        name: id,
        file: f,
        license: "user supplied",
        source: "custom folder",
        scale: parseInt(getModelScale(id), 10) || 4,
        arch: "custom ONNX",
        ep: ["dml", "cpu"],
        tile: 256,
        overlap: 24,
      } as ModelManifestEntry;
    });
}

export function modelsStatus() {
  return getRefinedManifest().map((m) => ({
    id: m.id,
    name: m.name,
    bytes: m.bytes ?? 0,
    license: m.license,
    source: m.source,
    scale: m.scale,
    installed: isInstalled(m),
    bundled: !!m.bundled,
    tags: m.tags ?? [],
    detail: !!m.detail,
  }));
}

function get(url: string, redirects = 0): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "UpscaylRefined" } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 8) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      } else if (code !== 200) {
        res.resume();
        reject(new Error(`HTTP ${code} for ${url}`));
      } else resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("download timed out")));
  });
}

const active = new Map<string, Promise<void>>();

/** Download + SHA-256 verify into the user models folder. */
export function downloadRefinedModel(
  id: string,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const entry = getRefinedManifest().find((m) => m.id === id);
  if (!entry || !entry.url) return Promise.reject(new Error(`Unknown model ${id}`));
  if (active.has(id)) return active.get(id)!;
  const job = (async () => {
    fs.mkdirSync(userRefinedDir, { recursive: true });
    const dest = path.join(userRefinedDir, entry.file);
    const part = dest + ".part";
    const res = await get(entry.url!);
    const total = parseInt(res.headers["content-length"] ?? "0", 10) || entry.bytes || 0;
    const hash = crypto.createHash("sha256");
    let received = 0;
    let lastTick = 0;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(part);
      res.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        const now = Date.now();
        if (now - lastTick > 200) {
          lastTick = now;
          onProgress(received, total);
        }
      });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      res.pipe(out);
    });
    const digest = hash.digest("hex");
    if (entry.sha256 && digest !== entry.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`Checksum mismatch for ${entry.file}`);
    }
    fs.renameSync(part, dest);
    onProgress(received, total);
    logit(`⬇️ Model ${id} installed (${(received / 1e6).toFixed(1)} MB)`);
  })().finally(() => active.delete(id));
  active.set(id, job);
  return job;
}

export function deleteRefinedModel(id: string) {
  const entry = getRefinedManifest().find((m) => m.id === id);
  if (!entry) return;
  const p = path.join(userRefinedDir, entry.file);
  if (fs.existsSync(p)) fs.rmSync(p);
}
