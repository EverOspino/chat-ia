import re
import shutil
import subprocess

import httpx

from app.errors import AppError, normalize_error, parse_json

FISH_TTS = "https://api.fish.audio/v1/tts"
FISH_MODELS = "https://api.fish.audio/model"
FISH_MODEL_IDS = ("s2.1-pro-free", "s2.1-pro", "s2-pro", "s1")


def speakable(text: str) -> str:
    cleaned = re.sub(r"\*", " ", text or "")
    cleaned = re.sub(r"[«»\"“”]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def consume_sentences(buffer: str) -> tuple[list[str], str]:
    stripped = buffer or ""
    held = ""
    if stripped.count("*") % 2 == 1:
        cut = stripped.rfind("*")
        held = stripped[cut:]
        stripped = stripped[:cut]
    prepared = re.sub(r"\*", " ", stripped)
    prepared = re.sub(r"[«»\"“”]", " ", prepared)
    prepared = re.sub(r"[ \t]+", " ", prepared)
    parts: list[str] = []
    rest = prepared
    pattern = re.compile(r"^(.+?[.!?…])(?:\s+|$)")
    while rest:
        newline = rest.find("\n")
        match = pattern.match(rest)
        if newline == 0:
            rest = rest[1:]
            continue
        if match and (newline < 0 or match.end() <= newline):
            sentence = match.group(1).strip()
            rest = rest[match.end():]
        elif newline > 0:
            sentence = rest[:newline].strip()
            rest = rest[newline + 1:]
        else:
            break
        if sentence:
            parts.append(sentence)
    return parts, rest + held


def local_say(text: str) -> AppError | None:
    spoken = speakable(text)
    if not spoken:
        return AppError("unknown", "No queda texto para leer.")
    if not shutil.which("spd-say"):
        return AppError(
            "unknown",
            "Brave no ve voces y tampoco está speech-dispatcher. Instalá speech-dispatcher y espeak-ng.",
        )
    try:
        subprocess.run(
            ["spd-say", "-w", "-l", "es", spoken[:800]],
            timeout=45,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return AppError("502", "La voz local tardó demasiado.")
    return None


async def fish_tts(api_key: str, text: str, voice_id: str, model: str) -> tuple[bytes, AppError | None]:
    spoken = speakable(text)
    if not spoken:
        return b"", AppError("unknown", "No queda texto para leer.")
    if not api_key:
        return b"", AppError("401", "Falta la API key de Fish Audio.")
    if not voice_id:
        return b"", AppError("unknown", "Falta el id de voz de Fish Audio. Es el reference_id, no la key.")
    chosen = model if model in FISH_MODEL_IDS else "s2.1-pro-free"
    payload = {
        "text": spoken[:800],
        "reference_id": voice_id,
        "format": "mp3",
        "latency": "balanced",
        "mp3_bitrate": 128,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "model": chosen,
        "User-Agent": "chat-ia/0.1",
    }
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
            resp = await client.post(FISH_TTS, headers=headers, json=payload)
    except httpx.TimeoutException:
        return b"", AppError("502", "Fish Audio no respondió a tiempo.")
    except httpx.ConnectError:
        return b"", AppError("502", "No se pudo conectar con Fish Audio.")
    except httpx.HTTPError:
        return b"", AppError("502", "Falló la conexión con Fish Audio.")
    if resp.status_code != 200:
        text_body = resp.text
        return b"", normalize_error(resp.status_code, text_body, parse_json(text_body))
    if not resp.content:
        return b"", AppError("parse_empty", "Fish Audio devolvió un audio vacío.")
    return resp.content, None


async def fish_list_voices(api_key: str) -> tuple[list[dict], AppError | None]:
    if not api_key:
        return [], AppError("401", "Falta la API key de Fish Audio.")
    headers = {"Authorization": f"Bearer {api_key}", "User-Agent": "chat-ia/0.1"}
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            resp = await client.get(FISH_MODELS, headers=headers, params={"page_size": 30, "self": "true"})
    except httpx.HTTPError:
        return [], AppError("502", "No se pudo listar las voces de Fish Audio.")
    parsed = parse_json(resp.text)
    if resp.status_code != 200:
        return [], normalize_error(resp.status_code, resp.text, parsed)
    items = parsed.get("items") if isinstance(parsed, dict) else None
    if not isinstance(items, list):
        return [], AppError("parse_empty", "Fish Audio no devolvió una lista de voces.")
    out = []
    for item in items:
        if not isinstance(item, dict) or not item.get("_id"):
            continue
        out.append({
            "id": str(item["_id"]),
            "name": str(item.get("title") or item["_id"]),
            "languages": item.get("languages") if isinstance(item.get("languages"), list) else [],
        })
    return out, None
