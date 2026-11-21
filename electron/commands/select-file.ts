import { MessageBoxOptions, dialog } from "electron";
import path from "path";
import { getMainWindow } from "../main-window";
import { savedImagePath, setSavedImagePath } from "../utils/config-variables";
import logit from "../utils/logit";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "jfif", "webp", "avif", "tif", "tiff", "bmp"];

const selectFile = async () => {
  const mainWindow = getMainWindow();

  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openFile"],
    title: "Select Image",
    defaultPath: savedImagePath,
    message: "Select Image to Upscale",
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
  });

  if (canceled || !filePaths.length) {
    logit("🚫 File Operation Cancelled");
    return null;
  }
  setSavedImagePath(filePaths[0]);

  const ext = path.extname(filePaths[0]).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    logit("❌ Invalid File Detected");
    const options: MessageBoxOptions = {
      type: "error",
      title: "Invalid File",
      message: "The selected file is not a supported image (png, jpg, webp, avif, tiff, bmp).",
    };
    if (!mainWindow) return null;
    dialog.showMessageBoxSync(mainWindow, options);
    return null;
  }

  logit("📄 Selected File Path: ", filePaths[0]);
  return filePaths[0];
};

export default selectFile;
