import prepareNext from "electron-next";
import log from "electron-log";
import { app, ipcMain, net, protocol } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { ELECTRON_COMMANDS } from "../common/electron-commands";
import logit from "./utils/logit";
import openFolder from "./commands/open-folder";
import stop from "./commands/stop";
import selectFolder from "./commands/select-folder";
import selectFile from "./commands/select-file";
import getModelsList from "./commands/get-models-list";
import customModelsSelect from "./commands/custom-models-select";
import imageUpscayl from "./commands/image-upscayl";
import { createMainWindow, getMainWindow } from "./main-window";
import { execPath, modelsPath } from "./utils/get-resource-paths";
import batchUpscayl from "./commands/batch-upscayl";
import doubleUpscayl from "./commands/double-upscayl";
import pasteImage from "./commands/paste-image";
import {
  bundledRefinedDir,
  deleteRefinedModel,
  downloadRefinedModel,
  modelsStatus,
  userRefinedDir,
} from "./utils/refined-models";
import { setKeepWarm } from "./utils/refined-engine-host";
import { readAppPrefs, writeAppPrefs } from "./utils/app-prefs";

// ---------------------------------------------------------------------------
// Idle footprint. The UI is a static page; keep Chromium's background work low.
// Measured on Windows 11 (docs/REFINED_ENGINE.md): software compositing plus an
// in-process network service take the idle app from 4 processes / 401 MB to
// 3 processes / 321 MB working set (private 328 -> 129 MB). The AI engine has
// its own GPU context, so this only affects how the UI itself is drawn.
const prefs = readAppPrefs();
if (!prefs.uiHardwareAcceleration) app.disableHardwareAcceleration();
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,SpareRendererForSitePerProcess,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,OptimizationHints");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");
app.commandLine.appendSwitch("renderer-process-limit", "1");
app.commandLine.appendSwitch("js-flags", "--max-semi-space-size=2 --optimize-for-size");

protocol.registerSchemesAsPrivileged([
  { scheme: "public", privileges: { secure: true, supportFetchAPI: true } },
  // local image previews: media:///C%3A/path/to/image.png
  { scheme: "media", privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

log.initialize({ preload: true });
// One instance is enough; a second launch focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = getMainWindow();
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
}

app.on("ready", async () => {
  await prepareNext("./renderer");

  // Image previews: the renderer URI-encodes every path segment.
  try {
    protocol.handle("media", (request) => {
      const filePath = decodeURIComponent(request.url.replace(/^media:\/\/\/?/, ""));
      return net.fetch(pathToFileURL(filePath).toString());
    });
  } catch (e) {
    log.error("media protocol:", e);
  }
  try {
    protocol.handle("public", (request) => {
      const rel = decodeURIComponent(request.url.replace(/^public:\/\/\/?/, ""));
      const file = path.join(
        app.getAppPath(),
        "renderer",
        process.env.NODE_ENV === "development" ? "public" : "out",
        rel,
      );
      return net.fetch(pathToFileURL(file).toString());
    });
  } catch (e) {
    log.error("public protocol:", e);
  }

  createMainWindow();

  log.info("🆙 Upscayl Refined version:", app.getVersion());
  log.info("🚀 UPSCAYL EXEC PATH: ", execPath);
  log.info("🚀 MODELS PATH: ", modelsPath);
  log.info("🧠 REFINED MODELS: ", bundledRefinedDir, userRefinedDir);
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.on(ELECTRON_COMMANDS.STOP, stop);
ipcMain.on(ELECTRON_COMMANDS.OPEN_FOLDER, openFolder);
ipcMain.handle(ELECTRON_COMMANDS.SELECT_FOLDER, selectFolder);
ipcMain.handle(ELECTRON_COMMANDS.SELECT_FILE, selectFile);
ipcMain.on(ELECTRON_COMMANDS.GET_MODELS_LIST, getModelsList);
ipcMain.handle(ELECTRON_COMMANDS.SELECT_CUSTOM_MODEL_FOLDER, customModelsSelect);
ipcMain.on(ELECTRON_COMMANDS.UPSCAYL, imageUpscayl);
ipcMain.on(ELECTRON_COMMANDS.FOLDER_UPSCAYL, batchUpscayl);
ipcMain.on(ELECTRON_COMMANDS.DOUBLE_UPSCAYL, doubleUpscayl);
ipcMain.on(ELECTRON_COMMANDS.PASTE_IMAGE, pasteImage);

// Refined model manager
ipcMain.handle(ELECTRON_COMMANDS.REFINED_MODELS_STATUS, () => modelsStatus());
ipcMain.handle(ELECTRON_COMMANDS.REFINED_MODEL_DOWNLOAD, async (_e, id: string) => {
  const w = getMainWindow();
  try {
    await downloadRefinedModel(id, (received, total) =>
      w?.webContents.send(ELECTRON_COMMANDS.REFINED_MODEL_DOWNLOAD_PROGRESS, { id, received, total }),
    );
    return { ok: true };
  } catch (e: any) {
    logit("❌ Model download failed:", e?.message ?? e);
    return { ok: false, error: String(e?.message ?? e) };
  }
});
ipcMain.handle(ELECTRON_COMMANDS.REFINED_MODEL_DELETE, (_e, id: string) => {
  deleteRefinedModel(id);
  return modelsStatus();
});
ipcMain.on(ELECTRON_COMMANDS.REFINED_ENGINE_CONFIG, (_e, cfg: { keepWarmSec?: number }) => {
  if (typeof cfg?.keepWarmSec === "number") setKeepWarm(cfg.keepWarmSec);
});
ipcMain.handle(ELECTRON_COMMANDS.APP_PREFS, (_e, patch?: Record<string, unknown>) =>
  patch ? writeAppPrefs(patch) : readAppPrefs(),
);

ipcMain.handle("get-gpu-info", async () => {
  try {
    return await app.getGPUInfo("basic");
  } catch (error) {
    console.error("Failed to get GPU info:", error);
    return null;
  }
});

ipcMain.handle("get-app-version", () => `${app.getVersion()} Refined`);
