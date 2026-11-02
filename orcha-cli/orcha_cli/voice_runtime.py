"""Local speech for voice-first mode (GH #409): one MLX speech service per Mac.

Speech-to-text runs on Apple Silicon with MLX (Parakeet by default); text-to-speech uses
Kokoro, a free, open neural voice on MLX (the Mac's own voices are the fallback). Both run in ONE loopback service shared by every project on the machine,
so models download and load once. Audio never leaves the machine: the service only listens
on 127.0.0.1, runs with the Hugging Face hub offline, and refuses any non-loopback socket.

Layout (``ORCHA_VOICE_HOME``, default ``~/.orcha/voice``)::

    venv/          its own Python environment (MLX is not installed into the CLI's)
    models/        Hugging Face cache for the speech models (HF_HOME)
    config.json    installed model, port
    token          shared secret the portal sends; the service refuses requests without it
    service.pid / service.log

`orcha voice install` sets it up; the portal starts the service on demand while
voice-first mode is on, and it stops itself after a while with no requests.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import pathlib
import platform
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Callable, Optional

PACKAGES = ("mlx-audio==0.6.3", "misaki[en]==0.9.4")
# Kokoro's English text front end loads this spaCy model; fetched at install (the service runs offline)
SPACY_MODEL = ("en_core_web_sm", "3.8.0")
# Kokoro phonemises unknown words with espeak-ng. The pip copy has a broken data path on macOS,
# so the Homebrew build is used (free, ~26 MB): `brew install espeak-ng`.
ESPEAK_PREFIXES = ("/opt/homebrew", "/usr/local")
DEFAULT_PORT = 8790
STT_MODELS = {
    "parakeet-v3": {
        "repo": "mlx-community/parakeet-tdt-0.6b-v3",
        "label": "Parakeet TDT 0.6B v3",
        "size_bytes": 2_508_000_000,
        "note": "fast, English and 24 other European languages",
    },
    "whisper-turbo": {
        "repo": "mlx-community/whisper-large-v3-turbo",
        "label": "Whisper large-v3 turbo",
        "size_bytes": 1_614_000_000,
        "note": "smaller download, many languages",
    },
}
DEFAULT_STT = "parakeet-v3"
TTS_MODELS = {
    "kokoro": {
        "repo": "mlx-community/Kokoro-82M-bf16",
        "label": "Kokoro (natural voices)",
        "size_bytes": 390_000_000,
        "note": "free, open neural voices, very fast",
    },
}
TTS_ENGINES = {"system": {"label": "Mac voices", "size_bytes": 0, "note": "built into macOS (fallback)"}}
START_WAIT_S = 120.0  # first start loads the model into memory


class VoiceError(Exception):
    """A plain-words reason local speech can't be used right now."""


# --------------------------------------------------------------------------- paths


def voice_home() -> pathlib.Path:
    return pathlib.Path(os.environ.get("ORCHA_VOICE_HOME") or (pathlib.Path.home() / ".orcha" / "voice"))


def venv_python() -> pathlib.Path:
    return voice_home() / "venv" / "bin" / "python"


def models_dir() -> pathlib.Path:
    return voice_home() / "models"


def server_script() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent / "voice_server.py"


def apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def read_config() -> dict:
    try:
        return json.loads((voice_home() / "config.json").read_text())
    except (OSError, ValueError):
        return {}


def _write_config(cfg: dict) -> None:
    home = voice_home()
    home.mkdir(parents=True, exist_ok=True)
    tmp = home / "config.json.tmp"
    tmp.write_text(json.dumps(cfg, indent=2) + "\n")
    os.replace(tmp, home / "config.json")


def token() -> Optional[str]:
    try:
        return (voice_home() / "token").read_text().strip() or None
    except OSError:
        return None


def port() -> int:
    return int(read_config().get("port") or DEFAULT_PORT)


def stt_model() -> str:
    m = read_config().get("stt_model")
    return m if m in STT_MODELS else DEFAULT_STT


def espeak_paths() -> Optional[tuple[str, str]]:
    """(library, data dir) of a Homebrew espeak-ng, or None."""
    for prefix in ESPEAK_PREFIXES:
        lib = pathlib.Path(prefix) / "lib" / "libespeak-ng.dylib"
        data = pathlib.Path(prefix) / "share" / "espeak-ng-data"
        if lib.exists() and data.is_dir():
            return str(lib), str(data)
    return None


def model_downloaded(model_id: str) -> bool:
    repo = (STT_MODELS.get(model_id) or TTS_MODELS[model_id])["repo"]
    snap = models_dir() / "hub" / ("models--" + repo.replace("/", "--")) / "snapshots"
    return any(snap.glob("*/*.safetensors")) if snap.is_dir() else False


