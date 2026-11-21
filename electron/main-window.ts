import { app, BrowserWindow, shell } from "electron";
import { getPlatform } from "./utils/get-device-specs";
import { join } from "path";
import { ELECTRON_COMMANDS } from "../common/electron-commands";
import { fetchLocalStorage } from "./utils/config-variables";
import electronIsDev from "electron-is-dev";
import { pathToFileURL } from "url";

let mainWindow: BrowserWindow | undefined;

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    icon: join(__dirname, "build", "icon.png"),
    width: 1300,
    height: 940,
    minHeight: 500,
    minWidth: 600,
    show: false,
    backgroundColor: "#171717",
    webPreferences: {
      // The renderer only talks to the main process through the preload bridge.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // file:// previews of user images need this; there is no remote content.
      webSecurity: false,
      spellcheck: false,
      backgroundThrottling: true,
      v8CacheOptions: "bypassHeatCheck",
      preload: join(__dirname, "preload.js"),
    },
    titleBarStyle: getPlatform() === "mac" ? "hiddenInset" : "default",
  });

  const url = electronIsDev
    ? "http://localhost:8000"
    : pathToFileURL(join(__dirname, "../../renderer/out/index.html")).toString();

  mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Never navigate the app window away from the bundled UI.
  mainWindow.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith("file://") && !target.startsWith("http://localhost:8000")) {
      e.preventDefault();
      if (/^https?:\/\//.test(target)) shell.openExternal(target);
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    mainWindow.show();
  });

  // Free renderer caches while the window is hidden or minimised.
  mainWindow.on("minimize", () => mainWindow?.webContents.session.clearCache().catch(() => {}));

  fetchLocalStorage();

  mainWindow.webContents.send(ELECTRON_COMMANDS.OS, getPlatform());
  mainWindow.setMenuBarVisibility(false);
};

const getMainWindow = () => {
  return mainWindow;
};

export { createMainWindow, getMainWindow, app };
