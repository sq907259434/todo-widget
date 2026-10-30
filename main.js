/* 待办清单（独立版）—— Electron 主进程
   从合体版「WeatherWidget 1.9.1」拆出：本应用只带待办一张卡。
   全透明窗口（不用 acrylic —— 材质会铺满整个窗口矩形，页面再透明也会被
   系统那层糊住，"只剩任务框"的效果出不来）+ 鼠标碰到展开 + 拖动 + 记忆位置 */

const { app, BrowserWindow, ipcMain, Menu, screen, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const createDesktopLayer = require("./desktop-layer");
const createBackdrop = require("./backdrop");

/* 卡片尺寸。窗口必须正好等于卡片：它靠"鼠标碰到"来决定展开，
   四周要是留了透明边距，鼠标还在卡片外面卡片就弹开了。 */
const CARD_W = 320;
const CARD_H = 302;   /* 首次默认高度，实际由页面按条数上报 */

let win = null;

/* ================= 桌面快照背景 =================
   卡片半透明处要"透出桌面图标"，可桌面层里真透明只能透壁纸（见 desktop-layer.js），
   所以改成把桌面快照垫在卡片底下。这里只管裁剪/下发，抓图在 backdrop.js。
   pad：向外多裁一圈，给磨砂糊边留出血，不然边缘会露出没模糊的壁纸。 */
let BD = null;
let bdTimer = null;
const BD_PAD = 44;

function bdPayload() {
  const w = win;
  if (!w || w.isDestroyed() || !BD || !BD.has()) return null;
  const b = w.getBounds();
  let scale = 1;
  try { scale = screen.getDisplayMatching(b).scaleFactor || 1; } catch (e) {}
  return BD.patch(
    { x: b.x * scale, y: b.y * scale, width: b.width * scale, height: b.height * scale },
    scale, BD_PAD
  );
}

function pushBackdrop(delay) {
  clearTimeout(bdTimer);
  bdTimer = setTimeout(() => {
    const w = win;
    if (!w || w.isDestroyed()) return;
    if (w.__drag) return;                 /* 拖动中位置一直在变，松手后再给 */
    const p = bdPayload();
    if (!p) return;
    try { w.webContents.send("wgt:backdrop", p); } catch (e) {}
  }, delay == null ? 160 : delay);
}

/* ================= 背景"实时"化 =================
   快照是静态的：图标挪了、换壁纸了，卡片里的背景还停在抓的那一刻。

   ★ v1.0.19 重做（原因：卡片会在桌面上"闪一下"）
   抓一张"干净桌面"必须让卡片消失 60~70ms —— WDA_EXCLUDEFROMCAPTURE 对
   Progman 子窗口无效（实测 wda=false），只能退回 SW_HIDE。所以能不能抓，
   关键不在"怎么抓"而在"多久抓一次"。旧策略是"20 秒无条件抓一次 + 每次
   松开鼠标都抓"，等于卡片在桌面上每 20 秒自己消失一下。现在改成按事件抓：
     · 换壁纸（TranscodedWallpaper 的 mtime 变了）→ 抓。这时用户正开着设置
       界面，桌面被挡住，看不见闪；
     · 改分辨率 / 缩放 → 抓（快照尺寸对不上，必须重抓）；
     · 在**桌面上**松开左键（图标选中态变了）→ 抓，但 60 秒最多一次；
     · 点的是应用窗口 → 不抓（卡片被窗口盖着，抓了也看不见，纯属白闪）；
     · 手动菜单「刷新桌面背景」→ 抓。 */
let _snapT = null, _snapLast = 0, _snapOk = null;

const _fgClsBuf = Buffer.alloc(512);
const DESK_FG_CLASSES = ["Progman", "WorkerW", "SHELLDLL_DefView", "SysListView32"];

/* 前台窗口是不是桌面本体。点应用窗口时前台是那扇窗口，就不该重抓快照。 */
function fgIsDesktop() {
  if (!_drg || !_drg.GetForegroundWindow) return false;
  try {
    const n = _drg.GetClassNameW(_drg.GetForegroundWindow(), _fgClsBuf, 256);
    if (!(n > 0)) return false;
    return DESK_FG_CLASSES.indexOf(_fgClsBuf.toString("utf16le", 0, n * 2)) >= 0;
  } catch (e) { return false; }
}

/* 换壁纸时 Windows 会重写这个文件，看 mtime 就够（stat 一次几百微秒，无闪烁） */
const wallpaperFile = () =>
  path.join(app.getPath("appData"), "Microsoft", "Windows", "Themes", "TranscodedWallpaper");
function wallpaperStamp() {
  try { const s = fs.statSync(wallpaperFile()); return s.mtimeMs || 0; } catch (e) { return 0; }
}

function refreshSnapshot(reason) {
  const w = win;
  if (!w || w.isDestroyed() || !BD) return false;
  if (w.__drag) return false;
  const wda = setCaptureAffinity(w, true);
  let ok = false;
  try {
    ok = BD.capture({ hide: !wda, noHide: wda });
  } finally {
    if (wda) setCaptureAffinity(w, false);
  }
  if (ok) pushBackdrop(40);
  if (_snapOk !== ok) {                     /* 只在状态翻转时留痕，别把日志刷爆 */
    _snapOk = ok;
    try { bootLog(`snapshot ${ok ? "OK" : "FAIL"} wda=${wda} (${reason || ""})`); } catch (e) {}
  }
  return ok;
}

function scheduleSnapshot(delay, reason) {
  clearTimeout(_snapT);
  _snapT = setTimeout(() => {
    const now = Date.now();
    if (now - _snapLast < 900) return;      /* 连着点桌面也别一直抓 */
    _snapLast = now;
    refreshSnapshot(reason);
  }, delay == null ? 400 : delay);
}

let _clickSnap = 0, _wpStamp = 0;

function startDesktopWatch() {
  if (!_drg) return;
  _wpStamp = wallpaperStamp();

  let prev = false;
  setInterval(() => {
    const down = (_drg.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
    if (down === prev) return;
    prev = down;
    if (down) return;                        /* 只关心松开那一刻 */
    const w = win;
    if (!w || w.isDestroyed() || w.__drag) return;
    const p = screen.getCursorScreenPoint(), b = w.getBounds();
    if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return;
    /* 点的是应用窗口 → 卡片被盖着，抓了也看不见，不抓（省一次 70ms 隐藏） */
    if (!fgIsDesktop()) return;
    const now = Date.now();
    if (now - _clickSnap < 60000) return;    /* 在桌面上连点，一分钟最多抓一次 */
    _clickSnap = now;
    scheduleSnapshot(400, "desktop-click");
  }, 60);

  /* 换壁纸：TranscodedWallpaper 的 mtime 变了才抓 */
  setInterval(() => {
    const s = wallpaperStamp();
    if (!s || s === _wpStamp) return;
    _wpStamp = s;
    scheduleSnapshot(600, "wallpaper");
  }, 5000);

  /* 分辨率 / 缩放变了：快照尺寸对不上，必须重抓 */
  try { screen.on("display-metrics-changed", () => scheduleSnapshot(800, "metrics")); } catch (e) {}

  /* 这台机器上读不到壁纸文件时，退化成 10 分钟一次的兜底（几乎没有闪烁机会） */
  if (!_wpStamp) setInterval(() => scheduleSnapshot(0, "tick"), 600000);
}

const stateFile = () => path.join(app.getPath("userData"), "widget-state.json");
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    /* 原子写：先写临时文件，再用 rename 一瞬间替换正主。
       直接改写原文件时，写一半断电/崩溃会留下半截 JSON，下次启动
       readState 解析失败，位置和置顶就全丢了。rename 在同一块盘上是
       原子操作——任何时刻文件要么是旧的、要么是完整的新的，没有中间态。 */
    const tmp = stateFile() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, stateFile());
  } catch (e) { /* 写不进去也不影响使用，只是记不住位置 */ }
}

/* 待办卡的位置/置顶记在 state.todo 子对象里，各记各的 */
function readCardState() {
  return readState().todo || {};
}

function patchCardState(patch) {
  const st = readState();
  st.todo = Object.assign({}, st.todo || {}, patch);
  writeState(st);
}

