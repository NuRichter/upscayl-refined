/**
 * Shared types for the Refined engine. The engine runs in its own process
 * (Electron utilityProcess or plain Node for the CLI) and never touches
 * Electron APIs, so it can be tested headless.
 */

export type ExecutionProvider = "dml" | "webgpu" | "cpu";

export type ModelManifestEntry = {
  id: string;
  name: string;
  /** file name inside a models directory */
  file: string;
  /** where the model manager downloads it from when not bundled */
  url?: string;
  sha256?: string;
  bytes?: number;
  license: string;
  source: string;
  scale: number;
  arch: string;
  /** execution providers in order of preference */
  ep: ExecutionProvider[];
  /** tile edge in input pixels */
  tile: number;
  /** overlap in input pixels on each shared edge */
  overlap: number;
  /** input sizes are rounded up to this multiple (window size) */
  multiple?: number;
  /** graph has a runtime "detail" input (network interpolation) */
  detail?: boolean;
  /** graph has a runtime "fidelity" input ([chroma, luma]) */
  fidelity?: boolean;
  defaultDetail?: number;
  bundled?: boolean;
  /** relative speed hint, input megapixels per second on a mid-range GPU */
  speedHint?: number;
  tags?: string[];
};

export type Analysis = {
  width: number;
  height: number;
  hasAlpha: boolean;
  /** block-boundary gradient ratio, ~1.0 = no JPEG blocking */
  blockiness: number;
  /** estimated Gaussian noise sigma on a 0..255 scale */
  noiseSigma: number;
  /** mean gradient energy of luma (content dependent) */
  sharpness: number;
  /** 2*|d1|/|d2| luma difference ratio: ~2 = crisp/noisy, ~1 = smooth/blurred */
  acutance: number;
  /** 0..1, how illustration-like the image looks (flat areas, few colors) */
  artScore: number;
  /** rough quality label used for routing and logs */
  label: "clean" | "soft" | "compressed" | "noisy" | "heavy";
  ms: number;
};

export type JobOptions = {
  input: string;
  output: string;
  /** model id from the manifest, or "refined-auto" */
  model: string;
  /** directories searched for model files, first hit wins */
  modelDirs: string[];
  /** final scale relative to the input; ignored when customWidth > 0 */
  scale: number;
  customWidth?: number;
  format: "png" | "jpg" | "jpeg" | "webp";
  /** 0..100, used for jpg/webp quality and png effort */
  compression: number;
  /** 0..1, overrides the model default when set */
  detail?: number;
  /** [chroma, luma] low-frequency fidelity weights 0..1 */
  fidelity?: [number, number];
  /** override tile edge in input px (0/undefined = manifest) */
  tile?: number;
  ep?: ExecutionProvider | "auto";
  gpuId?: number;
  /** run the model twice (double upscayl) */
  passes?: number;
  /** test-time augmentation (8 flips/rotations), slow */
  tta?: boolean;
};

export type JobStats = {
  model: string;
  ep: ExecutionProvider;
  analysis?: Analysis;
  detail?: number;
  fidelity?: [number, number];
  tiles: number;
  inferenceMs: number;
  totalMs: number;
  outWidth: number;
  outHeight: number;
};

export type ProgressFn = (p: { pct: number; stage: string; detail?: string }) => void;

export type WorkerRequest =
  | { type: "job"; id: string; job: JobOptions; manifest: ModelManifestEntry[] }
  | { type: "analyze"; id: string; input: string }
  | { type: "cancel"; id: string }
  | { type: "config"; keepWarmSec: number }
  | { type: "shutdown" };

export type WorkerResponse =
  | { type: "ready"; pid: number }
  | { type: "progress"; id: string; pct: number; stage: string; detail?: string }
  | { type: "log"; message: string }
  | { type: "done"; id: string; output: string; stats: JobStats }
  | { type: "analysis"; id: string; analysis: Analysis }
  | { type: "error"; id: string; message: string }
  | { type: "idle-exit" };
