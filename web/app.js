import { tokenizeScript, tokenizeHypothesis, align, contextAround, isDegenerate } from "./aligner.js";
import * as whisper from "./stt/backend-whisper.js";
import * as browser from "./stt/backend-browser.js";

const $ = (id) => document.getElementById(id);
const BACKENDS = { whisper, browser };

const SETTINGS_KEY = "prompter.settings";
const DEFAULT_SETTINGS = {
  fontSize: 56, colWidth: 80, eyeline: 40, lineHeight: 1.35,
  mirrorH: false, mirrorV: false, dimPast: true, autoScroll: false, scrollSpeed: 60,
  language: "en", backend: "whisper", script: "", debug: false, railHidden: false,
};

const state = {
  settings: loadSettings(),
  scriptName: "",
  text: "",
  tokens: [],
  wordEls: [],
  cursor: -1,
  listening: false,
  backend: null,
  lastHyp: "",
  lastAlign: null,
  lastTail: [],
  lastContextCursor: -999,
  targetY: 0,
  currentY: 0,
  lastFrame: 0,
  status: "idle",
  latency: null,
  speaking: false,
  link: "off",            // off | ok | reconnecting | mic
  awake: { browser: "unknown", server: null },
  dropped: 0,
};

// ---------- settings ----------
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {}
}
function applySettings() {
  const s = state.settings;
  const root = document.documentElement.style;
  root.setProperty("--font-size", s.fontSize + "px");
  root.setProperty("--col-width", s.colWidth + "%");
  root.setProperty("--eyeline", s.eyeline + "%");
  root.setProperty("--line-height", s.lineHeight);
  $("viewport").classList.toggle("mirror-h", s.mirrorH);
  $("viewport").classList.toggle("mirror-v", s.mirrorV);
  $("viewport").classList.toggle("dim-past", s.dimPast);
  $("font-size").value = s.fontSize; $("col-width").value = s.colWidth; $("eyeline").value = s.eyeline;
  $("line-height").value = s.lineHeight; $("mirror-h").checked = s.mirrorH; $("mirror-v").checked = s.mirrorV;
  $("dim-past").checked = s.dimPast; $("auto-scroll").checked = s.autoScroll; $("scroll-speed").value = s.scrollSpeed;
  $("language").value = s.language; $("backend").value = s.backend;
  $("debug").hidden = !s.debug;
  $("rail").hidden = s.railHidden; $("btn-show-rail").hidden = !s.railHidden;
  saveSettings();
  snapScroll();
}