/* ---------- 贴进桌面层（把卡片变成桌面窗口的子窗口）----------
   开关状态记在 state.todo.desktopLayer。
   切换方式：改完状态直接重启自己（约 1.5 秒）。窗口层级这种事放在启动时一次做干净，
   比运行中再挂/再摘可靠得多 —— 而且万一贴进去以后看不见，按 Ctrl+Alt+1 就是把状态
   改回 false 再重启，窗口一定回来，不会出现"看不见又点不到"的死局。 */
function toggleDesktopLayer(want) {
  const on = !!want;
  const cur = readCardState().desktopLayer === true;
  patchCardState(on ? { desktopLayer: true, top: false } : { desktopLayer: false });
  if (cur === on) return on;
  app.relaunch();
  app.exit(0);
  return on;
}

/* ---------- 首次启动迁移 ----------
   独立版存档在 %APPDATA%\todo-card，合体版在 %APPDATA%\weather-widget。
   窗口位置在 widget-state.json 的 todo 子对象；待办内容本身存在页面的
   localStorage（Local Storage\leveldb），整目录复制过来。
   两样都搬，用户重新装完不用重新摆位置、也不用重录待办。 */
function maybeMigrateLegacy() {
  try {
    if (fs.existsSync(stateFile())) return;
    const legacyDir = path.join(app.getPath("appData"), "weather-widget");
    const legacyState = path.join(legacyDir, "widget-state.json");
    if (!fs.existsSync(legacyState)) return;
    const ls = path.join(legacyDir, "Local Storage");
    if (fs.existsSync(ls)) {
      fs.cpSync(ls, path.join(app.getPath("userData"), "Local Storage"), {
        recursive: true, force: false,
      });
    }
    const legacy = JSON.parse(fs.readFileSync(legacyState, "utf8")) || {};
    const seed = {};
    if (legacy.todo && Number.isFinite(legacy.todo.x)) {
      seed.todo = { x: legacy.todo.x, y: legacy.todo.y };
      if (legacy.todo.top === true) seed.todo.top = true;
    }
    writeState(seed);
  } catch (e) { /* 搬不动就全新开始，不影响启动 */ }
}

/* ---------- 光标到底还在不在窗口里 ----------
   待办卡靠"鼠标在不在"决定展开/收起。以前只看页面自己的 mouseenter/mouseleave，
   但页面那一路在窗口自己变高、往上挪的时候会误判：展开时窗口顶边上移 63px，
   Chromium 按旧坐标重新命中一次，就会甩一个假的 mouseleave。
   假离开不只是闪一下 —— 它会顺手把"临时置顶"撤掉，卡片沉到别的窗口后面，
   看起来就是"鼠标明明还在框里，它自己隐藏了"。
   所以判据换成系统光标：screen.getCursorScreenPoint() 跟窗口矩形比，
   只在"变化"时通知页面。页面那边把 false 当唯一可以收起的理由。 */
function watchCursor(w, onEnter) {
  w.__cursorInside = null;
  w.__cursorTimer = setInterval(() => {
    if (w.isDestroyed() || !w.webContents || w.webContents.isDestroyed()) {
      clearInterval(w.__cursorTimer);
      return;
    }
    if (!w.isVisible() || w.isMinimized()) return;
    const p = screen.getCursorScreenPoint();
    const b = w.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside === w.__cursorInside) return;
    w.__cursorInside = inside;
    if (inside && onEnter) { try { onEnter(); } catch (e) {} }
    /* cx/cy：光标相对窗口客户区的 CSS px（p 和 b 都是 DIP，直接相减即可）。
       页面要用它判断"光标是不是压在左侧勾选带上"—— 压在那一竖条上不展开整张卡，
       方便只想点一下"已完成"的时候不让整张卡弹出来。 */
    const cx = p.x - b.x, cy = p.y - b.y;
    try { w.webContents.send("wgt:cursor", { inside, cx, cy }); } catch (e) {}
  }, 90);
}

/* ================= 拖动窗口：主进程直接跟着系统光标走 =================
   为什么不让页面算位移再每帧 IPC（那是上一版的写法，实测手感"慢半拍"）：
     1) 每帧要多走一次渲染进程 ↔ 主进程往返；
     2) 更要命的是窗口跟着鼠标跑的时候，渲染进程的 mousemove 会被节流，
        事件一到就是一堆挤在一起，画面看着就是"跟得上但一顿一顿"。
   这里改成主进程每 8ms 读一次系统光标、直接 SetWindowPos 挪窗口：
   延迟只剩一个定时器周期（<10ms），与窗口里渲染了什么完全无关。

   全程物理像素。GetCursorPos / GetWindowRect / SetWindowPos 是同一套坐标系，
   绝不做 DIP 换算 —— 桌面层里窗口已经不做 DPI 虚拟化（见 desktop-layer.js
   文件头坑 1），本机 200% 缩放下换算错一次就是"只走一半"。

   为什么非要自己搬：卡片贴进桌面层后是 Progman 的子窗口（WS_CHILD），
   系统那套非客户区拖动（-webkit-app-region: drag）在子窗口上不会进入移动循环
   —— 实测按住左键匀速拖 26 帧，窗口 x 一动不动。而子窗口本身完全能移动
   （原生 SetWindowPos 实测 6/6 帧跟手），所以只能自己搬。

   位置用"原点 + 光标总位移"算，不做逐帧累加：累加会把每一帧的取整误差攒起来，
   拖一会儿就偏出几十像素。 */
const _drg = (() => {
  try {
    const u = require("koffi").load("user32.dll");
    return {
      GetCursorPos: u.func("GetCursorPos", "bool", ["void *"]),
      GetWindowRect: u.func("GetWindowRect", "bool", ["void *", "void *"]),
      SetWindowPos: u.func("SetWindowPos", "bool", ["void *", "void *", "int", "int", "int", "int", "uint32"]),
      GetAsyncKeyState: u.func("GetAsyncKeyState", "int16", ["int"]),
      /* 让本窗口"对屏幕捕获隐身"。抓桌面快照时临时打开，抓完关掉：
         比 SW_HIDE 一闪要好，也不要靠它来藏界面。 */
      SetWindowDisplayAffinity: u.func("SetWindowDisplayAffinity", "bool", ["void *", "uint32"]),
      /* 判"现在前台是不是桌面本体"用（见 fgIsDesktop） */
      GetForegroundWindow: u.func("GetForegroundWindow", "void *", []),
      GetClassNameW: u.func("GetClassNameW", "int", ["void *", "uint16_t *", "int"]),
    };
  } catch (e) { return null; }
})();

/* WDA_EXCLUDEFROMCAPTURE：Win10 2004+ 才有。窗口仍正常显示，只是不进截图/录屏/捕获。 */
const WDA_EXCLUDE = 0x11;
/* 拖动中专用：无视 __drag 闸门立刻裁一块推给页面（拖动实况背景靠它） */
function pushBackdropNow() {
  const w = win;
  if (!w || w.isDestroyed()) return;
  const p = bdPayload();
  if (!p) return;
  try { w.webContents.send("wgt:backdrop", p); } catch (e) {}
}

function setCaptureAffinity(w, on) {
  if (!_drg || !_drg.SetWindowDisplayAffinity) return false;
  const hwnd = w && !w.isDestroyed() ? hwndNum(w) : 0;
  if (!hwnd) return false;
  try {
    return !!_drg.SetWindowDisplayAffinity(hwnd, on ? WDA_EXCLUDE : 0);
  } catch (e) { return false; }
}

/* ================= 窗口形状裁剪（SetWindowRgn） =================
   ★ 为什么非要这一步：卡片贴进桌面层后是 Progman 的子窗口，而 Windows 只把
     它和**父窗口**（Progman 的壁纸）做合成 —— 同级的 SHELLDLL_DefView（图标层）
     不会被"透过"。实测：把卡片拖到图标上，截图与"卡片不在"的干净桌面逐像素比，
     窗口矩形内的图标**整片消失**，壁纸却在。也就是说：透明区能透壁纸，透不出图标。

   而卡片收起 / 拖动时视觉上只剩待办那几条（卡片底是撤掉的），窗口矩形却还是
   展开态那么大，多出来的部分就在"吃掉"桌面图标 —— 用户反馈的正是这个。

   解法：把窗口形状裁成"真正画了东西的那几块"。区域之外的像素不属于窗口，
   图标自然原样露出来，命中测试也一起穿过（点那边 = 点到桌面）。
   代价：裁剪是硬边（无抗锯齿），所以只用直角矩形贴合每一条待办，边不外扩。 */
