// sharp ships CJS types (.d.cts) that the node10 resolver cannot see; keep it loosely typed.
type SharpFactory = any;
type Sharp = any;

/**
 * sharp is loaded lazily: the main process never imports this module, and
 * the engine process only pays for libvips once a job actually arrives.
 */
let sharpModule: SharpFactory | null = null;
export function getSharp(): SharpFactory {
  if (!sharpModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sharpModule = require("sharp");
    sharpModule!.cache(false);
    sharpModule!.concurrency(0);
  }
  return sharpModule!;
}

export type RgbImage = {
  width: number;
  height: number;
  /** interleaved RGB, 8 bit */
  rgb: Buffer;
  /** single channel alpha, 8 bit, or null when fully opaque */
  alpha: Buffer | null;
  /** EXIF orientation that was applied to the pixels (1 = none) */
  orientation: number;
};

/** Decode any sharp-supported file into upright 8-bit RGB (+ alpha). */
export async function decodeImage(file: string): Promise<RgbImage> {
  const sharp = getSharp();
  const base = sharp(file, { limitInputPixels: false, failOn: "none" });
  const meta = await base.metadata();
  const upright = sharp(file, { limitInputPixels: false, failOn: "none" })
    .rotate()
    .toColourspace("srgb");
  const hasAlpha = !!meta.hasAlpha;
  if (!hasAlpha) {
    const { data, info } = await upright
      .removeAlpha()
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      rgb: data,
      alpha: null,
      orientation: meta.orientation ?? 1,
    };
  }
  const { data, info } = await upright
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const rgb = Buffer.allocUnsafe(n * 3);
  const alpha = Buffer.allocUnsafe(n);
  let opaque = true;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    rgb[i * 3] = data[j];
    rgb[i * 3 + 1] = data[j + 1];
    rgb[i * 3 + 2] = data[j + 2];
    const a = data[j + 3];
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }
  return {
    width: info.width,
    height: info.height,
    rgb,
    alpha: opaque ? null : alpha,
    orientation: meta.orientation ?? 1,
  };
}

/** Resize interleaved 8-bit pixels with Lanczos3 (used for alpha and final scaling). */
export async function resizeRaw(
  data: Buffer,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
  outW: number,
  outH: number,
): Promise<Buffer> {
  if (outW === width && outH === height) return data;
  const sharp = getSharp();
  return sharp(data, { raw: { width, height, channels }, limitInputPixels: false })
    .resize(outW, outH, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer();
}

/** Encode RGB (+ optional alpha) to the requested format. */
export async function encodeImage(
  rgb: Buffer,
  alpha: Buffer | null,
  width: number,
  height: number,
  file: string,
  format: string,
  compression: number,
): Promise<void> {
  const sharp = getSharp();
  let img: Sharp = sharp(rgb, {
    raw: { width, height, channels: 3 },
    limitInputPixels: false,
  });
  if (alpha) {
    img = img.joinChannel(alpha, { raw: { width, height, channels: 1 } });
  }
  // Upscayl's "compression" is 0 (best quality) .. 100 (smallest file).
  const c = Math.max(0, Math.min(100, compression || 0));
  const quality = Math.max(1, Math.round(100 - c * 0.9));
  switch (format) {
    case "jpg":
    case "jpeg":
      // mozjpeg (progressive + trellis) buffers every coefficient; skip it for huge outputs
      img = img.flatten({ background: "#ffffff" }).jpeg({
        quality,
        mozjpeg: width * height <= 50e6,
        chromaSubsampling: c < 10 ? "4:4:4" : "4:2:0",
      });
      break;
    case "webp":
      img = img.webp({ quality, lossless: c === 0, effort: 4 });
      break;
    default:
      // png is lossless either way: 0 -> fast zlib level 3, 100 -> level 9
      img = img.png({ compressionLevel: Math.min(9, 3 + Math.ceil(c / 16)), adaptiveFiltering: false });
  }
  await img.toFile(file);
}
