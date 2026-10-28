/* 读窗口与顶栏的精确几何：node _chk/geo-probe.js <port> */
const WebSocket = require("ws");
const http = require("http");
const port = process.argv[2] || "9224";
http.get("http://127.0.0.1:" + port + "/json", (res) => {
  let d = "";
  res.on("data", (c) => d += c);
  res.on("end", () => {
    const pages = JSON.parse(d).filter((t) => t.type === "page");
    if (!pages.length) { console.log("NO_PAGE"); process.exit(1); }
    const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
        expression: `(function(){
          const hd = document.querySelector('.hd');
          const hr = hd.getBoundingClientRect();
          return JSON.stringify({
            screenX: window.screenX, screenY: window.screenY,
            dpr: window.devicePixelRatio,
            outerW: window.outerWidth, outerH: window.outerHeight,
            hdY: hr.y, hdH: hr.height, hdX: hr.x, hdW: hr.width,
          });
        })()`,
        returnByValue: true,
      }}));
    });
    ws.on("message", (m) => {
      const msg = JSON.parse(m);
      if (msg.id === 1) { console.log(msg.result.result.value); process.exit(0); }
    });
  });
});
