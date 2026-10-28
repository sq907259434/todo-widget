/* 查询两卡窗口的精确逻辑坐标：node _chk/win-pos.js */
const WebSocket = require("C:/Users/90725/WorkBuddy/2026-10-27-18-13-03/weather-widget/node_modules/ws");
const http = require("http");

function q(port) {
  return new Promise((res) => {
    http.get("http://127.0.0.1:" + port + "/json", (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => {
        const p = JSON.parse(d).find((t) => t.type === "page");
        if (!p) return res("NO_PAGE");
        const ws = new WebSocket(p.webSocketDebuggerUrl);
        ws.on("open", () => {
          ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
            expression: "JSON.stringify({x:window.screenX,y:window.screenY,w:window.outerWidth,h:window.outerHeight,dpr:window.devicePixelRatio})",
            returnByValue: true,
          }}));
        });
        ws.on("message", (m) => {
          const g = JSON.parse(m);
          if (g.id === 1) { res(g.result.result.value); ws.close(); }
        });
      });
    });
  });
}

(async () => {
  console.log("weather:", await q(9223));
  console.log("todo:", await q(9224));
})();
