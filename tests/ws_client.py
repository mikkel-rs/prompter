"""Stream a 16 kHz mono Int16 WAV into the sidecar at real-time pace and print hypotheses.

Usage:
    uv run python tests/ws_client.py path/to/audio.wav [da|en] [ws://localhost:8765/ws/stt]

Make a test file with macOS speech synthesis:
    say -v Sara "Godmorgen alle sammen, og tak fordi I tog jer tid." -o /tmp/da.aiff
    afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/da.aiff /tmp/da.wav
"""

import asyncio
import json
import sys
import time
import wave

import websockets


async def main(path: str, lang: str, url: str):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16 kHz mono Int16"
        pcm = w.readframes(w.getnframes())
    frame = 3200  # 100 ms
    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "language": lang, "context": ""}))
        t0 = time.time()
        got = []

        async def reader():
            async for msg in ws:
                m = json.loads(msg)
                if m.get("type") == "hyp":
                    got.append(m)
                    print(f"[{time.time() - t0:5.1f}s] {m['latency_ms']:4d} ms  {m['text']}")
                elif m.get("type") in ("status", "ready", "error"):
                    print(f"[{time.time() - t0:5.1f}s] {m}")

        task = asyncio.create_task(reader())
        for i in range(0, len(pcm), frame):
            await ws.send(pcm[i:i + frame])
            await asyncio.sleep(0.1)
        await asyncio.sleep(2.5)  # let the last window flush
        await ws.send(json.dumps({"type": "stop"}))
        task.cancel()
        print(f"done: {len(got)} hypotheses, audio {len(pcm) / 32000:.1f}s, wall {time.time() - t0:.1f}s")


if __name__ == "__main__":
    p = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "en"
    url = sys.argv[3] if len(sys.argv) > 3 else "ws://localhost:8765/ws/stt"
    asyncio.run(main(p, lang, url))
