import json
import re
from datetime import datetime, timezone


DEFAULT_FORMAT = (
    "Toda acción física entre asteriscos (*mira a un lado*), sin gestos en prosa. "
    "Todo pensamiento entre comillas. Diálogo hablado sin comillas ni asteriscos. "
    "La longitud sigue al momento: una frase o un párrafo, no un conteo fijo."
)
DEFAULT_LIMITS = (
    "No rompas el personaje. No des consejos de asistente ni menciones que sos un modelo."
)
ADULT_RULE = "El personaje es adulto. No incluyas menores, ni en ficción."
FORMAT_TAIL = (
    "Formato, obligatorio. Esto pesa más que todo lo anterior.\n"
    "{formato}\n"
    "Prohibido narrar un gesto fuera de los asteriscos.\n"
    "Prohibido un pensamiento fuera de las comillas.\n"
    "Prohibido terminar el turno con una pregunta.\n"
    "Prohibido cerrar con ¿…?\n"
    "Prohibido el metrónomo acción-diálogo-acción-diálogo. No empieces y cierres siempre con asteriscos.\n"
    "No rellenes con gestos para alargar. Si alcanza una línea, una línea.\n"
    "Variá la forma: a veces solo habla, a veces solo un gesto, a veces un bloque. El momento manda, no el patrón.\n"
    "No actúes como asistente. No ofrezcas ayuda. Seguí el personaje."
)

FIELD_KEYS = (
    "nombre",
    "edad",
    "look",
    "tono",
    "vocabulario",
    "formato",
    "limites",
    "ejemplo",
)


def default_fields() -> dict:
    return {
        "nombre": "",
        "edad": "",
        "look": "",
        "tono": "",
        "vocabulario": "",
        "formato": DEFAULT_FORMAT,
        "limites": DEFAULT_LIMITS,
        "ejemplo": "",
        "max_tokens": 600,
        "temperatura": 0.85,
    }


def _clamp_int(value, default: int, low: int, high: int) -> int:
    try:
        num = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, num))


def _clamp_float(value, default: float, low: float, high: float) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, num))


def coerce_fields(raw: dict | None) -> dict:
    src = raw if isinstance(raw, dict) else {}
    base = default_fields()
    out = {}
    for key in FIELD_KEYS:
        val = src.get(key, base[key])
        out[key] = "" if val is None else str(val).strip()
    out["max_tokens"] = _clamp_int(src.get("max_tokens", base["max_tokens"]), 600, 32, 4096)
    out["temperatura"] = _clamp_float(src.get("temperatura", base["temperatura"]), 0.85, 0.0, 2.0)
    return out


def minor_age_error(fields: dict | None) -> str | None:
    raw = ""
    if isinstance(fields, dict):
        raw = str(fields.get("edad") or "")
    nums = [int(n) for n in re.findall(r"\d+", raw)]
    if not nums:
        return None
    n = nums[0]
    year = datetime.now(timezone.utc).year
    age = year - n if 1900 <= n <= year else n
    if age < 18:
        return "La edad del personaje tiene que ser 18 o más. Nada de menores, ni en ficción."
    return None


def compile_prompt(fields: dict | None) -> str:
    f = coerce_fields(fields)
    blocks = []
    ident = []
    if f["nombre"]:
        ident.append(f["nombre"])
    if f["edad"]:
        ident.append(f"{f['edad']} años" if f["edad"].isdigit() else f["edad"])
    line = ", ".join(ident)
    if f["look"]:
        line = f"{line}. {f['look']}" if line else f["look"]
    if line:
        blocks.append(line)
    if f["tono"]:
        blocks.append(f"Tono: {f['tono']}")
    if f["vocabulario"]:
        blocks.append(f"Vocabulario y estilo: {f['vocabulario']}")
    limits = f["limites"]
    if ADULT_RULE not in limits:
        limits = f"{limits}\n{ADULT_RULE}".strip()
    blocks.append(f"Límites: {limits}")
    if f["ejemplo"]:
        blocks.append("Ejemplo de turno a imitar, no a citar:\n" + f["ejemplo"])
    formato = f["formato"] or DEFAULT_FORMAT
    blocks.append(FORMAT_TAIL.format(formato=formato))
    return "\n\n".join(blocks)


CHARS_PER_TOKEN = 3.5
RATIO_MIN = 0.5
RATIO_MAX = 3.0


def approx_tokens(messages: list[dict], ratio: float = 1.0) -> int:
    chars = 0
    for msg in messages:
        chars += len(msg.get("content") or "")
    raw = chars / CHARS_PER_TOKEN + 8 * len(messages)
    return int(raw * ratio) + 1


def calibrate_ratio(previous: float | None, tokens_in: int | None, messages: list[dict]) -> float | None:
    """Ajusta la estimación con los tokens_in reales que reportó el proveedor."""
    if not tokens_in or tokens_in <= 0:
        return previous
    estimate = approx_tokens(messages)
    if estimate <= 0:
        return previous
    measured = max(RATIO_MIN, min(RATIO_MAX, tokens_in / estimate))
    if previous is None:
        return round(measured, 4)
    return round(previous * 0.5 + measured * 0.5, 4)


