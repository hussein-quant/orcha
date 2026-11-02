"""The local speech service for voice-first mode (GH #409).

Run by ``orcha voice`` / the portal with the voice venv's Python (``~/.orcha/voice/venv``),
NOT the CLI's: it imports only the standard library and, lazily, ``mlx_audio``. Nothing from
orcha_cli is imported, so it runs as a plain script.

    POST /stt     body: audio/wav            -> {"text": "...", "ms": 72}
    POST /tts     {"text", "voice"?, "rate"?} -> audio/wav (Kokoro's natural voices; Mac voices fallback)
    GET  /voices                             -> {"voices": [{"name", "language"}]}
    GET  /health                             -> {"ok", "stt": {"model", "ready", "error"}, ...}

Privacy: it listens on 127.0.0.1 only, every route needs the shared token from
``<home>/token``, browser requests (an ``Origin`` header) are refused, the Hugging Face hub
runs offline, and outbound sockets to anything but loopback are refused in-process — so no
audio, transcript or text leaves the machine. It exits after ``--idle-seconds`` without
requests; the portal keeps it warm while voice-first mode is on.
"""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

for _k, _v in (("HF_HUB_OFFLINE", "1"), ("TRANSFORMERS_OFFLINE", "1"), ("HF_HUB_DISABLE_TELEMETRY", "1")):
    os.environ.setdefault(_k, _v)

MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_TEXT_CHARS = 4000
SAY = "/usr/bin/say"
# Spoken at start-up to compile the model's kernels for short and longer replies.
WARM_PHRASES = ("Approve the plan, thanks.",
                "Send it back because the login screen still crashes when I tap the button twice.")


# --------------------------------------------------------------------------- network guard


def _loopback(address) -> bool:
    host = address[0] if isinstance(address, tuple) else address
    if not isinstance(host, str):
        return True  # AF_UNIX paths and the like
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host.split("%")[0]).is_loopback
    except ValueError:
        return False  # a hostname: resolving it would itself go out


class NetworkRefused(OSError):
    pass


def guard_network() -> None:
    """Refuse every outbound connection that is not loopback, for the life of the process."""
    real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _loopback(address):
            raise NetworkRefused(f"voice service: network access refused ({address!r})")
        return real_connect(self, address)

    def connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _loopback(address):
            raise NetworkRefused(f"voice service: network access refused ({address!r})")
        return real_connect_ex(self, address)

    def getaddrinfo(host, *args, **kwargs):
        if host is not None and not _loopback((host if isinstance(host, str) else str(host),)):
            raise NetworkRefused(f"voice service: name lookup refused ({host!r})")
        return real_getaddrinfo(host, *args, **kwargs)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.getaddrinfo = getaddrinfo


# --------------------------------------------------------------------------- engines


class ParakeetSTT:
    """Speech-to-text with an MLX model from the local Hugging Face cache (offline)."""

    def __init__(self, repo: str):
        self.repo = repo
        self.model = None
        self.error: Optional[str] = None
        self._lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.model is not None

    def load(self) -> None:
        try:
            from mlx_audio.stt.utils import load_model

            model = load_model(self.repo)
            self.model = model
            self._warm()
        except Exception as exc:  # report on /health instead of dying silently
            self.error = f"{type(exc).__name__}: {exc}"

    def _warm(self) -> None:
        # The first inference compiles kernels (~5 s); do it now, not on the owner's first reply.
        # Silence never reaches the decoder, so warm up on a real spoken phrase (rendered
        # locally by the Mac's voice) at the rate the portal sends, falling back to silence.
        import wave

        for phrase in WARM_PHRASES:
            fd, path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            try:
                spoken = os.path.exists(SAY) and subprocess.run(
                    [SAY, "-o", path, "--file-format=WAVE", "--data-format=LEI16@16000", phrase],
                    capture_output=True, timeout=30,
                ).returncode == 0
                if not spoken:
                    with wave.open(path, "wb") as w:
                        w.setnchannels(1)
                        w.setsampwidth(2)
                        w.setframerate(16000)
                        w.writeframes(b"\x00\x00" * 16000)
                with self._lock:
                    self.model.generate(path)
            finally:
                os.unlink(path)

    def transcribe(self, wav: bytes) -> str:
        if not self.ready:
            raise RuntimeError(self.error or "the speech model is still loading")
        fd, path = tempfile.mkstemp(suffix=".wav")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(wav)
            with self._lock:  # one inference at a time on the GPU
                result = self.model.generate(path)
            return (getattr(result, "text", "") or "").strip()
        finally:
            os.unlink(path)