const _rgn = (() => {
  try {
    const k = require("koffi");
    const u = k.load("user32.dll"), g = k.load("gdi32.dll");
    return {
      SetWindowRgn: u.func("SetWindowRgn", "int", ["void *", "void *", "bool"]),
      CreateRectRgn: g.func("CreateRectRgn", "void *", ["int", "int", "int", "int"]),
      CombineRgn: g.func("CombineRgn", "int", ["void *", "void *", "void *", "int"]),
      DeleteObject: g.func("DeleteObject", "bool", ["void *"]),
    };
  } catch (e) { return null; }
})();

/* 页面报来的是 CSS 像素（相对窗口客户区），这里换成物理像素再合并成一块 region。
   RGN_OR = 2。成功后 region 归系统所有，绝不能 DeleteObject。 */
function applyRegion(w, list) {
  if (!_rgn || !w || w.isDestroyed()) return false;
  const hwnd = hwndNum(w);
  if (!hwnd) return false;
  let scale = 1;
  try { scale = screen.getDisplayMatching(w.getBounds()).scaleFactor || 1; } catch (e) {}

  const rects = (Array.isArray(list) ? list : [])
    .map((r) => ({
      l: Math.round(Number(r.x) * scale),
      t: Math.round(Number(r.y) * scale),
      r: Math.round((Number(r.x) + Number(r.w)) * scale),
      b: Math.round((Number(r.y) + Number(r.h)) * scale),
    }))
    .filter((q) => q.r - q.l > 1 && q.b - q.t > 1);

  /* 没有矩形 = 整窗（展开态、或页面还没准备好）：清掉 region */
  const sig = rects.length ? JSON.stringify(rects) : "none";
  if (w.__rgnSig === sig) return true;
  w.__rgnSig = sig;

  if (!rects.length) {
    try { _rgn.SetWindowRgn(hwnd, null, true); return true; } catch (e) { return false; }
  }

  let acc = null;
  for (const q of rects) {
    let one;
    try { one = Number(_rgn.CreateRectRgn(q.l, q.t, q.r + 1, q.b + 1)); } catch (e) { continue; }
    if (!one) continue;
    if (!acc) { acc = one; continue; }
    try { _rgn.CombineRgn(acc, acc, one, 2); } catch (e) {}
    try { _rgn.DeleteObject(one); } catch (e) {}
  }
  if (!acc) return false;
  try {
    if (!_rgn.SetWindowRgn(hwnd, acc, true)) { _rgn.DeleteObject(acc); w.__rgnSig = null; return false; }
  } catch (e) { return false; }
  return true;
}

const SWP_DRAG = 0x0001 | 0x0004 | 0x0010;   /* NOSIZE | NOZORDER | NOACTIVATE */
const VK_LBUTTON = 0x01, VK_MBUTTON = 0x04;
const DRAG_THRESHOLD = 4;                    /* 物理像素，手抖不算拖 */

function hwndNum(win) {
  try {
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
  } catch (e) { return 0; }
}

function bootLog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "win-events.log"),
      new Date().toISOString() + " " + msg + "\n");
  } catch (e) { }
}

function dragBegin(w, btn) {
  dragStop(w, false);
  if (!_drg) { w.__dragFrom = w.getBounds(); bootLog(`drag begin btn=${btn} NO koffi`); return; }
  const hwnd = hwndNum(w);
  const cb = Buffer.alloc(8), rb = Buffer.alloc(16);
  const okC = _drg.GetCursorPos(cb);
  const okR = hwnd ? _drg.GetWindowRect(hwnd, rb) : 0;
  bootLog(`drag begin btn=${btn} hwnd=${hwnd} okC=${okC} okR=${okR} cursor=${cb.readInt32LE(0)},${cb.readInt32LE(4)} rect=${rb.readInt32LE(0)},${rb.readInt32LE(4)} ${rb.readInt32LE(8)}x${rb.readInt32LE(12)}`);
  if (!hwnd || !okC || !okR) {
    w.__dragFrom = w.getBounds();
    return;
  }
  const st = {
    hwnd,
    ox: rb.readInt32LE(0), oy: rb.readInt32LE(4),      /* 窗口起点（物理） */
    cx: cb.readInt32LE(0), cy: cb.readInt32LE(4),      /* 光标起点（物理） */
    btn: btn === 1 ? VK_MBUTTON : VK_LBUTTON,
    moving: false,
    timer: null,
    /* 锚点 __rowsY 全项目都用 DIP，而这里的坐标是物理像素 —— 换算回 DIP 才能往它上面写 */
    scale: (() => { try { return screen.getDisplayMatching(w.getBounds()).scaleFactor || 1; } catch (e) { return 1; } })(),
  };
  w.__drag = st;
  /* 拖动实况背景（整幅快照方案）：起拖把整幅快照一次性发给页面，
     页面把它按屏幕坐标"钉死"在桌面上，之后每个 tick 只发一个窗口坐标
     （几十字节），页面只改 #bd 的 left/top —— 背景纹丝不动、窗口在上面滑，
     像素级对齐。旧的"每 70ms 重裁一块"方案里，两次推送之间卡片动了而
     背景还停在上一个裁剪位，拖快了背景明显错位（用户报的"透明时没对齐"）。
     快照本身是干净的（启动/20s 兜底抓的都没有卡片自己），不用再抓图。 */
  st.bd = !!(BD && BD.has());
  if (st.bd) {
    sendBdFull(w);
    try { w.webContents.send("wgt:bd-pos", { x: st.ox, y: st.oy }); } catch (e) { }
  }
  let tick0 = false;
  st.timer = setInterval(() => {
    if (w.isDestroyed()) { dragStop(w, true); return; }
    const ks = _drg.GetAsyncKeyState(st.btn);
    if (!tick0) {
      tick0 = true;
      bootLog(`drag tick0 key=0x${(ks & 0xFFFF).toString(16)} btn=${st.btn}`);
    }
    /* 按键松开就收工：比等页面 mouseup 可靠 —— 鼠标甩出窗口时页面根本收不到 */
    if ((ks & 0x8000) === 0) { dragStop(w, true); return; }
    const c = Buffer.alloc(8);
    if (!_drg.GetCursorPos(c)) return;
    const dx = c.readInt32LE(0) - st.cx;
    const dy = c.readInt32LE(4) - st.cy;
    if (!st.moving) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      st.moving = true;
      /* ★ 真正开始搬了才告诉页面"进入拖动外观"。
         不能等页面自己按 mousemove 判：窗口是被我们跟着光标搬的，光标在窗口里的
         相对位置几乎不变，页面根本收不到 mousemove —— 它那套 moved/lookDrag/
         heightLocked 会一直不成立（用户报的"拖动漂移"就是从这里来的）。 */
      try { w.webContents.send("wgt:drag-look", { on: true }); } catch (e) { }
    }
    const nx = st.ox + dx, ny = st.oy + dy;
    try { _drg.SetWindowPos(st.hwnd, 0, nx, ny, 0, 0, SWP_DRAG); } catch (e) { }
    /* 拖动实况背景：只发窗口新坐标，页面自己挪整幅快照（与窗口同源同步） */
    if (st.bd) { try { w.webContents.send("wgt:bd-pos", { x: nx, y: ny }); } catch (e) { } }
    /* 锚点必须跟着一起走。位置是原生 SetWindowPos 改的，不会触发 Electron 的
       moved 事件 —— 不在这里同步，__rowsY 就一直停在拖动前的值。松手后页面收起
       卡片、set-card-height 拿旧锚点反推 y，卡片会"啪"地弹回原位（用户报的跳变）。
       每一帧都同步，是因为页面 mouseup 可能比主进程的按键轮询更早到。
       注意单位：ny 是物理像素，__rowsY 是 DIP。 */
    w.__rowsY = ny / (st.scale || 1) + (w.__pad || 0) + (w.__top || 0);
  }, 8);
}

/* 拖动实况背景：整幅快照一次性下发（PNG 几 MB，一次拖动只发一回；
   页面缓存 blob，桌面快照没换也只会在这时换） */
