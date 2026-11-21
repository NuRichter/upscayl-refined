import { test } from "node:test";
import assert from "node:assert/strict";
import { tileOrigins, upscaleTiled } from "../electron/engine/tiler";
import { analyzeImage } from "../electron/engine/analyze";
import type { PooledSession } from "../electron/engine/session-pool";

/** A stand-in ONNX session: nearest-neighbour upscale of the NCHW input. */
function fakeSession(scale: number, calls: number[][] = []): PooledSession {
  return {
    key: "fake",
    ep: "cpu",
    inputName: "x",
    outputName: "y",
    inputType: "float32",
    extraInputs: new Set(),
    lastUsed: 0,
    session: {
      run: async (feeds: any) => {
        const t = feeds.x;
        const [, c, h, w] = t.dims;
        calls.push([h, w]);
        const src = t.data as Float32Array;
        const oh = h * scale;
        const ow = w * scale;
        const out = new Float32Array(c * oh * ow);
        for (let k = 0; k < c; k++)
          for (let y = 0; y < oh; y++)
            for (let x = 0; x < ow; x++)
              out[k * oh * ow + y * ow + x] = src[k * h * w + Math.floor(y / scale) * w + Math.floor(x / scale)];
        return { y: { data: out, dims: [1, c, oh, ow] } };
      },
    } as any,
  };
}

function randomImage(w: number, h: number, seed = 1) {
  const rgb = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let i = 0; i < rgb.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    rgb[i] = s & 255;
  }
  return { width: w, height: h, rgb };
}

function nearest(img: { width: number; height: number; rgb: Buffer }, s: number) {
  const W = img.width * s;
  const H = img.height * s;
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 3; c++)
        out[(y * W + x) * 3 + c] = img.rgb[(Math.floor(y / s) * img.width + Math.floor(x / s)) * 3 + c];
  return out;
}

test("tile origins cover the axis with uniform tiles", () => {
  for (const [size, tile, ov] of [[1000, 256, 32], [257, 256, 32], [256, 256, 32], [100, 256, 16], [4032, 512, 24]]) {
    const o = tileOrigins(size, tile, ov);
    const t = Math.min(tile, size);
    assert.equal(o[0], 0);
    assert.equal(o[o.length - 1] + t, size);
    for (let i = 1; i < o.length; i++) {
      assert.ok(o[i] > o[i - 1], "strictly increasing");
      assert.ok(o[i - 1] + t - o[i] >= Math.min(ov, t), "overlap respected");
    }
  }
});

test("tiled blending is exact for a pixel-wise model (no seams, no drift)", async () => {
  for (const [w, h, s, tile, ov] of [
    [131, 97, 4, 48, 8],
    [300, 64, 2, 64, 16],
    [64, 64, 4, 256, 32],
    [257, 129, 3, 128, 24],
  ]) {
    const img = randomImage(w, h, w * h);
    const calls: number[][] = [];
    const r = await upscaleTiled(img, fakeSession(s, calls), { scale: s, tile, overlap: ov }, () => {}, () => false);
    assert.equal(r.width, w * s);
    assert.equal(r.height, h * s);
    assert.deepEqual(r.rgb, nearest(img, s), `mismatch for ${w}x${h} s${s} tile${tile}`);
    // every call uses the same tile shape (one compiled graph on GPU)
    const shapes = new Set(calls.map((c) => c.join("x")));
    assert.equal(shapes.size, 1);
  }
});

test("8-way TTA of an equivariant model returns the plain result", async () => {
  const img = randomImage(40, 24, 7);
  const r = await upscaleTiled(img, fakeSession(2), { scale: 2, tile: 32, overlap: 8, tta: true }, () => {}, () => false);
  assert.deepEqual(r.rgb, nearest(img, 2));
});

test("cancellation stops between tiles", async () => {
  const img = randomImage(200, 200, 3);
  let n = 0;
  await assert.rejects(
    upscaleTiled(img, fakeSession(2), { scale: 2, tile: 64, overlap: 8 }, () => n++, () => n >= 2),
    /cancelled/,
  );
});

test("analyzer flags JPEG-style blocking and Gaussian noise", () => {
  const w = 256;
  const h = 256;
  // 8x8 flat blocks with random levels -> strong grid discontinuities
  const blocky = Buffer.alloc(w * h * 3);
  let s = 11;
  for (let by = 0; by < h; by += 8)
    for (let bx = 0; bx < w; bx += 8) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = 60 + (s % 120);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const i = ((by + y) * w + bx + x) * 3;
          // gentle ramp inside the block so off-grid gradients are not zero
          blocky[i] = blocky[i + 1] = blocky[i + 2] = v + x;
        }
    }
  const a = analyzeImage({ width: w, height: h, rgb: blocky, alpha: null, orientation: 1 });
  assert.ok(a.blockiness > 1.18, `blockiness ${a.blockiness}`);

  // flat grey + gaussian noise sigma 8
  const noisy = Buffer.alloc(w * h * 3);
  let seed = 5;
  const gauss = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const u = (seed + 1) / 0x80000001;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const v = (seed + 1) / 0x80000001;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  for (let i = 0; i < w * h; i++) {
    const g = Math.max(0, Math.min(255, Math.round(128 + 8 * gauss())));
    noisy[i * 3] = noisy[i * 3 + 1] = noisy[i * 3 + 2] = g;
  }
  const n = analyzeImage({ width: w, height: h, rgb: noisy, alpha: null, orientation: 1 });
  assert.ok(n.noiseSigma > 5 && n.noiseSigma < 11, `noise ${n.noiseSigma}`);
  assert.equal(n.label === "noisy" || n.label === "heavy", true);
});