def voice_quality(name: str) -> str:
    n = name.lower()
    return "premium" if "(premium)" in n else "enhanced" if "(enhanced)" in n else "standard"


def best_voice(voices: list[dict]) -> Optional[str]:
    """The most natural English voice installed: Premium, then Enhanced (US, then any
    English). None = the system voice. Apple's Premium voices are a free download in System
    Settings › Accessibility › Spoken Content › System voice › Manage Voices."""
    for quality in ("premium", "enhanced"):
        for lang in ("en-US", "en-GB", "en-"):
            for v in voices:
                if v["quality"] == quality and v["language"].startswith(lang):
                    return v["name"]
    return None


class SystemTTS:
    """Text-to-speech with the Mac's own voices (`say`), rendered to a WAV file."""

    def __init__(self):
        self._voices: Optional[list[dict]] = None
        self._listed_at = 0.0

    def voices(self) -> list[dict]:
        if self._voices is not None and time.monotonic() - self._listed_at < 300:
            return self._voices
        try:
            out = subprocess.run([SAY, "-v", "?"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.TimeoutExpired):
            return []
        voices = []
        for line in out.splitlines():
            m = re.match(r"^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})\b", line)
            if m:
                name = m.group(1).strip()
                voices.append({"name": name, "language": m.group(2).replace("_", "-"), "quality": voice_quality(name)})
        self._voices, self._listed_at = voices, time.monotonic()
        return voices

    def best(self) -> Optional[str]:
        return best_voice(self.voices())

    def speak(self, text: str, voice: Optional[str] = None, rate: Optional[int] = None) -> bytes:
        voice = voice or self.best()
        tdir = tempfile.mkdtemp(prefix="orcha-tts-")
        src, out = os.path.join(tdir, "in.txt"), os.path.join(tdir, "out.wav")
        try:
            with open(src, "w", encoding="utf-8") as f:
                f.write(text)
            argv = [SAY, "-f", src, "-o", out, "--file-format=WAVE", "--data-format=LEI16@22050"]
            if voice:
                argv += ["-v", voice]
            if rate:
                argv += ["-r", str(int(rate))]
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=60)
            if proc.returncode != 0:
                raise RuntimeError((proc.stderr or "say failed").strip()[:200])
            with open(out, "rb") as f:
                return f.read()
        finally:
            for p in (src, out):
                try:
                    os.unlink(p)
                except OSError:
                    pass
            os.rmdir(tdir)


KOKORO_VOICES = (
    ("af_heart", "Heart", "en-US", "female"), ("af_bella", "Bella", "en-US", "female"),
    ("af_nicole", "Nicole", "en-US", "female"), ("af_sarah", "Sarah", "en-US", "female"),
    ("am_michael", "Michael", "en-US", "male"), ("am_fenrir", "Fenrir", "en-US", "male"),
    ("am_puck", "Puck", "en-US", "male"), ("bf_emma", "Emma", "en-GB", "female"),
    ("bf_isabella", "Isabella", "en-GB", "female"), ("bm_george", "George", "en-GB", "male"),
    ("bm_fable", "Fable", "en-GB", "male"),
)
KOKORO_IDS = {v[0] for v in KOKORO_VOICES}
DEFAULT_KOKORO = "af_heart"
KOKORO_RATE = 24000