function sendBdFull(w) {
  if (!BD || !BD.has() || !w || w.isDestroyed()) return false;
  const f = BD.full();
  const png = BD.image();
  if (!f || !png) return false;
  try { w.webContents.send("wgt:bd-full", { png, ox: f.ox, oy: f.oy, w: f.w, h: f.h }); return true; }
  catch (e) { return false; }
}

function dragStop(w, persist) {
  const st = w.__drag;
  w.__dragFrom = null;
  if (!st) return;
  clearInterval(st.timer);
  w.__drag = null;
  /* 告诉页面"搬完了"：页面据此清掉本地手势状态（它自己收不到 mouseup 时全靠这条） */
  try { w.webContents.send("wgt:drag-look", { on: false }); } catch (e) { }
  /* 拖动结束：让页面退出"整幅快照钉桌面"模式（随后 patch 载荷来重设 #bd） */
  if (st.bd) { try { w.webContents.send("wgt:bd-drag-end"); } catch (e) { } }
  /* 位置落盘：位置是原生 SetWindowPos 改的，等不到 moved（那条路只有系统拖动才有）。
     存"收起态"的顶边，和原来的口径一致。 */
  if (persist && w && !w.isDestroyed()) {
    const b = w.getBounds();
    /* 收尾再校一次锚点：拖动最后一帧可能刚好没被 tick 覆盖到（按钮松开先于定时器） */
    w.__rowsY = b.y + (w.__pad || 0) + (w.__top || 0);
    const idleY = Math.round(b.y + (w.__top || 0) - (w.__topMin || 0));
    patchCardState({ x: b.x, y: idleY });
    bootLog(`drag end bounds=${b.x},${b.y} hwndPos=${st.ox},${st.oy} moving=${st.moving}`);
    pushBackdrop(140);          /* 换位置了，快照要重新裁一块 */
  }
}

/* ================= 中键拖动：主进程兜底 =================
   桌面层里卡片是 Progman 的子窗口（WS_CHILD），永远拿不到"活动窗口"身份。
   实测：中键按下去，页面连 mousedown 都收不到（日志里根本没有 drag begin），
   所以"窗口任意位置按住中键就能拖"在桌面上失效了 —— 左键那条路还是通的。
   这里改成主进程自己看系统按键状态：16ms 轮询一次，中键刚按下且光标在窗口
   矩形内就起拖动。页面那套中键逻辑保留（普通窗口模式下还走它），两条不冲突。 */
function startMidWatch() {
  if (!_drg) return;
  let prev = false;
  setInterval(() => {
    const raw = _drg.GetAsyncKeyState(VK_MBUTTON);
    const down = (raw & 0x8000) !== 0;
    if (down === prev) return;
    prev = down;
    bootLog(`midwatch edge down=${down} raw=0x${(raw & 0xFFFF).toString(16)}`);
    const w = win;
    if (!w || w.isDestroyed()) return;
    if (down) {
      if (w.__drag) return;                  /* 已经有拖动在手（比如左键），不抢 */
      const p = screen.getCursorScreenPoint();   /* DIP，跟 getBounds 同一套 */
      const b = w.getBounds();
      if (p.x < b.x || p.x >= b.x + b.width || p.y < b.y || p.y >= b.y + b.height) return;
      dragBegin(w, 1);
    } else {
      dragStop(w, true);                     /* 没在拖就是空操作 */
    }
  }, 16);
}

/* ================= 桌面层输入桥（幽灵输入窗） =================
   卡片贴进桌面层后是 Progman 的子窗口 —— 子窗口永远进不了前台输入队列，
   键盘（含输入法）一个字都到不了页面，输入框就成了摆设（用户实测报障）。
   解法：开一个**真顶层窗口**（能正常拿焦点、能起输入法），透明隐形，
   贴在卡片输入框的位置上代收打字，再把文字实时镜像回卡片：
     · 页面 input focusin → wgt:ime-begin（带输入框的屏幕矩形+现有文字）
     · 主进程把幽灵窗摆到那个矩形 → 幽灵窗拿到焦点开始代收
     · ime:text → 卡片 inp.value 实时跟随；Enter/Esc/失焦分别走提交/放弃/提交
   普通窗口模式键盘本来就是通的，主进程直接忽略 ime-begin。 */
let imeWin = null;        /* 幽灵输入窗（懒创建，常驻复用） */
let imeTarget = null;     /* 正在代收的那张卡片窗口 */
let imeHiding = false;    /* 自己 hide() 触发的 blur，别当成"用户点走了" */

