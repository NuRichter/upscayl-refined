import { getMainWindow } from "../main-window";
import { childProcesses, setStopped } from "../utils/config-variables";
import logit from "../utils/logit";
import { stopRefined } from "./refined-upscayl";

const stop = async (event, payload) => {
  const mainWindow = getMainWindow();

  setStopped(true);
  mainWindow && mainWindow.setProgressBar(-1);
  stopRefined();
  childProcesses.forEach((child) => {
    logit("🛑 Stopping Upscaling Process", child.process.pid);
    child.kill();
  });
};

export default stop;
