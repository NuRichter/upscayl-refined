import { MessageBoxOptions, dialog } from "electron";
import path from "path";
import {
  savedCustomModelsPath,
  setSavedCustomModelsPath,
} from "../utils/config-variables";
import logit from "../utils/logit";
import { ELECTRON_COMMANDS } from "../../common/electron-commands";
import getModels from "../utils/get-models";
import { getMainWindow } from "../main-window";

const customModelsSelect = async () => {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;

  const { canceled, filePaths: folderPaths } = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Select Custom Models Folder",
    defaultPath: savedCustomModelsPath,
    message: "Select the custom models folder (named 'models')",
  });

  if (canceled || !folderPaths.length) {
    logit("🚫 Select Custom Models Folder Operation Cancelled");
    return null;
  }
  setSavedCustomModelsPath(folderPaths[0]);

  if (path.basename(path.resolve(folderPaths[0])) !== "models") {
    logit("❌ Invalid Custom Models Folder Detected: Not a 'models' folder");
    const options: MessageBoxOptions = {
      type: "error",
      title: "Invalid Folder",
      message: "Please make sure that the folder name is 'models' and nothing else.",
      buttons: ["OK"],
    };
    dialog.showMessageBoxSync(options);
    return null;
  }

  const models = await getModels(savedCustomModelsPath);
  mainWindow.webContents.send(ELECTRON_COMMANDS.CUSTOM_MODEL_FILES_LIST, models);
  logit("📁 Custom Folder Path: ", savedCustomModelsPath);
  return savedCustomModelsPath;
};

export default customModelsSelect;
