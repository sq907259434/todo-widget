/* 待办清单（独立版）—— Electron 主进程
   从合体版「WeatherWidget 1.9.1」拆出：本应用只带待办一张卡。
   全透明窗口（不用 acrylic —— 材质会铺满整个窗口矩形，页面再透明也会被
   系统那层糊住，"只剩任务框"的效果出不来）+ 鼠标碰到展开 + 拖动 + 记忆位置 */

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

/* 卡片尺寸。窗口必须正好等于卡片：它靠"鼠标碰到"来决定展开，
   四周要是留了透明边距，鼠标还在卡片外面卡片就弹开了。 */
const CARD_W = 320;
const CARD_H = 302;   /* 首次默认高度，实际由页面按条数上报 */

let win = null;

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
    fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
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
function watchCursor(w) {
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
    try { w.webContents.send("wgt:cursor", { inside }); } catch (e) {}
  }, 90);
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

  if (top) w.setAlwaysOnTop(true, "floating");

  /* 锚点不用顶边，用"待办条目在屏幕上的 y"（__rowsY）。
     卡片悬停展开时顶栏+输入条会把条目往下推 65px，只有咬住条目本身，
     鼠标底下的行才不会动。第一次由页面报高度时按当时的窗口位置推出来。 */
  w.__rowsY = null;
  w.__pad = 0;       /* 这张卡没有透明边距，所有 y 换算都按它来 */

  w.loadFile(path.join(__dirname, "todo.html"));

  w.once("ready-to-show", () => { w.show(); });

  /* 收放要看"光标到底还在不在窗口里"，这件事只有系统知道 */
  watchCursor(w);

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

  const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.on("wgt:close", (e) => {
    const w = senderWin(e);
    if (w) w.close();
  });

  ipcMain.on("wgt:menu", async (e) => {
    const w = senderWin(e);
    if (!w) return;
    const m = await buildMenu();
    /* 菜单弹出时卡片会失焦、鼠标也离开页面。标记一下，免得这时候被"还原到后面"，
       结果菜单还开着、卡片已经被别的窗口盖住。 */
    w.__menuOpen = true;
    w.__restPending = false;
    m.popup({
      window: w,
      callback: () => {
        if (w.isDestroyed()) return;
        w.__menuOpen = false;
        if (!w.__restPending) return;
        w.__restPending = false;
        w.setAlwaysOnTop(readCardState().top === true, "floating");
      },
    });
  });

  ipcMain.handle("wgt:get-top", () => readCardState().top === true);

  ipcMain.handle("wgt:set-top", (e, v) => {
    patchCardState({ top: !!v });
    const w = senderWin(e);
    if (w) w.setAlwaysOnTop(!!v, "floating");
    return !!v;
  });

  /* ---------- 鼠标指上来就临时浮到最前 ----------
     用户把别的窗口压到待办卡上，按"点一下"才浮上来太迟钝；
     hover 即抬升、移开即还原 —— 都是临时的，不写进存档，
     用户自己在菜单里设的"窗口置顶"不能被它改掉。 */
  ipcMain.on("wgt:raise", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    w.__hoverTop = true;
    if (!w.isAlwaysOnTop()) w.setAlwaysOnTop(true, "floating");
    /* ★ 只打上"置顶"这个样式并不会改变它在置顶层里的前后位置：
       其他窗口本来就是置顶的时候，光 setAlwaysOnTop 翻不上去 —— 实测 z 序一点没变。
       必须再主动提一次。 */
    w.moveTop();
  });

  ipcMain.on("wgt:rest", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    w.__hoverTop = false;
    if (w.__menuOpen) { w.__restPending = true; return; }   /* 菜单还开着，等它关了再沉 */
    w.setAlwaysOnTop(readCardState().top === true, "floating");
  });

  /* 左键抓顶栏是系统原生 caption 拖动，主进程不插手；但中键够不着那条 22px
     的标题栏（drag region 不派发 DOM 事件给中键），所以中键这条路改由页面算
     位移、主进程照着挪。屏幕坐标起步，窗口一动 client 坐标就失真。 */
  ipcMain.on("wgt:drag-begin", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    w.__dragFrom = w.getBounds();
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
    w.__dragFrom = null;
    /* 位置在这里落盘，不能等 moved —— 中键拖动根本不会来 moved，等的话位置就
       永远记不住（下次启动回到旧位置）。存"收起态"的顶边：y + top - topMin。 */
    const b = w.getBounds();
    const idleY = Math.round(b.y + (w.__top || 0) - (w.__topMin || 0));
    patchCardState({ x: b.x, y: idleY });
  });

  /* 页面按内容报高度，主进程改窗口尺寸。
     页面报 { h, top, topMin }：h=卡片高度，top=待办区上沿距卡片顶的距离，
     topMin=收起状态下的 top。y 用"条目在屏幕上不动"反推，所以悬停展开时
     顶栏和输入条是从上面长出来的，鼠标底下的条目纹丝不动。 */
  ipcMain.handle("wgt:set-card-height", (e, want) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return false;

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

    if (H === b.height && y === b.y) return true;

    w.__autoY = y;      /* 记下这次是我们自己改的 y，moved 事件据此放行 */
    w.setBounds({ x: b.x, y: y, width: b.width, height: H }, false);
    setTimeout(() => { if (!w.isDestroyed()) w.__autoY = null; }, 1500);
    return true;
  });
});

app.on("window-all-closed", () => { app.quit(); });
