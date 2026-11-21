# Refined engine — design notes and QA record

Upscayl Refined keeps Upscayl's interface and replaces the processing core
with a second engine built on ONNX Runtime. The classic NCNN engine
(`upscayl-bin`) stays for the original models and for custom `.param/.bin`
models. Everything below was measured on the development machine: Windows 11
Pro 26300, Ryzen (AM5, B850), RTX 5060 Ti 16 GB, driver 621.24, ONNX Runtime
1.31.1 (DirectML/WebGPU), Electron 45.4.1.

## 1. Process model — why the idle app is light

```
 ┌──────────────── idle: 3 processes, ~330 MB working set ───────────────┐
 │ main (Node, IPC, file dialogs)    renderer (React UI)    gpu-process   │
 │   │  no ONNX Runtime, no sharp,      static export,        software    │
 │   │  no exiftool, no updater,        no analytics,         compositor  │
 │   │  network service in-process      no remote fetches                │
 └───┼────────────────────────────────────────────────────────────────────┘
     │ first Refined job                          classic model
     ├──────────────► engine (utilityProcess)     └──► upscayl-bin (NCNN/Vulkan)
     │                  ONNX Runtime + sharp           spawned per job, exits
     │                  sessions kept warm N s
     └◄─────────────── exits after keep-warm → GPU memory released
```

* The engine process is forked on the first Refined job and exits
  `keepWarmSec` (default 45 s, Settings → Refined Engine) after the last one.
  Batch jobs reuse warm sessions; an idle app holds no VRAM.
* `onnxruntime-node` and `sharp` are only ever loaded inside the engine
  process. `exiftool-vendored` is loaded per metadata copy and closed
  afterwards, so no Perl process lingers.
* PostHog analytics, Firebase, the remote news modal, the YouTube onboarding
  embed and electron-updater were removed. The app makes no network request
  unless the user downloads a model.
