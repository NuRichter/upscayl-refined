import type { PooledSession } from "./session-pool";
import { getOrt } from "./session-pool";

export type TileOptions = {
  scale: number;
  tile: number;
  overlap: number;
  detail?: number;
  fidelity?: [number, number];
  tta?: boolean;
};

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

/** Evenly spread tile origins so every tile has the same size (one graph shape). */
export function tileOrigins(size: number, tile: number, overlap: number): number[] {
  if (size <= tile) return [0];
  const stride = Math.max(1, tile - overlap);
  const n = Math.ceil((size - tile) / stride) + 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round((i * (size - tile)) / (n - 1)));
  return out;
}

/** Raised-cosine edge ramps; edges on the image border keep full weight. */
function edgeWeights(len: number, rampL: number, rampR: number): Float32Array {
  const w = new Float32Array(len).fill(1);
  for (let u = 0; u < rampL && u < len; u++) {
    w[u] = 0.5 - 0.5 * Math.cos((Math.PI * (u + 0.5)) / rampL);
  }
  for (let u = 0; u < rampR && u < len; u++) {
    w[len - 1 - u] = Math.min(w[len - 1 - u], 0.5 - 0.5 * Math.cos((Math.PI * (u + 0.5)) / rampR));
  }
  return w;
}

/**
 * Tiled inference over an RGB image with seam-free blending.
 * Output rows are finalised band by band, so peak memory is one tile row of
 * float accumulators plus the 8-bit output, never a full float canvas.
 */
