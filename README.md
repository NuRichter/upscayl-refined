<div align="center">

# Upscayl Refined

**NuRichter Refined Nov Ver.** — a fork of [Upscayl](https://github.com/upscayl/upscayl) 2.15
with a new hybrid processing core. Same simple window, newer models, lighter when idle.

<img src="renderer/public/model-comparison/refined-auto/after.webp" width="420" alt="Refined Auto result" />

</div>

## What changed

| | Upscayl 2.15 | Upscayl Refined 3.0 |
|---|---|---|
| Engine | NCNN/Vulkan (`upscayl-bin`), ESRGAN-era models | **Refined engine** (ONNX Runtime, DirectML/WebGPU/CPU) **plus** the classic engine |
| Newest model | 2023–2024 ESRGAN variants | HEART / NERVE / PULSE (Nov 2026), network-interpolated, colour-locked |
| Per-image routing | — | **Refined Auto**: analyses JPEG blocking, noise, blur, art vs photo, picks model and detail |
| Detail control | — | one slider: faithful ↔ sharp (weight-space interpolation, no extra cost) |
| Idle footprint* | 4 processes, 418 MB, 187 MB private | **3 processes, 330 MB, 135 MB private**, 0 % CPU |
| AI engine at idle | — | not running; starts on the first job, exits after 45 s |
| Network at idle | analytics, news fetch, update check | **none** (only model downloads you ask for) |
| Inputs | png, jpg, webp | + avif, tiff, bmp |

\*Windows 11, RTX 5060 Ti, measured with `qa/idle_bench.mjs`.

Quality on 30 images × 4 degradations (details in
[docs/REFINED_ENGINE.md](docs/REFINED_ENGINE.md)):

| | PSNR clean / web / heavy / soft | mean LPIPS ↓ |
|---|---|---|
| Classic: Upscayl Standard | 27.29 / 26.11 / 25.53 / 27.25 | 0.254 |
| **Refined Auto** | **28.71 / 26.77 / 26.21 / 28.72** | **0.220** |

## Models

| Model | Best for | Licence | Shipped |
|---|---|---|---|
| Refined Auto (Smart Hybrid) | anything; picks HEART ≤ 8 MP, NERVE above | — | ✓ |
| Refined HEART 4x | best quality photos/art (transformer) | Apache-2.0 | ✓ |
| Refined NERVE 4x | fast restoration of photos, JPEGs, phone shots | Apache-2.0 | ✓ |
| Refined NERVE 2x | fast native 2x | Apache-2.0 | ✓ |
| Refined PULSE 4x | instant, clean inputs | MIT | ✓ |
| Refined HEART 2x | clean native 2x | Apache-2.0 | download |
| UltraSharp V2 / V2 Lite | art and illustrations | CC BY-NC-SA 4.0 | download |
| Upscayl classic models (7) | as before | see upstream | ✓ |

Custom models: drop `.onnx` files (Refined engine) or `.param/.bin` pairs
(classic engine) in a folder named `models` and pick it in Settings.

## Use

Download the installer from [Releases](https://github.com/NuRichter/upscayl-refined/releases).
It installs per user next to the original Upscayl without touching it.

Headless:

```
node export/electron/engine/cli.js -i photo.jpg -o photo_4x.png -m refined-auto
node export/electron/engine/cli.js -i photo.jpg --analyze
```

## Build

```
npm install
npm run build          # tsc + translations + Next static export
npm test               # engine unit tests
npx electron-builder --win
```

Rebuild the Refined models from their pinned upstream checkpoints
(Python with `onnx onnxruntime onnxconverter-common numpy`):

```
python -I tools/model-forge/build.py
```

## Docs

* [docs/REFINED_ENGINE.md](docs/REFINED_ENGINE.md) — architecture, model forge, QA numbers
* [docs/REFERENCES.md](docs/REFERENCES.md) — sources behind the design
* [resources/refined-models/NOTICE.md](resources/refined-models/NOTICE.md) — model licences and changes
* [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md) — the original Upscayl README

## Credits

Upscayl by Nayam Amarshe and TGS963 and its contributors (AGPL-3.0).
HEART, NERVE and PULSE by Philip Hofmann (Phhofm). UltraSharp V2 by Kim2091.
Real-ESRGAN by Xintao Wang et al. ONNX Runtime by Microsoft. sharp/libvips.

Licensed under AGPL-3.0, like Upscayl.
