// Mic -> AudioWorklet (16 kHz Int16) -> WebSocket -> local Whisper sidecar -> hypotheses.
//
// Built to survive a long live session without anyone touching it:
// - the socket reconnects on its own with backoff, re-sending language and context;
// - a watchdog resumes a suspended AudioContext and re-acquires the microphone if
//   audio frames stop flowing or the track ends (device change, system audio reset);
// - if frames go out but the sidecar stays silent, the socket is reopened.
// Handlers: onHypothesis, onLevel(rms, speaking), onStatus(text), onError(text),
// onLink(state) where state is "ok" | "reconnecting" | "mic".

const FRAME_STALL_RESUME_MS = 4000;   // no frames for this long: try resuming the context
const FRAME_STALL_RESTART_MS = 8000;  // still nothing: re-acquire the microphone
const SERVER_SILENT_MS = 10000;       // frames flowing but no server message: reopen socket
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 5000;    // a connect that does not open in this time is abandoned

export function isAvailable() {
  return !!(navigator.mediaDevices && window.AudioWorkletNode && window.WebSocket);
}

export function create() {
  let ctx = null, stream = null, node = null, src = null, ws = null;
  let running = false, moduleLoaded = false, sessionLive = false, restartingCapture = false;
  let handlers = {};
  let language = "en";
  let pendingContext = "";
  let reconnectTimer = null, reconnectDelay = RECONNECT_MIN_MS, watchdogTimer = null;
  let lastFrameAt = 0, lastServerAt = 0;
  const stats = { reconnects: 0, captureRestarts: 0, framesSent: 0, hyps: 0, startedAt: 0 };

  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws/stt`;
  }

  // ---------- socket ----------
  function openSocket() {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(wsUrl());
      sock.binaryType = "arraybuffer";
      let opened = false;
      // A frozen sidecar accepts the TCP connection but never answers the upgrade.
      // Do not sit on that; give up and let the backoff retry.
      const handshakeTimer = setTimeout(() => {
        if (opened) return;
        sock.onclose = null;
        try { sock.close(); } catch {}
        reject(new Error("sidecar did not answer"));
      }, HANDSHAKE_TIMEOUT_MS);
      sock.onopen = () => {
        opened = true;
        clearTimeout(handshakeTimer);
        ws = sock;
        sessionLive = false;
        reconnectDelay = RECONNECT_MIN_MS;
        lastServerAt = now();
        sock.send(JSON.stringify({ type: "start", language, context: pendingContext }));
        resolve(sock);
      };
      sock.onerror = () => { if (!opened) { clearTimeout(handshakeTimer); reject(new Error("sidecar not reachable")); } };
      sock.onmessage = (ev) => {
        lastServerAt = now();
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "hyp") {
          stats.hyps++;
          handlers.onHypothesis?.({ text: msg.text, latencyMs: msg.latency_ms, source: "whisper" });
          handlers.onLevel?.(msg.rms, true);
        } else if (msg.type === "level") {
          handlers.onLevel?.(msg.rms, !!msg.speaking);
        } else if (msg.type === "status") {
          if (msg.state === "listening") { sessionLive = true; handlers.onLink?.("ok"); }
          handlers.onStatus?.(msg.state);
        } else if (msg.type === "ready") {
          handlers.onStatus?.("loading model");
        } else if (msg.type === "error") {
          handlers.onError?.(msg.message);
        }
      };
      sock.onclose = () => {
        if (ws === sock) ws = null;
        sessionLive = false;
        if (opened && running) scheduleReconnect();
      };
    });
  }

  // Abandon the current socket without waiting for a close handshake (a hung peer never
  // completes one and the browser would wait up to a minute), then reconnect.
  function dropSocket() {
    const sock = ws;
    ws = null;
    sessionLive = false;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
      try { sock.close(); } catch {}
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    handlers.onLink?.("reconnecting");
    handlers.onStatus?.(`connection lost, reconnecting in ${Math.round(reconnectDelay / 1000)} s`);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (!running) return;
      try {
        await openSocket();
        stats.reconnects++;
        handlers.onStatus?.("reconnected, waiting for sidecar");
      } catch {
        reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
        scheduleReconnect();
      }
    }, reconnectDelay);
  }

  // ---------- microphone ----------
  async function startCapture() {
    const fresh = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!running) { fresh.getTracks().forEach((t) => t.stop()); return; } // stopped while we waited
    stream = fresh;
    if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); moduleLoaded = false; }
    if (ctx.state === "suspended") await ctx.resume();
    if (!moduleLoaded) { await ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url)); moduleLoaded = true; }
    src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "pcm-downsampler", { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (ev) => {
      lastFrameAt = now();
      stats.framesSent++;
      if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(ev.data.pcm); } catch {} }
      handlers.onLevel?.(ev.data.rms, undefined);
    };
    src.connect(node);
    lastFrameAt = now();
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => { if (running) restartCapture("microphone track ended"); };
      track.onmute = () => handlers.onStatus?.("microphone muted by the system");
      track.onunmute = () => handlers.onStatus?.("listening");
    }
    ctx.onstatechange = () => {
      if (running && ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    };
  }

  function teardownCapture() {
    try { node?.port && (node.port.onmessage = null); } catch {}
    try { node?.disconnect(); } catch {}
    try { src?.disconnect(); } catch {}
    try { stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); }); } catch {}
    node = src = stream = null;
  }

  async function restartCapture(reason) {
    if (restartingCapture || !running) return;
    restartingCapture = true;
    handlers.onLink?.("mic");
    handlers.onStatus?.(`restarting microphone: ${reason}`);
    teardownCapture();
    while (running) {
      try {
        await startCapture();
        stats.captureRestarts++;
        handlers.onStatus?.("listening");
        handlers.onLink?.(ws && ws.readyState === WebSocket.OPEN ? "ok" : "reconnecting");
        break;
      } catch (e) {
        handlers.onError?.(`microphone unavailable: ${e.message || e}`);
        await sleep(3000);
      }
    }
    restartingCapture = false;
  }

  // ---------- watchdog ----------
  function watchdog() {
    if (!running) return;
    const t = now();
    if (!restartingCapture) {
      const stalled = t - lastFrameAt;
      if (stalled > FRAME_STALL_RESUME_MS && ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
      if (stalled > FRAME_STALL_RESTART_MS) { restartCapture(`no audio for ${Math.round(stalled / 1000)} s`); return; }
    }
    const framesFlowing = t - lastFrameAt < 2000;
    if (ws && ws.readyState === WebSocket.OPEN && sessionLive && framesFlowing && t - lastServerAt > SERVER_SILENT_MS) {
      handlers.onStatus?.("sidecar stopped answering, reopening connection");
      dropSocket();
    }
  }

  // ---------- public ----------
  async function start({ language: lang, onHypothesis, onLevel, onStatus, onError, onLink, context }) {
    handlers = { onHypothesis, onLevel, onStatus, onError, onLink };
    language = (lang || "en").startsWith("da") ? "da" : "en";
    pendingContext = context || "";
    running = true;
    stats.startedAt = Date.now();
    onStatus?.("connecting");
    await openSocket();            // throws if the sidecar is not reachable at all
    await startCapture();          // throws if the microphone is denied
    watchdogTimer = setInterval(watchdog, 2000);
  }

  function setContext(text) {
    pendingContext = text;
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: "context", text })); } catch {} }
  }

  async function stop() {
    running = false;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearInterval(watchdogTimer); watchdogTimer = null;
    teardownCapture();
    try { await ctx?.close(); } catch {}
    ctx = null; moduleLoaded = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "stop" })); } catch {}
      try { ws.close(); } catch {}
    }
    ws = null;
  }

  // Diagnostics for the console and for tests.
  function debug() {
    return {
      stats: { ...stats },
      socket: ws ? ws.readyState : null,
      sessionLive,
      audioState: ctx?.state ?? null,
      msSinceFrame: lastFrameAt ? Math.round(now() - lastFrameAt) : null,
      msSinceServer: lastServerAt ? Math.round(now() - lastServerAt) : null,
      ctx, stream, ws,
    };
  }

  return { name: "whisper", start, stop, setContext, debug };
}
