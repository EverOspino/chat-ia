from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

from app.errors import AppError, chunk_error, extract_text, normalize_error, parse_json


PRESETS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
    "bazaarlink": "https://api.bazaarlink.ai/v1",
    "xai": "https://api.x.ai/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    "ollama": "http://127.0.0.1:11434/v1",
    "lmstudio": "http://127.0.0.1:1234/v1",
}


@dataclass
class Delta:
    text: str


@dataclass
class StreamDone:
    tokens_in: int | None = None
    tokens_out: int | None = None


@dataclass
class StreamFail:
    error: AppError


def normalize_base_url(url: str) -> tuple[str, AppError | None]:
    raw = (url or "").strip()
    if not raw:
        return "", AppError("unknown", "Falta la Base URL.")
    if not (raw.startswith("http://") or raw.startswith("https://")):
        return "", AppError("unknown", "La Base URL tiene que empezar con http:// o https://.")
    cleaned = raw.rstrip("/")
    low = cleaned.lower()
    if low.endswith("/keys") or "/keys/" in low or low.endswith("/settings/keys"):
        return "", AppError(
            "unknown",
            "Esa URL es de gestión de keys, no de chat. En OpenRouter la Base URL es https://openrouter.ai/api/v1 — sin /keys.",
        )
    if cleaned.endswith("/chat/completions"):
        cleaned = cleaned[: -len("/chat/completions")]
    return cleaned, None


def needs_key(base_url: str) -> bool:
    low = (base_url or "").lower()
    return not any(host in low for host in ("127.0.0.1", "localhost", "[::1]"))


def auth_headers(api_key: str, base_url: str, json_body: bool = True) -> dict[str, str]:
    headers = {
        "User-Agent": "chat-ia/0.1",
    }
    if json_body:
        headers["Content-Type"] = "application/json"
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if "openrouter.ai" in base_url.lower():
        headers["HTTP-Referer"] = "http://127.0.0.1:8765"
        headers["X-Title"] = "Chat IA"
    return headers


def build_payload(
    model: str,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
    base_url: str,
    stream: bool = True,
) -> dict:
    payload = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if stream and "openrouter.ai" in base_url.lower():
        payload["stream_options"] = {"include_usage": True}
    return payload


def parse_models(parsed) -> list[dict]:
    if not isinstance(parsed, dict):
        return []
    data = parsed.get("data")
    if not isinstance(data, list):
        data = parsed.get("models")
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        mid = item.get("id") or item.get("name")
        if not isinstance(mid, str) or not mid.strip():
            continue
        context = item.get("context_length") or item.get("context_window") or item.get("max_model_len")
        if not isinstance(context, int):
            context = None
        pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
        prompt_price = str(pricing.get("prompt", ""))
        free = mid.endswith(":free") or prompt_price in ("0", "0.0", "0.00")
        name = item.get("name") if isinstance(item.get("name"), str) else mid
        out.append({"id": mid, "name": name, "context": context, "free": free})
    out.sort(key=lambda item: item["id"].lower())
    return out[:400]


def _usage(chunk) -> tuple[int | None, int | None]:
    if not isinstance(chunk, dict):
        return None, None
    usage = chunk.get("usage")
    if not isinstance(usage, dict):
        return None, None
    tin = usage.get("prompt_tokens")
    tout = usage.get("completion_tokens")
    return (
        tin if isinstance(tin, int) else None,
        tout if isinstance(tout, int) else None,
    )


def _connect_error(exc: Exception) -> AppError:
    if isinstance(exc, httpx.TimeoutException):
        return AppError("502", "La Base URL no respondió a tiempo.")
    if isinstance(exc, httpx.ConnectError):
        return AppError("502", "No se pudo conectar. Revisá la Base URL y que el servicio esté arriba.")
    return AppError("502", "Falló la conexión con el proveedor.")


async def list_models(base_url: str, api_key: str, timeout: float = 20) -> tuple[list[dict], AppError | None]:
    base, err = normalize_base_url(base_url)
    if err:
        return [], err
    url = f"{base}/models"
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            resp = await client.get(url, headers=auth_headers(api_key, base))
    except httpx.HTTPError as exc:
        return [], _connect_error(exc)
    if resp.status_code in (301, 302, 303, 307, 308):
        return [], AppError("unknown", "La Base URL redirigió. Usá la URL final de chat, sin /keys.")
    text = resp.text
    parsed = parse_json(text)
    if resp.status_code == 404:
        return [], AppError(
            "unknown",
            "Esta Base URL no expone /models. La key puede estar bien. Escribí el id del modelo a mano.",
            404,
        )
    if resp.status_code != 200:
        return [], normalize_error(resp.status_code, text, parsed)
    return parse_models(parsed), None


async def test_connection(base_url: str, api_key: str) -> tuple[bool, AppError | None, int]:
    models, err = await list_models(base_url, api_key)
    if err:
        return False, err, 0
    return True, None, len(models)


