// Mic -> AudioWorklet (16 kHz Int16) -> WebSocket -> local Whisper sidecar -> hypotheses.
export function isAvailable() {
  return !!(navigator.mediaDevices && window.AudioWorkletNode && window.WebSocket);
}

export function create() {
  let ctx = null, stream = null, node = null, ws = null, running = false;
  let handlers = {};
  let pendingContext = "";

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws/stt`;
  }

  async function start({ language, onHypothesis, onLevel, onStatus, onError, context }) {
    handlers = { onHypothesis, onLevel, onStatus, onError };
    pendingContext = context || "";
    running = true;
    onStatus?.("connecting");
    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("sidecar not reachable")); });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "hyp") {
        handlers.onHypothesis?.({ text: msg.text, latencyMs: msg.latency_ms, source: "whisper" });
        handlers.onLevel?.(msg.rms, true);
      } else if (msg.type === "level") {
        handlers.onLevel?.(msg.rms, false);
      } else if (msg.type === "status") {
        handlers.onStatus?.(msg.state);
      } else if (msg.type === "ready") {
        handlers.onStatus?.("loading model");
      } else if (msg.type === "error") {
        handlers.onError?.(msg.message);
      }
    };
    ws.onclose = () => { if (running) handlers.onStatus?.("disconnected"); };
    ws.send(JSON.stringify({ type: "start", language: language.startsWith("da") ? "da" : "en", context: pendingContext }));

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "pcm-downsampler", { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (ev) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(ev.data.pcm);
      handlers.onLevel?.(ev.data.rms, undefined);
    };
    src.connect(node);
  }

  function setContext(text) {
    pendingContext = text;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "context", text }));
  }

  async function stop() {
    running = false;
    try { node?.disconnect(); } catch {}
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { await ctx?.close(); } catch {}
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "stop" })); ws.close(); }
    ctx = stream = node = ws = null;
  }

  return { name: "whisper", start, stop, setContext };
}
