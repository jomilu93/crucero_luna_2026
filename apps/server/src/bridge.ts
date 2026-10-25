/**
 * Browser side of "Call the Bridge" (see voice.ts): the phone call page, and the bridge overlay
 * the TV page loads. Both use the Anam JS SDK from a CDN; the phone→TV mic relay streams 16 kHz
 * 16-bit PCM over a WebSocket and the TV feeds it to the avatar as its microphone.
 */
import { SHIP_NAME } from "@crucero/agent";
import { MAX_CALL_SECONDS } from "./voice.js";
import { esc } from "./web.js";

export const ANAM_SDK = "https://cdn.jsdelivr.net/npm/@anam-ai/js-sdk@4.27.1/+esm";
/** A safety net only, a minute after the vendors' own limit: calls end when the caller hangs up or goes quiet. */
export const MAX_CALL_MS = (MAX_CALL_SECONDS + 60) * 1000;

/** Shared browser helpers: the mic capture and playback worklets, PCM conversion, and the WebSocket URL. */
const AUDIO_JS = `
const RATE = 16000;
const CAPTURE = "class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('cap',C)";
const PLAY = "class P extends AudioWorkletProcessor{constructor(){super();this.q=[];this.o=0;this.port.onmessage=e=>{this.q.push(e.data);if(this.q.length>40)this.q.splice(0,this.q.length-8)}}process(_,outs){const out=outs[0][0];let i=0;while(i<out.length){if(!this.q.length){out.fill(0,i);break}const b=this.q[0];const n=Math.min(out.length-i,b.length-this.o);out.set(b.subarray(this.o,this.o+n),i);i+=n;this.o+=n;if(this.o>=b.length){this.q.shift();this.o=0}}return true}}registerProcessor('play',P)";
const worklet = async (ctx, src) => ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
function toPcm16(f32, fromRate) {
  const ratio = fromRate / RATE, n = Math.floor(f32.length / ratio), out = new Int16Array(n);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f32[Math.floor(i * ratio)])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return out;
}
const fromPcm16 = (buf) => { const i16 = new Int16Array(buf), f = new Float32Array(i16.length); for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000; return f; };
const wsUrl = (path) => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + path;
`;

const PHONE_CSS = `
:root{--navy:#0b1f3f;--blue:#1565d8;--gold:#f2b632}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:radial-gradient(120% 80% at 50% 0%,#12408a 0%,#0b1f3f 55%,#06101e 100%);color:#fff;font:16px/1.45 "Plus Jakarta Sans",system-ui,-apple-system,sans-serif;overflow:hidden}
.wrap{position:relative;height:100%;max-width:560px;margin:0 auto;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:calc(18px + env(safe-area-inset-top)) 20px calc(26px + env(safe-area-inset-bottom))}
.top{width:100%;display:flex;justify-content:space-between;align-items:center}.top a{color:#fff;text-decoration:none;display:inline-flex;gap:6px;align-items:center;font-weight:700;opacity:.85}
.who{text-align:center;margin-top:4vh}.ring{position:relative;width:min(62vw,260px);aspect-ratio:1;margin:0 auto 22px;border-radius:50%;padding:6px;background:conic-gradient(from 180deg,var(--gold),#fff6d5,var(--gold))}
.ring img,.ring .ph{width:100%;height:100%;border-radius:50%;object-fit:cover;display:grid;place-items:center;background:#0f2d5c;font-size:90px}
.ring:after{content:"";position:absolute;inset:-14px;border-radius:50%;border:2px solid rgba(242,182,50,.35);animation:pulse 2.4s infinite}
@keyframes pulse{0%{transform:scale(.95);opacity:1}100%{transform:scale(1.12);opacity:0}}
h1{margin:0;font-size:28px}.sub{opacity:.75}.status{min-height:24px;margin-top:10px;font-weight:600;color:var(--gold)}
.btns{width:100%;display:flex;flex-direction:column;gap:12px}
button{font:inherit;font-weight:800;border:0;border-radius:18px;padding:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;font-size:17px}
.call{background:#16a34a;color:#fff;box-shadow:0 10px 30px rgba(22,163,74,.35)}.tv{background:rgba(255,255,255,.12);color:#fff}
.end{background:#dc2626;color:#fff;width:72px;height:72px;border-radius:50%;padding:0}.mute{background:rgba(255,255,255,.16);color:#fff;width:60px;height:60px;border-radius:50%;padding:0}
.live{position:fixed;inset:0;background:#000;display:none;z-index:5}.live video{width:100%;height:100%;object-fit:cover}
/* A laptop or tablet held sideways gets a landscape avatar, shown whole (never cropped into a giant face). */
@media (min-aspect-ratio:1/1){.live{background:radial-gradient(ellipse at center,#123a6b 0%,#06101e 75%)}.live video{object-fit:contain}}
.live .bar{position:absolute;left:0;right:0;bottom:0;padding:20px 20px calc(28px + env(safe-area-inset-bottom));display:flex;gap:22px;justify-content:center;align-items:center;background:linear-gradient(transparent,rgba(0,0,0,.65))}
.live .tag{position:absolute;top:calc(14px + env(safe-area-inset-top));left:16px;background:rgba(0,0,0,.45);padding:6px 12px;border-radius:999px;font-weight:700;font-size:14px}
.remote{display:none;text-align:center}.hold{width:min(70vw,260px);aspect-ratio:1;border-radius:50%;margin:0 auto;background:#16a34a;color:#fff;font-size:20px;flex-direction:column;box-shadow:0 0 0 0 rgba(22,163,74,.6);user-select:none;-webkit-user-select:none;touch-action:none}
.hold.on{background:#f2b632;color:#0b1f3f;box-shadow:0 0 0 18px rgba(242,182,50,.25)}.hold span{font-size:54px}
.note{font-size:13px;opacity:.65;text-align:center;margin-top:8px}
`;