async def _read_sse(resp: httpx.Response) -> AsyncIterator[Delta | StreamDone | StreamFail]:
    tokens_in = None
    tokens_out = None
    async for line in resp.aiter_lines():
        if line is None:
            continue
        line = line.strip()
        if not line or line.startswith(":"):
            continue
        if line.startswith("data:"):
            data = line[5:].strip()
        elif line.startswith("{") or line.startswith("["):
            data = line
        else:
            continue
        if data == "[DONE]":
            break
        parsed = parse_json(data)
        if not isinstance(parsed, dict):
            continue
        err = chunk_error(parsed)
        if err:
            yield StreamFail(err)
            return
        tin, tout = _usage(parsed)
        if tin is not None:
            tokens_in = tin
        if tout is not None:
            tokens_out = tout
        text = extract_text(parsed)
        if text:
            yield Delta(text)
    yield StreamDone(tokens_in, tokens_out)


async def stream_chat(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
) -> AsyncIterator[Delta | StreamDone | StreamFail]:
    base, err = normalize_base_url(base_url)
    if err:
        yield StreamFail(err)
        return
    if not (model or "").strip():
        yield StreamFail(AppError("unknown", "Falta el modelo."))
        return
    payload = build_payload(model.strip(), messages, max_tokens, temperature, base)
    timeout = httpx.Timeout(connect=20, read=180, write=30, pool=20)
    url = f"{base}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            async with client.stream(
                "POST",
                url,
                headers=auth_headers(api_key, base),
                json=payload,
            ) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    yield StreamFail(AppError("unknown", "La Base URL redirigió. Revisala: no pongas /keys."))
                    return
                if resp.status_code != 200:
                    body = await resp.aread()
                    text = body.decode("utf-8", errors="replace")
                    yield StreamFail(normalize_error(resp.status_code, text, parse_json(text)))
                    return
                async for item in _read_sse(resp):
                    yield item
    except httpx.HTTPError as exc:
        yield StreamFail(_connect_error(exc))


async def complete_chat(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
) -> tuple[str, AppError | None, int | None, int | None]:
    base, err = normalize_base_url(base_url)
    if err:
        return "", err, None, None
    if not (model or "").strip():
        return "", AppError("unknown", "Falta el modelo."), None, None
    payload = build_payload(model.strip(), messages, max_tokens, temperature, base, stream=False)
    timeout = httpx.Timeout(connect=20, read=180, write=30, pool=20)
    url = f"{base}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            resp = await client.post(url, headers=auth_headers(api_key, base), json=payload)
    except httpx.HTTPError as exc:
        return "", _connect_error(exc), None, None
    if resp.status_code in (301, 302, 303, 307, 308):
        return "", AppError("unknown", "La Base URL redirigió. Revisala: no pongas /keys."), None, None
    body = resp.text
    parsed = parse_json(body)
    if resp.status_code != 200:
        return "", normalize_error(resp.status_code, body, parsed), None, None
    if not isinstance(parsed, dict):
        return "", AppError("parse_empty", "No se pudo parsear la respuesta. No se asumió choices[0].", resp.status_code), None, None
    fail = chunk_error(parsed)
    if fail:
        return "", fail, None, None
    tin, tout = _usage(parsed)
    text = extract_text(parsed)
    if not (text or "").strip():
        return "", AppError("parse_empty", "El proveedor devolvió un cuerpo vacío. No se leyó la respuesta.", resp.status_code), tin, tout
    return text, None, tin, tout


def whisper_models(base_url: str) -> tuple[str, ...]:
    low = (base_url or "").lower()
    if "groq.com" in low:
        return ("whisper-large-v3-turbo", "whisper-large-v3")
    if "openrouter.ai" in low:
        return ("openai/whisper-1",)
    if "openai.com" in low:
        return ("whisper-1",)
    return ("whisper-large-v3-turbo", "whisper-large-v3", "whisper-1")


async def transcribe_audio(
    base_url: str,
    api_key: str,
    audio: bytes,
    filename: str,
    mime: str,
) -> tuple[str, AppError | None]:
    base, err = normalize_base_url(base_url)
    if err:
        return "", err
    if not audio:
        return "", AppError("unknown", "No hay audio para transcribir.")
    url = f"{base}/audio/transcriptions"
    timeout = httpx.Timeout(connect=20, read=120, write=30, pool=20)
    last_err: AppError | None = None
    for model in whisper_models(base):
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
                resp = await client.post(
                    url,
                    headers=auth_headers(api_key, base, json_body=False),
                    files={"file": (filename or "speech.webm", audio, mime or "application/octet-stream")},
                    data={"model": model, "language": "es"},
                )
        except httpx.HTTPError as exc:
            return "", _connect_error(exc)
        if resp.status_code in (301, 302, 303, 307, 308):
            return "", AppError("unknown", "La Base URL redirigió. Revisala: no pongas /keys.")
        body = resp.text
        parsed = parse_json(body)
        if resp.status_code == 200:
            text = ""
            if isinstance(parsed, dict) and isinstance(parsed.get("text"), str):
                text = parsed["text"].strip()
            if not text:
                return "", AppError("parse_empty", "El proveedor no devolvió texto.", 200)
            return text, None
        last_err = normalize_error(resp.status_code, body, parsed)
        if resp.status_code not in (400, 404):
            return "", last_err
    return "", last_err or AppError("unknown", "Esta conexión no transcribe audio.")
