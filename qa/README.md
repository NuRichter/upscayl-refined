# QA harness

Run from this folder after `npm run build` (and `electron-builder --dir` for the
app tests). Python needs numpy, pillow, scikit-image, torch and lpips.

| Script | Purpose |
|---|---|
| `make_scenarios.py` | Kodak 24 (+ optional crops from `QA_USER_IMAGES`) -> 4 degradations in `data/lr` |
| `run_all.py [configs]` | runs Refined configs through the engine CLI and the classic `upscayl-bin` |
| `metrics.py` | PSNR/SSIM (Y) + LPIPS-alex -> `results/results.csv` and a summary table |
| `idle_bench.mjs <exe> <label> [switches]` | idle footprint of a build (process tree) |
| `e2e.mjs <exe> <outDir>` | 16 end-to-end checks over the DevTools protocol |
| `e2e_ui.mjs <exe> <outDir>` | drag-and-drop, button, viewer and paste checks |

`results/` holds the numbers quoted in `docs/REFINED_ENGINE.md`.