export async function upscaleTiled(
  src: { width: number; height: number; rgb: Buffer },
  sess: PooledSession,
  opt: TileOptions,
  onTile: (done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<{ rgb: Buffer; width: number; height: number; tiles: number; inferMs: number }> {
  const ort = getOrt();
  const { width: W, height: H, rgb } = src;
  const s = opt.scale;
  const Tx = Math.min(opt.tile, W);
  const Ty = Math.min(opt.tile, H);
  const ov = Math.min(opt.overlap, Math.floor(opt.tile / 2));
  const xs = tileOrigins(W, Tx, ov);
  const ys = tileOrigins(H, Ty, ov);
  const Wo = W * s;
  const Ho = H * s;
  const out = Buffer.alloc(Wo * Ho * 3);
  const bandRows = Ty * s;
  const acc = new Float32Array(bandRows * Wo * 3);
  const wac = new Float32Array(bandRows * Wo);
  const total = xs.length * ys.length;
  let done = 0;
  let inferMs = 0;

  const extra: Record<string, any> = {};
  if (sess.extraInputs.has("detail")) {
    extra.detail = new ort.Tensor("float32", new Float32Array([opt.detail ?? 0.5]), [1]);
  }
  if (sess.extraInputs.has("fidelity")) {
    const f = opt.fidelity ?? [0, 0];
    extra.fidelity = new ort.Tensor("float32", new Float32Array([f[0], f[1]]), [2]);
  }
  const half = sess.inputType === "float16";

  const runTile = async (planar: Float32Array, tw: number, th: number): Promise<Float32Array> => {
    let data: any = planar;
    if (half) {
      const u = new Uint16Array(planar.length);
      for (let i = 0; i < planar.length; i++) u[i] = toHalf(planar[i]);
      data = u;
    }
    const tensor = new ort.Tensor(half ? "float16" : "float32", data, [1, 3, th, tw]);
    const t0 = performance.now();
    const res = await sess.session.run({ [sess.inputName]: tensor, ...extra });
    inferMs += performance.now() - t0;
    const o = res[sess.outputName];
    const od = o.data as any;
    tensor.dispose?.();
    if (od instanceof Float32Array) return od;
    const f = new Float32Array(od.length);
    for (let i = 0; i < od.length; i++) f[i] = fromHalf(od[i]);
    return f;
  };

  let bandStart = 0; // output row held at acc row 0
  for (let r = 0; r < ys.length; r++) {
    const y0 = ys[r];
    const prevOvY = r > 0 ? ys[r - 1] + Ty - y0 : 0;
    const nextOvY = r < ys.length - 1 ? y0 + Ty - ys[r + 1] : 0;
    const wy = edgeWeights(Ty * s, prevOvY * s, nextOvY * s);
    for (let c = 0; c < xs.length; c++) {
      if (isCancelled()) throw new CancelledError();
      const x0 = xs[c];
      const prevOvX = c > 0 ? xs[c - 1] + Tx - x0 : 0;
      const nextOvX = c < xs.length - 1 ? x0 + Tx - xs[c + 1] : 0;
      const wx = edgeWeights(Tx * s, prevOvX * s, nextOvX * s);

      // gather input tile, planar float32 0..1
      const plane = Tx * Ty;
      const inp = new Float32Array(3 * plane);
      for (let y = 0; y < Ty; y++) {
        let si = ((y0 + y) * W + x0) * 3;
        const di = y * Tx;
        for (let x = 0; x < Tx; x++, si += 3) {
          inp[di + x] = rgb[si] / 255;
          inp[plane + di + x] = rgb[si + 1] / 255;
          inp[2 * plane + di + x] = rgb[si + 2] / 255;
        }
      }

      const o = opt.tta ? await runTta(inp, Tx, Ty, s, runTile) : await runTile(inp, Tx, Ty);
      const ow = Tx * s;
      const oh = Ty * s;
      const oplane = ow * oh;
      const accRow0 = y0 * s - bandStart;
      for (let y = 0; y < oh; y++) {
        const wyv = wy[y];
        const ar = accRow0 + y;
        let ai = (ar * Wo + x0 * s) * 3;
        let wi = ar * Wo + x0 * s;
        const oi = y * ow;
        for (let x = 0; x < ow; x++, ai += 3, wi++) {
          const w = wyv * wx[x];
          acc[ai] += w * o[oi + x];
          acc[ai + 1] += w * o[oplane + oi + x];
          acc[ai + 2] += w * o[2 * oplane + oi + x];
          wac[wi] += w;
        }
      }
      done++;
      onTile(done, total);
    }

    // finalise rows that no later tile row touches
    const finalEnd = r < ys.length - 1 ? ys[r + 1] * s : Ho;
    const rows = finalEnd - bandStart;
    for (let y = 0; y < rows; y++) {
      let ai = y * Wo * 3;
      let wi = y * Wo;
      let oi = (bandStart + y) * Wo * 3;
      for (let x = 0; x < Wo; x++, ai += 3, wi++, oi += 3) {
        const w = wac[wi] > 1e-8 ? 1 / wac[wi] : 0;
        out[oi] = to8(acc[ai] * w);
        out[oi + 1] = to8(acc[ai + 1] * w);
        out[oi + 2] = to8(acc[ai + 2] * w);
      }
    }
    // shift the unfinished rows to the top of the band
    const keep = bandRows - rows;
    if (keep > 0 && rows > 0) {
      acc.copyWithin(0, rows * Wo * 3, bandRows * Wo * 3);
      wac.copyWithin(0, rows * Wo, bandRows * Wo);
    }
    acc.fill(0, Math.max(0, keep) * Wo * 3);
    wac.fill(0, Math.max(0, keep) * Wo);
    bandStart = finalEnd;
  }
  return { rgb: out, width: Wo, height: Ho, tiles: total, inferMs };
}

function to8(v: number): number {
  const x = Math.round(v * 255);
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

/** 8-way geometric self-ensemble (flip x, flip y, transpose). */
async function runTta(
  inp: Float32Array,
  w: number,
  h: number,
  s: number,
  run: (p: Float32Array, tw: number, th: number) => Promise<Float32Array>,
): Promise<Float32Array> {
  const ow = w * s;
  const oh = h * s;
  const sum = new Float32Array(3 * ow * oh);
  for (let k = 0; k < 8; k++) {
    const fx = (k & 1) !== 0;
    const fy = (k & 2) !== 0;
    const tr = (k & 4) !== 0;
    const t = transform(inp, w, h, fx, fy, tr);
    const o = await run(t.data, t.w, t.h);
    const back = inverse(o, t.w * s, t.h * s, fx, fy, tr);
    for (let i = 0; i < sum.length; i++) sum[i] += back[i];
  }
  for (let i = 0; i < sum.length; i++) sum[i] *= 0.125;
  return sum;
}

function transform(src: Float32Array, w: number, h: number, fx: boolean, fy: boolean, tr: boolean) {
  const nw = tr ? h : w;
  const nh = tr ? w : h;
  const plane = w * h;
  const dst = new Float32Array(src.length);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = fx ? w - 1 - x : x;
        const sy = fy ? h - 1 - y : y;
        const v = src[c * plane + sy * w + sx];
        const dx = tr ? y : x;
        const dy = tr ? x : y;
        dst[c * plane + dy * nw + dx] = v;
      }
    }
  }
  return { data: dst, w: nw, h: nh };
}

/** Undo transform(): data is laid out as (w x h) of the transformed frame. */
function inverse(src: Float32Array, w: number, h: number, fx: boolean, fy: boolean, tr: boolean) {
  const ow = tr ? h : w; // original width
  const oh = tr ? w : h;
  const plane = w * h;
  const dst = new Float32Array(src.length);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const sx0 = fx ? ow - 1 - x : x;
        const sy0 = fy ? oh - 1 - y : y;
        const tx = tr ? sy0 : sx0;
        const ty = tr ? sx0 : sy0;
        dst[c * plane + y * ow + x] = src[c * plane + ty * w + tx];
      }
    }
  }
  return dst;
}

// IEEE half helpers for fp16-I/O graphs
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((mant + 0x1000) >> 13);
}
function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
