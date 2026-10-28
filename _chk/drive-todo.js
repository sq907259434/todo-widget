/* 录制驱动：通过 CDP 操作待办卡页面。
   用法：node _chk/drive-todo.js <scenario> [args...]
   scenarios:
     actions   —— 加一条待办→打勾→删除→开历史→回主页（配套停顿，总约 18s）
     middrag <dx> <dy> —— 用 wgt API 做中键拖动（约 3s）
*/
const WebSocket = require("C:/Users/90725/WorkBuddy/2026-10-27-18-13-03/weather-widget/node_modules/ws");
const http = require("http");
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
  return g.result && g.result.result ? g.result.result.value : null;
}
async function rectOf(ws, sel) {
  const v = await evalJs(ws, `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
  return v ? { x: v.x + v.w / 2, y: v.y + v.h / 2 } : null;
}
async function click(ws, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send(ws, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    await sleep(60);
  }
}
async function move(ws, x, y) {
  await send(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

(async () => {
  const [scenario, a1, a2] = process.argv.slice(2);
  const ws = await connect(9224);
  onMsg(ws);
  await sleep(500);

  if (scenario === "dedup") {
    // 删除所有文本包含指定关键词的行（默认“给群友”）
    const kw = a1 || "给群友";
    for (let round = 0; round < 4; round++) {
      const r = await evalJs(ws, `(function(){
        var rows=[...document.querySelectorAll('.row')];
        var e=rows.find(x=>x.textContent.includes(${JSON.stringify(kw)}));
        if(!e)return null;
        e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
        var d=e.querySelector('.del'); var b=(d||e).getBoundingClientRect();
        return {x:b.x+b.width/2,y:b.y+b.height/2};
      })()`);
      if (!r) break;
      await move(ws, r.x, r.y); await sleep(400); await click(ws, r.x, r.y); await sleep(700);
    }
    console.log("DEDUP-DONE");
  }

  if (scenario === "actions") {
    // 1) 点输入框并输入
    let r = await rectOf(ws, "#inp");
    if (!r) throw new Error("no input");
    await click(ws, r.x, r.y);
    await sleep(400);
    await send(ws, "Input.insertText", { text: "给群友也整一个桌面小卡" });
    await sleep(700);
    // 2) 回车提交
    await send(ws, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(900);
    // 3) 给第一条未完成的打勾
    r = await evalJs(ws, `(function(){var e=document.querySelector('.row .chk');if(!e)return null;var b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    if (r) { await click(ws, r.x, r.y); }
    await sleep(900);
    // 4) 悬停该行让垃圾桶出现并点击删除
    r = await evalJs(ws, `(function(){var rows=document.querySelectorAll('.row');var e=rows[0];if(!e)return null;e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));var b=e.getBoundingClientRect();return {x:b.x+b.width-30,y:b.y+b.height/2};})()`);
    if (r) { await move(ws, r.x, r.y); await sleep(500); await click(ws, r.x, r.y); }
    await sleep(900);
    // 5) 历史：点时钟图标，停 3 秒，返回
    r = await rectOf(ws, "#histBtn");
    if (r) { await click(ws, r.x, r.y); }
    await sleep(3000);
    r = await rectOf(ws, "#histBtn");
    if (r) { await click(ws, r.x, r.y); }
    await sleep(500);
    console.log("ACTIONS-DONE");
  }

  if (scenario === "middrag") {
    const dx = Number(a1) || -300, dy = Number(a2) || -150, steps = 12, ms = 90;
    await evalJs(ws, "window.wgt && window.wgt.dragBegin()");
    await sleep(150);
    for (let i = 1; i <= steps; i++) {
      await evalJs(ws, `window.wgt && window.wgt.dragMove(${(dx / steps).toFixed(2)},${(dy / steps).toFixed(2)})`);
      await sleep(ms);
    }
    await evalJs(ws, "window.wgt && window.wgt.dragEnd()");
    await sleep(300);
    console.log("MIDDRAG-DONE");
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
