"""Sidecar unit tests. Run: uv run python tests/test_stt.py"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.stt import compression_ratio, looks_like_loop  # noqa: E402

LOOPS = [
    "safe and safe and safe and safe and safe and safe and safe and safe and safe and",
    "assistant assistant assistant assistant assistant assistant assistant assistant",
    "four to number four to number four to number four to number four to number four",
    "of the right result of the right result of the right result of the right result",
    "and the US and the US and the US and the US and the US and the US and the US and",
    "a guest with a guest with a guest with a guest with a guest with a guest with a",
]
SPEECH = [
    "Good evening everyone, and thank you for coming.",
    "He went from number four to number three and the harm couldn't be undone",
    "Nobody had to approve what it did before it changed something that belonged to someone else",
    "For et år siden havde klubben tolv aktive medlemmer under fyrre og en bane, der stod tom",
    "It worked I mean it told him he was now number three",
    "So in the chat please just type A B or C You have thirty seconds",
]


def test_loops_are_detected():
    for t in LOOPS:
        assert looks_like_loop(t), (t, compression_ratio(t))


def test_speech_is_not_flagged():
    for t in SPEECH:
        assert not looks_like_loop(t), (t, compression_ratio(t))


def test_empty_is_not_a_loop():
    assert compression_ratio("") == 0.0
    assert not looks_like_loop("")


def test_keepawake_disabled_by_env():
    os.environ["PROMPTER_KEEP_AWAKE"] = "0"
    from server.keepawake import KeepAwake

    k = KeepAwake()
    assert k.enabled is False
    k.start()
    assert k.status() == {"enabled": False, "active": False, "pid": None, "restarts": 0}
    k.stop()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} passed")
