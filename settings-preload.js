const { contextBridge, ipcRenderer } = require("electron");

/* 设置浮窗专用的最小桥 */
/* 页面里读不到 process（nodeIntegration 关闭），主题只能由 preload 传过去 */
const themeArg = process.argv.find((a) => a.startsWith("--wgt-theme="));
const THEME = themeArg ? themeArg.split("=")[1] : "dark";

contextBridge.exposeInMainWorld("st", {
  theme: THEME,
  get: () => ipcRenderer.invoke("wgt:get-look"),
  set: (v) => ipcRenderer.invoke("wgt:set-look", v),
  close: () => ipcRenderer.send("wgt:close-settings"),
  dragBegin: () => ipcRenderer.send("wgt:settings-drag-begin"),
  dragEnd: () => ipcRenderer.send("wgt:settings-drag-end"),
});
