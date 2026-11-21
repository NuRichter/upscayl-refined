import fs from "fs";
import os from "os";
import path from "path";
import logit from "./logit";

/** Formats the classic upscayl-bin can decode on its own. */
const NATIVE = new Set(["png", "jpg", "jpeg", "jfif", "webp"]);

/**
 * upscayl-bin cannot read AVIF/TIFF/BMP. For those inputs write a temporary
 * PNG (sharp is only loaded in this rare case) and hand that to the binary.
 */
export async function ensureLegacyInput(file: string): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (NATIVE.has(ext)) return file;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upscayl-in-"));
  const out = path.join(dir, path.parse(file).name + ".png");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require("sharp");
  await sharp(file, { limitInputPixels: false }).rotate().png({ compressionLevel: 1 }).toFile(out);
  logit(`🔁 Converted ${ext.toUpperCase()} input for the classic engine: ${out}`);
  return out;
}
