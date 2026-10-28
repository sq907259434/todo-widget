/* 拖动外观探针：连 CDP 轮询 body.dragging，记录每次翻转的时间与原因线索
   用法: node _chk/look-probe.js <port> <时长ms> <间隔ms>
   结束时输出: 全部翻转时刻 + 页面 blur/focus 事件表 */
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");

const port = process.argv[2] || "9224";
const DUR = parseInt(process.argv[3] || "6000", 10);
const IV = parseInt(process.argv[4] || "40", 10);

http.get("http://127.0.0.1:" + port + "/json", (res) => {
  let d = "";
  res.on("data", (c) => d += c);
  res.on("end", () => {
    const pages = JSON.parse(d).filter((t) => t.type === "page");
    if (!pages.length) { console.log("NO_PAGE"); process.exit(1); }
    const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
    const log = [];
    const t0 = Date.now();
    let last = null;
    let seq = 0;

    const send = (expr) => {
      seq += 1;
      ws.send(JSON.stringify({ id: seq, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
      return seq;
    };

    ws.on("open", () => {
      /* 页面里先装好 blur/focus 记录器（幂等） */
      send("(function(){ if(!window.__bf){ window.__bf=[]; window.addEventListener('blur',()=>window.__bf.push(['blur',Date.now()])); window.addEventListener('focus',()=>window.__bf.push(['focus',Date.now()])); } return 'ok'; })()");
      const timer = setInterval(() => {
        if (Date.now() - t0 > DUR) {
          clearInterval(timer);
          send("JSON.stringify({bf: window.__bf || []})");
          return;
        }
        send("(function(){ return JSON.stringify({d: document.body.classList.contains('dragging'), full: document.getElementById('card') ? document.getElementById('card').classList.contains('full') : null}); })()");
      }, IV);
    });

    ws.on("message", (m) => {
      const msg = JSON.parse(m);
      if (!msg.id || !msg.result) return;
      const v = msg.result.result && msg.result.result.value;
      if (typeof v !== "string") return;
      if (v.startsWith("{\"d\"")) {
        const o = JSON.parse(v);
        if (o.d !== last) {
          log.push([Date.now() - t0, "dragging=" + o.d + " full=" + o.full]);
          last = o.d;
        }
      } else if (v.startsWith("{\"bf\"")) {
        const o = JSON.parse(v);
        console.log("=== dragging 翻转记录 (ms, 相对探针启动) ===");
        log.forEach((r) => console.log(r[0] + "ms  " + r[1]));
        if (!log.length) console.log("(无翻转，dragging 恒为 " + last + ")");
        console.log("=== 页面 blur/focus 事件 ===");
        o.bf.forEach((e) => console.log(e[1] - t0 + "ms  " + e[0]));
        if (!o.bf.length) console.log("(无)");
        fs.writeFileSync(__dirname + "/look-probe-last.txt", JSON.stringify({ flips: log, bf: o.bf }, null, 2));
        ws.close();
        process.exit(0);
      }
    });
  });
});
