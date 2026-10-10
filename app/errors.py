import json
from dataclasses import dataclass


@dataclass(frozen=True)
class AppError:
    error_class: str
    message: str
    http_status: int | None = None


def parse_json(text: str | None):
    if text is None:
        return None
    raw = text.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def extract_message(parsed, body_text: str) -> str:
    if isinstance(parsed, dict):
        err = parsed.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("code") or ""
            return str(msg)
        if isinstance(err, str):
            return err
        if parsed.get("message"):
            return str(parsed["message"])
    text = (body_text or "").strip()
    if len(text) > 400:
        return text[:400]
    return text


def _has(low: str, needles: tuple[str, ...]) -> bool:
    return any(n in low for n in needles)


def normalize_error(status: int | None, body_text: str | None, parsed) -> AppError:
    body = body_text or ""
    stripped = body.strip()
    msg = extract_message(parsed, body)
    low = f"{msg}\n{body}".lower()

    if "nonetype" in low and "subscriptable" in low:
        return AppError(
            "parse_empty",
            "La respuesta vino mal formada. No se leyó choices[0]. Probá de nuevo o cambiá de modelo.",
            status,
        )

    if stripped.lower().startswith("<!doctype") or stripped.lower().startswith("<html"):
        return AppError(
            "502",
            "La Base URL devolvió HTML, no la API. Tiene que ser la URL de chat, por ejemplo https://openrouter.ai/api/v1, sin /keys.",
            status,
        )

    if status == 401 or (status == 403 and _has(low, ("api key", "unauthorized", "invalid", "incorrect"))):
        return AppError(
            "401",
            "Key inválida o mal pegada. Revisá la key. En OpenRouter no se recupera: creá otra.",
            status,
        )

    if status == 402 or _has(
        low,
        (
            "insufficient credits",
            "insufficient_quota",
            "payment required",
            "requires more credits",
            "credit balance",
            "not enough credits",
        ),
    ):
        return AppError(
            "402",
            "Sin créditos en un modelo de pago. Recargá o usá un ID :free.",
            status,
        )

    rate = status == 429 or _has(low, ("rate limit", "rate_limit", "too many requests", "quota exceeded"))
    if rate:
        if _has(low, ("site-wide", "sitewide", "site wide", "provider returned", "provider_returned")):
            return AppError(
                "429_global",
                "El pool free del proveedor está lleno. No es tu key. Reintentá más tarde o usá un modelo de pago barato.",
                status or 429,
            )
        if _has(low, ("personal quota", "personal_quota", "per-day", "daily limit")):
            return AppError(
                "429_personal",
                "Llegaste a tu tope (RPM o requests del día). Esperá el reset o subí de plan.",
                status or 429,
            )
        return AppError(
            "429_personal",
            "El proveedor limitó la request (429). Si el texto dice site-wide, no es tu key. Si dice personal quota, esperá el reset. Reintentar también gasta cupo.",
            status or 429,
        )

    if status in (500, 502, 503, 504):
        return AppError(
            "502",
            "El proveedor no respondió bien. Reintentá en un rato. No cambies de personaje por esto.",
            status,
        )

    if not stripped:
        return AppError(
            "parse_empty",
            "El proveedor devolvió un cuerpo vacío. No se leyó la respuesta.",
            status,
        )

    if parsed is None:
        return AppError(
            "parse_empty",
            "No se pudo parsear la respuesta. No se asumió choices[0].",
            status,
        )

    human = msg.strip() or "Error desconocido del proveedor."
    if len(human) > 400:
        human = human[:400]
    return AppError("unknown", human, status)


def extract_text(chunk) -> str:
    if not isinstance(chunk, dict):
        return ""
    if chunk.get("error"):
        return ""
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    for key in ("delta", "message"):
        block = first.get(key)
        if not isinstance(block, dict):
            continue
        content = block.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return _parts(content)
    return ""


def _parts(content: list) -> str:
    out = []
    for part in content:
        if isinstance(part, str):
            out.append(part)
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                out.append(text)
    return "".join(out)


def chunk_error(chunk) -> AppError | None:
    if not isinstance(chunk, dict) or not chunk.get("error"):
        return None
    err = chunk.get("error")
    status = None
    if isinstance(err, dict) and isinstance(err.get("code"), int):
        status = err["code"]
    payload = {"error": err}
    raw = json.dumps(payload, ensure_ascii=False)
    return normalize_error(status, raw, payload)
