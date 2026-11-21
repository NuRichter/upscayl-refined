/**
 * Headless front end for the Refined engine (QA, batch scripts, debugging).
 *
 *   node export/electron/engine/cli.js -i in.png -o out.png -m refined-auto \
 *        [-s 4] [--detail 0.5] [--fidelity 1,0] [--tile 256] [--ep dml]
 *        [--models dir1;dir2] [--manifest file] [--analyze] [--tta] [--passes 2]
 */
import fs from "fs";
import path from "path";
import { analyzeFile, runJob } from "./pipeline";
import { releaseAll } from "./session-pool";
import type { JobOptions, ModelManifestEntry } from "./types";

function arg(name: string, short?: string): string | undefined {
  const a = process.argv;
  for (let i = 2; i < a.length; i++) {
    if (a[i] === `--${name}` || (short && a[i] === `-${short}`)) return a[i + 1];
  }
  return undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** --batch jobs.json: [{input, output, model, detail?, fidelity?, scale?}], one session pool. */
async function runBatch(file: string) {
  const root = path.resolve(__dirname, "..", "..", "..");
  const manifestPath = arg("manifest") ?? path.join(root, "resources", "refined-models", "manifest.json");
  const manifest: ModelManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, "utf8")).models;
  const dirs = (arg("models") ?? path.dirname(manifestPath)).split(";");
  const jobs: Partial<JobOptions>[] = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const j of jobs) {
    const job: JobOptions = {
      model: "refined-auto",
      modelDirs: dirs,
      scale: 4,
      format: "png",
      compression: 0,
      ep: "auto",
      ...j,
    } as JobOptions;
    try {
      const st = await runJob(job, manifest, () => {}, () => false, () => {});
      console.log(JSON.stringify({ input: job.input, output: job.output, ...st }));
    } catch (e) {
      console.log(JSON.stringify({ input: job.input, output: job.output, error: String(e) }));
    }
  }
  await releaseAll();
  process.exit(0);
}

async function main() {
  const batch = arg("batch");
  if (batch) return runBatch(batch);
  const input = arg("input", "i");
  if (!input) {
    console.error("usage: cli -i input -o output [-m model] [-s scale] ...");
    process.exit(2);
  }
  if (flag("analyze")) {
    console.log(JSON.stringify(await analyzeFile(input)));
    return;
  }
  const root = path.resolve(__dirname, "..", "..", "..");
  const manifestPath = arg("manifest") ?? path.join(root, "resources", "refined-models", "manifest.json");
  const manifest: ModelManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, "utf8")).models;
  const dirs = (arg("models") ?? path.dirname(manifestPath)).split(";");
  const output = arg("output", "o") ?? input.replace(/(\.[^.]+)$/, "_refined.png");
  const fid = arg("fidelity");
  const job: JobOptions = {
    input,
    output,
    model: arg("model", "m") ?? "refined-auto",
    modelDirs: dirs,
    scale: parseFloat(arg("scale", "s") ?? "4"),
    customWidth: arg("width") ? parseInt(arg("width")!, 10) : undefined,
    format: (path.extname(output).slice(1).toLowerCase() || "png") as JobOptions["format"],
    compression: parseInt(arg("compression") ?? "0", 10),
    detail: arg("detail") !== undefined ? parseFloat(arg("detail")!) : undefined,
    fidelity: fid ? (fid.split(",").map(Number) as [number, number]) : undefined,
    tile: arg("tile") ? parseInt(arg("tile")!, 10) : undefined,
    ep: (arg("ep") as JobOptions["ep"]) ?? "auto",
    gpuId: arg("gpu") ? parseInt(arg("gpu")!, 10) : 0,
    passes: arg("passes") ? parseInt(arg("passes")!, 10) : 1,
    tta: flag("tta"),
  };
  const quiet = flag("quiet");
  let last = -1;
  const stats = await runJob(
    job,
    manifest,
    (p) => {
      const pct = Math.floor(p.pct);
      if (!quiet && pct !== last && pct % 10 === 0) {
        last = pct;
        process.stderr.write(`${pct}% ${p.stage}\n`);
      }
    },
    () => false,
    (m) => !quiet && process.stderr.write(`[engine] ${m}\n`),
  );
  await releaseAll();
  const peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(JSON.stringify({ output, ...stats, peakRssMB }));
  // GPU provider threads can keep the loop alive; the job is done
  process.exit(0);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
