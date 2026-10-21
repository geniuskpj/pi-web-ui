import { spawn, spawnSync } from "node:child_process";
import WebSocket from "ws";
const PORT = 8790;
const srv = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: String(PORT), PI_WEB_PORT: String(PORT), PI_WEB_DEBUG: "1" }, stdio: ["ignore","pipe","pipe"] });
let log=""; srv.stdout.on("data",d=>log+=d); srv.stderr.on("data",d=>log+=d);
await new Promise(r=>setTimeout(r,2500));
await new Promise((resolve,reject)=>{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?session=debug0123456789abcdef`, { origin: `http://127.0.0.1:${PORT}` });
  const t0=Date.now();
  ws.on("open",()=>{ console.log("[open]"); ws.send(JSON.stringify({t:"i",d:"echo DEBUG_$((6*7))\r"})); });
  ws.on("message",(raw)=>{ const s=raw.toString(); console.log(`[+${Date.now()-t0}ms]`, JSON.stringify(s.slice(0,240))); if(s.includes("DEBUG_42")||Date.now()-t0>12000){ try{spawnSync("taskkill",["/F","/T","/PID",String(srv.pid)],{stdio:"ignore"});}catch{}; process.exit(s.includes("DEBUG_42")?0:1);} });
  ws.on("error",(e)=>{ console.log("[err]",e.message); try{spawnSync("taskkill",["/F","/T","/PID",String(srv.pid)],{stdio:"ignore"});}catch{}; process.exit(2); });
});