* UI drawing uses software compositing by default (toggle "UI hardware
  acceleration", restart to apply) and the network service runs in-process.

### Idle footprint (window open, nothing loaded, 25 s settle + 30 s window)

| Build | Processes | Working set | Private bytes | Idle CPU |
|---|---|---|---|---|
| Upscayl 2.15.0 (Electron 33) | 4 | 418 MB | 187 MB | 0.04 % |
| Refined, Electron 45, defaults of Chromium | 4 | 401 MB | 328 MB | 0.00 % |
| + network service in-process | 3 | 341 MB | 311 MB | 0.00 % |
| + software UI compositing (**shipped default**) | **3** | **330 MB** | **135 MB** | **0.00 %** |
| V8 `--lite-mode` (rejected, no gain) | 3 | 318 MB | 135 MB | 0.01 % |
| after jobs, engine auto-exited, result on screen | 3 | 353 MB | – | – |

Measured with `_qa/idle_bench.mjs` (sum over the whole process tree).

## 2. Pipeline

```
decode ─► analyze ─► route ─► tiled inference ─► resize/alpha ─► encode ─► metadata
sharp     ~10-30 ms   Auto     ONNX Runtime       Lanczos3         png/jpg/   exiftool
upright   no network  table    DML/WebGPU/CPU     (sharp)          webp       (opt.)
sRGB
```

**Decode.** sharp/libvips, EXIF orientation applied to the pixels (the
orientation tag is reset to 1 when metadata is copied), ICC → sRGB, alpha
split off and resized separately with Lanczos3.

**Analyze** (`electron/engine/analyze.ts`, pure TypeScript):

| Cue | Method |
|---|---|
| JPEG blocking | mean luma step on 8-px block borders ÷ off-border mean (Wang/Sheikh/Bovik) on a native-resolution centre crop |
| noise σ | Immerkær Laplacian-difference estimator restricted to low-gradient pixels |
| blur | acutance ratio 2·mean\|d1\| / mean\|d2\|: ≈2 crisp, ≈1 locally linear (blurred) |
| illustration | flat-pixel share + 15-bit palette compactness |

Labels: `clean`, `compressed`, `heavy`, `noisy`, `soft` (+ `art` when the art
score ≥ 0.7). Confusion on the QA set (true scenario → label): clean 23/30
clean; web 24/30 compressed or heavy; heavy 30/30 compressed or heavy; soft
17/30 soft. Misses are cheap because neighbouring labels map to nearby
detail values.

**Route (Refined Auto).** Model: HEART 4x up to 8 MP input, NERVE 4x above.
Detail by label: clean 0.85, compressed 0.85, noisy 0.9, soft 0.95, heavy
0.95, art 0.6. Colour lock: chroma on, luma off. "Auto" on the Detail slider
uses the same table for explicitly chosen HEART/NERVE models.

**Tiled inference** (`electron/engine/tiler.ts`):

* Tiles are evenly spaced so every tile has the same shape; DirectML
  compiles one graph per shape, so this avoids re-compilation per edge tile.
* Overlaps are blended with raised-cosine ramps and normalised by the summed
  weights. A unit test proves the result is bit-exact for a pixel-wise model
  on odd sizes and scales (no seams, no drift).
* Output rows are finalised band by band; peak memory is one tile row of
  float accumulators plus the 8-bit output (12 MP → 195 MP output peaks at
  2.5 GB RSS).
* On a GPU memory error the tile is halved (aligned to the model's window
  multiple) and the session reopened; providers fall back DML → WebGPU → CPU.
* Optional 8-way TTA; cancellation is checked between tiles.

## 3. Model forge — the "new models"

`tools/model-forge/` turns pinned upstream checkpoints into the graphs the
engine runs (`build.py` downloads by Hugging Face revision + SHA-256, forges,
self-checks in ONNX Runtime, refreshes `manifest.json`). Building twice gives
byte-identical files.

| Pass | What it does | Verified |
|---|---|---|
| `io32` | float32 graph I/O (wraps fp16 I/O with Cast) | — |
| `cubic` | replaces bicubic `Resize` with Pad(edge) + grouped 5×5 Conv + DepthToSpace that reproduces ONNX cubic (a = −0.75, half-pixel) exactly. DirectML has no GPU kernel for cubic Resize and silently runs it on the CPU. | 146.7 dB vs original; NERVE tile 256: 630 ms → 14 ms |
| `blend` | network interpolation between two checkpoints of one lineage (fidelity → GAN finetune). Both weight sets live in the graph as `w = a + detail·(b − a)`; `detail` is a runtime input, so one file covers the whole range at zero extra inference cost. | detail 0 / 1 reproduce each source at 145 / 143 dB |
| `fidelity` | appended head: `out = sr + c·(D − Y(D)) + l·Y(D)`, `D = low(up(lr)) − low(sr)`, low = 5-level à-trous B3-spline, up = exact bicubic. Runtime input `fidelity = [chroma, luma]`. StableSR-style colour correction on a GAN restorer. | neutral on synthetic tests (Δ ≤ 0.04 dB, Δ LPIPS ≤ 0.001); guards against tone/colour drift |
| `fp16` | float16 weights/compute, float32 I/O; shape-arithmetic casts retargeted so `Shape → Cast → Pow` paths stay type-consistent | HEART 79.0 dB, NERVE 75.7 dB, HEART 2x 79.5 dB vs fp32 |

Shipped graphs:

| id | Source (upstream, licence) | Passes | Size | Bundled |
|---|---|---|---|---|
| refined-heart-4x | HEART 4x OTF fidelity ⊕ OTF GAN (Apache-2.0, 2026-11) | blend, fidelity, fp16 | 74.8 MB | yes |
| refined-nerve-4x | NERVE 4x OTF fidelity ⊕ OTF GAN (Apache-2.0, 2026-11) | cubic, blend, fidelity, fp16 | 7.2 MB | yes |
| refined-nerve-2x | NERVE 2x OTF GAN (Apache-2.0, 2026-09) | cubic, fidelity, fp16 | 3.6 MB | yes |
| refined-pulse-4x | PULSE 4x (MIT, 2026-11) | fidelity, fp16 | 0.7 MB | yes |
| refined-heart-2x | HEART 2x (Apache-2.0, 2026-11) | fidelity, fp16 | 37.1 MB | download |
| ultrasharp-v2-4x | UltraSharp V2 DAT2 (CC BY-NC-SA 4.0) | original ONNX | 51.8 MB | download |
| ultrasharp-v2-lite-4x | UltraSharp V2 Lite (CC BY-NC-SA 4.0) | original fp16 ONNX | 15.3 MB | download |

Downloads are verified against the manifest SHA-256 before they are used.

## 4. Execution providers (tile 256, single run, ms)

| Model | DirectML | WebGPU | Notes |
|---|---|---|---|
| PULSE 4x | 6 | 12 | |
| NERVE 4x original | 630 | 40 | cubic Resize on CPU under DML |
| NERVE 4x forged | **14** | – | cubic rewritten |
| HEART 4x fp32 | 1189 | 6730 | WebGPU attention is slow |
| HEART 4x forged fp16 | **773** (11.8 s/MP) | – | batch 4 and larger tiles give no gain |
| UltraSharp V2 DAT2 fp32 | 1001 | – | 26 ms of CPU-side shape ops |

The manifest stores a provider order per model (HEART: DML → CPU, NERVE/PULSE:
DML → WebGPU → CPU). Real images: KazuScara-sized 1200×672 → 4800×2688 in
1.8 s (NERVE) / 20 s (HEART); a 12 MP phone photo → 12096×16128 in 10.6 s
with Auto (NERVE), and in 214 s with HEART 4x (252 tiles, peak RSS 2.4 GB).

## 5. Quality QA

Set: Kodak PhotoCD (24) + 3 photo and 3 painted-art crops from the test
folder, 30 images × 4 degradations (×4 down): `clean` bicubic; `web` JPEG q60;
`heavy` blur σ0.8 + noise σ6 + JPEG q40; `soft` blur σ1.6. Metrics: PSNR/SSIM
on Y (4-px border crop), LPIPS-alex (lower is better). Cells are
PSNR / SSIM / LPIPS.

| Method | clean | web (JPEG q60) | heavy (blur+noise+JPEG q40) | soft (blur 1.6) | mean LPIPS |
|---|---|---|---|---|---|
| UltraSharp V2 Lite (NC) | 28.03 / 0.771 / 0.126 | 26.40 / 0.686 / 0.271 | 25.81 / 0.638 / 0.315 | 27.17 / 0.739 / 0.143 | 0.2136 |
| Refined HEART 4x, detail 1.0 | 28.45 / 0.786 / 0.137 | 26.54 / 0.690 / 0.268 | 26.07 / 0.656 / 0.308 | 28.55 / 0.785 / 0.149 | 0.2152 |
| UltraSharp V2 (DAT2, NC) | 28.76 / 0.806 / 0.139 | 26.45 / 0.698 / 0.279 | 25.94 / 0.664 / 0.301 | 28.44 / 0.797 / 0.151 | 0.2173 |
| **Refined Auto** | 28.71 / 0.795 / 0.143 | 26.77 / 0.699 / 0.275 | 26.21 / 0.664 / 0.307 | 28.72 / 0.791 / 0.154 | 0.2198 |
| Refined HEART 4x, detail 0.75 | 28.93 / 0.801 / 0.148 | 26.96 / 0.705 / 0.285 | 26.46 / 0.676 / 0.314 | 28.98 / 0.798 / 0.162 | 0.2272 |
| HEART 0.5, colour lock off | 29.33 / 0.812 / 0.164 | 27.23 / 0.714 / 0.310 | 26.68 / 0.687 / 0.337 | 29.33 / 0.808 / 0.179 | 0.2477 |
| Refined HEART 4x, detail 0.5 | 29.33 / 0.812 / 0.164 | 27.22 / 0.714 / 0.311 | 26.68 / 0.687 / 0.338 | 29.32 / 0.808 / 0.179 | 0.2480 |
| HEART 0.5, chroma+luma lock | 29.36 / 0.812 / 0.164 | 27.27 / 0.714 / 0.311 | 26.72 / 0.687 / 0.338 | 29.36 / 0.808 / 0.179 | 0.2481 |
| Classic: Upscayl Standard | 27.29 / 0.748 / 0.218 | 26.11 / 0.686 / 0.273 | 25.53 / 0.658 / 0.301 | 27.25 / 0.741 / 0.224 | 0.2541 |
| Classic: UltraSharp | 26.72 / 0.727 / 0.197 | 25.43 / 0.644 / 0.308 | 25.12 / 0.611 / 0.337 | 26.71 / 0.715 / 0.206 | 0.2619 |
| Refined NERVE 4x, detail 1.0 | 28.03 / 0.772 / 0.182 | 26.24 / 0.674 / 0.315 | 25.74 / 0.638 / 0.361 | 28.55 / 0.781 / 0.210 | 0.2671 |
| Refined HEART 4x, detail 0.25 | 29.60 / 0.818 / 0.183 | 27.40 / 0.720 / 0.340 | 26.82 / 0.693 / 0.367 | 29.56 / 0.813 / 0.200 | 0.2725 |
| Refined HEART 4x, detail 0.0 | 29.67 / 0.817 / 0.204 | 27.49 / 0.721 / 0.368 | 26.90 / 0.695 / 0.398 | 29.59 / 0.813 / 0.221 | 0.2977 |
| Classic: High Fidelity | 28.01 / 0.767 / 0.267 | 26.65 / 0.693 / 0.328 | 25.99 / 0.660 / 0.356 | 27.86 / 0.759 / 0.272 | 0.3055 |
| Refined NERVE 4x, detail 0.5 | 28.92 / 0.798 / 0.234 | 27.11 / 0.707 / 0.360 | 26.54 / 0.679 / 0.394 | 28.99 / 0.795 / 0.260 | 0.3119 |
| Classic: Remacri | 27.83 / 0.782 / 0.182 | 26.23 / 0.695 / 0.360 | 25.89 / 0.658 / 0.440 | 28.21 / 0.772 / 0.375 | 0.3391 |
| Refined NERVE 4x, detail 0.0 | 29.06 / 0.799 / 0.280 | 27.26 / 0.710 / 0.413 | 26.67 / 0.683 / 0.448 | 28.97 / 0.793 / 0.300 | 0.3603 |
| Refined PULSE 4x | 29.58 / 0.814 / 0.286 | 26.78 / 0.680 / 0.538 | 26.07 / 0.643 / 0.608 | 27.94 / 0.758 / 0.409 | 0.4603 |
| Bicubic | 27.66 / 0.750 / 0.446 | 26.70 / 0.682 / 0.628 | 26.12 / 0.653 / 0.688 | 26.93 / 0.715 / 0.496 | 0.5644 |

Reading it:

* Refined Auto beats the classic default (Upscayl Standard) on every
  scenario in PSNR and SSIM, and on mean LPIPS (0.220 vs 0.254, −13 %).
  The only cell where the classic model is ahead is LPIPS on `heavy`
  (0.301 vs 0.307), where Auto is +0.68 dB PSNR.
* The detail control is a real perception–distortion dial: HEART detail 0
  has the best PSNR of all methods, detail 1 the best LPIPS of the
  permissively licensed models.
* UltraSharp V2 (non-commercial licence) is on par; it stays an optional
  download.

## 6. Automated tests

* `npm test` — engine unit tests (tile coverage, exact seam-free blending,
  band streaming, TTA, cancellation, analyzer).
* `_qa/e2e.mjs` (16 checks) — packaged app over the Chrome DevTools Protocol:
  title/edition, default model, no analytics/embeds, idle without engine,
  Refined Auto single image + metadata copy, engine spawned on demand,
  classic engine, Refined batch, double upscale = 16×, model status, real
  download + SHA-256, downloaded fp16-I/O model runs, stop mid-job, engine
  exit after keep-warm.
* `_qa/e2e_ui.mjs` (6 checks) — real drag-and-drop, button click, result in
  the compare viewer, clipboard paste.

## 7. Known limits and next steps

* HEART on DirectML runs at ~12 s per input megapixel. NVIDIA's TensorRT-RTX
  execution provider (plugin EP ABI, ORT ≥ 1.24, shipped through Windows ML)
  is the obvious speed-up but is not reachable from `onnxruntime-node` yet.
* The illustration detector is a heuristic; painted art scores like photos
  and is treated as such (detail 0.85, close to its optimum).
* Windows is the tested platform. Other platforms fall back to WebGPU/CPU and
  have not been measured.
* No face-specific stage yet (GFPGAN/GPEN ONNX + YuNet were evaluated, see
  `REFERENCES.md`).
