// Web Speech API (Chrome -> Google servers, Safari -> Apple servers). Zero setup, not local.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isAvailable() {
  return !!SR;
}

export function create() {
  let rec = null, running = false, handlers = {}, lang = "en-US";
  let ctx = null, stream = null, analyser = null, levelTimer = null;

  function langCode(language) {
    return language.startsWith("da") ? "da-DK" : "en-US";
  }

  function spawn() {
    rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      // Take the last couple of result segments; interim text is what we align on.
      let text = "";
      const from = Math.max(0, ev.results.length - 2);
      for (let i = from; i < ev.results.length; i++) text += " " + ev.results[i][0].transcript;
      handlers.onHypothesis?.({ text: text.trim(), latencyMs: null, source: "browser" });
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        handlers.onError?.("microphone or speech service not allowed: " + ev.error);
        running = false;
      } else if (ev.error !== "no-speech" && ev.error !== "aborted") {
        handlers.onError?.("speech error: " + ev.error);
      }
    };
    rec.onend = () => {
      // Chrome ends the session after silence or ~60 s. Restart while we are supposed to run.
      if (running) setTimeout(() => { try { rec.start(); } catch { spawn(); } }, 150);
      else handlers.onStatus?.("stopped");
    };
    rec.onstart = () => handlers.onStatus?.("listening");
    rec.start();
  }

  async function startMeter() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        handlers.onLevel?.(Math.sqrt(s / buf.length), undefined);
      }, 100);
    } catch { /* meter is cosmetic */ }
  }

  async function start({ language, onHypothesis, onLevel, onStatus, onError }) {
    handlers = { onHypothesis, onLevel, onStatus, onError };
    lang = langCode(language);
    running = true;
    onStatus?.("connecting");
    await startMeter();
    spawn();
  }

  function setContext() { /* no decoder biasing available in the browser API */ }

  async function stop() {
    running = false;
    try { rec?.stop(); } catch {}
    clearInterval(levelTimer);
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { await ctx?.close(); } catch {}
    rec = ctx = stream = analyser = null;
  }

  return { name: "browser", start, stop, setContext };
}
