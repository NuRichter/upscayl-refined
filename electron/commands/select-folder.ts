import { dialog } from "electron";
import {
  savedBatchUpscaylFolderPath,
  setSavedBatchUpscaylFolderPath,
} from "../utils/config-variables";
import logit from "../utils/logit";

const selectFolder = async () => {
  const { canceled, filePaths: folderPaths } = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    defaultPath: savedBatchUpscaylFolderPath,
  });

  if (canceled || !folderPaths.length) {
    logit("🚫 Select Folder Operation Cancelled");
    return null;
  }
  setSavedBatchUpscaylFolderPath(folderPaths[0]);
  logit("📁 Selected Folder Path: ", savedBatchUpscaylFolderPath);
  return folderPaths[0];
};

export default selectFolder;
