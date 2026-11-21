# Research references (snapshot 2026-11-21)

Sources that were actually read or checked while designing the Refined
engine. Grouped by what they informed. Dates are publication or last-update
dates where the source states one.

## Models that ship or are offered for download

| Source | What it gave us |
|---|---|
| Phips/HEART, Hugging Face, updated 2026-11-09 — https://huggingface.co/Phips/HEART | 16.7M-param transformer (HAT family, i-LN, RIB position bias). OTF fidelity -> OTF GAN finetune chain, Apache-2.0, CC0 training data, dynamic fp32 ONNX opset 17. Basis of `refined-heart-4x` / `refined-heart-2x`. |
| Phips/NERVE, Hugging Face, updated 2026-11-09 — https://huggingface.co/Phips/NERVE | 1.8M-param pure convolution restorer, release -> OTF fidelity -> OTF GAN chain, Apache-2.0. Basis of `refined-nerve-4x` / `refined-nerve-2x`. |
| Phips/PULSE, Hugging Face, updated 2026-11-09 — https://huggingface.co/Phips/PULSE | 0.35M-param clean upscaler, MIT, no Resize op. Basis of `refined-pulse-4x`. |
| Kim2091/UltraSharpV2, Hugging Face (2025-05-23) — https://huggingface.co/Kim2091/UltraSharpV2 | DAT2 + RealPLKSR Lite, CC BY-NC-SA 4.0, official ONNX. Offered as optional downloads. |
| Kim2091/2x-AnimeSharpV4 (2025-01-07) — https://huggingface.co/Kim2091/2x-AnimeSharpV4 | RCAN anime model, reviewed; not shipped (non-commercial, 2x only). |
| Kim2091-Models releases — https://github.com/Kim2091/Kim2091-Models/releases | 2025-2026 release list (1x-AniRestore TFDAT 2026-02, 1x-DeBink TFDAT 2026-01, 1x-SwatKats DIS 2025-11, 2x-AnimeUp TSPAN 2025-10, 1x-FullTone GateRV3, 1x-SuperScale, GameUp TSCUNet). All CC BY-NC-SA except PBRify (CC0). |
| Phhofm/models — https://github.com/Phhofm/models and releases | 2025 pretrains (BHI realplksr/esc/span/drct), 1xgaterv3_r_restore/_sharpen (2025-10), 2xParagonSR_Nano (2026-11), 4xBHI_dat2_real. |
| OpenModelDB — https://openmodeldb.info and https://github.com/OpenModelDB/open-model-database/commits/main | Additions 2025-11..2026-11: 1x-AzuMPEG (SPAN), 2x-90s-Sonic (Compact/RealPLKSR), 2x-Adore (Real-CUGAN), 1x-Archiver set (ESRGAN), 1x-Book-Compact, UltraSharpV2 entry. |
| OpenModelDB model pages: 4x-UltraSharpV2, 4x-PBRify-RPLKSRd-V3, 4x-PBRify-UpscalerV4, 2x-UniScale-CartoonRestore-lite, 2x-GameUpV2-TSCUNet | Architecture/licence cross-checks. |
| traiNNer-redux — https://github.com/the-database/traiNNer-redux, docs https://trainner-redux.readthedocs.io | Architecture weight classes (SPAN/RealPLKSR/DAT2/HAT/ATD/DRCT), NERVE PR #327 (2026-09). |
| spandrel 0.4.2 (2026-02-21) — https://github.com/chaiNNer-org/spandrel , https://pypi.org/project/spandrel/ | Supported architectures, non-commercial "extra arches" split. |
| OpenCV Zoo YuNet — https://huggingface.co/opencv/face_detection_yunet , 2026may dynamic export https://huggingface.co/pollen-robotics/face_detection_yunet_2026may | Face detector option (MIT) for a future face stage. |
| Face restoration overviews: https://github.com/hpc203/Face-restoration-models , https://visomaster.studio/blog/gfpgan-vs-codeformer-vs-gpen , CodeFormer++ arXiv:2510.04410 | GFPGAN/GPEN/CodeFormer/RestoreFormer ONNX status and licences. |

## Papers and challenge reports (2025-2026)

