// Regenerates renderer/public/model-comparison/<id>/{before,after}.webp for the
// Refined models from the same source picture the classic models use.
//   node scripts/make-comparisons.js [--models dir1;dir2]
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const cmp = path.join(root, "renderer", "public", "model-comparison");
const source = path.join(cmp, "upscayl-standard-4x", "before.webp");
const ids = [
  "refined-auto",
  "refined-heart-4x",
  "refined-nerve-4x",
  "refined-nerve-2x",
  "refined-pulse-4x",
  "refined-heart-2x",
  "ultrasharp-v2-4x",
  "ultrasharp-v2-lite-4x",
];
const i = process.argv.indexOf("--models");
const modelDirs = i > 0 ? process.argv[i + 1] : path.join(root, "resources", "refined-models");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-"));
const jobs = ids.map((id) => ({
  input: source,
  output: path.join(tmp, `${id}.png`),
  model: id,
  scale: 4,
}));
fs.writeFileSync(path.join(tmp, "jobs.json"), JSON.stringify(jobs));
const out = execFileSync(
  process.execPath,
  [path.join(root, "export", "electron", "engine", "cli.js"), "--batch", path.join(tmp, "jobs.json"), "--models", modelDirs],
  { encoding: "utf8" },
);
console.log(out.trim());

const sharp = require("sharp");
(async () => {
  for (const id of ids) {
    const png = path.join(tmp, `${id}.png`);
    if (!fs.existsSync(png)) {
      console.log(`skip ${id} (model missing)`);
      continue;
    }
    const dir = path.join(cmp, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, path.join(dir, "before.webp"));
    await sharp(png).webp({ quality: 82, effort: 6 }).toFile(path.join(dir, "after.webp"));
    console.log(`wrote ${id}`);
  }
})();