// ---------- scripts ----------
async function refreshScripts() {
  const list = await (await fetch("/api/scripts")).json();
  const sel = $("script-select");
  sel.innerHTML = "";
  for (const f of list) {
    const o = document.createElement("option");
    o.value = f.name; o.textContent = f.name;
    sel.appendChild(o);
  }
  const want = state.settings.script && list.some((f) => f.name === state.settings.script)
    ? state.settings.script : (list[0]?.name || "");
  if (want) await loadScript(want);
}
async function loadScript(name) {
  const r = await fetch(`/api/scripts/${encodeURIComponent(name)}`);
  if (!r.ok) return;
  state.scriptName = name;
  state.settings.script = name; saveSettings();
  $("script-select").value = name;
  setText(await r.text());
}
async function saveScript(name, text) {
  const r = await fetch(`/api/scripts/${encodeURIComponent(name)}`, { method: "PUT", body: text, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!r.ok) { setStatus("save failed: " + (await r.text())); return false; }
  await refreshScripts();
  await loadScript(name);
  return true;
}

function setText(text) {
  state.text = text;
  state.tokens = tokenizeScript(text);
  state.cursor = -1;
  renderScript();
  snapScroll();
}

// Render paragraphs; each word becomes a span keyed by token index.
function renderScript() {
  const container = $("script");
  container.innerHTML = "";
  state.wordEls = [];
  const text = state.text;
  const tokens = state.tokens;
  let ti = 0;
  const paras = [];
  let pos = 0;
  for (const block of text.split(/\n\s*\n/)) {
    const start = text.indexOf(block, pos);
    paras.push({ start, end: start + block.length, block });
    pos = start + block.length;
  }
  for (const para of paras) {
    if (!para.block.trim()) continue;
    const p = document.createElement("p");
    const isHeading = /^\s*#+\s/.test(para.block);
    if (isHeading) p.classList.add("h");
    let cur = para.start;
    while (ti < tokens.length && tokens[ti].start < para.end) {
      const t = tokens[ti];
      if (t.start > cur) p.appendChild(document.createTextNode(text.slice(cur, t.start).replace(/^#+\s/, "")));
      const span = document.createElement("span");
      span.className = "w"; span.dataset.i = ti; span.textContent = t.display;
      span.addEventListener("click", () => setCursor(Number(span.dataset.i), true));
      p.appendChild(span);
      state.wordEls[ti] = span;
      cur = t.end; ti++;
    }
    if (cur < para.end) p.appendChild(document.createTextNode(text.slice(cur, para.end)));
    container.appendChild(p);
  }
}

// ---------- cursor + scrolling ----------
function setCursor(i, manual = false) {
  const prev = state.cursor;
  state.cursor = Math.max(-1, Math.min(state.tokens.length - 1, i));
  if (prev === state.cursor) return;
  const lo = Math.min(prev, state.cursor), hi = Math.max(prev, state.cursor);
  for (let k = Math.max(0, lo); k <= hi; k++) {
    const el = state.wordEls[k]; if (!el) continue;
    el.classList.toggle("past", k < state.cursor);
    el.classList.toggle("cur", k === state.cursor);
  }
  if (prev >= 0 && state.wordEls[prev]) state.wordEls[prev].classList.remove("cur");
  if (state.cursor >= 0 && state.wordEls[state.cursor]) state.wordEls[state.cursor].classList.add("cur");
  updateTarget();
  maybeSendContext(manual);
}

function updateTarget() {
  const vp = $("viewport");
  const eye = vp.clientHeight * (state.settings.eyeline / 100);
  if (state.cursor < 0) { state.targetY = eye - $("script").offsetTop - vp.clientHeight * 0.5; return; }
  const el = state.wordEls[state.cursor];
  if (!el) return;
  const lineTop = el.offsetTop; // relative to #script
  const lineMid = lineTop + el.offsetHeight / 2;
  state.targetY = eye - lineMid;
}

function snapScroll() {
  updateTarget();
  state.currentY = state.targetY;
  $("script").style.transform = `translateY(${state.currentY}px)`;
}

function frame(ts) {
  const dt = Math.min(0.1, (ts - state.lastFrame) / 1000 || 0);
  state.lastFrame = ts;
  if (state.settings.autoScroll && !state.listening) {
    state.targetY -= state.settings.scrollSpeed * dt;
  }
  const diff = state.targetY - state.currentY;
  if (Math.abs(diff) > 0.3) {
    // Critically damped-ish approach: fast when far, gentle when close.
    const k = Math.min(1, dt * 6);
    state.currentY += diff * k;
    $("script").style.transform = `translateY(${state.currentY}px)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- speech ----------
function onHypothesis({ text, latencyMs }) {
  state.lastHyp = text;
  state.latency = latencyMs;
  const hyp = tokenizeHypothesis(text);
  state.lastTail = hyp.slice(-6);
  const r = align(state.tokens, hyp, Math.max(0, state.cursor));
  if (isDegenerate(hyp) && !(r && r.matches >= Math.min(hyp.length, 6))) {
    // Recognizer stutter ("safe and safe and safe"). Hold rather than guess, unless the
    // script really says that (then every word of the tail matched).
    state.dropped++;
    state.lastAlign = null;
    renderDebug();
    return;
  }
  state.lastAlign = r;
  if (r) setCursor(r.cursor);
  renderDebug();
}

function maybeSendContext(force) {
  if (!state.backend) return;
  if (!force && Math.abs(state.cursor - state.lastContextCursor) < 8) return;
  state.lastContextCursor = state.cursor;
  state.backend.setContext(contextAround(state.tokens, Math.max(0, state.cursor), 8, 20));
}

function setStatus(s) { state.status = s; $("status").textContent = s; }

async function startListening() {
  if (state.listening) return;
  const kind = state.settings.backend;
  const mod = BACKENDS[kind];
  if (!mod.isAvailable()) { setStatus(`${kind} backend not available in this browser`); return; }
  state.backend = mod.create();
  state.listening = true;
  $("btn-listen").textContent = "Stop listening"; $("btn-listen").classList.add("live");
  try {
    await state.backend.start({
      language: state.settings.language,
      context: contextAround(state.tokens, Math.max(0, state.cursor), 8, 20),
      onHypothesis,
      onLevel: (rms, speaking) => {
        if (typeof rms === "number") $("level").style.width = Math.min(100, rms * 600) + "%";
        if (typeof speaking === "boolean" && speaking !== state.speaking) { state.speaking = speaking; renderPill(); }
      },
      onStatus: (s) => setStatus(`${kind}: ${s}`),
      onError: (e) => setStatus(`${kind}: ${e}`),
      onLink: setLink,
    });
    if (kind === "browser") setLink("ok");
  } catch (e) {
    await stopListening(`${kind}: ${e.message || e}`);
  }
}
async function stopListening(reason = "idle") {
  if (!state.listening && !state.backend) return;
  state.listening = false;
  $("btn-listen").textContent = "Start listening"; $("btn-listen").classList.remove("live");
  const b = state.backend; state.backend = null;
  try { await b?.stop(); } catch {}
  $("level").style.width = "0%";
  setLink("off");
  setStatus(reason);
}

// ---------- on-screen link state (visible in fullscreen) ----------
function setLink(link) { if (state.link !== link) { state.link = link; renderPill(); } }
function renderPill() {
  const pill = $("link");
  pill.className = "pill " + state.link + (state.link === "ok" && !state.speaking ? " quiet" : "");
  const text = { off: "ready", ok: state.speaking ? "listening" : "quiet", reconnecting: "reconnecting", mic: "microphone lost" }[state.link] || state.link;
  $("link-text").textContent = text;
  const awake = state.awake.browser === "held" || state.awake.server?.active;
  $("awake-pill").hidden = !awake;
  pill.hidden = false;
}

// ---------- keep the screen on ----------
// Two layers: the sidecar runs caffeinate for as long as it is up (see server/keepawake.py),
// and this page holds a Screen Wake Lock while it is visible. Either one is enough.
let wakeLock = null;
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) { state.awake.browser = "unsupported"; renderAwake(); return; }
  if (document.visibilityState !== "visible") return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    state.awake.browser = "held";
    wakeLock.addEventListener("release", () => {
      state.awake.browser = "released";
      renderAwake();
      // Released when the tab is hidden or the system takes it back. Take it again as soon as we can.
      setTimeout(requestWakeLock, 500);
    });
  } catch (e) {
    state.awake.browser = "denied: " + (e.message || e);
  }
  renderAwake();
}
function renderAwake() {
  const b = state.awake.browser, sv = state.awake.server;
  const server = sv == null ? "server: unknown" : sv.unreachable ? "server: unreachable" : sv.active ? "server: caffeinate on" : sv.enabled ? "server: caffeinate OFF" : "server: disabled";
  $("awake").textContent = `Screen: browser lock ${b} · ${server}`;
  $("awake").classList.toggle("warn", !(b === "held" || sv?.active));
  renderPill();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestWakeLock(); });
setInterval(requestWakeLock, 30000);
function toggleListening() { state.listening ? stopListening("idle") : startListening(); }

function renderDebug() {
  if (!state.settings.debug) return;
  const r = state.lastAlign;
  const cur = state.cursor >= 0 ? state.tokens[state.cursor]?.display : "(start)";
  $("debug").textContent =
    `status: ${state.status}   latency: ${state.latency ?? "-"} ms   cursor: ${state.cursor} "${cur}"\n` +
    `hyp: ${state.lastHyp}\n` +
    `tail: ${(state.lastTail || []).join(" ")}\n` +
    `align: ${r ? `-> ${r.cursor} score ${r.score.toFixed(2)} matches ${r.matches}` : "hold"}`;
}

// ---------- editor ----------
function openEditor(newFile = false) {
  $("editor").hidden = false;
  $("editor-name").value = newFile ? "" : state.scriptName;
  $("editor-text").value = newFile ? "" : state.text;
  $("editor-text").focus();
}
function closeEditor() { $("editor").hidden = true; }

// ---------- wiring ----------
function bind() {
  $("script-select").addEventListener("change", (e) => loadScript(e.target.value));
  $("btn-new").addEventListener("click", () => openEditor(true));
  $("btn-edit").addEventListener("click", () => openEditor(false));
  $("btn-delete").addEventListener("click", async () => {
    if (!state.scriptName || !confirm(`Delete ${state.scriptName}?`)) return;
    await fetch(`/api/scripts/${encodeURIComponent(state.scriptName)}`, { method: "DELETE" });
    state.settings.script = ""; await refreshScripts();
  });
  $("editor-save").addEventListener("click", async () => {
    let name = $("editor-name").value.trim();
    if (!name) { $("editor-name").focus(); return; }
    if (!/\.(md|txt)$/i.test(name)) name += ".md";
    if (await saveScript(name, $("editor-text").value)) closeEditor();
  });
  $("editor-cancel").addEventListener("click", closeEditor);

  $("btn-listen").addEventListener("click", toggleListening);
  $("btn-reset").addEventListener("click", () => { setCursor(-1, true); snapScroll(); });
  $("btn-fullscreen").addEventListener("click", toggleFullscreen);
  $("btn-debug").addEventListener("click", () => { state.settings.debug = !state.settings.debug; applySettings(); renderDebug(); });
  $("btn-hide-rail").addEventListener("click", () => { state.settings.railHidden = true; applySettings(); });
  $("btn-show-rail").addEventListener("click", () => { state.settings.railHidden = false; applySettings(); });

  const num = (id, key) => $(id).addEventListener("input", (e) => { state.settings[key] = Number(e.target.value); applySettings(); });
  const bool = (id, key) => $(id).addEventListener("change", (e) => { state.settings[key] = e.target.checked; applySettings(); });
  num("font-size", "fontSize"); num("col-width", "colWidth"); num("eyeline", "eyeline"); num("line-height", "lineHeight"); num("scroll-speed", "scrollSpeed");
  bool("mirror-h", "mirrorH"); bool("mirror-v", "mirrorV"); bool("dim-past", "dimPast"); bool("auto-scroll", "autoScroll");
  $("language").addEventListener("change", async (e) => { state.settings.language = e.target.value; saveSettings(); if (state.listening) { await stopListening(); startListening(); } });
  $("backend").addEventListener("change", async (e) => { state.settings.backend = e.target.value; saveSettings(); if (state.listening) { await stopListening(); startListening(); } });

  window.addEventListener("resize", () => { updateTarget(); });

  document.addEventListener("keydown", (e) => {
    const inEditor = !$("editor").hidden || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
    if (e.key === "Escape") { if (!$("editor").hidden) closeEditor(); else if (document.fullscreenElement) document.exitFullscreen(); return; }
    if (inEditor) return;
    switch (e.key) {
      case " ": e.preventDefault(); toggleListening(); break;
      case "ArrowDown": e.preventDefault(); setCursor(state.cursor + (e.shiftKey ? 20 : 5), true); break;
      case "ArrowUp": e.preventDefault(); setCursor(state.cursor - (e.shiftKey ? 20 : 5), true); break;
      case "Home": e.preventDefault(); setCursor(-1, true); snapScroll(); break;
      case "End": e.preventDefault(); setCursor(state.tokens.length - 1, true); break;
      case "+": case "=": state.settings.fontSize = Math.min(120, state.settings.fontSize + 2); applySettings(); break;
      case "-": case "_": state.settings.fontSize = Math.max(28, state.settings.fontSize - 2); applySettings(); break;
      case "m": case "M": state.settings.mirrorH = !state.settings.mirrorH; applySettings(); break;
      case "v": case "V": state.settings.mirrorV = !state.settings.mirrorV; applySettings(); break;
      case "f": case "F": toggleFullscreen(); break;
      case "d": case "D": state.settings.debug = !state.settings.debug; applySettings(); renderDebug(); break;
      case "e": case "E": openEditor(false); break;
      case "Tab": e.preventDefault(); state.settings.railHidden = !state.settings.railHidden; applySettings(); break;
    }
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("stage").requestFullscreen?.();
}

async function pollStatus() {
  let next = 30000;
  try {
    const s = await (await fetch("/api/status")).json();
    if (!state.listening && (state.status === "idle" || state.status.startsWith("whisper model:"))) setStatus(`whisper model: ${s.state}${s.error ? " (" + s.error + ")" : ""}`);
    if (s.state !== "ready" && s.state !== "error") next = 2000;
    state.awake.server = s.keep_awake || null;
  } catch {
    state.awake.server = { enabled: false, active: false, unreachable: true };
    next = 5000;
  }
  renderAwake();
  setTimeout(pollStatus, next);
}

bind();
applySettings();
renderPill();
requestWakeLock();
if (!browser.isAvailable()) $("backend").querySelector('[value="browser"]').disabled = true;
refreshScripts().then(pollStatus);

// Debug hook: drive the prompter without a microphone, e.g. from the console:
//   __prompter.hyp("for seks måneder siden satte vi os")
window.__prompter = { state, hyp: (text) => onHypothesis({ text, latencyMs: null }), setCursor, snapScroll, backend: () => state.backend, startListening, stopListening };
