/* 点击可达性测试：装 mousedown/mouseup 监听 → 等外部脚本点击 → 报告收到的事件
   用法: node _chk/click-test.js <port> <等待ms> */
const WebSocket = require("ws");
const http = require("http");
const port = process.argv[2] || "9224";
const WAIT = parseInt(process.argv[3] || "6000", 10);
http.get("http://127.0.0.1:" + port + "/json", (res) => {
  let d = "";
  res.on("data", (c) => d += c);
  res.on("end", () => {
    const pages = JSON.parse(d).filter((t) => t.type === "page");
    if (!pages.length) { console.log("NO_PAGE"); process.exit(1); }
    const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
    ws.on("open", () => {
      const t0 = Date.now();
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
        expression: `(function(){
          if (!window.__ct) {
            window.__ct = [];
            ['mousedown','mouseup','mousemove'].forEach((ev) =>
              document.addEventListener(ev, (e) => {
                if (window.__ct.length < 500) window.__ct.push([ev, e.button, Math.round(e.clientX), Math.round(e.clientY)]);
              }, true));
          }
          window.__ct.length = 0;
          return 'installed';
        })()`,
        returnByValue: true,
      }}));
      const timer = setInterval(() => {
        if (Date.now() - t0 > WAIT) {
          clearInterval(timer);
          ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: {
            expression: "JSON.stringify(window.__ct || [])",
            returnByValue: true,
          }}));
        }
      }, 200);
    });
    let got2 = false;
    ws.on("message", (m) => {
      const msg = JSON.parse(m);
      if (msg.id === 2 && msg.result) {
        got2 = true;
        const evts = JSON.parse(msg.result.result.value || "[]");
        console.log("PAGE-EVENTS=" + evts.length);
        const down = evts.filter((e) => e[0] !== "mousemove");
        down.forEach((e) => console.log(e[0] + " btn=" + e[1] + " @" + e[2] + "," + e[3]));
        console.log("mousemoves=" + (evts.length - down.length));
        process.exit(0);
      }
    });
    setTimeout(() => { if (!got2) { console.log("TIMEOUT"); process.exit(1); } }, WAIT + 3000);
  });
});
