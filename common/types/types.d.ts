import { ImageFormat } from "@electron/types/types";

/** Options that only the Refined (ONNX) engine reads. */
export type RefinedOptions = {
  /** 0..1 network-interpolation mix: 0 = faithful, 1 = sharp texture; <0 = model/auto default */
  detail?: number;
  /** keep the input colors in the low-frequency band (default true) */
  chromaLock?: boolean;
  backend?: "auto" | "dml" | "webgpu" | "cpu";
};

export type ImageUpscaylPayload = {
  imagePath: string;
  outputPath: string;
  scale: string;
  model: string;
  gpuId: string;
  saveImageAs: ImageFormat;
  overwrite: boolean;
  compression: string;
  noImageProcessing: boolean;
  customWidth: string;
  useCustomWidth: boolean;
  tileSize: number;
  ttaMode: boolean;
  copyMetadata: boolean;
  refined?: RefinedOptions;
};

export type DoubleUpscaylPayload = {
  model: string;
  /**
   * The path to the image to upscale.
   */
  imagePath: string;
  outputPath: string;
  scale: string;
  gpuId: string;
  saveImageAs: ImageFormat;
  compression: string;
  noImageProcessing: boolean;
  customWidth: string;
  useCustomWidth: boolean;
  tileSize: number;
  ttaMode: boolean;
  copyMetadata: boolean;
  refined?: RefinedOptions;
};

export type BatchUpscaylPayload = {
  batchFolderPath: string;
  outputPath: string;
  model: string;
  gpuId: string;
  saveImageAs: ImageFormat;
  scale: string;
  compression: string;
  noImageProcessing: boolean;
  customWidth: string;
  useCustomWidth: boolean;
  tileSize: number;
  ttaMode: boolean;
  copyMetadata: boolean;
  refined?: RefinedOptions;
};
