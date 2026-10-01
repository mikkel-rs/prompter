"""Keep the Mac awake while the sidecar runs.

Two assertions, both via the stock `caffeinate` tool so nothing has to be installed:

- A long-lived `caffeinate -d -i -s -w <server pid>` prevents display sleep, idle
  sleep and (on AC power) system sleep. The `-w` makes it release the assertion
  the moment the server exits, even if the server crashes.
- A `caffeinate -u` pulse every 45 s declares user activity. The display assertion
  alone does not stop the screen saver; declared activity does.

Disable with PROMPTER_KEEP_AWAKE=0. No-op on anything that is not macOS.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import threading

log = logging.getLogger("prompter.keepawake")

PULSE_EVERY_SEC = 45
PULSE_LEN_SEC = 60


class KeepAwake:
    def __init__(self):
        self.enabled = (
            platform.system() == "Darwin"
            and shutil.which("caffeinate") is not None
            and os.environ.get("PROMPTER_KEEP_AWAKE", "1") == "1"
        )
        self._proc: subprocess.Popen | None = None
        self._pulse_proc: subprocess.Popen | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.restarts = 0

    # ---- lifecycle ----
    def start(self):
        if not self.enabled:
            log.info("keep-awake disabled (not macOS, no caffeinate, or PROMPTER_KEEP_AWAKE=0)")
            return
        self._spawn_main()
        self._thread = threading.Thread(target=self._loop, name="keepawake", daemon=True)
        self._thread.start()
        log.info("keeping the Mac awake (display, idle and system sleep blocked) while the server runs; PROMPTER_KEEP_AWAKE=0 disables this")

    def stop(self):
        self._stop.set()
        for p in (self._proc, self._pulse_proc):
            if p and p.poll() is None:
                try:
                    p.terminate()
                except Exception:  # noqa: BLE001
                    pass
        self._proc = self._pulse_proc = None

    # ---- internals ----
    def _spawn(self, args: list[str]) -> subprocess.Popen | None:
        try:
            return subprocess.Popen(
                ["caffeinate", *args],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:  # noqa: BLE001
            log.exception("caffeinate failed to start")
            return None

    def _spawn_main(self):
        self._proc = self._spawn(["-d", "-i", "-s", "-w", str(os.getpid())])

    def _loop(self):
        while not self._stop.wait(PULSE_EVERY_SEC):
            if self._proc is None or self._proc.poll() is not None:
                # Somebody killed it, or it died. Bring it back and say so.
                self.restarts += 1
                log.warning("caffeinate exited unexpectedly, restarting it (restart #%d)", self.restarts)
                self._spawn_main()
            if self._pulse_proc and self._pulse_proc.poll() is None:
                try:
                    self._pulse_proc.terminate()
                except Exception:  # noqa: BLE001
                    pass
            self._pulse_proc = self._spawn(["-u", "-t", str(PULSE_LEN_SEC)])

    # ---- reporting ----
    def status(self) -> dict:
        active = self._proc is not None and self._proc.poll() is None
        return {
            "enabled": self.enabled,
            "active": active,
            "pid": self._proc.pid if active else None,
            "restarts": self.restarts,
        }