def trim_messages(messages: list[dict], context_tokens: int, max_output: int, ratio: float | None = None) -> list[dict]:
    budget = max(256, int(context_tokens) - int(max_output) - 256)
    factor = max(RATIO_MIN, min(RATIO_MAX, ratio)) if ratio else 1.0
    system = [m for m in messages if m.get("role") == "system"]
    rest = [m for m in messages if m.get("role") != "system"]
    while len(rest) > 1 and approx_tokens(system + rest, factor) > budget:
        rest.pop(0)
    while len(rest) > 1 and rest[0].get("role") == "assistant":
        rest.pop(0)
    return system + rest


def assemble_messages(system: str, history: list[dict]) -> list[dict]:
    out = [{"role": "system", "content": system}]
    for msg in history:
        role = msg.get("role")
        content = msg.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content})
    return out


SUGGEST_KEYS = ("continuar", "empujar", "desviar")
SUGGEST_SYSTEM = (
    "Tu salida es texto que el usuario humano pegaría en el chat. "
    "No sos el personaje. No narrás al personaje. No continuás su turno. "
    "Copiá la voz y la longitud de los ejemplos del usuario. "
    "Si el usuario manda una línea corta, cada opción es una línea corta. "
    "Prohibido prosa larga, descripción de cuerpos, ambiente o pensamientos del personaje. "
    "Tres movimientos del usuario, distintos: "
    "continuar: sigue la escena en su voz. "
    "empujar: sube tensión, deseo o conflicto, en su voz. "
    "desviar: cambia el foco o corta, en su voz. "
    "No expliques. No armes JSON. "
    "Devolvé exactamente este formato:\n"
    "<<<continuar>>>\n"
    "mensaje\n"
    "<<<empujar>>>\n"
    "mensaje\n"
    "<<<desviar>>>\n"
    "mensaje"
)
_TAG_SPLIT = re.compile(r"<<<\s*(continuar|empujar|desviar)\s*>>>", re.I)
_LABEL_SPLIT = re.compile(r"(?im)^\s*(continuar|empujar|desviar)\s*[:\-]\s*")


def _clip(text: str, limit: int = 180) -> str:
    val = " ".join((text or "").split()).strip()
    if len(val) <= limit:
        return val
    return val[: limit - 1].rstrip() + "…"


def suggestion_messages(history: list[dict], character_name: str = "") -> list[dict]:
    name = (character_name or "").strip() or "Personaje"
    system = SUGGEST_SYSTEM + f"\nEl personaje se llama {name}. El usuario no es {name}."
    users: list[str] = []
    last_char = ""
    for msg in history:
        role = msg.get("role")
        content = msg.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        if role == "user":
            users.append(content.strip())
        elif role == "assistant":
            last_char = content.strip()
    style = "\n".join(f"- {item}" for item in users[-6:]) or "- (todavía no escribió)"
    beat = _clip(last_char) if last_char else "(nada todavía)"
    user = (
        "Voz del usuario. Imitá esto, esta longitud:\n"
        f"{style}\n\n"
        f"Último turno de {name}, solo contexto. No escribas así:\n"
        f"{beat}\n\n"
        f"Tres mensajes nuevos del usuario. Si suena a {name}, está mal."
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _clean_reply(value) -> str:
    if isinstance(value, dict):
        value = value.get("text") or value.get("content") or value.get("mensaje") or ""
    if not isinstance(value, str):
        return ""
    val = " ".join(value.split()).strip()
    if len(val) > 500:
        return val[:500].rstrip()
    return val


def _keyed_replies(raw: str, splitter: re.Pattern) -> list[str]:
    parts = splitter.split(raw)
    found: dict[str, str] = {}
    i = 1
    while i + 1 < len(parts):
        key = parts[i].lower()
        found[key] = _clean_reply(parts[i + 1])
        i += 2
    keyed = [found.get(key, "") for key in SUGGEST_KEYS]
    return keyed if all(keyed) else []


def parse_replies(text: str) -> list[str]:
    raw = (text or "").strip()
    if not raw:
        return []
    tagged = _keyed_replies(raw, _TAG_SPLIT) or _keyed_replies(raw, _LABEL_SPLIT)
    if tagged:
        return tagged
    parsed = _suggestion_json(raw)
    if isinstance(parsed, dict):
        keyed = [_clean_reply(parsed.get(key)) for key in SUGGEST_KEYS]
        if all(keyed):
            return keyed
        for key in ("replies", "opciones", "suggestions"):
            value = parsed.get(key)
            if isinstance(value, list):
                parsed = value
                break
    items = parsed if isinstance(parsed, list) else _suggestion_lines(raw)
    out: list[str] = []
    for item in items:
        val = _clean_reply(item)
        if not val or val in out:
            continue
        out.append(val)
        if len(out) == 3:
            break
    return out


def _suggestion_json(raw: str):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        try:
            return json.loads(fence.group(1).strip())
        except json.JSONDecodeError:
            pass
    brace = re.search(r"\{[\s\S]*\}|\[[\s\S]*\]", raw)
    if brace:
        try:
            return json.loads(brace.group(0))
        except json.JSONDecodeError:
            return None
    return None


def _suggestion_lines(raw: str) -> list[str]:
    lines = []
    for line in raw.splitlines():
        line = re.sub(r"^\s*(?:\d+[\.)]\s*|[-*]\s+)", "", line).strip()
        if not line or line.startswith("```") or line in ("{", "}"):
            continue
        lines.append(line)
    return lines
