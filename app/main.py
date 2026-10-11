import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import db
from app.adapter import PRESETS, complete_chat, list_models, needs_key, normalize_base_url, stream_chat, transcribe_audio
from app.adapter import Delta, StreamDone, StreamFail
from app.errors import AppError
from app.personality import (
    ADULT_RULE,
    assemble_messages,
    calibrate_ratio,
    compile_prompt,
    default_fields,
    foto_error,
    fresh_replies,
    minor_age_error,
    parse_replies,
    suggestion_messages,
    trim_messages,
)
from app.avatars import default_model, list_models as list_avatar_models, resolve_model
from app.animations import list_clips, resolve_clip
from app.voice import FISH_MODEL_IDS, fish_list_voices, fish_tts, local_say

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


class NoCacheStatic(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init()
    yield


LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _hostname(netloc: str) -> str:
    if netloc.startswith("["):
        return netloc.split("]", 1)[0] + "]"
    return netloc.rsplit(":", 1)[0].lower()


class LocalOnly:
    """Corta DNS rebinding (Host ajeno) y pedidos de otras webs (Origin ajeno)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
        host = headers.get("host", "")
        if _hostname(host) not in LOCAL_HOSTS:
            return await _forbidden(send, "Host no permitido. Abrí la app en http://127.0.0.1:8765.")
        origin = headers.get("origin")
        if origin and scope["method"] not in SAFE_METHODS:
            netloc = origin.split("://", 1)[-1]
            if origin == "null" or netloc != host:
                return await _forbidden(send, "Pedido de otro sitio. Se bloqueó.")
        return await self.app(scope, receive, send)


async def _forbidden(send, message: str) -> None:
    body = json.dumps({"detail": message}, ensure_ascii=False).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 403,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


app = FastAPI(title="Chat IA", lifespan=lifespan)
app.add_middleware(LocalOnly)


class FieldsIn(BaseModel):
    fields: dict = Field(default_factory=dict)


class ProviderIn(BaseModel):
    name: str = ""
    base_url: str = ""
    api_key: str | None = None
    clear_key: bool = False


class ThreadIn(BaseModel):
    character_id: str
    provider_account_id: str
    model: str
    context_tokens: int = 8192


class ThreadPatch(BaseModel):
    model: str | None = None
    context_tokens: int | None = None
    provider_account_id: str | None = None
    voice_account_id: str | None = None
    speak: int | None = None
    title: str | None = None


class VoiceIn(BaseModel):
    name: str = ""
    provider: str = "fish"
    api_key: str | None = None
    clear_key: bool = False
    voice_id: str = ""
    model: str = "s2.1-pro-free"


class SpeakIn(BaseModel):
    text: str = ""


class MessageIn(BaseModel):
    content: str = ""
    model: str | None = None
    context_tokens: int | None = None
    retry_message_id: str | None = None


EMPTY_TURN = (
    "El modelo terminó sin escribir nada. Si es un modelo que razona, pudo gastar todo el tope "
    "de tokens pensando: subí max_tokens en la ficha o probá otro modelo."
)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def title_from(content: str) -> str:
    line = " ".join(content.strip().split())
    if not line:
        return "Nuevo hilo"
    if len(line) > 48:
        return line[:48].rstrip() + "…"
    return line


def clamp_context(value: int | None) -> int:
    try:
        num = int(value if value is not None else 8192)
    except (TypeError, ValueError):
        num = 8192
    return max(512, min(200000, num))


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/presets")
def presets():
    return {
        "presets": [
            {"id": "openrouter", "label": "OpenRouter", "base_url": PRESETS["openrouter"]},
            {"id": "groq", "label": "Groq", "base_url": PRESETS["groq"]},
            {"id": "bazaarlink", "label": "BazaarLink", "base_url": PRESETS["bazaarlink"]},
            {"id": "xai", "label": "xAI API", "base_url": PRESETS["xai"]},
            {"id": "nvidia", "label": "NVIDIA NIM", "base_url": PRESETS["nvidia"]},
            {"id": "ollama", "label": "Ollama", "base_url": PRESETS["ollama"]},
            {"id": "lmstudio", "label": "LM Studio", "base_url": PRESETS["lmstudio"]},
        ]
    }


@app.get("/api/defaults")
def defaults():
    fields = default_fields()
    return {"fields": fields, "prompt_compiled": compile_prompt(fields), "adult_rule": ADULT_RULE}


@app.post("/api/compile")
def compile_fields(body: FieldsIn):
    err = minor_age_error(body.fields)
    if err:
        raise HTTPException(400, err)
    fields = body.fields
    return {"prompt_compiled": compile_prompt(fields), "fields": fields}


@app.get("/api/characters")
def get_characters():
    return {"characters": db.list_characters()}


@app.post("/api/characters")
def post_character(body: FieldsIn):
    err = minor_age_error(body.fields) or foto_error(body.fields)
    if err:
        raise HTTPException(400, err)
    name = str((body.fields or {}).get("nombre") or "").strip()
    if not name:
        raise HTTPException(400, "El personaje necesita un nombre.")
    return db.save_character(body.fields)


@app.put("/api/characters/{character_id}")
def put_character(character_id: str, body: FieldsIn):
    err = minor_age_error(body.fields) or foto_error(body.fields)
    if err:
        raise HTTPException(400, err)
    name = str((body.fields or {}).get("nombre") or "").strip()
    if not name:
        raise HTTPException(400, "El personaje necesita un nombre.")
    if db.get_character(character_id) is None:
        raise HTTPException(404, "Ese personaje no está.")
    return db.save_character(body.fields, character_id)


@app.delete("/api/characters/{character_id}")
def remove_character(character_id: str):
    if db.get_character(character_id) is None:
        raise HTTPException(404, "Ese personaje no está.")
    if db.character_in_use(character_id):
        raise HTTPException(400, "Hay hilos que usan este personaje. Borralos primero si querés eliminarlo.")
    db.delete_character(character_id)
    return {"ok": True}


@app.get("/api/providers")
def get_providers():
    return {"providers": db.list_providers()}


@app.post("/api/providers")
def post_provider(body: ProviderIn):
    name = body.name.strip() or "Conexión"
    base, err = normalize_base_url(body.base_url)
    if err:
        raise HTTPException(400, err.message)
    key = (body.api_key or "").strip()
    if needs_key(base) and not key:
        raise HTTPException(400, "Falta la API key. En local (Ollama, LM Studio) puede ir vacía.")
    return db.create_provider(name, base, key)


@app.put("/api/providers/{provider_id}")
def put_provider(provider_id: str, body: ProviderIn):
    current = db.get_provider(provider_id, secret=True)
    if current is None:
        raise HTTPException(404, "Esa conexión no está.")
    name = body.name.strip() or current["name"]
    base, err = normalize_base_url(body.base_url)
    if err:
        raise HTTPException(400, err.message)
    if body.clear_key:
        key = ""
    elif body.api_key:
        key = body.api_key.strip()
    else:
        key = current["api_key"]
    if needs_key(base) and not key:
        raise HTTPException(400, "Falta la API key. En local (Ollama, LM Studio) puede ir vacía.")
    return db.update_provider(provider_id, name, base, key)


@app.delete("/api/providers/{provider_id}")
def remove_provider(provider_id: str):
    if not db.delete_provider(provider_id):
        raise HTTPException(404, "Esa conexión no está.")
    return {"ok": True}


@app.post("/api/providers/{provider_id}/test")
async def post_test(provider_id: str):
    provider = db.get_provider(provider_id, secret=True)
    if provider is None:
        raise HTTPException(404, "Esa conexión no está.")
    models, err = await list_models(provider["base_url"], provider["api_key"])
    db.add_usage(
        None,
        "",
        None,
        None,
        err.http_status if err else 200,
        None if err is None else err.error_class,
    )
    if err:
        return {"ok": False, "error_class": err.error_class, "message": err.message, "models": []}
    return {
        "ok": True,
        "message": f"Conexión ok. {len(models)} modelos. Esto no usó el prompt del personaje.",
        "models": models,
    }


@app.get("/api/providers/{provider_id}/models")
async def get_models(provider_id: str):
    provider = db.get_provider(provider_id, secret=True)
    if provider is None:
        raise HTTPException(404, "Esa conexión no está.")
    models, err = await list_models(provider["base_url"], provider["api_key"])
    if err:
        raise HTTPException(err.http_status or 400, err.message)
    return {"models": models}


@app.get("/api/usage")
def get_usage():
    return {"events": db.list_usage()}


@app.get("/api/threads")
def get_threads():
    return {"threads": db.list_threads()}


@app.post("/api/threads")
def post_thread(body: ThreadIn):
    if db.get_character(body.character_id) is None:
        raise HTTPException(400, "Elegí un personaje.")
    if db.get_provider(body.provider_account_id) is None:
        raise HTTPException(400, "Elegí una conexión.")
    model = body.model.strip()
    if not model:
        raise HTTPException(400, "Falta el id del modelo.")
    return db.create_thread(body.character_id, body.provider_account_id, model, clamp_context(body.context_tokens))


@app.get("/api/threads/{thread_id}")
def get_one_thread(thread_id: str):
    thread = db.get_thread(thread_id)
    if thread is None:
        raise HTTPException(404, "Ese hilo no está.")
    return {"thread": thread, "messages": db.list_messages(thread_id)}


@app.patch("/api/threads/{thread_id}")
def patch_thread(thread_id: str, body: ThreadPatch):
    if db.get_thread(thread_id) is None:
        raise HTTPException(404, "Ese hilo no está.")
    if body.provider_account_id and db.get_provider(body.provider_account_id) is None:
        raise HTTPException(400, "Esa conexión no está.")
    model = body.model.strip() if isinstance(body.model, str) else None
    if model == "":
        raise HTTPException(400, "El modelo no puede quedar vacío.")
    context = clamp_context(body.context_tokens) if body.context_tokens is not None else None
    voice_kw = {}
    if "voice_account_id" in body.model_fields_set:
        if body.voice_account_id and db.get_voice(body.voice_account_id) is None:
            raise HTTPException(400, "Esa voz no está.")
        voice_kw["voice_account_id"] = body.voice_account_id or ""
    if "speak" in body.model_fields_set:
        voice_kw["speak"] = 1 if body.speak else 0
    if "title" in body.model_fields_set:
        title = " ".join((body.title or "").split())
        if not title:
            raise HTTPException(400, "El título no puede quedar vacío.")
        if len(title) > 80:
            raise HTTPException(400, "Ese título es demasiado largo.")
        voice_kw["title"] = title
    updated = db.update_thread(
        thread_id,
        model=model,
        context_tokens=context,
        provider_account_id=body.provider_account_id,
        **voice_kw,
    )
    return updated


@app.delete("/api/threads/{thread_id}")
def remove_thread(thread_id: str):
    if not db.delete_thread(thread_id):
        raise HTTPException(404, "Ese hilo no está.")
    return {"ok": True}


def _persist_turn(thread_id: str, model: str, parts: list[str], error: AppError | None, tin, tout) -> None:
    text = "".join(parts).strip()
    if text:
        db.add_message(thread_id, "assistant", text)
    status = 200 if error is None else error.http_status
    db.add_usage(
        thread_id,
        model,
        tin,
        tout,
        status,
        None if error is None else error.error_class,
    )


def _chat_ready(thread_id: str):
    thread = db.get_thread(thread_id)
    if thread is None:
        raise HTTPException(404, "Ese hilo no está.")
    character = db.get_character(thread["character_id"]) if thread.get("character_id") else None
    if character is None:
        raise HTTPException(400, "Este hilo no tiene personaje.")
    age_err = minor_age_error(character["fields"])
    if age_err:
        raise HTTPException(400, age_err)
    provider = db.get_provider(thread["provider_account_id"], secret=True) if thread.get("provider_account_id") else None
    if provider is None:
        raise HTTPException(400, "Esta conexión ya no está. Elegí otra. El personaje sigue igual.")
    model = (thread.get("model") or "").strip()
    if not model:
        raise HTTPException(400, "Elegí un modelo. No hace falta tocar la ficha.")
    if needs_key(provider["base_url"]) and not provider["api_key"]:
        raise HTTPException(400, "Falta la API key de esta conexión.")
    return thread, character, provider, model


@app.post("/api/threads/{thread_id}/messages")
async def post_message(thread_id: str, body: MessageIn, request: Request):
    thread = db.get_thread(thread_id)
    if thread is None:
        raise HTTPException(404, "Ese hilo no está.")
    retry_id = (body.retry_message_id or "").strip()
    kept = db.user_message(thread_id, retry_id) if retry_id else None
    if retry_id and kept is None:
        raise HTTPException(400, "No se puede reintentar ese mensaje.")
    content = kept["content"] if kept else body.content.strip()
    if not content:
        raise HTTPException(400, "Escribí un mensaje.")
    if len(content) > 20000:
        raise HTTPException(400, "Ese mensaje es demasiado largo.")
    if body.model is not None or body.context_tokens is not None:
        model = body.model.strip() if isinstance(body.model, str) else None
        if model == "":
            raise HTTPException(400, "Falta el modelo. Cambiarlo no reescribe el personaje.")
        context = clamp_context(body.context_tokens) if body.context_tokens is not None else None
        db.update_thread(thread_id, model=model, context_tokens=context)
    thread, character, provider, model = _chat_ready(thread_id)
    system = compile_prompt(character["fields"])
    if kept:
        db.truncate_after(thread_id, kept["id"])
    else:
        db.add_message(thread_id, "user", content)
        if thread.get("title") in (None, "", "Nuevo hilo"):
            db.update_thread(thread_id, title=title_from(content))
    history = db.list_messages(thread_id)
    assembled = assemble_messages(system, history)
    ratio = db.token_ratio(thread, model)
    trimmed = trim_messages(assembled, clamp_context(thread.get("context_tokens")), character["max_tokens"], ratio)

    async def events():
        parts: list[str] = []
        error: AppError | None = None
        gone = False
        tin = None
        tout = None
        try:
            async for item in stream_chat(
                provider["base_url"],
                provider["api_key"],
                model,
                trimmed,
                character["max_tokens"],
                character["temperature"],
            ):
                if await request.is_disconnected():
                    gone = True
                    break
                if isinstance(item, Delta):
                    parts.append(item.text)
                    if sum(len(p) for p in parts) > 50000:
                        error = AppError("unknown", "Se cortó el turno: superó el tope local de texto.")
                        break
                    yield sse("delta", {"text": item.text})
                elif isinstance(item, StreamFail):
                    error = item.error
                    break
                elif isinstance(item, StreamDone):
                    tin = item.tokens_in
                    tout = item.tokens_out
            if error is None and not gone and not "".join(parts).strip():
                error = AppError("parse_empty", EMPTY_TURN)
        except Exception:
            error = AppError("unknown", "Falló el cliente al leer el stream. No se asumió choices[0].")
        finally:
            try:
                _persist_turn(thread_id, model, parts, error, tin, tout)
            except Exception:
                if error is None:
                    error = AppError("unknown", "No se pudo guardar el turno en disco.")
            if error is None and tin:
                try:
                    db.set_token_ratio(thread_id, model, calibrate_ratio(ratio, tin, trimmed))
                except Exception:
                    pass
        try:
            if await request.is_disconnected():
                return
            if error is not None:
                yield sse("error", {"error_class": error.error_class, "message": error.message})
            yield sse("done", {"ok": error is None})
        except Exception:
            return

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )



@app.post("/api/threads/{thread_id}/suggestions")
async def post_suggestions(thread_id: str):
    thread, character, provider, model = _chat_ready(thread_id)
    history = db.list_messages(thread_id)
    assembled = suggestion_messages(history, character.get("name") or "")
    trimmed = trim_messages(assembled, clamp_context(thread.get("context_tokens")), 900, db.token_ratio(thread, model))
    # Un segundo intento, más suelto, si el modelo devolvió mensajes que el usuario ya mandó.
    for temperature in (0.9, 1.1):
        text, err, tin, tout = await complete_chat(
            provider["base_url"],
            provider["api_key"],
            model,
            trimmed,
            900,
            temperature,
        )
        db.add_usage(
            thread_id,
            model,
            tin,
            tout,
            200 if err is None else err.http_status,
            None if err is None else err.error_class,
        )
        if err:
            raise HTTPException(err.http_status or 400, err.message)
        replies = fresh_replies(parse_replies(text), history)
        if len(replies) >= 3:
            return {"replies": replies[:3]}
    raise HTTPException(400, "No se pudieron armar 3 opciones nuevas. Probá de nuevo o cambiá de modelo.")


@app.post("/api/threads/{thread_id}/transcribe")
async def post_transcribe(thread_id: str, file: UploadFile = File(...)):
    thread, _character, provider, _model = _chat_ready(thread_id)
    audio = await file.read()
    if len(audio) < 64:
        raise HTTPException(400, "No se capturó audio. Hablá con el mic prendido y tocá de nuevo para cortar.")
    if len(audio) > 8_000_000:
        raise HTTPException(400, "Ese audio es demasiado largo.")
    name = file.filename or "speech.webm"
    mime = file.content_type or "application/octet-stream"
    text, err = await transcribe_audio(provider["base_url"], provider["api_key"], audio, name, mime)
    db.add_usage(
        thread_id,
        "whisper",
        None,
        None,
        200 if err is None else err.http_status,
        None if err is None else err.error_class,
    )
    if err:
        raise HTTPException(err.http_status or 400, err.message)
    return {"text": text}


def _voice_key(current: dict | None, body: VoiceIn) -> str:
    if body.clear_key:
        return ""
    if body.api_key:
        return body.api_key.strip()
    if current:
        return current.get("api_key") or ""
    return ""


@app.get("/api/voices")
def get_voices():
    db.ensure_browser_voice()
    return {"voices": db.list_voices(), "fish_models": list(FISH_MODEL_IDS)}


@app.post("/api/voices")
def post_voice(body: VoiceIn):
    provider = body.provider if body.provider in ("browser", "fish") else ""
    if not provider:
        raise HTTPException(400, "El motor tiene que ser navegador o Fish Audio.")
    name = body.name.strip() or ("Navegador" if provider == "browser" else "Fish Audio")
    key = _voice_key(None, body)
    model = body.model if body.model in FISH_MODEL_IDS else "s2.1-pro-free"
    if provider == "fish" and not key:
        raise HTTPException(400, "Falta la API key de Fish Audio.")
    if provider == "browser":
        key = ""
        model = ""
    return db.create_voice(name, provider, key, body.voice_id.strip(), model)


@app.put("/api/voices/{voice_id}")
def put_voice(voice_id: str, body: VoiceIn):
    current = db.get_voice(voice_id, secret=True)
    if current is None:
        raise HTTPException(404, "Esa voz no está.")
    provider = body.provider if body.provider in ("browser", "fish") else current["provider"]
    name = body.name.strip() or current["name"]
    key = _voice_key(current, body)
    model = body.model if body.model in FISH_MODEL_IDS else (current.get("model") or "s2.1-pro-free")
    if provider == "fish" and not key:
        raise HTTPException(400, "Falta la API key de Fish Audio.")
    if provider == "browser":
        key = ""
        model = ""
    return db.update_voice(voice_id, name, provider, key, body.voice_id.strip(), model)


@app.delete("/api/voices/{voice_id}")
def remove_voice(voice_id: str):
    current = db.get_voice(voice_id)
    if current is None:
        raise HTTPException(404, "Esa voz no está.")
    if current["provider"] == "browser":
        raise HTTPException(400, "El motor del navegador se queda. No usa key.")
    db.delete_voice(voice_id)
    return {"ok": True}


@app.get("/api/voices/{voice_id}/models")
async def voice_models(voice_id: str):
    current = db.get_voice(voice_id, secret=True)
    if current is None:
        raise HTTPException(404, "Esa voz no está.")
    if current["provider"] != "fish":
        return {"models": []}
    models, err = await fish_list_voices(current["api_key"])
    if err:
        raise HTTPException(err.http_status or 400, err.message)
    return {"models": models}


@app.post("/api/voices/{voice_id}/speak")
async def speak_voice(voice_id: str, body: SpeakIn):
    current = db.get_voice(voice_id, secret=True)
    if current is None:
        raise HTTPException(404, "Esa voz no está.")
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "No hay texto para leer.")
    if len(text) > 800:
        raise HTTPException(400, "Esa frase es demasiado larga para una sola lectura.")
    if current["provider"] == "browser":
        err = await asyncio.to_thread(local_say, text)
        if err:
            raise HTTPException(err.http_status or 400, err.message)
        return Response(status_code=204)
    audio, err = await fish_tts(current["api_key"], text, current.get("voice_id") or "", current.get("model") or "")
    if err:
        raise HTTPException(err.http_status or 400, err.message)
    return Response(content=audio, media_type="audio/mpeg")


@app.get("/api/avatars")
def get_avatars():
    return {"avatars": list_avatar_models(), "default": default_model()}


@app.get("/api/avatars/file")
def get_avatar_file(name: str):
    path = resolve_model(name)
    if path is None:
        raise HTTPException(404, "Ese modelo no está.")
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@app.get("/api/animations")
def get_animations():
    return {"clips": list_clips()}


@app.get("/api/animations/file")
def get_animation_file(name: str):
    path = resolve_clip(name)
    if path is None:
        raise HTTPException(404, "Esa animación no está.")
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


SPA_ROOTS = {"chat", "personajes", "conexiones", "voces"}


def spa_index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/")
def index():
    return spa_index()


app.mount("/static", NoCacheStatic(directory=STATIC), name="static")


@app.get("/{full_path:path}")
def spa(full_path: str):
    root = full_path.split("/", 1)[0]
    if root not in SPA_ROOTS:
        raise HTTPException(404, "Eso no está.")
    return spa_index()