export interface PhoneBridgeOpts {
  lang: "es" | "en";
  base: string;
  name: string;
  portraitUrl?: string;
  ready: boolean;
}

/** The phone page: call the Capitán here, or talk to him on the TV with this phone as the mic. */
export function phoneBridgePage(o: PhoneBridgeOpts): string {
  const es = o.lang === "es";
  const S = {
    title: es ? "El Puente" : "The Bridge",
    sub: es ? `Videollamada desde el Puente del ${SHIP_NAME}` : `Video call from the Bridge of the ${SHIP_NAME}`,
    call: es ? "Llamar al Capitán" : "Call the Capitán",
    tv: es ? "Hablar en la tele" : "Talk on the TV",
    back: es ? "Volver" : "Back",
    connecting: es ? "Conectando con el Puente…" : "Connecting to the Bridge…",
    mic: es ? "Permite el micrófono para hablar con él." : "Allow the microphone to talk to him.",
    notReady: es ? "El Capitán todavía se está arreglando el uniforme: pídele a un admin que lo active." : "The Capitán is still ironing his uniform: ask an admin to switch him on.",
    ended: es ? "Llamada terminada." : "Call ended.",
    onTv: es ? "En la tele" : "On the TV",
    hold: es ? "Mantén presionado para hablar" : "Hold to talk",
    talking: es ? "Te escucha…" : "Listening…",
    waitingTv: es ? "Esperando a la tele… (debe estar abierta en el modo TV)" : "Waiting for the TV… (it must be open in TV mode)",
    tvLive: es ? "¡En la tele! Mantén presionado y habla." : "On the TV! Hold and speak.",
    tvGone: es ? "La tele se desconectó." : "The TV disconnected.",
    end: es ? "Colgar" : "Hang up",
    network: es ? "Se cayó la conexión de video." : "The video connection dropped.",
    dropped: es ? "El Puente cortó la llamada." : "The Bridge ended the call.",
    tvNote: es ? "Tu teléfono es el micrófono; el Capitán responde en la tele." : "Your phone is the mic; the Capitán answers on the TV.",
  };
  const face = o.portraitUrl ? `<img src="${esc(o.portraitUrl)}" alt="">` : `<div class="ph">🧑‍✈️</div>`;
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1f3f"><title>${S.title} · ${SHIP_NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet"><style>${PHONE_CSS}</style></head><body>
<div class="wrap">
  <div class="top"><a href="${esc(o.base)}">‹ ${S.back}</a><span class="sub">🌙 ${SHIP_NAME}</span></div>
  <div class="who" id="who"><div class="ring">${face}</div><h1>Capitán Lunáticus</h1><div class="sub">${S.sub}</div><div class="status" id="status">${o.ready ? "" : S.notReady}</div></div>
  <div class="remote" id="remote"><button class="hold" id="hold"><span>🎙️</span>${S.hold}</button><div class="note">${S.tvNote}</div><div class="status" id="rstatus"></div></div>
  <div class="btns" id="btns">
    <button class="call" id="call"${o.ready ? "" : " disabled"}>📞 ${S.call}</button>
    <button class="tv" id="tv"${o.ready ? "" : " disabled"}>📺 ${S.tv}</button>
  </div>
  <div class="btns" id="rbtns" style="display:none"><button class="end" id="rend" style="margin:0 auto">✕</button></div>
</div>
<div class="live" id="live"><video id="cap" autoplay playsinline></video><div class="tag">🔴 Capitán Lunáticus</div>
<div class="bar"><button class="mute" id="mute">🎙️</button><button class="end" id="end">✕</button></div></div>
<script type="module">
import { createClient } from "${ANAM_SDK}";
${AUDIO_JS}
const S = ${JSON.stringify(S)};
const BASE = ${JSON.stringify(o.base)};
const $ = (id) => document.getElementById(id);
const say = (t, id = "status") => ($(id).textContent = t);
async function post(path, form) {
  const r = await fetch(BASE + path, { method: "POST", ...(form ? { body: new URLSearchParams(form) } : {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
let client = null, timer = null, muted = false, mic = null;
const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
const CLOSED = {
  CONNECTION_CLOSED_CODE_NORMAL: S.ended,
  CONNECTION_CLOSED_CODE_MICROPHONE_PERMISSION_DENIED: S.mic,
  CONNECTION_CLOSED_CODE_WEBRTC_FAILURE: S.network,
  CONNECTION_CLOSED_CODE_SIGNALLING_CLIENT_CONNECTION_FAILURE: S.network,
};
/** Tells the server why the call ended, so it shows up in fly logs. */
const report = (event, code, details) =>
  fetch(BASE + "/bridge/log", { method: "POST", body: new URLSearchParams({ event, code: code || "", details: details || "" }) }).catch(() => {});
function closed(code, details) {
  if (!client) return; // stopStreaming() fires CONNECTION_CLOSED again; report each call's end once
  report("closed", code, details);
  hangup((CLOSED[code] || S.dropped) + (details ? " (" + details + ")" : ""));
}
function hangup(msg) {
  clearTimeout(timer);
  const c = client;
  client = null;
  try { c && c.stopStreaming(); } catch {}
  mic && mic.getTracks().forEach((t) => t.stop());
  mic = null;
  $("live").style.display = "none";
  say(msg || S.ended);
}
$("call").onclick = async () => {
  say(S.connecting);
  // Still inside the tap: let the video element play sound later without another tap.
  const v = $("cap");
  v.muted = false;
  v.play().catch(() => {});
  try {
    // Open the mic before the Capitán starts talking: phones switch their audio mode when the mic turns on, and
    // that switch swallowed the first seconds of his greeting.
    try { mic = await navigator.mediaDevices.getUserMedia(MIC); } catch { return hangup(S.mic); }
    // Wider than tall (a laptop, a tablet sideways): ask for the landscape framing instead of the phone's portrait.
    const { sessionToken } = await post("/bridge/session", { shape: innerWidth > innerHeight ? "landscape" : "portrait" });
    client = createClient(sessionToken);
    client.addListener("CONNECTION_CLOSED", closed);
    client.addListener("SERVER_WARNING", (m) => { report("warning", "", m); say(m); });
    client.addListener("MIC_PERMISSION_DENIED", () => hangup(S.mic));
    client.addListener("VIDEO_PLAY_STARTED", () => say(""));
    $("live").style.display = "block";
    await client.streamToVideoElement("cap", mic);
    timer = setTimeout(() => hangup(), ${MAX_CALL_MS});
  } catch (e) { report("error", "", e.message); hangup(e.message); }
};
$("end").onclick = () => { report("hangup", "", ""); hangup(); };
$("mute").onclick = () => {
  if (!client) return;
  muted = !muted;
  muted ? client.muteInputAudio() : client.unmuteInputAudio();
  $("mute").textContent = muted ? "🔇" : "🎙️";
};

// ----- talk on the TV: this phone is the mic -----
let ws = null, ctx = null, stream = null, talking = false, rtimer = null;
function stopRemote(msg) {
  clearTimeout(rtimer);
  try { ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: "end" })); ws && ws.close(); } catch {}
  ws = null;
  stream && stream.getTracks().forEach((t) => t.stop());
  ctx && ctx.close();
  ctx = stream = null;
  $("remote").style.display = "none"; $("rbtns").style.display = "none";
  $("who").style.display = ""; $("btns").style.display = "";
  say(msg || S.ended);
}
$("tv").onclick = async () => {
  say(S.connecting);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    ctx = new AudioContext();
    await worklet(ctx, CAPTURE);
    const node = new AudioWorkletNode(ctx, "cap");
    ctx.createMediaStreamSource(stream).connect(node);
    node.port.onmessage = (e) => { if (talking && ws && ws.readyState === 1) ws.send(toPcm16(e.data, ctx.sampleRate).buffer); };
    const { relay } = await post("/bridge/tv");
    ws = new WebSocket(wsUrl(relay + "&role=phone"));
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data);
      if (m.type === "peer" && m.role === "tv") m.connected ? say(S.tvLive, "rstatus") : stopRemote(S.tvGone);
      if (m.type === "end") stopRemote();
    };
    ws.onclose = () => ws && stopRemote(S.tvGone);
    $("who").style.display = "none"; $("btns").style.display = "none";
    $("remote").style.display = "block"; $("rbtns").style.display = "";
    say("");
    say(S.waitingTv, "rstatus");
    rtimer = setTimeout(() => stopRemote(), ${MAX_CALL_MS});
  } catch (e) { stopRemote(e.name === "NotAllowedError" ? S.mic : e.message); }
};
$("rend").onclick = () => stopRemote();
const hold = $("hold");
const on = (e) => { e.preventDefault(); talking = true; hold.classList.add("on"); ctx && ctx.resume(); };
const off = () => { talking = false; hold.classList.remove("on"); };
hold.addEventListener("pointerdown", on); hold.addEventListener("pointerup", off); hold.addEventListener("pointerleave", off); hold.addEventListener("pointercancel", off);
</script></body></html>`;
}

/** Markup + module script the TV page appends: an always-ready Bridge with a mic button and phone pickups. */
export function tvBridge(o: { key: string; portraitUrl?: string }): string {
  return `