def pcm_wav(samples, rate: int) -> bytes:
    """float samples in [-1, 1] -> 16-bit mono WAV bytes."""
    import io
    import wave

    import numpy as np

    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class KokoroTTS:
    """Kokoro-82M on MLX: free, open, natural voices. Its phonemiser uses Homebrew's espeak-ng
    (the pip copy has a broken data path on macOS), so the paths are passed in."""

    def __init__(self, repo: str, espeak_lib: str, espeak_data: str):
        self.repo = repo
        self.espeak = (espeak_lib, espeak_data)
        self.model = None
        self.error: Optional[str] = None
        self._lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.model is not None

    def load(self) -> None:
        try:
            import espeakng_loader

            lib, data = self.espeak
            espeakng_loader.get_library_path = lambda: lib
            espeakng_loader.get_data_path = lambda: data
            from mlx_audio.tts.utils import load_model

            model = load_model(self.repo)
            for _ in model.generate("Ready.", voice=DEFAULT_KOKORO):  # compile + load the voice now
                pass
            self.model = model
        except Exception as exc:  # Mac voices keep working; /health says why
            self.error = f"{type(exc).__name__}: {exc}"

    def voices(self) -> list[dict]:
        return [{"name": vid, "label": f"{label} (natural)", "language": lang, "quality": "neural", "gender": g}
                for vid, label, lang, g in KOKORO_VOICES]

    def speak(self, text: str, voice: Optional[str] = None, rate: Optional[int] = None) -> bytes:
        import numpy as np

        voice = voice if voice in KOKORO_IDS else DEFAULT_KOKORO
        speed = min(1.6, max(0.7, rate / 175.0)) if rate else 1.0
        with self._lock:
            chunks = [np.array(r.audio) for r in self.model.generate(text, voice=voice, speed=speed, lang_code=voice[0])]
        return pcm_wav(np.concatenate(chunks) if chunks else np.zeros(1), KOKORO_RATE)


class SpeechOut:
    """Kokoro when it is loaded (and for its own voice names), else the Mac's voices."""

    def __init__(self, kokoro: Optional[KokoroTTS], system: "SystemTTS"):
        self.kokoro = kokoro
        self.system = system

    @property
    def natural(self) -> bool:
        return bool(self.kokoro and self.kokoro.ready)

    def voices(self) -> list[dict]:
        return (self.kokoro.voices() if self.natural else []) + self.system.voices()

    def best(self) -> Optional[str]:
        return DEFAULT_KOKORO if self.natural else self.system.best()

    def speak(self, text: str, voice: Optional[str] = None, rate: Optional[int] = None) -> bytes:
        if self.natural and (not voice or voice in KOKORO_IDS):
            return self.kokoro.speak(text, voice, rate)
        return self.system.speak(text, None if voice in KOKORO_IDS else voice, rate)

    def health(self) -> dict:
        k = self.kokoro
        return {"engine": "kokoro" if self.natural else "system",
                "kokoro": None if k is None else {"ready": k.ready, "error": k.error}}


# --------------------------------------------------------------------------- HTTP


class VoiceServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, token: str, stt, tts, idle_seconds: float):
        super().__init__(("127.0.0.1", port), Handler)
        self.token = token
        self.stt = stt
        self.tts = tts
        self.idle_seconds = idle_seconds
        self.last_request = time.monotonic()


