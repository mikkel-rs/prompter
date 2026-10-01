"""Prompter sidecar: serves the web UI, the scripts folder, and a Whisper WebSocket."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .keepawake import KeepAwake
from .stt import WhisperSession, model_status, warm_up

log = logging.getLogger("prompter")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SCRIPTS = Path(os.environ.get("PROMPTER_SCRIPTS", ROOT / "scripts")).resolve()
SCRIPTS.mkdir(parents=True, exist_ok=True)

NAME_RE = re.compile(r"^[\w\- .()æøåÆØÅ]+\.(md|txt)$")

app = FastAPI(title="prompter")
keep_awake = KeepAwake()

# The server exits on its own once no page has talked to it for this long, so a
# server started from the desktop app never keeps the Mac awake after you are done.
# An open tab polls /api/status every 30 s, which counts as activity. 0 disables.
IDLE_EXIT_MIN = float(os.environ.get("PROMPTER_IDLE_EXIT_MIN", "20"))
_last_activity = time.time()


def _touch():
    global _last_activity
    _last_activity = time.time()


@app.middleware("http")
async def _track_activity(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        _touch()
    return await call_next(request)


def _exit_soon(reason: str, delay: float = 0.5):
    log.info("shutting down: %s", reason)
    asyncio.get_running_loop().call_later(delay, lambda: os.kill(os.getpid(), signal.SIGTERM))


async def _idle_watch():
    while True:
        await asyncio.sleep(30)
        if IDLE_EXIT_MIN > 0 and time.time() - _last_activity > IDLE_EXIT_MIN * 60:
            _exit_soon(f"no page activity for {IDLE_EXIT_MIN:g} min")
            return


def _script_path(name: str) -> Path:
    if not NAME_RE.match(name) or ".." in name or "/" in name:
        raise HTTPException(400, "bad script name")
    p = (SCRIPTS / name).resolve()
    if p.parent != SCRIPTS:
        raise HTTPException(400, "bad script name")
    return p


@app.get("/api/scripts")
def list_scripts():
    files = sorted(p for p in SCRIPTS.iterdir() if p.suffix in (".md", ".txt") and p.is_file())
    return [{"name": p.name, "size": p.stat().st_size, "mtime": p.stat().st_mtime} for p in files]


@app.get("/api/scripts/{name}", response_class=PlainTextResponse)
def read_script(name: str):
    p = _script_path(name)
    if not p.exists():
        raise HTTPException(404, "not found")
    return p.read_text(encoding="utf-8")


@app.put("/api/scripts/{name}")
async def write_script(name: str, request: Request):
    p = _script_path(name)
    body = (await request.body()).decode("utf-8")
    p.write_text(body, encoding="utf-8")
    return {"ok": True, "name": p.name, "size": len(body)}


@app.delete("/api/scripts/{name}")
def delete_script(name: str):
    p = _script_path(name)
    if p.exists():
        p.unlink()
    return {"ok": True}


@app.get("/api/status")
def status():
    return {**model_status(), "keep_awake": keep_awake.status(), "idle_exit_min": IDLE_EXIT_MIN}


@app.post("/api/shutdown")
async def shutdown():
    """Quit button on the page. Graceful: uvicorn runs the shutdown hook, caffeinate is released."""
    _exit_soon("quit requested from the page")
    return {"ok": True}


@app.websocket("/ws/stt")
async def stt_socket(ws: WebSocket):
    await ws.accept()
    session: WhisperSession | None = None
    loop = asyncio.get_running_loop()

    async def send(msg: dict):
        try:
            await ws.send_text(json.dumps(msg, ensure_ascii=False))
        except Exception:
            pass

    async def deliver(msg: dict):
        await send(msg)
        if msg.get("fatal"):
            try:
                await ws.close(code=1011, reason="sidecar failure")
            except Exception:
                pass

    def on_result(msg: dict):
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(deliver(msg)))

    try:
        while True:
            msg = await ws.receive()
            _touch()
            if msg.get("type") == "websocket.disconnect":
                break
            if "bytes" in msg and msg["bytes"] is not None:
                if session:
                    session.feed(msg["bytes"])
                continue
            text = msg.get("text")
            if not text:
                continue
            data = json.loads(text)
            kind = data.get("type")
            if kind == "start":
                if session:
                    session.stop()
                session = WhisperSession(
                    language=data.get("language", "en"),
                    model=data.get("model"),
                    on_result=on_result,
                )
                session.set_context(data.get("context", ""))
                session.start()
                await send({"type": "ready", "model": session.model_name})
            elif kind == "context" and session:
                session.set_context(data.get("text", ""))
            elif kind == "stop" and session:
                session.stop()
                session = None
    except WebSocketDisconnect:
        pass
    finally:
        if session:
            session.stop()


@app.on_event("startup")
async def _startup():
    keep_awake.start()
    _touch()
    asyncio.get_running_loop().create_task(_idle_watch())
    if os.environ.get("PROMPTER_WARM", "1") == "1":
        asyncio.get_running_loop().run_in_executor(None, warm_up)


@app.on_event("shutdown")
async def _shutdown():
    keep_awake.stop()


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