function imeEnsure() {
  if (imeWin && !imeWin.isDestroyed()) return imeWin;
  imeWin = new BrowserWindow({
    width: 8, height: 8,
    frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false,
    show: false, alwaysOnTop: true,
    title: "输入桥",
    webPreferences: {
      preload: path.join(__dirname, "ime-preload.js"),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  imeWin.setMenu(null);
  imeWin.__loaded = false;
  imeWin.webContents.on("did-finish-load", () => {
    imeWin.__loaded = true;
    if (imeWin.__pending != null) {
      try { imeWin.webContents.send("ime:init", imeWin.__pending); } catch (e) {}
      imeWin.__pending = null;
    }
  });
  imeWin.loadFile(path.join(__dirname, "ime.html"));
  return imeWin;
}

/* 幽灵窗必须真正拿到系统前台，键盘才进得来。Windows 默认拒绝后台进程
   抢前台（SetForegroundWindow 有锁）—— 经典解锁手法：空按一次 ALT，
   系统就允许本进程把前台要回来。正常情况下用户刚点过卡片（本进程收到过
   最后一次输入事件），第一次 focus 就能成；这里只是兜底。 */
function imeForceFocus(g) {
  let fgMe = false;
  try {
    const u = require("koffi").load("user32.dll");
    const GetForegroundWindow = u.func("GetForegroundWindow", "void *", []);
    const GetWindowThreadProcessId = u.func("GetWindowThreadProcessId", "uint32", ["void *", "uint32 *"]);
    const keybd_event = u.func("keybd_event", "void", ["uint8", "uint8", "uint32", "void *"]);
    const pidBuf = Buffer.alloc(4);
    const fgPid = () => {
      const fg = GetForegroundWindow();
      if (!fg) return 0;
      GetWindowThreadProcessId(fg, pidBuf);
      return pidBuf.readUInt32LE(0);
    };
    fgMe = fgPid() === process.pid;
    if (!fgMe) {
      keybd_event(0x12, 0, 0, null);       /* ALT down */
      keybd_event(0x12, 0, 2, null);       /* ALT up（KEYEVENTF_KEYUP） */
      try { g.focus(); } catch (e) {}
      fgMe = fgPid() === process.pid;
    }
  } catch (e) {}
  return fgMe;
}

function imeHide() {
  imeHiding = true;
  if (imeWin && !imeWin.isDestroyed()) {
    try { imeWin.hide(); } catch (e) {}
  }
  setTimeout(() => { imeHiding = false; }, 150);
}

function imeRelay(ch, v) {
  const w = imeTarget;
  if (!w || w.isDestroyed()) return;
  try { w.webContents.send(ch, v); } catch (e) {}
}

/* 在 app ready 之后注册一次（not per window） */
function registerImeIpc() {
  ipcMain.on("wgt:ime-begin", (e, r) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return;
    /* 普通窗口模式：页面自己就能收键盘，不插手 */
    if (readCardState().desktopLayer !== true) return;
    const o = (r && typeof r === "object") ? r : {};
    const b = w.getBounds();
    /* 页面报的是窗口内 CSS px（本卡无缩放，1css=1dip），换算成屏幕坐标 */
    const rect = {
      x: Math.round(b.x + (Number(o.x) || 0)),
      y: Math.round(b.y + (Number(o.y) || 0)),
      width: Math.max(8, Math.round(Number(o.w) || 8)),
      height: Math.max(8, Math.round(Number(o.h) || 8)),
    };
    const g = imeEnsure();
    imeTarget = w;
    try { g.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); } catch (er) {}
    const val = String(o.value || "");
    if (g.__loaded) {
      /* 幽灵窗常驻复用：隐藏着也要把预填值送过去，否则上次输入的文字
         会残留在框里，新一次打字接着旧文字往后拼（实测翻倍）。 */
      try { g.webContents.send("ime:init", val); } catch (er) {}
    } else {
      g.__pending = val;      /* 首次创建还没加载完，等 did-finish-load 再送 */
    }
    g.show();
    try { g.focus(); } catch (er) {}
    const fgMe = imeForceFocus(g);
    bootLog(`ime-begin rect=${rect.x},${rect.y} ${rect.width}x${rect.height} fgIsMe=${fgMe}`);
  });
  ipcMain.on("wgt:ime-end", () => { imeHide(); imeTarget = null; });
  ipcMain.on("ime:text", (_e, v) => { if (!imeHiding) imeRelay("todo:ime-text", String(v == null ? "" : v)); });
  ipcMain.on("ime:commit", () => { imeHide(); imeRelay("todo:ime-commit"); });
  ipcMain.on("ime:cancel", () => { imeHide(); imeRelay("todo:ime-cancel"); });
  ipcMain.on("ime:blur", () => {
    if (imeHiding) return;               /* 自己藏起来的不算失焦 */
    imeHide();
    imeRelay("todo:ime-blur");
  });
}

function createWindow() {
  if (win && !win.isDestroyed()) {   /* 已经在跑就只唤到前面，不开第二个 */
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  const st = readCardState();
  const wa = screen.getPrimaryDisplay().workArea;
  const top = st.top === true;   /* 默认不置顶：卡片安静待在桌面上，不压在其他窗口前面 */

  /* 默认贴右上角 */
  const defX = wa.x + wa.width - CARD_W - 24;
  const defY = wa.y + 54;

  let x = Number.isFinite(st.x) ? st.x : defX;
  let y = Number.isFinite(st.y) ? st.y : defY;

  /* 位置兜底：换显示器、拔掉副屏、或系统把窗口挪到边缘时，
     旧坐标可能让卡片贴边甚至跑到屏幕外。这里强制夹回可视区内并留出边距。 */
  const MARGIN = 14;
  const target = screen.getAllDisplays().find((d) => {
    const a = d.workArea;
    return x + CARD_W / 2 >= a.x && x + CARD_W / 2 <= a.x + a.width &&
           y + CARD_H / 2 >= a.y && y + CARD_H / 2 <= a.y + a.height;
  }) || screen.getPrimaryDisplay();

  const ta = target.workArea;
  x = Math.min(Math.max(x, ta.x + MARGIN), ta.x + ta.width - CARD_W - MARGIN);
  y = Math.min(Math.max(y, ta.y + MARGIN), ta.y + ta.height - CARD_H - MARGIN);

  const w = new BrowserWindow({
    width: CARD_W,
    height: CARD_H,
    x: x,
    y: y,
    frame: false,
    transparent: true,          /* 不用 acrylic，原因见文件头 */
    backgroundColor: "#00000000",
    roundedCorners: false,      /* Win11 会给透明窗口自动加系统圆角，弧线外填一块黑
                                   （用户截图：四角黑三角）。关掉，圆角由 CSS 自己画 */
    hasShadow: false,           // 无边框窗口自带阴影会把直角露出来
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: top,
    show: false,
    title: "待办清单",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        "--wgt-acrylic=0",
        "--wgt-card=todo",
      ],
      backgroundThrottling: false, // 后台不降频，否则切走再回来数字是旧的
    },
  });

  win = w;   /* 让"已经在跑"的判断和中键轮询都能找到这个窗口 */

  if (top) w.setAlwaysOnTop(true, "floating");

  /* 事件留痕（%APPDATA%\TodoCard\win-events.log）：窗口生命周期事件很罕见，
     一旦用户再报"卡片自己消失/弹出"，这就是精确现场。 */
  const evlogSafe = (msg) => {
    try {
      fs.appendFileSync(path.join(app.getPath("userData"), "win-events.log"),
        new Date().toISOString() + " " + msg + "\n");
    } catch (e) { /* 日志失败不影响功能 */ }
  };

  /* ---------- 智能置顶：Win+D「显示桌面」的唯一免疫手段 ----------
     本机实测（用 desktopCapturer 可信截图为证）：Win+D 会把所有**非置顶**窗口在
     合成层直接收走，而且不给 Electron 任何事件、IsWindowVisible 仍是 true、
     DwmGetWindowAttribute 的 cloak 仍为 0、渲染进程 visibilityState 仍是 visible
     —— 程序侧完全无感，靠事件反击不可能（试过 WS_EX_TOOLWINDOW 工具窗样式，无效）。
     唯一免疫的是置顶窗口（WS_EX_TOPMOST）。
     所以按需置顶：
       · 用户在菜单里勾了「窗口置顶」→ 一直置顶，本逻辑不插手；
       · 没勾 → 平时不置顶（老实待在别的窗口后面），只在「显示桌面」期间临时置顶，
         桌面收回去后立刻撤销。
     识别信号（实测）：显示桌面时前台窗口变成 Progman，屏幕中心落在桌面图标层
     （SysListView32）。只要屏幕中心被任何应用窗口（包括自家卡片）占着，就绝不置顶，
     避免平时乱冒头。 */
  let _win32 = null;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    _win32 = {
      GetForegroundWindow: user32.func("GetForegroundWindow", "void *", []),
      GetClassNameW: user32.func("GetClassNameW", "int", ["void *", "uint16_t *", "int"]),
      GetTopWindow: user32.func("GetTopWindow", "void *", ["void *"]),
      GetWindow: user32.func("GetWindow", "void *", ["void *", "uint32"]),
      IsWindowVisible: user32.func("IsWindowVisible", "bool", ["void *"]),
      IsIconic: user32.func("IsIconic", "bool", ["void *"]),
      GetWindowLongW: user32.func("GetWindowLongW", "int", ["void *", "int"]),
      GetWindowThreadProcessId: user32.func("GetWindowThreadProcessId", "uint32", ["void *", "uint32 *"]),
      SetWindowPos: user32.func("SetWindowPos", "bool", ["void *", "void *", "int", "int", "int", "int", "uint32"]),
    };
  } catch (e) { evlogSafe("koffi load err: " + e.message); }   /* 只影响 Win+D 免疫 */

  const DESKTOP_CLASSES = [
    "Progman", "WorkerW", "SHELLDLL_DefView", "SysListView32",
    "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow",
    /* 系统壳窗口：显示桌面时它们照样可见，但不是"应用窗口"，别让它们把计数抬上去 */
    "PseudoConsoleWindow", "MonitorDisplayChange", "Xaml_WindowedPopupClass",
    "TopLevelWindowForOverflowXamlIsland", "ForegroundStaging",
  ];
  const _clsBuf = Buffer.alloc(512);
  const classNameOf = (h) => {
    try {
      const n = _win32.GetClassNameW(h, _clsBuf, 256);
      return n > 0 ? _clsBuf.toString("utf16le", 0, n * 2) : "";
    } catch (e) { return ""; }
  };
  const _pidBuf = Buffer.alloc(4);
  const pidOf = (h) => {
    try { _win32.GetWindowThreadProcessId(h, _pidBuf); return _pidBuf.readUInt32LE(0); } catch (e) { return 0; }
  };
  const isTopmost = (h) => {
    try { return (_win32.GetWindowLongW(h, -20) & 0x8) !== 0; } catch (e) { return false; }
  };
  const selfHwnd = () => {
    try {
      const b = w.getNativeWindowHandle();
      return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
    } catch (e) { return 0; }
  };

  /* 「显示桌面」判据（v1.0.8 重做）—— 旧做法取 3 个采样点问 WindowFromPoint「谁在最上面」，
     实测不可靠：Win+D 把窗口收走后，命中谁完全取决于当时的窗口布局，于是同一套代码
     时而判成"在显示桌面"（卡片一直置顶 → 飘在所有窗口前面），
     时而判成"不在"（卡片没置顶，被系统一起收走 → 消失）。用户两个症状都是它。
     新判据用两条独立证据，必须同时成立：
       ① 前台是桌面本体（Progman / WorkerW）；
       ② 屏幕上一扇"普通应用窗口"都不剩了 —— Win+D 会把这些窗口的 IsWindowVisible 直接置 false
          （实测：正常桌面能看到 6~8 扇；显示桌面时它们从可见列表里消失，只剩桌面、任务栏、
           置顶窗口和桌面级挂件）。
     ② 正好解开「退出显示桌面、但焦点还留在桌面」这个死结：那一刻前台仍是 Progman，
     但窗口全都回来了 → 可见应用窗口数 > 2 → 判 false → 撤销置顶 + 沉底。
     置顶窗口必须排除，因为显示桌面时它们本来就还可见（包括我们自己的卡片）。 */
  const desktopIsShowing = () => {
    if (!_win32) return false;
    try {
      if (DESKTOP_CLASSES.indexOf(classNameOf(_win32.GetForegroundWindow())) < 0) return false;
      const me = process.pid;
      let apps = 0, guard = 0;
      let h = _win32.GetTopWindow(null);
      while (h && Number(h) !== 0 && guard++ < 400) {
        if (_win32.IsWindowVisible(h) && !_win32.IsIconic(h)) {
          const c = classNameOf(h);
          if (DESKTOP_CLASSES.indexOf(c) < 0 && pidOf(h) !== me && !isTopmost(h)) apps++;
        }
        h = _win32.GetWindow(h, 2);   /* GW_HWNDNEXT = 2 */
      }
      return apps <= 3;
    } catch (e) { return false; }
  };

  let _smartTopOn = null;

  /* ---------- 贴进桌面层（可选，默认关）----------
     用户实测：桌面快捷图标怎么按 Win+D 都不动。原因是图标根本不是窗口 ——
     它们住在桌面窗口 Progman 内部（Progman → SHELLDLL_DefView → SysListView32），
     Win+D 只收「顶层应用窗口」，从不碰这棵树。
     所以想让卡片同等待遇，唯一办法是把自己 SetParent 进 Progman（见 desktop-layer.js）。
     挂上之后不需要任何轮询判断「现在是不是显示桌面」，下面那段智能置顶会整体让位。 */
  const dl = createDesktopLayer({ getWin: () => w, log: evlogSafe });
  if (dl.available && readCardState().desktopLayer === true) {
    w.once("show", () => setTimeout(() => {
      if (readCardState().desktopLayer !== true) return;
      dl.set(true).then((ok) => evlogSafe("dlayer startup " + ok));
    }, 700));
  }
  if (dl.available) {
    /* 看门狗：Explorer 重启/关系被冲掉时重建；宿主整个没了就退回顶层（宁可回到旧行为） */
    setInterval(() => { if (readCardState().desktopLayer === true) dl.ensure(); }, 3000);
  }

  /* 撤销置顶 ≠ 沉下去 —— 这是 v1.0.7 修掉的那个别扭行为：
     Windows 把窗口从置顶组挪回普通组时，是插到普通组的**最上面**，于是退出「显示桌面」
     后卡片会浮在刚刚恢复的窗口前面，一直挡着，直到用户点一下那个窗口才被压回去。
     补一刀 SetWindowPos(HWND_BOTTOM)：把卡片沉到所有窗口之下。实测 Progman（桌面）
     永远被系统压在 Z 序最底，所以沉底后卡片依然可见（PowerShell 实测：卡片@41 / Progman@42，
     卡片在桌面之上、其它应用之下 = 桌面卡片该有的位置）。 */
  const SWP_SINK = 0x0001 | 0x0002 | 0x0010 | 0x0200;   /* NOSIZE|NOMOVE|NOACTIVATE|NOOWNERZORDER */
  const sinkToBottom = () => {
    if (dl.isOn()) return;    /* 桌面层里沉底 = 被 SHELLDLL_DefView 图标层盖住 = 卡片"自己消失" */
    if (!_win32 || w.isDestroyed()) return;
    try {
      const buf = w.getNativeWindowHandle();
      const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
      _win32.SetWindowPos(hwnd, 1, 0, 0, 0, 0, SWP_SINK);   /* 1 = HWND_BOTTOM */
    } catch (e) { /* 失败就保持现状：卡片在最前，点一下别的窗口就退回去，不致命 */ }
  };

  const applyTop = (on) => {
    if (w.isDestroyed()) return;
    try {
      if (on) w.setAlwaysOnTop(true, "floating");
      else {
        w.setAlwaysOnTop(false);
        setTimeout(sinkToBottom, 60);   /* 等 DWM 处理完"取消置顶"，再沉底 */
      }
    } catch (e) { /* 切换失败不影响其他功能 */ }
  };
  if (_win32) {
    let tick = 0;
    let wantTop = top;
    setInterval(() => {
      if (w.isDestroyed()) return;
      if (dl.isOn()) { _smartTopOn = null; return; }   /* 已经在桌面层里，不需要置顶这套 */
      tick++;
      if ((tick % 5) === 0) {            /* 每 ~1s 读一次用户设置：够快，也不折腾磁盘 */
        try { wantTop = readCardState().top === true; } catch (e) { /* 读不到就沿用上次 */ }
      }
      if (wantTop) { _smartTopOn = null; return; }   /* 用户要常驻置顶：交给设置，不插手 */
      const showing = desktopIsShowing();
      const curTop = isTopmost(selfHwnd());
      if ((tick % 25) === 0) {           /* 每 ~5s 一条心跳：再出问题可以直接看现场 */
        evlogSafe(`tick showing=${showing} top=${curTop} fg=${classNameOf(_win32.GetForegroundWindow())}`);
      }
      _smartTopOn = showing;
      /* 幂等校正：不看"上一轮判过什么"，只看"这一轮该不该置顶"。
         状态机一旦被外部改乱（系统在切换瞬间强行隐藏/置顶窗口），这里每 200ms 拉回一次。 */
      if (showing && !curTop) { evlogSafe("apply ON  fg=" + classNameOf(_win32.GetForegroundWindow())); applyTop(true); }
      else if (!showing && curTop) { evlogSafe("apply OFF fg=" + classNameOf(_win32.GetForegroundWindow())); applyTop(false); }
    }, 200);
  }

  /* 窗口事件留痕 */
  const evlog = (ev) => {
    try {
      fs.appendFileSync(path.join(app.getPath("userData"), "win-events.log"),
        new Date().toISOString() + " " + ev + "\n");
    } catch (e) { /* 日志失败不影响功能 */ }
  };
  ["minimize", "restore", "show", "hide"].forEach((ev) => w.on(ev, () => evlog(ev)));

  /* 桌面快照：必须赶在 show 之前抓 —— 卡片是 Progman 的子窗口，PrintWindow 会把
     它一起画进快照里，那就成了"卡片背景里嵌着卡片自己"。 */
  BD = createBackdrop({ getHwnd: () => hwndNum(w), log: evlogSafe });
  BD.capture({ hide: false });


  /* 锚点不用顶边，用"待办条目在屏幕上的 y"（__rowsY）。
     卡片悬停展开时顶栏+输入条会把条目往下推 65px，只有咬住条目本身，
     鼠标底下的行才不会动。第一次由页面报高度时按当时的窗口位置推出来。 */
  w.__rowsY = null;
  w.__pad = 0;       /* 这张卡没有透明边距，所有 y 换算都按它来 */

  w.loadFile(path.join(__dirname, "todo.html"));

  w.once("ready-to-show", () => { w.show(); pushBackdrop(260); });

  /* 收放要看"光标到底还在不在窗口里"，这件事只有系统知道。
     第二参数只在光标**刚进窗口**时触发：桌面层模式下用它把本卡抬到兄弟窗口最上面，
     这样鼠标指哪张卡哪张就在前 —— 否则先进桌面层的那张会永远压住另一张。 */
  watchCursor(w, () => { if (dl.isOn()) dl.raise(); });

  /* ---------- 拖动中：把卡片退成"只剩任务框" ----------
     左键抓顶栏是系统原生 caption 拖动（吃得到 Aero Snap 分屏），这个动作浏览器
     侧完全看不到事件，只有主进程能感知：will-move 在窗口被挪之前来，move 在挪的
     过程中持续来。两条都用，谁先到谁开灯，之后谁在动谁续命，停手 260ms 关灯。

     难点是"自己挪"和"用户挪"走的是同一条路：展开/收起时我们自己会 setBounds，
     那也会触发 move。不挡掉的话，鼠标一悬停就整张卡透明一下。两把闸：
       · 自己伸缩 —— 目标 y 就是刚记下的 __autoY；
       · 页面发起的中键拖动 —— wgt:drag-move 会自己打时间戳，那 300ms 内不算。 */
  w.__lookOn = false;
  let lookTimer = null;
  let motion = [];            /* 最近 260ms 内的移动事件时间戳 */
  const setLook = (on) => {
    if (w.__lookOn === on) return;
    w.__lookOn = on;
    if (!w.webContents || w.webContents.isDestroyed()) return;
    try { w.webContents.send("wgt:drag-look", { on }); } catch (e) {}
  };
  const selfMove = () => {
    if (w.__autoY == null) return false;
    return Math.abs(w.getBounds().y - w.__autoY) <= 1;
  };
  /* 只有"连续在动"才算用户拖动。
     松手之后系统还会补一两个落位事件（窗口把最后一点位移结算掉），
     单看一个事件就开灯的话，卡片会在松手后又闪一下透明 —— 见过，很难看。
     所以要求 260ms 内至少两跳，孤零零的一跳不理它。 */
  const onMotion = () => {
    const now = Date.now();
    motion.push(now);
    while (motion.length && now - motion[0] > 260) motion.shift();
    if (motion.length < 2) return;
    if (!w.__lookOn) setLook(true);
    /* 兜底灭灯只兜"彻底停了"的情况：整整 1.2 秒没有任何一跳才关灯。
       真正的拖动结束由 moved 事件宣布（见下面 moved 处理器）。
       原来这里只等 320ms —— 用户慢慢把卡片往目标位置摆的时候（尤其贴着
       磨砂的天气卡），移动事件会断档超过 320ms，灯被灭掉又点亮，
       背景框就一闪一闪。中键路径没有这个超时（页面按住按钮期间一直亮），
       所以用户实测中键从不闪、左键闪，差别就在这里。 */
    clearTimeout(lookTimer);
    lookTimer = setTimeout(() => { motion = []; setLook(false); }, 1200);
  };
  w.on("will-move", (_e, nb) => {
    if (w.__autoY != null && Math.round(nb.y) === w.__autoY) return;
    if (Date.now() - (w.__midDragAt || 0) < 300) return;
    /* 只改 z 序（hover 抬升的 moveTop）也可能走到这里，
       但那种情况下 x/y 根本没变 —— 不是挪窗口 */
    const b = w.getBounds();
    if (Math.round(nb.x) === b.x && Math.round(nb.y) === b.y) return;
    onMotion();
  });
  w.on("move", () => {
    if (selfMove()) return;
    if (Date.now() - (w.__midDragAt || 0) < 300) return;
    onMotion();
  });
  w.on("closed", () => clearTimeout(lookTimer));

  /* 位置记忆（拖动会高频触发，做节流） */
  let moveTimer = null;
  w.on("moved", () => {
    /* 自动伸缩时我们会自己改 y（展开时向上长、长高了贴底时往上顶），
       那不是用户拖的，别覆盖存档。用"目标 y 精确比对"而不是时间窗：
       setBounds 触发的 moved 在 Windows 上可能晚到，靠计时器复位容易漏判。 */
    const b = w.getBounds();
    if (w.__autoY != null && b.y === w.__autoY) return;
    /* 用户松手，原生拖动结束 —— 这里才是关灯的权威信号。
       moved 只在用户拖动结束时来一次（中键路径的 setPosition 不触发它，
       中键的关灯由页面在 dragEnd 自己处理），所以在这里关灯不会误伤。
       拖动途中移动事件再怎么断档，灯也只认 moved，不再靠超时兜底灭掉。 */
    if (w.__lookOn) setLook(false);
    w.__autoY = null;
    w.__rowsY = b.y + w.__pad + (w.__top || 0);   /* 锚点跟着用户整体平移 */
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (w.isDestroyed()) return;
      const bb = w.getBounds();
      /* 存"收起状态"的顶边：拖动只可能在展开时发生（顶栏才看得见），
         直接存当前 y 的话，下次启动卡片会比用户摆的高 65px。 */
      const idleY = Math.round(bb.y + (w.__top || 0) - (w.__topMin || 0));
      patchCardState({ x: bb.x, y: idleY });
    }, 400);
  });

  w.on("closed", () => {
    if (w.__cursorTimer) clearInterval(w.__cursorTimer);
    win = null;
  });

  return w;
}