class Handler(BaseHTTPRequestHandler):
    server: VoiceServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet: never log transcripts or text
        return

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, doc: dict) -> None:
        self._send(status, json.dumps(doc).encode(), "application/json")

    def _allowed(self) -> bool:
        if self.headers.get("Origin"):
            self._json(403, {"error": "browser requests are not accepted; go through the portal"})
            return False
        sent = self.headers.get("X-Orcha-Voice-Token") or ""
        if not hmac.compare_digest(sent, self.server.token):
            self._json(401, {"error": "missing or wrong voice token"})
            return False
        self.server.last_request = time.monotonic()
        return True

    def _body(self, limit: int) -> Optional[bytes]:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            self._json(400, {"error": "empty body"})
            return None
        if n > limit:
            self._json(413, {"error": "body too large"})
            return None
        return self.rfile.read(n)

    def do_GET(self):  # noqa: N802
        if not self._allowed():
            return
        if self.path == "/health":
            stt = self.server.stt
            self._json(200, {"ok": True, "stt": {"model": getattr(stt, "repo", None), "ready": stt.ready,
                                                 "error": getattr(stt, "error", None)},
                             "tts": tts.health() if hasattr(tts := self.server.tts, "health") else {"engine": "system"},
                             "idle_seconds": self.server.idle_seconds})
        elif self.path == "/voices":
            tts = self.server.tts
            self._json(200, {"voices": tts.voices(), "best": tts.best() if hasattr(tts, "best") else None})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._allowed():
            return
        if self.path == "/stt":
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype not in ("audio/wav", "audio/x-wav", "audio/wave"):
                self._json(415, {"error": "send audio/wav"})
                return
            wav = self._body(MAX_AUDIO_BYTES)
            if wav is None:
                return
            started = time.monotonic()
            try:
                text = self.server.stt.transcribe(wav)
            except Exception as exc:
                self._json(503, {"error": str(exc)[:300]})
                return
            self._json(200, {"text": text, "ms": int((time.monotonic() - started) * 1000)})
        elif self.path == "/tts":
            raw = self._body(64 * 1024)
            if raw is None:
                return
            try:
                doc = json.loads(raw)
            except ValueError:
                self._json(400, {"error": "send JSON"})
                return
            text = str(doc.get("text") or "").strip()
            if not text or len(text) > MAX_TEXT_CHARS:
                self._json(400, {"error": f"text must be 1..{MAX_TEXT_CHARS} characters"})
                return
            voice = doc.get("voice") or None
            if voice is not None and not re.fullmatch(r"[\w .()'-]{1,64}", str(voice)):
                self._json(400, {"error": "unknown voice"})
                return
            rate = doc.get("rate")
            try:
                rate = int(rate) if rate else None
            except (TypeError, ValueError):
                rate = None
            if rate is not None and not 80 <= rate <= 400:
                rate = None
            try:
                audio = self.server.tts.speak(text, voice, rate)
            except Exception as exc:
                self._json(503, {"error": str(exc)[:300]})
                return
            self._send(200, audio, "audio/wav")
        else:
            self._json(404, {"error": "not found"})


def _idle_watch(server: VoiceServer) -> None:
    while True:
        time.sleep(5)
        if time.monotonic() - server.last_request > server.idle_seconds:
            server.shutdown()
            return


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Orcha local speech service (voice-first mode)")
    ap.add_argument("--home", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--model", required=True, help="Hugging Face repo of the speech-to-text model")
    ap.add_argument("--idle-seconds", type=float, default=1800.0)
    ap.add_argument("--tts-model", default=None, help="Hugging Face repo of the Kokoro voice model")
    ap.add_argument("--espeak-lib", default=None)
    ap.add_argument("--espeak-data", default=None)
    args = ap.parse_args(argv)
    with open(os.path.join(args.home, "token"), encoding="utf-8") as f:
        token = f.read().strip()
    if not token:
        print("voice service: empty token file", file=sys.stderr)
        return 2
    guard_network()
    stt = ParakeetSTT(args.model)
    kokoro = (KokoroTTS(args.tts_model, args.espeak_lib, args.espeak_data)
              if args.tts_model and args.espeak_lib and args.espeak_data else None)
    server = VoiceServer(args.port, token, stt, SpeechOut(kokoro, SystemTTS()), args.idle_seconds)

    def load_all() -> None:  # one after the other: they share the GPU
        stt.load()
        if kokoro:
            kokoro.load()

    threading.Thread(target=load_all, daemon=True).start()
    threading.Thread(target=_idle_watch, args=(server,), daemon=True).start()
    print(f"voice service: listening on 127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