| Source | Relevance |
|---|---|
| NTIRE 2026 Efficient SR Challenge report, arXiv:2604.03198; code https://github.com/Amazingren/NTIRE2026_ESR (MIT) | Small SR nets are memory-bandwidth bound, not FLOP bound; SPAN-family, pruning + distillation, re-parameterisation. Informed fp16 + fused graphs + fixed tile shapes. |
| NTIRE 2026 Image SR x4 Challenge, arXiv:2604.14558; https://ntire-sr.github.io/2026 | Pre-trained transformers + fine-tuning still the strongest fidelity foundation. |
| NTIRE 2026 Mobile Real-World SR Challenge, arXiv:2604.17306 | One-step diffusion favoured for perceptual quality on mobile; distillation from heavy teachers. |
| Training-Free Model Ensemble for SISR via Strong-Branch Compensation, arXiv:2604.11564 | Image-space blending of a stable and a strong branch beats either alone. We get the same effect at zero extra cost with weight-space interpolation inside one graph. |
| Rank-factorized Implicit Neural Bias / SST, arXiv:2603.06738, https://github.com/dslisleedh/SST | FlashAttention-friendly SR transformers (used by HEART). |
| ESC, arXiv:2503.06671, https://github.com/dslisleedh/ESC | Convolutional emulation of self-attention for efficient SR. |
| UCAN, arXiv:2603.11680 | Lightweight convolution-attention hybrid. |
| Token-Aligned Hierarchies for Lightweight SR, CVPRW 2026 | Depthwise/grouped-conv token mixing. |
| ASID, arXiv:2501.15774; CFSR, arXiv:2401.05633 | Lightweight SR transformer baselines. |
| HAT, arXiv:2205.04437; HAT-iLN, arXiv:2504.06629 | Ancestry of HEART. |
| ESRGAN (network interpolation), arXiv:1809.00219 | Weight-space interpolation between PSNR and GAN checkpoints of one lineage — the "detail" control. |
| StableSR, arXiv:2305.07015 | Wavelet colour correction: low frequencies from the input, high frequencies from the restorer. Basis of the fidelity head. |
| Wavelet-domain losses for artifact control, Korkmaz et al., CVPR 2024 | Separating real HF detail from artifacts. |
| AdaptSR, arXiv:2503.07748 | LoRA adaptation for efficient real-world SR. |
| PhoenixSR, arXiv:2609.30988; Difficulty-aware dynamic routing for diffusion SR, arXiv:2607.15711; DreamSR, arXiv:2605.15682 | 2026 work on efficient real-world/diffusion SR and routing. |
| AdaRefSR (ICLR 2026), https://github.com/vivoCameraResearch/AdaRefSR | One-step diffusion SR: 12.66 GB at 512² — too heavy for a lightweight container. |
| FlashVSR (CVPR 2026), https://github.com/OpenImagingLab/FlashVSR; PS-SR (CVPR 2026) | One-step diffusion video SR, reviewed for scope. |
| SeedVR2 notes: https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler , https://seedvr2.net/blog/tutorials/seedvr2-comfyui-low-vram-guide-2026 | 16 GB needs FP8 + block swap; rejected for idle/size budget. |
| AIM 2025 Efficient Perceptual SR, arXiv:2510.12765 | Real-ESRGAN-class quality under 5M params. |
| Adversarial Diffusion Compression (AdcSR), CVPR 2025 | Diffusion/GAN hybrid reference point. |
| Divide and Restore (routing), arXiv:2603.28658; LightBSR, arXiv:2506.22710; blind SR baselines arXiv:2205.04910 | Explicit degradation diagnosis before restoration — informs the analyzer-driven Auto route. |
| Ordinal degradation representations, arXiv:2512.10340; CDCL implicit degradation, arXiv:2408.05440 | Degradation estimation background. |
| Overlap-add with Hann windows, arXiv:2610.20305; seam write-ups https://discuss.pytorch.org/t/225886 , https://dev.to/elise_moreau/the-seam-our-tiled-upscaler-left-on-every-4k-product-render-pf5 | Raised-cosine blending, global normalisation, uniform tile shapes. |
| Immerkaer, "Fast Noise Variance Estimation", CVIU 1996 | Noise estimator in the analyzer. |
| Wang, Sheikh, Bovik, "No-reference perceptual quality assessment of JPEG compressed images", ICIP 2002 | Block-boundary statistic in the analyzer. |

## Runtime and platform

| Source | Relevance |
|---|---|
| onnxruntime-node 1.31.1 (npm) — https://www.npmjs.com/package/onnxruntime-node | DirectML + WebGPU EPs on Windows; measured here: DML has no GPU kernel for cubic Resize (CPU fallback, 45x slowdown), WebGPU is fast for convs but slow for attention. Float16Array I/O bug on Node >= 26. |
| ONNX Runtime EP docs — https://onnxruntime.ai/docs/execution-providers/ , WebGPU EP, DirectML (sustained engineering), Windows guidance | Provider selection. |
| NVIDIA TensorRT-RTX EP — https://onnxruntime.ai/docs/execution-providers/TensorRTRTX-ExecutionProvider.html , https://pypi.org/project/onnxruntime-ep-nv-tensorrt-rtx/ , https://github.com/NVIDIA/TensorRT-RTX-EP-ABI/releases , KB5136900 (2026-11-19) | Future fast path for RTX cards (plugin EP ABI, ORT >= 1.24). Not reachable from onnxruntime-node yet. |
| ONNX float16 conversion — https://onnxruntime.ai/docs/performance/model-optimizations/float16.html ; LayerNorm fp16 overflow thread (NVIDIA forums) | keep_io_types, block lists, overflow checks; HEART fp16 verified at 79 dB vs fp32. |
| sharp 0.35.5 / libvips 8.18 | Decode/encode/resize, lazy-loaded in the engine process only. |
| Electron performance guide — https://electronjs.org/docs/latest/tutorial/performance ; Discord Electron 42 report, Windows Latest 2026-09-27 | Idle footprint work: lazy modules, single renderer, no background networking. |
| upscayl-ncnn releases — https://github.com/upscayl/upscayl-ncnn/releases | Classic engine binary (20251207). |
