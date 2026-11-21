import { app } from "electron";
import fs from "fs";
import path from "path";

/**
 * Settings the main process needs before any window exists (Chromium
 * switches). Everything else stays in the renderer's localStorage.
 */
export type AppPrefs = {
  /** draw the UI with the GPU (more memory while idle, smoother zooming) */
  uiHardwareAcceleration: boolean;
};

const DEFAULTS: AppPrefs = { uiHardwareAcceleration: false };
const file = () => path.join(app.getPath("userData"), "refined-prefs.json");

export function readAppPrefs(): AppPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeAppPrefs(patch: Partial<AppPrefs>): AppPrefs {
  const next = { ...readAppPrefs(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}
