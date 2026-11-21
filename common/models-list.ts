export const MODELS = {
  "upscayl-standard-4x": {
    id: "upscayl-standard-4x",
  },
  "upscayl-lite-4x": {
    id: "upscayl-lite-4x",
  },
  "high-fidelity-4x": {
    id: "high-fidelity-4x",
  },
  "remacri-4x": {
    id: "remacri-4x",
  },
  "ultramix-balanced-4x": {
    id: "ultramix-balanced-4x",
  },
  "ultrasharp-4x": {
    id: "ultrasharp-4x",
  },
  "digital-art-4x": {
    id: "digital-art-4x",
  },
};

export type ModelId = keyof typeof MODELS;

/** Models served by the Refined (ONNX) engine, in display order. */
export const REFINED_MODELS = [
  "refined-auto",
  "refined-heart-4x",
  "refined-nerve-4x",
  "refined-nerve-2x",
  "refined-pulse-4x",
  "refined-heart-2x",
  "ultrasharp-v2-4x",
  "ultrasharp-v2-lite-4x",
] as const;

export type RefinedModelId = (typeof REFINED_MODELS)[number];

/** Models whose graph exposes the runtime "detail" mix. */
export const DETAIL_MODELS: readonly string[] = ["refined-auto", "refined-heart-4x", "refined-nerve-4x"];

export const isRefinedModel = (id: string) => (REFINED_MODELS as readonly string[]).includes(id) || id.endsWith(".onnx");
