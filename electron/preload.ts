import { ipcRenderer, contextBridge, webUtils, type IpcRendererEvent } from "electron";
import {
  getAppVersion,
  getDeviceSpecs,
  getPlatform,
} from "./utils/get-device-specs";

// 'ipcRenderer' will be available in index.js with the method 'window.electron'
contextBridge.exposeInMainWorld("electron", {
  send: (command: string, payload: any) => ipcRenderer.send(command, payload),
  /** Subscribe; the returned function removes this listener again. */
  on: (command: string, func: (...args: any) => any) => {
    const listener = (event: IpcRendererEvent, args: any) => func(event, args);
    ipcRenderer.on(command, listener);
    return () => ipcRenderer.removeListener(command, listener);
  },
  invoke: (command: string, payload: any) =>
    ipcRenderer.invoke(command, payload),
  /** File.path is gone since Electron 32; resolve dropped files here. */
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: getPlatform(),
  getSystemInfo: async () => await getDeviceSpecs(),
  getAppVersion: async () => await getAppVersion(),
});