/* 开机自启：绿色版会把 exe 解到临时目录再运行，直接用 process.execPath 会指向临时文件，
   electron-builder 的 portable 运行器给了 PORTABLE_EXECUTABLE_FILE，优先用它。 */
function launchExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function getAutoStart() {
  try {
    return app.getLoginItemSettings({ path: launchExePath() }).openAtLogin === true;
  } catch (e) {
    return false;
  }
}

function setAutoStart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: launchExePath(), args: [] });
    return getAutoStart();
  } catch (e) {
    return false;
  }
}

/* ---------- 桌面空白处右键菜单 ----------
   往 HKCU\Software\Classes\DesktopBackground\Shell 下写一项，不碰 HKLM、不需要管理员。
   Explorer 会实时读这个位置，写完立刻生效；关掉就删掉整项。
   键名用 TodoWidget，跟天气卡片的 WeatherWidget 互不干扰，两个都装也不冲突。 */
const DESKTOP_MENU_KEY = "HKCU\\Software\\Classes\\DesktopBackground\\Shell\\TodoWidget";

function reg(args) {
  return new Promise((resolve) => {
    try {
      execFile("reg", args, { windowsHide: true }, (err) => resolve(!err));
    } catch (e) {
      resolve(false);
    }
  });
}

function getDesktopMenu() {
  return reg(["query", DESKTOP_MENU_KEY]);
}