<style>
.bridge-btn{position:fixed;left:5vw;bottom:6vh;z-index:20;display:flex;align-items:center;gap:1vw;border:0;border-radius:999px;padding:1.6vh 2.4vw;font:800 2.6vh system-ui,sans-serif;background:#16a34a;color:#fff;box-shadow:0 1vh 4vh rgba(0,0,0,.4);cursor:pointer}
.bridge-btn img{width:5vh;height:5vh;border-radius:50%;object-fit:cover;border:2px solid #f2b632}
.bridge{position:fixed;inset:0;z-index:30;display:none;background:radial-gradient(120% 90% at 50% 40%,#12408a 0%,#0b1f3f 55%,#06101e 100%)}
.bridge video{position:absolute;inset:0;margin:auto;aspect-ratio:3/2;height:min(84vh,1229px);max-width:92vw;object-fit:contain;border-radius:2.4vh;background:#000;box-shadow:0 0 0 .6vh rgba(242,182,50,.55),0 3vh 10vh rgba(0,0,0,.6)}
.bridge .who{position:absolute;top:3vh;left:3vw;background:rgba(0,0,0,.5);color:#fff;padding:1vh 1.6vw;border-radius:999px;font:700 2.4vh system-ui,sans-serif}
.bridge .x{position:absolute;right:3vw;bottom:4vh;width:9vh;height:9vh;border-radius:50%;border:0;background:#dc2626;color:#fff;font-size:4vh;cursor:pointer}
.unlock{position:fixed;inset:0;z-index:40;display:grid;place-items:center;background:rgba(6,16,30,.85);color:#fff;font:800 4vh system-ui,sans-serif;cursor:pointer;text-align:center}
.unlock small{display:block;font-weight:500;font-size:2.4vh;opacity:.75;margin-top:1vh}
</style>
<button class="bridge-btn" id="bridgeBtn">${o.portraitUrl ? `<img src="${esc(o.portraitUrl)}" alt="">` : "🧑‍✈️"} 🎙️ Hablar con el Capitán</button>
<div class="bridge" id="bridge"><video id="tvcap" autoplay playsinline></video><div class="who" id="bridgeWho">🔴 El Puente</div><button class="x" id="bridgeEnd">✕</button></div>
<div class="unlock" id="unlock"><div>🔊 Toca para encender el Puente<small>Así el Capitán puede hablar en la tele · Tap to wake the Bridge</small></div></div>
<script type="module">
import { createClient } from "${ANAM_SDK}";
${AUDIO_JS}
const KEY = ${JSON.stringify(o.key)};
const $ = (id) => document.getElementById(id);
let client = null, ws = null, ctx = null, timer = null, ownMic = null;
$("unlock").onclick = () => { $("unlock").remove(); new AudioContext().resume(); };
function end() {
  clearTimeout(timer);
  const c = client;
  client = null;
  try { c && c.stopStreaming(); } catch {}
  ownMic && ownMic.getTracks().forEach((t) => t.stop());
  ownMic = null;
  try { ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: "end" })); ws && ws.close(); } catch {}
  ctx && ctx.close();
  client = ws = ctx = null;
  $("bridge").style.display = "none";
}
const report = (event, code, details) =>
  fetch("/tv/" + KEY + "/log", { method: "POST", body: new URLSearchParams({ event, code: code || "", details: details || "" }) }).catch(() => {});
async function begin(sessionToken, who, audio) {
  client = createClient(sessionToken);
  client.addListener("CONNECTION_CLOSED", (code, details) => { if (!client) return; report("closed", code, details); end(); });
  client.addListener("SERVER_WARNING", (m) => report("warning", "", m));
  $("bridgeWho").textContent = "🔴 " + who;
  $("bridge").style.display = "block";
  await client.streamToVideoElement("tvcap", audio);
  timer = setTimeout(end, ${MAX_CALL_MS});
}
$("bridgeEnd").onclick = end;
// The TV's own mic (a laptop or device with a microphone driving the screen).
$("bridgeBtn").onclick = async () => {
  end();
  const v = $("tvcap");
  v.muted = false;
  v.play().catch(() => {});
  try {
    // The mic is open before the greeting starts, so turning it on can't cut his first words.
    ownMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const r = await fetch("/tv/" + KEY + "/call", { method: "POST" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    await begin(j.sessionToken, "El Puente", ownMic);
  } catch (e) { end(); alert(e.message); }
};
// A phone asked to talk on the TV: its mic arrives over the relay and becomes the avatar's microphone.
async function poll() {
  if (client) return;
  try {
    const r = await fetch("/tv/" + KEY + "/call.json", { cache: "no-store" });
    const { call } = await r.json();
    if (!call) return;
    ctx = new AudioContext({ sampleRate: RATE });
    await worklet(ctx, PLAY);
    const node = new AudioWorkletNode(ctx, "play");
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    const relayCtx = ctx;
    ws = new WebSocket(wsUrl(call.relay + "&role=tv"));
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return node.port.postMessage(fromPcm16(e.data));
      const m = JSON.parse(e.data);
      if (m.type === "end" || (m.type === "peer" && m.role === "phone" && !m.connected)) end();
    };
    await relayCtx.resume();
    await begin(call.sessionToken, "Hablando con " + call.name, dest.stream);
  } catch (e) { console.error(e); end(); }
}
setInterval(poll, 2000);
</script>`;
}
