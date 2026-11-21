import type { Analysis } from "./types";
import type { RgbImage } from "./image-io";

/**
 * Cheap blind degradation analysis (no neural network, ~10-40 ms).
 * Runs on a native-resolution centre crop so the 8x8 JPEG grid survives.
 *
 *  - blockiness: mean |horizontal+vertical luma step| on 8-px block borders
 *    divided by the same statistic off the borders (Wang/Bovik style).
 *  - noiseSigma: Immerkaer's fast estimator on the Laplacian-difference
 *    kernel, restricted to low-gradient pixels so edges are not counted.
 *  - sharpness: mean gradient magnitude of luma.
 *  - acutance: 2 * mean|I(x+1)-I(x)| / mean|I(x+2)-I(x)|. Scale-free blur cue:
 *    locally linear (blurred) signals give ~1, uncorrelated detail gives ~2.
 *  - artScore: share of flat pixels plus palette compactness on a proxy.
 */
export function analyzeImage(img: RgbImage): Analysis {
  const t0 = Date.now();
  const { width, height, rgb } = img;
  const cw = Math.min(width, 1024);
  const ch = Math.min(height, 1024);
  const ox = Math.max(0, ((width - cw) >> 1) & ~7);
  const oy = Math.max(0, ((height - ch) >> 1) & ~7);

  const Y = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    let si = ((oy + y) * width + ox) * 3;
    let di = y * cw;
    for (let x = 0; x < cw; x++, si += 3, di++) {
      Y[di] = 0.299 * rgb[si] + 0.587 * rgb[si + 1] + 0.114 * rgb[si + 2];
    }
  }

  // --- blockiness ---------------------------------------------------------
  let onB = 0, onN = 0, offB = 0, offN = 0;
  for (let y = 0; y < ch; y++) {
    const row = y * cw;
    for (let x = 0; x < cw - 1; x++) {
      const d = Math.abs(Y[row + x + 1] - Y[row + x]);
      if (((x + ox) & 7) === 7) { onB += d; onN++; } else { offB += d; offN++; }
    }
  }
  for (let y = 0; y < ch - 1; y++) {
    const row = y * cw;
    const border = ((y + oy) & 7) === 7;
    for (let x = 0; x < cw; x++) {
      const d = Math.abs(Y[row + cw + x] - Y[row + x]);
      if (border) { onB += d; onN++; } else { offB += d; offN++; }
    }
  }
  const blockiness = onN && offN && offB > 0 ? (onB / onN) / (offB / offN) : 1;

  // --- gradient, noise ------------------------------------------------------
  let gradSum = 0;
  let noiseAcc = 0;
  let noiseN = 0;
  let flat = 0;
  const grads: number[] = [];
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      const gx = Y[i + 1] - Y[i - 1];
      const gy = Y[i + cw] - Y[i - cw];
      const g = Math.abs(gx) + Math.abs(gy);
      gradSum += g;
      if ((x & 15) === 0 && (y & 15) === 0) grads.push(g);
      if (g < 3) flat++;
    }
  }
  const nPix = Math.max(1, (cw - 2) * (ch - 2));
  let d1 = 0;
  let d2 = 0;
  for (let y = 2; y < ch - 2; y++) {
    const row = y * cw;
    for (let x = 2; x < cw - 2; x++) {
      const i = row + x;
      d1 += Math.abs(Y[i + 1] - Y[i]) + Math.abs(Y[i + cw] - Y[i]);
      d2 += Math.abs(Y[i + 2] - Y[i]) + Math.abs(Y[i + 2 * cw] - Y[i]);
    }
  }
  const acutance = d2 > 0 ? (2 * d1) / d2 : 2;
  const sharpness = gradSum / nPix;
  grads.sort((a, b) => a - b);
  // edge threshold: pixels above the 60th percentile gradient are ignored
  const edgeT = grads.length ? Math.max(4, grads[Math.floor(grads.length * 0.6)]) : 8;
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      const gx = Y[i + 1] - Y[i - 1];
      const gy = Y[i + cw] - Y[i - cw];
      if (Math.abs(gx) + Math.abs(gy) > edgeT) continue;
      const v =
        Y[i - cw - 1] - 2 * Y[i - cw] + Y[i - cw + 1] -
        2 * Y[i - 1] + 4 * Y[i] - 2 * Y[i + 1] +
        Y[i + cw - 1] - 2 * Y[i + cw] + Y[i + cw + 1];
      noiseAcc += Math.abs(v);
      noiseN++;
    }
  }
  const noiseSigma = noiseN ? Math.sqrt(Math.PI / 2) * noiseAcc / (6 * noiseN) : 0;

  // --- art score (proxy, whole image) ---------------------------------------
  const step = Math.max(1, Math.floor(Math.max(width, height) / 256));
  const palette = new Set<number>();
  let samples = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 3;
      palette.add(((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3));
      samples++;
    }
  }
  const flatShare = flat / nPix;
  const paletteRatio = palette.size / Math.max(1, samples);
  const artScore = clamp01(0.65 * smooth(flatShare, 0.35, 0.75) + 0.35 * (1 - smooth(paletteRatio, 0.08, 0.45)));

  // thresholds fitted on the QA scenario set (docs/REFINED_ENGINE.md)
  let label: Analysis["label"] = "clean";
  const compressed = blockiness > 1.15;
  const noisy = noiseSigma > 4.5;
  if ((compressed && noisy) || blockiness > 1.33) label = "heavy";
  else if (compressed) label = "compressed";
  else if (noisy) label = "noisy";
  else if (acutance < 1.2) label = "soft";

  return {
    width,
    height,
    hasAlpha: !!img.alpha,
    blockiness: round3(blockiness),
    noiseSigma: round3(noiseSigma),
    sharpness: round3(sharpness),
    acutance: round3(acutance),
    artScore: round3(artScore),
    label,
    ms: Date.now() - t0,
  };
}

function smooth(x: number, lo: number, hi: number): number {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