async function setDesktopMenu(on) {
  if (!on) {
    await reg(["delete", DESKTOP_MENU_KEY, "/f"]);
    return getDesktopMenu();
  }
  const exe = launchExePath();
  await reg(["add", DESKTOP_MENU_KEY, "/ve", "/d", "显示待办卡片", "/f"]);
  await reg(["add", DESKTOP_MENU_KEY, "/v", "Icon", "/d", exe, "/f"]);
  /* 命令里带空格必须自己加引号，reg 不会替你转义 */
  await reg(["add", DESKTOP_MENU_KEY + "\\command", "/ve", "/d", '"' + exe + '"', "/f"]);
  return getDesktopMenu();
}

async function buildMenu() {
  const st = readCardState();
  const onTop = st.top === true;
  const desktopMenu = await getDesktopMenu();

  return Menu.buildFromTemplate([
    { label: "添加待办", accelerator: "CmdOrCtrl+N", click: () => win && win.webContents.send("todo:focus-input") },
    { label: "历史记录", click: () => win && win.webContents.send("todo:show-history") },
    { label: "清除已完成", click: () => win && win.webContents.send("todo:clear-done") },
    { label: "外观设置（透明度 / 磨砂）", click: () => win && win.webContents.send("todo:show-look") },
    {
      label: "完全体（整张卡常驻）",
      type: "checkbox",
      checked: !!(st.look && st.look.full),
      click: (item) => win && win.webContents.send("todo:set-fullmode", item.checked),
    },
    {
      label: "刷新桌面背景",
      click: () => {
        /* 正常情况下背景会自己跟着桌面变（交互后 0.4 秒、以及每 20 秒兜底抓一次），
           这里留一个手动入口，抓图失败或想立刻对齐时用。 */
        refreshSnapshot("menu");
      },
    },
    { type: "separator" },
    {
      label: "桌面右键菜单显示",
      type: "checkbox",
      checked: desktopMenu,
      click: async (item) => {
        /* 写失败（权限/组策略）就如实回弹，别让勾选状态骗人 */
        item.checked = await setDesktopMenu(item.checked);
      },
    },
    {
      label: "开机自动启动",
      type: "checkbox",
      checked: getAutoStart(),
      click: (item) => setAutoStart(item.checked),
    },
    { type: "separator" },
    {
      label: "贴进桌面（和桌面图标同层）",
      type: "checkbox",
      checked: st.desktopLayer === true,
      click: (item) => { toggleDesktopLayer(item.checked); },
    },
    {
      label: "窗口置顶",
      type: "checkbox",
      checked: onTop,
      click: (item) => {
        patchCardState({ top: item.checked });
        if (win && !win.isDestroyed()) {
          win.setAlwaysOnTop(item.checked, "floating");
        }
      },
    },
    { type: "separator" },
    { label: "退出", role: "quit" },
  ]);
}

