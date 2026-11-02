"""GH #409 Talk: the per-Mac speech service and its manager.

  * voice_server: loopback only, a token on every route, browser (Origin) requests refused,
    and — the acceptance criterion — no network calls: once the guard is installed every
    non-loopback connection or name lookup is refused (checked in a separate process);
  * voice_runtime: status / install refusals without touching the real ~/.orcha/voice.
No real model, MLX or network is used.
"""
import json
import os
import pathlib
import socket
import subprocess
import sys
import textwrap
import threading
import urllib.error
import urllib.request

import pytest

ORCHA_CLI = pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"
sys.path.insert(0, str(ORCHA_CLI))

from orcha_cli import voice_runtime, voice_server  # noqa: E402

TOKEN = "t0ken-for-tests"


# --------------------------------------------------------------------------- voice_server


class FakeSTT:
    repo = "fake/stt"
    error = None
    ready = True

    def __init__(self):
        self.seen = []

    def transcribe(self, wav):
        self.seen.append(len(wav))
        return "approve the plan"


class FakeTTS:
    def voices(self):
        return [{"name": "Samantha", "language": "en-US"}]

    def speak(self, text, voice=None, rate=None):
        return b"RIFF" + text.encode()


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server():
    srv = voice_server.VoiceServer(_free_port(), TOKEN, FakeSTT(), FakeTTS(), idle_seconds=60)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def _call(srv, method, path, body=None, headers=None):
    h = {"X-Orcha-Voice-Token": TOKEN, **(headers or {})}
    req = urllib.request.Request(f"http://127.0.0.1:{srv.server_address[1]}{path}", data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.headers.get("Content-Type"), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read()


def test_server_binds_loopback_only(server):
    assert server.server_address[0] == "127.0.0.1"


def test_every_route_needs_the_token(server):
    for path in ("/health", "/voices"):
        status, _, _ = _call(server, "GET", path, headers={"X-Orcha-Voice-Token": "wrong"})
        assert status == 401
    status, _, _ = _call(server, "POST", "/stt", b"RIFF....", {"X-Orcha-Voice-Token": "", "Content-Type": "audio/wav"})
    assert status == 401


def test_browser_requests_are_refused(server):
    status, _, body = _call(server, "GET", "/health", headers={"Origin": "http://evil.example"})
    assert status == 403 and b"browser" in body


def test_stt_and_tts_round_trip(server):
    status, ctype, body = _call(server, "POST", "/stt", b"RIFF" + b"\0" * 64, {"Content-Type": "audio/wav"})
    assert status == 200 and json.loads(body)["text"] == "approve the plan"
    status, _, _ = _call(server, "POST", "/stt", b"x", {"Content-Type": "text/plain"})
    assert status == 415
    status, ctype, body = _call(server, "POST", "/tts", json.dumps({"text": "hello"}).encode(),
                                {"Content-Type": "application/json"})
    assert status == 200 and ctype == "audio/wav" and body == b"RIFFhello"
    status, _, _ = _call(server, "POST", "/tts", json.dumps({"text": "hi", "voice": "x; rm -rf /"}).encode(),
                         {"Content-Type": "application/json"})
    assert status == 400


def test_health_reports_model_state(server):
    status, _, body = _call(server, "GET", "/health")
    doc = json.loads(body)
    assert status == 200 and doc["stt"] == {"model": "fake/stt", "ready": True, "error": None}


def test_idle_shutdown(monkeypatch):
    srv = voice_server.VoiceServer(_free_port(), TOKEN, FakeSTT(), FakeTTS(), idle_seconds=0)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    monkeypatch.setattr(voice_server.time, "sleep", lambda _s: None)
    voice_server._idle_watch(srv)  # returns once it has shut the server down
    t.join(timeout=5)
    assert not t.is_alive()
    srv.server_close()


GUARD_SCRIPT = textwrap.dedent("""
    import json, socket, sys, urllib.request
    sys.path.insert(0, sys.argv[1])
    from orcha_cli import voice_server as v
    v.guard_network()
    out = {}
    def attempt(name, fn):
        try:
            fn(); out[name] = "allowed"
        except v.NetworkRefused:
            out[name] = "refused"
        except OSError as e:
            out[name] = "allowed-but-failed:" + type(e).__name__
    attempt("ipv4", lambda: socket.create_connection(("1.1.1.1", 443), timeout=1))
    attempt("ipv6", lambda: socket.create_connection(("2606:4700:4700::1111", 443), timeout=1))
    attempt("dns", lambda: socket.getaddrinfo("huggingface.co", 443))
    attempt("https", lambda: urllib.request.urlopen("https://huggingface.co", timeout=1))
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
    attempt("loopback", lambda: socket.create_connection(srv.getsockname(), timeout=1).close())
    print(json.dumps(out))
""")


def test_no_network_calls_from_the_voice_service():
    """Acceptance (#409): in Local mode no audio leaves the machine — the service process
    cannot open any non-loopback connection or even resolve a public name."""
    proc = subprocess.run([sys.executable, "-c", GUARD_SCRIPT, str(ORCHA_CLI)], capture_output=True,
                          text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout.strip().splitlines()[-1])
    assert out["ipv4"] == out["ipv6"] == out["dns"] == "refused"
    assert out["https"] in ("refused",) or out["https"].startswith("allowed-but-failed:URLError")
    assert out["loopback"] == "allowed"


def test_best_voice_prefers_premium_then_enhanced():
    v = [{"name": n, "language": lang, "quality": voice_server.voice_quality(n)} for n, lang in (
        ("Samantha", "en-US"), ("Daniel (Enhanced)", "en-GB"), ("Anna (Premium)", "de-DE"), ("Zoe (Premium)", "en-US"))]
    assert voice_server.best_voice(v) == "Zoe (Premium)"
    assert voice_server.best_voice(v[:3]) == "Daniel (Enhanced)"  # a German Premium voice isn't picked
    assert voice_server.best_voice(v[:1]) is None  # only standard voices: the system voice


class FakeKokoro:
    def __init__(self, ready=True):
        self.ready, self.error, self.spoke = ready, None if ready else "OSError: no espeak", []

    def voices(self):
        return [{"name": "af_heart", "label": "Heart (natural)", "language": "en-US", "quality": "neural"}]

    def speak(self, text, voice=None, rate=None):
        self.spoke.append((text, voice))
        return b"KOKORO"


class FakeSystem(FakeTTS):
    def voices(self):
        return [{"name": "Samantha", "language": "en-US", "quality": "standard"}]

    def best(self):
        return None

    def speak(self, text, voice=None, rate=None):
        return b"SYSTEM:" + (voice or "default").encode()


def test_natural_voice_is_the_default_and_mac_voices_still_work():
    out = voice_server.SpeechOut(FakeKokoro(), FakeSystem())
    assert out.best() == "af_heart" and out.voices()[0]["quality"] == "neural"
    assert out.speak("hi") == b"KOKORO" and out.speak("hi", "bm_george") == b"KOKORO"
    assert out.speak("hi", "Samantha") == b"SYSTEM:Samantha"  # a Mac voice chosen by name
    assert out.health() == {"engine": "kokoro", "kokoro": {"ready": True, "error": None}}


def test_mac_voices_take_over_when_the_natural_voice_fails_to_load():
    out = voice_server.SpeechOut(FakeKokoro(ready=False), FakeSystem())
    assert out.best() is None and all(v["quality"] != "neural" for v in out.voices())
    assert out.speak("hi", "af_heart") == b"SYSTEM:default"  # never a Kokoro id passed to `say`
    assert out.health()["engine"] == "system" and "espeak" in out.health()["kokoro"]["error"]


def test_the_service_starts_offline():
    assert os.environ.get("HF_HUB_OFFLINE") == "1" and os.environ.get("TRANSFORMERS_OFFLINE") == "1"


# --------------------------------------------------------------------------- voice_runtime


@pytest.fixture
def voice_home(tmp_path, monkeypatch):
    monkeypatch.setenv("ORCHA_VOICE_HOME", str(tmp_path / "voice"))
    return tmp_path / "voice"


def test_status_when_not_installed(voice_home):
    st = voice_runtime.status()
    assert st["installed"] is False and st["running"] is False
    assert st["home"] == str(voice_home)
    stt = [m for m in st["models"] if m["kind"] == "stt"]
    assert [m["id"] for m in stt] == ["parakeet-v3", "whisper-turbo"] and not any(m["downloaded"] for m in stt)
    assert st["install_command"] == "orcha voice install"


def test_install_refuses_without_apple_silicon(voice_home, monkeypatch):
    monkeypatch.setattr(voice_runtime, "apple_silicon", lambda: False)
    with pytest.raises(voice_runtime.VoiceError, match="Apple Silicon"):
        voice_runtime.install()
    assert not voice_home.exists()


def test_start_refuses_before_install(voice_home):
    with pytest.raises(voice_runtime.VoiceError, match="orcha voice install"):
        voice_runtime.start()


def test_model_detection_and_installed(voice_home):
    snap = voice_home / "models" / "hub" / "models--mlx-community--parakeet-tdt-0.6b-v3" / "snapshots" / "abc"
    snap.mkdir(parents=True)
    assert not voice_runtime.model_downloaded("parakeet-v3")
    (snap / "model.safetensors").write_bytes(b"x")
    assert voice_runtime.model_downloaded("parakeet-v3")
    (voice_home / "venv" / "bin").mkdir(parents=True)
    (voice_home / "venv" / "bin" / "python").write_text("")
    (voice_home / "config.json").write_text(json.dumps({"installed": True, "stt_model": "parakeet-v3", "port": 8790}))
    assert voice_runtime.installed()


def test_client_sends_the_token(voice_home, monkeypatch):
    voice_home.mkdir(parents=True)
    (voice_home / "token").write_text(TOKEN)
    srv = voice_server.VoiceServer(_free_port(), TOKEN, FakeSTT(), FakeTTS(), idle_seconds=60)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        (voice_home / "config.json").write_text(json.dumps({"installed": True, "port": srv.server_address[1]}))
        assert voice_runtime.health()["stt"]["ready"] is True
        assert voice_runtime.transcribe(b"RIFF....")["text"] == "approve the plan"
        assert voice_runtime.speak("hi") == b"RIFFhi"
        assert voice_runtime.voices()["voices"][0]["name"] == "Samantha"
    finally:
        srv.shutdown()
        srv.server_close()


def test_client_reports_an_unreachable_service(voice_home):
    voice_home.mkdir(parents=True)
    (voice_home / "config.json").write_text(json.dumps({"installed": True, "port": _free_port()}))
    assert voice_runtime.health() is None
    with pytest.raises(voice_runtime.VoiceError, match="not reachable"):
        voice_runtime.transcribe(b"RIFF")
