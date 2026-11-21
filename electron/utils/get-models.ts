import fs from "fs";
import logit from "./logit";
import { MessageBoxOptions, dialog } from "electron";

/**
 * Lists models in a custom folder: NCNN pairs (.param + .bin) run on the
 * classic upscayl-bin engine, .onnx files run on the Refined engine.
 */
const getModels = async (folderPath: string | undefined) => {
  const models: string[] = [];

  const invalid = () => {
    logit("❌ Invalid Custom Model Folder Detected");
    const options: MessageBoxOptions = {
      type: "error",
      title: "Invalid Folder",
      message:
        "The selected folder does not contain valid model files. Use NCNN '.param' + '.bin' pairs or '.onnx' models.",
      buttons: ["OK"],
    };
    dialog.showMessageBoxSync(options);
    return null;
  };

  if (!folderPath || !fs.existsSync(folderPath)) return invalid();

  for (const file of fs.readdirSync(folderPath)) {
    const lower = file.toLowerCase();
    if (lower.endsWith(".param") || lower.endsWith(".bin") || lower.endsWith(".onnx")) {
      const modelName = file.substring(0, file.lastIndexOf(".")) || file;
      if (!models.includes(modelName)) models.push(modelName);
    }
  }

  if (!models.length) return invalid();
  logit("🔎 Detected Custom Models: ", models);
  return models;
};

export default getModels;
