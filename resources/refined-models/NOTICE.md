# Refined models — notices

The `refined-*.onnx` graphs are derivative works of models by Philip Hofmann
(Phhofm), modified by the Upscayl Refined model forge
(`tools/model-forge/`). Modifications, per model:

| File | Upstream source (pinned revision) | Upstream licence | Changes |
|---|---|---|---|
| refined-heart-4x-v1.fp16.onnx | Phips/HEART `heart_4x_otf_v2` + `heart_4x_otf_gan` @ cdad6800 | Apache-2.0 (LICENSE-HEART.txt) | both weight sets combined with a runtime interpolation input; low-frequency colour-fidelity head appended; converted to float16 |
| refined-heart-2x-v1.fp16.onnx | Phips/HEART `heart_2x` @ cdad6800 | Apache-2.0 (LICENSE-HEART.txt) | colour-fidelity head appended; float16 |
| refined-nerve-4x-v1.fp16.onnx | Phips/NERVE `4x_NERVE_OTF_fidelity` + `4x_NERVE_OTF_gan` @ f096235d | Apache-2.0 (LICENSE-NERVE.txt) | bicubic Resize replaced by an equivalent convolution; runtime interpolation input; colour-fidelity head; float16 |
| refined-nerve-2x-v1.fp16.onnx | Phips/NERVE `2x_NERVE_OTF_gan` @ f096235d | Apache-2.0 (LICENSE-NERVE.txt) | bicubic Resize replaced; colour-fidelity head; float16 |
| refined-pulse-4x-v1.fp16.onnx | Phips/PULSE `4x_pulse` @ 88198f08 | MIT, Copyright (c) 2026 Philip Hofmann (LICENSE-PULSE.txt) | colour-fidelity head; float16 |

All of these were trained by their author on CC0 / public-domain images only.

Optional downloads that are **not** redistributed by this project and are
fetched from their original location on request:

* UltraSharp V2 and UltraSharp V2 Lite by Kim2091 — CC BY-NC-SA 4.0
  (non-commercial). https://huggingface.co/Kim2091/UltraSharpV2

The classic engine models in `resources/models` come from upstream Upscayl;
see the repository README and `Real-ESRGAN_LICENSE.txt`.