def installed() -> bool:
    return bool(read_config().get("installed")) and venv_python().exists() and model_downloaded(stt_model())


# --------------------------------------------------------------------------- service client


def request(method: str, path: str, body: Optional[bytes] = None, content_type: Optional[str] = None,
            timeout: float = 30.0) -> tuple[int, str, bytes]:
    """One call to the local service. Returns (status, content type, body); raises VoiceError
    when it is not reachable."""
    headers = {"X-Orcha-Voice-Token": token() or ""}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(f"http://127.0.0.1:{port()}{path}", data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - loopback only
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", "") if exc.headers else "", exc.read()
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise VoiceError(f"the local speech service is not reachable ({exc})") from None


def health(timeout: float = 2.0) -> Optional[dict]:
    try:
        status, _, data = request("GET", "/health", timeout=timeout)
    except VoiceError:
        return None
    if status != 200:
        return None
    try:
        return json.loads(data)
    except ValueError:
        return None


def _json_or_error(status: int, data: bytes) -> dict:
    try:
        doc = json.loads(data)
    except ValueError:
        doc = {}
    if status != 200:
        raise VoiceError(doc.get("error") or f"the local speech service answered {status}")
    return doc


def transcribe(wav: bytes, timeout: float = 60.0) -> dict:
    return _json_or_error(*_drop_type(request("POST", "/stt", wav, "audio/wav", timeout=timeout)))


def speak(text: str, voice: Optional[str] = None, rate: Optional[int] = None, timeout: float = 60.0) -> bytes:
    body = json.dumps({"text": text, "voice": voice, "rate": rate}).encode()
    status, ctype, data = request("POST", "/tts", body, "application/json", timeout=timeout)
    if status != 200 or not ctype.startswith("audio/"):
        _json_or_error(status if status != 200 else 500, data)
    return data


def voices() -> dict:
    """{"voices": [{name, language, quality}], "best": the voice used when none is chosen}."""
    doc = _json_or_error(*_drop_type(request("GET", "/voices")))
    return {"voices": doc.get("voices", []), "best": doc.get("best")}


def _drop_type(res: tuple[int, str, bytes]) -> tuple[int, bytes]:
    return res[0], res[2]


# --------------------------------------------------------------------------- lifecycle


def _pid() -> Optional[int]:
    try:
        pid = int((voice_home() / "service.pid").read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def status() -> dict:
    cfg = read_config()
    h = health() if cfg.get("installed") else None
    model = stt_model()
    return {
        "apple_silicon": apple_silicon(),
        "installed": installed(),
        "home": str(voice_home()),
        "running": bool(h),
        "ready": bool(h and h.get("stt", {}).get("ready")),
        "voice_engine": ((h or {}).get("tts") or {}).get("engine"),
        "port": port(),
        "pid": _pid(),
        "stt_model": model,
        "models": [
            {"id": mid, "kind": "stt", "label": m["label"], "size_bytes": m["size_bytes"], "note": m["note"],
             "downloaded": model_downloaded(mid), "selected": mid == model}
            for mid, m in STT_MODELS.items()
        ] + [
            {"id": tid, "kind": "tts", "label": t["label"], "size_bytes": t["size_bytes"], "note": t["note"],
             "downloaded": model_downloaded(tid) and espeak_paths() is not None,
             "selected": model_downloaded(tid)}
            for tid, t in TTS_MODELS.items()
        ] + [
            {"id": tid, "kind": "tts", "label": t["label"], "size_bytes": t["size_bytes"], "note": t["note"],
             "downloaded": True, "selected": not model_downloaded("kokoro")}
            for tid, t in TTS_ENGINES.items()
        ],
        "install_command": "orcha voice install",
    }


def _free_port(start: int) -> int:
    for p in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise VoiceError("no free local port for the speech service")


def _run(argv: list[str], env: Optional[dict] = None, out: Callable[[str], None] = print) -> None:
    out("[orcha] $ " + " ".join(argv))
    proc = subprocess.run(argv, env=env)
    if proc.returncode != 0:
        raise VoiceError(f"`{argv[0]} {argv[1] if len(argv) > 1 else ''}` failed (exit {proc.returncode})")


def install(model: str = DEFAULT_STT, out: Callable[[str], None] = print) -> dict:
    """Create the venv, install MLX speech, download the model. Safe to re-run."""
    if not apple_silicon():
        raise VoiceError("local speech needs a Mac with Apple Silicon (M1 or later); "
                         "use a cloud speech provider in Settings › Voice instead")
    if model not in STT_MODELS:
        raise VoiceError(f"unknown speech model {model!r} (choose from {', '.join(STT_MODELS)})")
    home = voice_home()
    home.mkdir(parents=True, exist_ok=True)
    py = venv_python()
    uv = shutil.which("uv")
    if not py.exists():
        if uv:
            _run([uv, "venv", "-q", "-p", sys.executable, str(home / "venv")], out=out)
        else:
            _run([sys.executable, "-m", "venv", str(home / "venv")], out=out)
    if uv:
        _run([uv, "pip", "install", "-q", "-p", str(py), *PACKAGES], out=out)
    else:
        _run([str(py), "-m", "pip", "install", "-q", *PACKAGES], out=out)
    name, version = SPACY_MODEL
    # the exact pinned model wheel (spaCy's own `download` would pick a version itself)
    wheel = (f"https://github.com/explosion/spacy-models/releases/download/{name}-{version}/"
             f"{name}-{version}-py3-none-any.whl")
    if uv:
        _run([uv, "pip", "install", "-q", "-p", str(py), wheel], out=out)
    else:
        _run([str(py), "-m", "pip", "install", "-q", wheel], out=out)
    if espeak_paths() is None:
        brew = shutil.which("brew")
        if brew:
            out("[orcha] installing espeak-ng with Homebrew (free, ~26 MB) for the natural voice …")
            _run([brew, "install", "espeak-ng"], out=out)
        else:
            out("[orcha] note: install Homebrew's espeak-ng for the natural voice; until then Mac voices are used")
    env = {**os.environ, "HF_HOME": str(models_dir()), "HF_HUB_DISABLE_TELEMETRY": "1"}
    for m in (STT_MODELS[model], TTS_MODELS["kokoro"]):
        out(f"[orcha] downloading {m['label']} (~{m['size_bytes'] / 1e9:.1f} GB, once) …")
        _run([str(py), "-c", f"from huggingface_hub import snapshot_download; snapshot_download({m['repo']!r})"],
             env=env, out=out)
    tok = home / "token"
    if not token():
        tok.write_text(secrets.token_urlsafe(32))
        tok.chmod(0o600)
    cfg = read_config()
    _write_config({**cfg, "installed": True, "stt_model": model, "packages": list(PACKAGES),
                   "port": cfg.get("port") or _free_port(DEFAULT_PORT),
                   "installed_at": _dt.datetime.now(_dt.timezone.utc).isoformat()})
    return status()


def start(wait: float = START_WAIT_S) -> dict:
    """Start the service if it isn't running and wait until speech-to-text is warm."""
    if not installed():
        raise VoiceError("local speech isn't installed yet: run `orcha voice install`")
    h = health()
    if not h:
        home = voice_home()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("ORCHA_RUN", "ORCHA_WORK"))}
        env.update(HF_HOME=str(models_dir()), HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                   HF_HUB_DISABLE_TELEMETRY="1")
        log = open(home / "service.log", "ab")  # noqa: SIM115 - handed to the child
        argv = [str(venv_python()), str(server_script()), "--home", str(home), "--port", str(port()),
                "--model", STT_MODELS[stt_model()]["repo"]]
        es = espeak_paths()
        if model_downloaded("kokoro") and es:
            argv += ["--tts-model", TTS_MODELS["kokoro"]["repo"], "--espeak-lib", es[0], "--espeak-data", es[1]]
        proc = subprocess.Popen(
            argv,
            stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, start_new_session=True,
        )
        (home / "service.pid").write_text(str(proc.pid))
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        h = health()
        kokoro = ((h or {}).get("tts") or {}).get("kokoro")
        voice_settled = kokoro is None or kokoro.get("ready") or kokoro.get("error")
        if h and h.get("stt", {}).get("ready") and voice_settled:
            return status()
        if h and h.get("stt", {}).get("error"):
            raise VoiceError("the speech model failed to load: " + str(h["stt"]["error"]))
        time.sleep(0.5)
    raise VoiceError(f"the local speech service did not become ready in {int(wait)} s "
                     f"(see {voice_home() / 'service.log'})")


def stop() -> bool:
    pid = _pid()
    if not pid:
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except OSError:
            break
        time.sleep(0.1)
    try:
        (voice_home() / "service.pid").unlink()
    except OSError:
        pass
    return True


def uninstall(models_only: bool = False) -> None:
    stop()
    home = voice_home()
    if models_only:
        shutil.rmtree(models_dir(), ignore_errors=True)
        cfg = read_config()
        if cfg:
            _write_config({**cfg, "installed": False})
        return
    shutil.rmtree(home, ignore_errors=True)
