"""Rolling-window Whisper transcription on MLX.

Audio arrives as 16 kHz mono Int16 frames. We keep the last WINDOW seconds in a
ring buffer and, roughly every STEP seconds, transcribe the window and push the
hypothesis to the client. The client's aligner absorbs the instability of the
window text; we never try to produce a clean committed transcript here.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import zlib
from collections import deque

import numpy as np

log = logging.getLogger("prompter.stt")

SAMPLE_RATE = 16000
WINDOW_SEC = float(os.environ.get("PROMPTER_WINDOW", "6"))
STEP_SEC = float(os.environ.get("PROMPTER_STEP", "0.8"))
DEFAULT_MODEL = os.environ.get("PROMPTER_MODEL", "mlx-community/whisper-large-v3-turbo")
SILENCE_RMS = float(os.environ.get("PROMPTER_SILENCE_RMS", "0.006"))
# Whisper's own loop detector: gzip ratio of the text. Real speech sits around 1.0-1.8,
# a stutter like "safe and safe and safe and" compresses far better than that.
LOOP_COMPRESSION_RATIO = float(os.environ.get("PROMPTER_LOOP_RATIO", "2.4"))
# Retry ladder for windows that come out looping. Only the compression test triggers
# a retry (not log-probability), so clean windows never pay for it.
TEMPERATURES = (0.0, 0.2, 0.4)


def compression_ratio(text: str) -> float:
    data = text.encode("utf-8")
    if not data:
        return 0.0
    return len(data) / len(zlib.compress(data))


def looks_like_loop(text: str) -> bool:
    return compression_ratio(text) > LOOP_COMPRESSION_RATIO

_model_lock = threading.Lock()
_loaded: dict[str, bool] = {}
_status = {"state": "idle", "model": DEFAULT_MODEL, "error": None}


def model_status():
    return dict(_status)


def _ensure_model(model: str):
    """mlx_whisper caches the loaded model per path; run one transcribe to load it."""
    if _loaded.get(model):
        return
    with _model_lock:
        if _loaded.get(model):
            return
        import mlx_whisper

        _status.update(state="loading", model=model, error=None)
        t0 = time.time()
        try:
            mlx_whisper.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), path_or_hf_repo=model, language="en", fp16=True)
        except Exception as e:  # noqa: BLE001
            _status.update(state="error", error=str(e))
            log.exception("model load failed")
            raise
        _loaded[model] = True
        _status.update(state="ready")
        log.info("model %s ready in %.1fs", model, time.time() - t0)


def warm_up(model: str | None = None):
    try:
        _ensure_model(model or DEFAULT_MODEL)
    except Exception:  # noqa: BLE001
        pass


class WhisperSession:
    def __init__(self, language: str, model: str | None, on_result):
        self.language = "da" if language.startswith("da") else "en"
        self.model_name = model or DEFAULT_MODEL
        self.on_result = on_result
        self._buf = deque()  # list of float32 arrays
        self._buf_len = 0
        self._new_samples = 0
        self._lock = threading.Lock()
        self._context = ""
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="whisper", daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()

    def set_context(self, text: str):
        # Short on purpose: a long prompt invites the decoder to copy it instead of listening.
        self._context = (text or "")[-240:]

    def feed(self, pcm: bytes):
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        with self._lock:
            self._buf.append(samples)
            self._buf_len += len(samples)
            self._new_samples += len(samples)
            max_len = int(WINDOW_SEC * SAMPLE_RATE)
            while self._buf_len > max_len and self._buf:
                old = self._buf.popleft()
                self._buf_len -= len(old)

    def _snapshot(self):
        with self._lock:
            if not self._buf:
                return None, 0
            audio = np.concatenate(list(self._buf))
            new = self._new_samples
            self._new_samples = 0
        return audio, new

    def _run(self):
        try:
            _ensure_model(self.model_name)
        except Exception as e:  # noqa: BLE001
            # Fatal for this session: the server closes the socket so the page's
            # reconnect path retries instead of sitting on a dead session.
            self.on_result({"type": "error", "message": f"model load failed: {e}", "fatal": True})
            return
        import mlx_whisper

        self.on_result({"type": "status", "state": "listening"})
        while not self._stop.is_set():
            time.sleep(STEP_SEC)
            try:
                self._step(mlx_whisper)
            except Exception:  # noqa: BLE001
                # Never let the worker die mid-session; log and carry on with the next window.
                log.exception("whisper step failed")
                time.sleep(0.5)

    def _step(self, mlx_whisper):
        audio, new = self._snapshot()
        if audio is None or new < int(0.3 * SAMPLE_RATE):
            return
        tail = audio[-int(1.5 * SAMPLE_RATE):]
        rms = float(np.sqrt(np.mean(tail * tail))) if len(tail) else 0.0
        if rms < SILENCE_RMS:
            # Speaker paused. Do not transcribe silence: Whisper hallucinates on it.
            self.on_result({"type": "level", "rms": rms, "speaking": False})
            return
        t0 = time.time()
        res = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.model_name,
            language=self.language,
            fp16=True,
            temperature=TEMPERATURES,
            compression_ratio_threshold=LOOP_COMPRESSION_RATIO,
            logprob_threshold=None,
            condition_on_previous_text=False,
            no_speech_threshold=0.5,
            initial_prompt=self._context or None,
            verbose=None,
        )
        dt = time.time() - t0
        text = (res.get("text") or "").strip()
        if text and looks_like_loop(text):
            log.info("%.2fs dropped looping window (ratio %.2f): %s", dt, compression_ratio(text), text[-80:])
            self.on_result({"type": "level", "rms": rms, "speaking": True, "dropped": "loop"})
            return
        log.info("%.2fs for %.1fs audio (rms %.3f): %s", dt, len(audio) / SAMPLE_RATE, rms, text[-80:])
        self.on_result({
            "type": "hyp",
            "text": text,
            "window_sec": len(audio) / SAMPLE_RATE,
            "latency_ms": int(dt * 1000),
            "rms": rms,
            "speaking": True,
        })
