const { contextBridge, ipcRenderer } = require("electron");

/* 待办卡不用系统磨砂（页面自绘透明），但保留这个开关：页面靠它决定走哪套底色 */
const ACRYLIC = process.argv.some((a) => a === "--wgt-acrylic=1");

contextBridge.exposeInMainWorld("wgt", {
  acrylic: ACRYLIC,
  close: () => ipcRenderer.send("wgt:close"),
  menu: () => ipcRenderer.send("wgt:menu"),
  /* 系统光标是否还在窗口矩形内（主进程按 90ms 轮询，只在变化时推）。
     页面自己的 mouseleave 在窗口重排时会误报，收起这件事以这条为准。 */
  onCursor: (fn) => ipcRenderer.on("wgt:cursor", (_e, p) => fn(p || {})),
  /* 原生 caption 拖动开始 / 停下（主进程按 will-move / move 判），
     页面据此把卡片退成"只剩任务框"的样子，方便看对齐 */
  onDragLook: (fn) => ipcRenderer.on("wgt:drag-look", (_e, p) => fn(p || {})),
  /* 拖动窗口：左键抓顶栏、中键按住都走这条。
     页面只报"哪个键按下 / 松开"，位移由主进程每 8ms 跟着系统光标直接搬窗口
     —— 页面算位移再逐帧 IPC 会慢半拍（窗口一动 mousemove 就被节流）。
     btn：0=左键 1=中键。 */
  dragBegin: (btn) => ipcRenderer.send("wgt:drag-begin", btn === 1 ? 1 : 0),
  /* 仅在没有 koffi 的老环境里兜底用 */
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
  /* 窗口形状：报"真正画了东西的矩形"（CSS px，相对窗口客户区）。
     桌面层里窗口是 Progman 的子窗口，透明像素能透壁纸、透不出图标层，
     所以窗口矩形必须和视觉一致 —— 见 main.js 的 applyRegion。
     传空数组 = 恢复整窗。 */
  setRegion: (rects) => ipcRenderer.send("wgt:set-region", rects),
  /* 桌面快照背景：主进程裁好一块"卡片底下的桌面"（壁纸+图标）推过来，
     页面铺在卡片最底下。真透明在桌面层里只能透壁纸，这是让图标"透出来"的唯一办法。 */
  backdropNow: () => ipcRenderer.invoke("wgt:backdrop-now"),
  onBackdrop: (fn) => ipcRenderer.on("wgt:backdrop", (_e, p) => fn(p || {})),
  /* 拖动实况：整幅快照 + 每 tick 窗口坐标（png 转 Uint8Array 才能过 contextBridge） */
  onBdFull: (fn) => ipcRenderer.on("wgt:bd-full", (_e, p) => fn(p && { ...p, png: new Uint8Array(p.png) })),
  onBdPos: (fn) => ipcRenderer.on("wgt:bd-pos", (_e, p) => fn(p || {})),
  onBdDragEnd: (fn) => ipcRenderer.on("wgt:bd-drag-end", () => fn()),
  /* 外观设置：透明度 / 磨砂 */
  getLook: () => ipcRenderer.invoke("wgt:get-look"),
  setLook: (v) => ipcRenderer.invoke("wgt:set-look", v),
  /* 真透明模式：页面据此关掉桌面快照层，让真实的背景透上来 */
  onNoReg: (fn) => ipcRenderer.on("wgt:noreg", (_e, v) => fn(!!v)),
  onSetFullmode: (cb) => ipcRenderer.on("todo:set-fullmode", (e, v) => cb(v)),
  onShowLook: (fn) => ipcRenderer.on("todo:show-look", () => fn()),
  /* 桌面层输入桥：卡片是 Progman 子窗口拿不到键盘焦点，打字由主进程的
     隐形输入窗代收（见 main.js「桌面层输入桥」）。focusin 时报输入框
     屏幕矩形和现有文字；主进程把幽灵窗摆过去代收并实时镜像回来。 */
  imeBegin: (rect) => ipcRenderer.send("wgt:ime-begin", rect),
  imeEnd: () => ipcRenderer.send("wgt:ime-end"),
  onImeText: (fn) => ipcRenderer.on("todo:ime-text", (_e, v) => fn(v)),
  onImeCommit: (fn) => ipcRenderer.on("todo:ime-commit", () => fn()),
  onImeCancel: (fn) => ipcRenderer.on("todo:ime-cancel", () => fn()),
  onImeBlur: (fn) => ipcRenderer.on("todo:ime-blur", () => fn()),
});
