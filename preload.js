const { contextBridge, ipcRenderer } = require("electron");

/* 待办卡不用系统磨砂（页面自绘透明），但保留这个开关：页面靠它决定走哪套底色 */
const ACRYLIC = process.argv.some((a) => a === "--wgt-acrylic=1");

contextBridge.exposeInMainWorld("wgt", {
  acrylic: ACRYLIC,
  close: () => ipcRenderer.send("wgt:close"),
  menu: () => ipcRenderer.send("wgt:menu"),
  /* 鼠标指上来时临时浮到最前，移开还原（临时状态，不写存档） */
  raise: () => ipcRenderer.send("wgt:raise"),
  rest: () => ipcRenderer.send("wgt:rest"),
  /* 系统光标是否还在窗口矩形内（主进程按 90ms 轮询，只在变化时推）。
     页面自己的 mouseleave 在窗口重排时会误报，收起这件事以这条为准。 */
  onCursor: (fn) => ipcRenderer.on("wgt:cursor", (_e, p) => fn(p || {})),
  /* 原生 caption 拖动开始 / 停下（主进程按 will-move / move 判），
     页面据此把卡片退成"只剩任务框"的样子，方便看对齐 */
  onDragLook: (fn) => ipcRenderer.on("wgt:drag-look", (_e, p) => fn(p || {})),
  /* 中键拖动：顶栏只有 22px 高，中键够不着原生拖动区，
     改成页面按屏幕坐标算位移，由主进程照着挪窗口 */
  dragBegin: () => ipcRenderer.send("wgt:drag-begin"),
  dragMove: (dx, dy) => ipcRenderer.send("wgt:drag-move", dx, dy),
  dragEnd: () => ipcRenderer.send("wgt:drag-end"),
  /* 待办卡片 */
  onFocusInput: (fn) => ipcRenderer.on("todo:focus-input", () => fn()),
  onClearDone: (fn) => ipcRenderer.on("todo:clear-done", () => fn()),
  onShowHistory: (fn) => ipcRenderer.on("todo:show-history", () => fn()),
  /* 按内容高度改窗口。传 {h, top, topMin}：
     h=卡片高度，top=待办区上沿距卡片顶的距离，topMin=收起时的 top。
     主进程靠 top 的变化反推窗口该往上挪多少，让条目在屏幕上不动。 */
  setCardHeight: (msg) => ipcRenderer.invoke("wgt:set-card-height", msg),
});
