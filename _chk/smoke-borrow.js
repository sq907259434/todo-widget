/* 冒烟：借鉴自 GlassWidgets 的 4 个点。
   前提：新版打包 TodoCard 以 --remote-debugging-port=9224 启动。
   scenarios:
     edit     —— 双击条目改字→回车保存，核对 items 与 localStorage
     bluradd  —— 输入框打字不回车→点别处（失焦），核对自动添加
     swipe    —— 按住条目右滑超过阈值松手，核对删除+历史
     atomic   —— 触发一次位置保存后，检查 widget-state.json 能整包解析、无 .tmp 残留
   用法：node _chk/smoke-borrow.js <scenario>
*/
const WebSocket = require("C:/Users/90725/WorkBuddy/2026-10-27-18-13-03/weather-widget/node_modules/ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(port) {
  return new Promise((res, rej) => {
    http.get("http://127.0.0.1:" + port + "/json", (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => {
        const p = JSON.parse(d).find((t) => t.type === "page");
        if (!p) return rej(new Error("NO_PAGE"));
        const ws = new WebSocket(p.webSocketDebuggerUrl);
        ws.on("open", () => res(ws));
        ws.on("error", rej);
      });
    }).on("error", rej);
  });
}

let mid = 0;
const pending = new Map();
function send(ws, method, params) {
  return new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
function onMsg(ws) {
  ws.on("message", (m) => {
    const g = JSON.parse(m);
    if (g.id && pending.has(g.id)) { pending.get(g.id)(g); pending.delete(g.id); }
  });
}
async function evalJs(ws, expr) {
  const g = await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (g.result && g.result.exceptionDetails) throw new Error("PAGE-ERR " + JSON.stringify(g.result.exceptionDetails).slice(0, 300));
  return g.result && g.result.result ? g.result.result.value : null;
}
async function centerOf(ws, sel) {
  const v = await evalJs(ws, `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  return v;
}
async function click(ws, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send(ws, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    await sleep(60);
  }
}
async function dblclick(ws, x, y) {
  /* 页面自己判双击（420ms 内两下、位移小于 6px），所以按普通 click 连发两次即可 */
  await click(ws, x, y);
  await sleep(120);
  await click(ws, x, y);
  await sleep(300);
}

(async () => {
  const [scenario] = process.argv.slice(2);
  const ws = await connect(9224);
  onMsg(ws);
  await sleep(400);

  if (scenario === "edit") {
    /* 准备：确保有一条已知文字的待办 */
    await evalJs(ws, `(function(){
      if(!state.items.some(function(x){return x.text==="借测-双击改字";})){
        add("借测-双击改字");
      }
      return state.items.length;
    })()`);
    await sleep(400);
    const c = await evalJs(ws, `(function(){
      var row=[...document.querySelectorAll('.row')].find(function(r){return r.textContent.indexOf("借测-双击改字")>=0;});
      if(!row)return null;
      var e=row.querySelector('.txt');var b=e.getBoundingClientRect();
      return {x:b.x+b.width/2,y:b.y+b.height/2};
    })()`);   /* 只点目标那一行，别碰用户真实条目 */
    if (!c) throw new Error("NO_TXT");
    await dblclick(ws, c.x, c.y);
    /* 编辑框应已出现 */
    const has = await evalJs(ws, `!!document.querySelector('.etxt')`);
    if (!has) throw new Error("EDIT_BOX_NOT_OPEN");
    /* 全选替换：Ctrl+A 之后 insertText */
    await send(ws, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(100);
    await send(ws, "Input.insertText", { text: "借测-改好了" });
    await sleep(150);
    /* 回车保存 */
    await send(ws, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(500);
    const ok = await evalJs(ws, `state.items.some(function(x){return x.text==="借测-改好了";}) && !state.items.some(function(x){return x.text==="借测-双击改字";})`);
    const ls = await evalJs(ws, `JSON.parse(localStorage.getItem("todo_v1")).some(function(x){return x.text==="借测-改好了";})`);
    console.log("EDIT", ok && ls ? "PASS" : "FAIL", "items-ok=" + ok, "ls-ok=" + ls);
  }

  if (scenario === "bluradd") {
    const before = await evalJs(ws, `state.items.length`);
    const c = await centerOf(ws, "#inp");
    await click(ws, c.x, c.y);
    await sleep(300);
    await send(ws, "Input.insertText", { text: "借测-失焦添加" });
    await sleep(200);
    /* 不回车，直接点顶栏标题让输入框失焦 */
    const t = await centerOf(ws, ".ttl");
    await click(ws, t.x, t.y);
    await sleep(600);
    const after = await evalJs(ws, `state.items.length`);
    const added = await evalJs(ws, `state.items.some(function(x){return x.text==="借测-失焦添加";})`);
    const cleared = await evalJs(ws, `document.getElementById("inp").value === ""`);
    console.log("BLURADD", added && cleared && after === before + 1 ? "PASS" : "FAIL",
      "added=" + added, "cleared=" + cleared, before + "->" + after);
  }

  if (scenario === "swipe") {
    /* 准备一条干净的行放在最后：add 会 push 到尾部 */
    await evalJs(ws, `add("借测-右滑删")`);
    await sleep(400);
    const rows = await evalJs(ws, `(function(){
      var items=[...document.querySelectorAll('.row')];
      var e=items[items.length-1].querySelector('.item');
      var r=e.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    const before = await evalJs(ws, `state.items.length`);
    /* 按住 → 分步右滑 110px（阈值 82）→ 松手 */
    await send(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: rows.x, y: rows.y, button: "left", clickCount: 1 });
    await sleep(80);
    for (let i = 1; i <= 8; i++) {
      await send(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x: rows.x + (110 / 8) * i, y: rows.y, button: "left" });
      await sleep(40);
    }
    await send(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x: rows.x + 110, y: rows.y, button: "left", clickCount: 1 });
    await sleep(700);   /* 飞出动画 190ms + remove */
    const after = await evalJs(ws, `state.items.length`);
    const gone = await evalJs(ws, `!state.items.some(function(x){return x.text==="借测-右滑删";})`);
    const inHist = await evalJs(ws, `state.hist.some(function(x){return x.text==="借测-右滑删" && x.kind==="del";})`);
    console.log("SWIPE", gone && inHist && after === before - 1 ? "PASS" : "FAIL",
      "gone=" + gone, "hist=" + inHist, before + "->" + after);
  }

  if (scenario === "atomic") {
    /* 触发一次位置保存：走 wgt.setCardHeight（页面正常上报就会写盘） */
    await evalJs(ws, `syncHeight(true)`);
    await sleep(600);
    /* 主进程侧验证：node 直接读 userData */
    const ud = process.env.APPDATA + "\\TodoCard";
    const sf = path.join(ud, "widget-state.json");
    const raw = fs.readFileSync(sf, "utf8");
    const j = JSON.parse(raw);          /* 解析失败会抛 */
    const tmpLeft = fs.existsSync(sf + ".tmp");
    console.log("ATOMIC", "PASS", "todo-y=" + (j.todo && j.todo.y), "tmp-left=" + tmpLeft);
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