/* 只允许一个实例，重复双击只把已开的窗口提到前面 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createWindow();
  });
}

app.whenReady().then(() => {
  maybeMigrateLegacy();
  createWindow();
  startMidWatch();   /* 桌面层下页面收不到中键，靠主进程轮询兜住 */
  startDesktopWatch();  /* 桌面一有动作就重抓背景快照，让卡片背景跟着桌面变 */
  registerImeIpc();  /* 桌面层里子窗口拿不到键盘焦点，打字由幽灵输入窗代收 */

  /* 快捷键兜底：万一贴进桌面后看不见窗口（或鼠标点不到），也能一键退回来。
     Ctrl+Alt+1 = 贴进桌面 / 退回普通窗口 来回切。 */
  try {
    const okKey = globalShortcut.register("Control+Alt+1", () => {
      const on = readCardState().desktopLayer === true;
      toggleDesktopLayer(!on);
    });
    if (!okKey) console.warn("快捷键 Control+Alt+1 被占用，未注册");
  } catch (e) { /* 注册失败不影响其它功能 */ }

  const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.on("wgt:close", (e) => {
    const w = senderWin(e);
    if (w) w.close();
  });

  ipcMain.on("wgt:menu", async (e) => {
    const w = senderWin(e);
    if (!w) return;
    const m = await buildMenu();
    m.popup({ window: w });
  });

  ipcMain.handle("wgt:get-top", () => readCardState().top === true);

  ipcMain.handle("wgt:set-top", (e, v) => {
    patchCardState({ top: !!v });
    const w = senderWin(e);
    if (w) w.setAlwaysOnTop(!!v, "floating");
    return !!v;
  });

  /* ---------- 鼠标指上来就临时浮到最前（已移除，v1.0.3） ----------
     以前这里有个 hover 抬升：鼠标进窗口矩形就把卡片提到最前、移开还原。
     但 watchCursor 是纯几何判断（光标坐标 vs 窗口矩形，不看遮挡），
     卡片被别的窗口整个压住时，鼠标扫过那块屏幕区域也会被判"进入"，
     卡片就自己跳出来打断人 —— 用户实测很烦，按要求移除。
     被压住想唤回：右键桌面 →"显示待办卡片"（second-instance 提到最前）。 */

  /* 左键抓顶栏是系统原生 caption 拖动，主进程不插手；但中键够不着那条 22px
     的标题栏（drag region 不派发 DOM 事件给中键），所以中键这条路改由页面算
     位移、主进程照着挪。屏幕坐标起步，窗口一动 client 坐标就失真。 */
  /* 左键抓顶栏 / 中键按住 —— 都改由主进程自己跟着系统光标搬窗口
     （页面只负责报"开始/结束"，理由见 dragBegin 上面那一大段）。
     页面发来的 drag-move 只在没有 koffi 时兜底用得上。 */
  ipcMain.on("wgt:drag-begin", (e, btn) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    dragBegin(w, btn);
  });

  ipcMain.on("wgt:drag-move", (e, dx, dy) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed() || !w.__dragFrom) return;
    w.__midDragAt = Date.now();     /* 告诉 move 监听：这是页面发起的，别插手外观 */
    const f = w.__dragFrom;
    const nx = Math.round(f.x + (Number(dx) || 0));
    const ny = Math.round(f.y + (Number(dy) || 0));
    w.setPosition(nx, ny);
    /* 中键拖动是页面算位移、主进程 setPosition —— Windows 上这条路径不会触发
       moved 事件，所以位置锚点必须在每一次挪动里同步更新。不然松手后鼠标一移开、
       卡片收起，set-card-height 会用旧锚点反推 y，把窗口拉回拖动前的位置
       （就是用户报的"松手又弹回原位"）。 */
    w.__rowsY = ny + w.__pad + (w.__top || 0);
    /* 兜底：鼠标冲出窗口后页面可能再也收不到事件，别让窗口一直黏着鼠标 */
    clearTimeout(w.__dragTimer);
    w.__dragTimer = setTimeout(() => { if (!w.isDestroyed()) w.__dragFrom = null; }, 1200);
  });

  ipcMain.on("wgt:drag-end", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    clearTimeout(w.__dragTimer);
    if (w.__drag) { dragStop(w, true); return; }   /* 主进程接管的那条路 */
    /* 兜底路径（没有 koffi）：位置是页面 setPosition 改的，同样不会来 moved */
    w.__dragFrom = null;
    const b = w.getBounds();
    w.__rowsY = b.y + (w.__pad || 0) + (w.__top || 0);
    const idleY = Math.round(b.y + (w.__top || 0) - (w.__topMin || 0));
    patchCardState({ x: b.x, y: idleY });
    pushBackdrop(140);
  });

  /* 页面按内容报高度，主进程改窗口尺寸。
     页面报 { h, top, topMin }：h=卡片高度，top=待办区上沿距卡片顶的距离，
     topMin=收起状态下的 top。y 用"条目在屏幕上不动"反推，所以悬停展开时
     顶栏和输入条是从上面长出来的，鼠标底下的条目纹丝不动。 */
  /* 页面报"真正画了东西的矩形"，主进程照着裁窗口形状（见文件上方 applyRegion） */
  ipcMain.on("wgt:set-region", (e, list) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    applyRegion(w, list);
  });

  /* 页面加载完自己来要一次快照背景（主进程推的那条可能早于页面就绪） */
  ipcMain.handle("wgt:backdrop-now", () => bdPayload());

  /* 外观设置：透明度（alpha）/ 磨砂（frost，CSS 模糊半径 px），存进 state.todo.look */
  ipcMain.handle("wgt:get-look", () => readCardState().look || null);
  ipcMain.handle("wgt:set-look", (e, v) => {
    const o = (v && typeof v === "object") ? v : {};
    const look = {
      alpha: Math.min(0.95, Math.max(0.06, Number(o.alpha) || 0.56)),
      frost: Math.min(20, Math.max(0, Number(o.frost) || 0)),
      full: o.full ? 1 : 0,   /* 完全体：整张卡常驻 */
    };
    patchCardState({ look });
    return look;
  });

  ipcMain.handle("wgt:set-card-height", (e, want) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return false;

    /* ★ 拖动期间一律不碰窗口。位置由拖动 tick 独占（每 8ms 跟着系统光标搬），
       这里再 setBounds 就是两边抢同一个窗口 —— 实测：拖到一半静止 1.2 秒，
       窗口自己往下跳了 126px，手上就是"漂移"。拖完页面会再发一次，那时再应用。 */
    if (w.__drag) return true;

    const msg = (want && typeof want === "object") ? want : { h: want, top: 0, topMin: 0 };
    const top = Math.max(0, Math.round(Number(msg.top) || 0));
    const topMin = Math.max(0, Math.round(Number(msg.topMin) || 0));

    const b = w.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const maxCard = Math.min(640, Math.round(wa.height * 0.72));
    const cardH = Math.round(
      Math.min(Math.max(Number(msg.h) || CARD_H, 50), maxCard)
    );
    const pad = w.__pad || 0;
    const H = cardH + pad * 2;

    if (w.__rowsY == null) w.__rowsY = b.y + pad + top;
    w.__top = top;
    w.__topMin = topMin;

    let y = Math.round(w.__rowsY - pad - top);
    y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - H - 8));

    /* 正在拖动时，别处（悬停展开/收起、贴底顶回）改了 y：把拖动的基准点一起平移，
       否则下一帧 tick 会按旧基准把窗口拽回去 —— 手上就是"一顿一跳"。
       基准跟窗口一起走，画面才连续。 */
    if (w.__drag && y !== b.y) w.__drag.oy += (y - b.y);

    if (H === b.height && y === b.y) return true;

    w.__autoY = y;      /* 记下这次是我们自己改的 y，moved 事件据此放行 */
    w.setBounds({ x: b.x, y: y, width: b.width, height: H }, false);
    pushBackdrop(220);  /* 尺寸/位置变了（悬停展开、收起），快照跟着重裁 */
    setTimeout(() => { if (!w.isDestroyed()) w.__autoY = null; }, 1500);
    return true;
  });
});

app.on("window-all-closed", () => { app.quit(); });

/* 退出时把快捷键还回去（否则再启动会注册失败） */
app.on("will-quit", () => {
  try { globalShortcut.unregisterAll(); } catch (e) { /* 无所谓 */ }
});
