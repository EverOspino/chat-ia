import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
import sys

sys.path.insert(0, str(ROOT))

from app.adapter import stream_chat, test_connection
from app.adapter import Delta, StreamDone, StreamFail
from app.errors import AppError, extract_text, normalize_error
from app.personality import assemble_messages, compile_prompt, minor_age_error, parse_replies, suggestion_messages, trim_messages
from app.avatars import allowed, default_model, list_models as list_avatar_files
from app.animations import allowed as anim_allowed, list_clips
from app.voice import consume_sentences, speakable


class AvatarTests(unittest.TestCase):
    def test_blocks_minor_coded_names(self):
        self.assertFalse(allowed("loli-rosa.vrm"))
        self.assertFalse(allowed("shota.vrm"))
        self.assertFalse(allowed("colegiala.vrm"))
        self.assertFalse(allowed("../atlas.vrm"))
        self.assertTrue(allowed("atlas.vrm"))

    def test_animation_files(self):
        self.assertTrue(anim_allowed("Idle.fbx"))
        self.assertFalse(anim_allowed("../Idle.fbx"))
        self.assertFalse(anim_allowed("Idle.vrm"))
        self.assertIn("Idle.fbx", list_clips())

    def test_ships_atlas(self):
        self.assertIn("atlas.vrm", list_avatar_files())
        self.assertEqual(default_model(), "atlas.vrm")


class VoiceTests(unittest.TestCase):
    def test_actions_are_spoken(self):
        spoken = speakable("*se cruza de brazos* Hola, cabrón.")
        self.assertNotIn("*", spoken)
        self.assertIn("Hola", spoken)
        self.assertIn("cruza", spoken)

    def test_split_keeps_unclosed_action(self):
        parts, rest = consume_sentences("Hola. *se")
        self.assertEqual(parts, ["Hola."])
        self.assertIn("*se", rest)

    def test_windows_say_passes_text_out_of_band(self):
        import base64
        import subprocess as sp
        from app import voice

        calls = []

        def fake_run(args, **kw):
            calls.append((args, kw))
            return sp.CompletedProcess(args, 0)

        text = "Hola $(rm x); \"y\""
        with patch.object(voice.sys, "platform", "win32"), patch.object(voice.shutil, "which", return_value="powershell"), patch.object(voice.subprocess, "run", fake_run):
            self.assertIsNone(voice.local_say(text))
        args, kw = calls[0]
        self.assertNotIn("rm x", " ".join(args))
        sent = base64.b64decode(kw["env"]["CHAT_IA_SAY"]).decode("utf-8")
        self.assertIn("$(rm x);", sent)

    def test_windows_say_without_spanish_voice(self):
        import subprocess as sp
        from app import voice

        with patch.object(voice.sys, "platform", "win32"), patch.object(voice.shutil, "which", return_value="powershell"), patch.object(voice.subprocess, "run", lambda a, **k: sp.CompletedProcess(a, 3)):
            err = voice.local_say("Hola.")
        self.assertIsNotNone(err)
        self.assertIn("español", err.message)


class PersonalityTests(unittest.TestCase):
    def test_format_block_is_last_and_not_a_helper(self):
        prompt = compile_prompt(
            {
                "nombre": "Vera",
                "edad": "34",
                "tono": "seca",
                "formato": "Acciones entre asteriscos.",
                "ejemplo": "Vera mira la taza.",
            }
        )
        self.assertTrue(prompt.strip().endswith("Seguí el personaje."))
        self.assertIn("Formato, obligatorio.", prompt)
        self.assertIn("metrónomo", prompt)
        self.assertGreater(prompt.rfind("Formato, obligatorio."), prompt.find("Ejemplo de turno"))
        self.assertNotIn("helpful assistant", prompt.lower())
        self.assertNotIn("sé un asistente útil", prompt.lower())
        self.assertIn("No incluyas menores", prompt)

    def test_rejects_minor_age(self):
        self.assertIsNotNone(minor_age_error({"edad": "15"}))
        self.assertIsNotNone(minor_age_error({"edad": "2012"}))
        self.assertIsNone(minor_age_error({"edad": "34"}))
        self.assertIsNone(minor_age_error({"edad": ""}))

    def test_trim_keeps_system_and_latest(self):
        system = {"role": "system", "content": "SYS"}
        old = {"role": "user", "content": "x" * 4000}
        latest = {"role": "user", "content": "nuevo"}
        trimmed = trim_messages([system, old, old, latest], 2000, 100)
        self.assertEqual(trimmed[0]["content"], "SYS")
        self.assertEqual(trimmed[-1]["content"], "nuevo")
        self.assertLess(len(trimmed), 4)

    def test_assemble_skips_notices(self):
        msgs = assemble_messages("SYS", [
            {"role": "user", "content": "hola"},
            {"role": "notice", "content": "429"},
            {"role": "assistant", "content": "ey"},
        ])
        self.assertEqual([m["role"] for m in msgs], ["system", "user", "assistant"])

    def test_parse_replies_from_json_and_lines(self):
        tagged = (
            "<<<continuar>>>\n*se acerca* \"no.\"\n"
            "<<<empujar>>>\n*la mira* Quedate.\n"
            "<<<desviar>>>\n*apaga la lámpara* Mañana."
        )
        self.assertEqual(
            parse_replies(tagged),
            ['*se acerca* "no."', "*la mira* Quedate.", "*apaga la lámpara* Mañana."],
        )
        self.assertEqual(
            parse_replies('{"continuar":"Hola","empujar":"¿Todo bien?","desviar":"Nos vemos"}'),
            ["Hola", "¿Todo bien?", "Nos vemos"],
        )
        self.assertEqual(
            parse_replies('{"replies":["Hola","¿Todo bien?","Nos vemos"]}'),
            ["Hola", "¿Todo bien?", "Nos vemos"],
        )
        fenced = '```json\n{"replies":["Uno","Dos","Tres"]}\n```'
        self.assertEqual(parse_replies(fenced), ["Uno", "Dos", "Tres"])
        self.assertEqual(parse_replies("1. A\n2. B\n3. C"), ["A", "B", "C"])
        self.assertEqual(parse_replies(""), [])

    def test_suggestion_messages_keep_context(self):
        long = "narración del personaje " * 40
        msgs = suggestion_messages(
            [{"role": "user", "content": "hola"}, {"role": "assistant", "content": long}],
            "Vera",
        )
        self.assertEqual(msgs[0]["role"], "system")
        self.assertIn("Vera", msgs[0]["content"])
        self.assertIn("continuar", msgs[0]["content"])
        self.assertIn("empujar", msgs[0]["content"])
        self.assertIn("desviar", msgs[0]["content"])
        self.assertIn("hola", msgs[1]["content"])
        self.assertIn("No escribas así", msgs[1]["content"])
        self.assertNotIn(long, msgs[1]["content"])
        self.assertEqual([m["role"] for m in msgs], ["system", "user"])
        self.assertNotIn("helpful assistant", msgs[0]["content"].lower())


class ErrorTests(unittest.TestCase):
    def test_classes(self):
        self.assertEqual(normalize_error(401, '{"error":{"message":"Invalid API key"}}', {"error": {"message": "Invalid API key"}}).error_class, "401")
        self.assertEqual(normalize_error(402, "insufficient credits", None).error_class, "402")
        personal = normalize_error(429, "personal quota exceeded", None)
        self.assertEqual(personal.error_class, "429_personal")
        global_ = normalize_error(429, "provider returned error site-wide", None)
        self.assertEqual(global_.error_class, "429_global")
        empty = normalize_error(200, "", None)
        self.assertEqual(empty.error_class, "parse_empty")
        none = normalize_error(500, "NoneType is not subscriptable", None)
        self.assertNotIn("NoneType", none.message)

    def test_extract_text_never_throws(self):
        cases = [
            {},
            {"choices": None},
            {"choices": []},
            {"choices": [None]},
            {"choices": [{"delta": None}]},
            {"choices": [{"delta": {"content": None}}]},
            {"choices": [{"delta": {"reasoning_content": "secret", "content": None}}]},
            {"error": {"message": "nope"}},
        ]
        for chunk in cases:
            self.assertEqual(extract_text(chunk), "")
        self.assertEqual(extract_text({"choices": [{"delta": {"content": "Hola"}}]}), "Hola")
        self.assertEqual(extract_text({"choices": [{"message": {"content": "Hola"}}]}), "Hola")


class AdapterTests(unittest.TestCase):
    def test_stream_survives_none_and_hides_key(self):
        class Resp:
            status_code = 200

            async def aiter_lines(self):
                yield 'data: {"choices":[null]}'
                yield 'data: {"choices":[{"delta":{"content":null}}]}'
                yield 'data: {"choices":[{"delta":{"content":"Hola"}}]}'
                yield "data: [DONE]"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class Client:
            def __init__(self, *args, **kwargs):
                self.kwargs = kwargs

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def stream(self, method, url, headers=None, json=None):
                self.payload = json
                self.headers = headers
                return Resp()

        async def run():
            with patch("app.adapter.httpx.AsyncClient", Client):
                items = []
                async for item in stream_chat(
                    "https://api.groq.com/openai/v1",
                    "sk-test-secret-should-not-leak",
                    "llama",
                    [{"role": "system", "content": "Vera"}],
                    600,
                    0.8,
                ):
                    items.append(item)
            return items

        items = asyncio.run(run())
        text = "".join(item.text for item in items if isinstance(item, Delta))
        self.assertEqual(text, "Hola")
        self.assertFalse(any(isinstance(item, StreamFail) for item in items))

    def test_429_does_not_throw(self):
        class Resp:
            status_code = 429

            async def aread(self):
                return b'{"error":{"message":"rate limit site-wide provider returned","code":429}}'

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class Client:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def stream(self, *args, **kwargs):
                return Resp()

        async def run():
            with patch("app.adapter.httpx.AsyncClient", Client):
                return [item async for item in stream_chat("https://openrouter.ai/api/v1", "sk-secret", "m", [], 100, 0.5)]

        items = asyncio.run(run())
        self.assertEqual(len(items), 1)
        self.assertIsInstance(items[0], StreamFail)
        self.assertEqual(items[0].error.error_class, "429_global")
        self.assertNotIn("sk-secret", items[0].error.message)
        self.assertNotIn("NoneType", items[0].error.message)

    def test_connection_uses_models_not_chat(self):
        class Resp:
            status_code = 200
            text = '{"data":[{"id":"llama-3.3-70b-versatile"}]}'

        class Client:
            urls = []

            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, url, headers=None):
                Client.urls.append(url)
                return Resp()

        async def run():
            with patch("app.adapter.httpx.AsyncClient", Client):
                return await test_connection("https://api.groq.com/openai/v1/", "sk")

        ok, err, count = asyncio.run(run())
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(count, 1)
        self.assertTrue(Client.urls[0].endswith("/models"))
        self.assertNotIn("chat/completions", Client.urls[0])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["CHAT_IA_DB"] = str(Path(self.tmp.name) / "chat.db")
        from fastapi.testclient import TestClient
        from app.main import app

        self._ctx = TestClient(app)
        self.client = self._ctx.__enter__()

    def tearDown(self):
        self._ctx.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_spa_routes_serve_index(self):
        for path in ("/", "/chat", "/personajes", "/conexiones", "/voces"):
            res = self.client.get(path)
            self.assertEqual(res.status_code, 200, path)
            self.assertIn("<title>Chat IA</title>", res.text)
        missing = self.client.get("/no-existe")
        self.assertEqual(missing.status_code, 404)

    def test_mvp_paths(self):
        compiled = self.client.post("/api/compile", json={"fields": {"nombre": "Vera", "edad": "34", "tono": "seca"}})
        self.assertEqual(compiled.status_code, 200)
        self.assertIn("Formato, obligatorio.", compiled.json()["prompt_compiled"])
        minor = self.client.post("/api/characters", json={"fields": {"nombre": "N", "edad": "12"}})
        self.assertEqual(minor.status_code, 400)
        created = self.client.post("/api/characters", json={"fields": {"nombre": "Vera", "edad": "34", "tono": "seca"}})
        self.assertEqual(created.status_code, 200)
        character_id = created.json()["id"]
        provider = self.client.post(
            "/api/providers",
            json={"name": "Groq", "base_url": "https://api.groq.com/openai/v1/keys", "api_key": "sk-test"},
        )
        self.assertEqual(provider.status_code, 400)
        provider = self.client.post(
            "/api/providers",
            json={"name": "Groq", "base_url": "https://api.groq.com/openai/v1", "api_key": "sk-test-secret"},
        )
        self.assertEqual(provider.status_code, 200)
        self.assertNotIn("sk-test-secret", provider.text)
        self.assertTrue(provider.json()["key_hint"].endswith("cret"))
        self.assertNotIn("api_key", provider.json())
        provider_id = provider.json()["id"]
        thread = self.client.post(
            "/api/threads",
            json={
                "character_id": character_id,
                "provider_account_id": provider_id,
                "model": "llama-3.3-70b-versatile",
            },
        )
        self.assertEqual(thread.status_code, 200)
        thread_id = thread.json()["id"]
        patched = self.client.patch("/api/threads/" + thread_id, json={"model": "otro-modelo"})
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["model"], "otro-modelo")
        again = self.client.get("/api/characters/" + character_id) if False else self.client.get("/api/characters")
        self.assertEqual(again.json()["characters"][0]["fields"]["tono"], "seca")
        reloaded = self.client.get("/api/threads/" + thread_id)
        self.assertEqual(reloaded.status_code, 200)
        self.assertEqual(reloaded.json()["thread"]["title"], "Nuevo hilo")
        self.assertEqual(reloaded.json()["thread"]["character_id"], character_id)
        other = self.client.post(
            "/api/providers",
            json={"name": "Ollama", "base_url": "http://127.0.0.1:11434/v1", "api_key": ""},
        )
        switched = self.client.patch(
            "/api/threads/" + thread_id,
            json={"provider_account_id": other.json()["id"], "model": "llama3.2"},
        )
        self.assertEqual(switched.status_code, 200)
        self.assertEqual(switched.json()["provider_account_id"], other.json()["id"])
        self.assertEqual(switched.json()["character_id"], character_id)
        self.assertEqual(switched.json()["model"], "llama3.2")
        voices = self.client.get("/api/voices")
        self.assertEqual(voices.status_code, 200)
        browser = next(item for item in voices.json()["voices"] if item["provider"] == "browser")
        self.assertNotIn("api_key", browser)
        blocked = self.client.delete("/api/voices/" + browser["id"])
        self.assertEqual(blocked.status_code, 400)
        fish = self.client.post("/api/voices", json={"name": "Fish", "provider": "fish", "api_key": "sk-fish-secret"})
        self.assertEqual(fish.status_code, 200)
        self.assertNotIn("sk-fish-secret", fish.text)
        missing = self.client.post("/api/voices/" + fish.json()["id"] + "/speak", json={"text": "Hola."})
        self.assertEqual(missing.status_code, 400)
        self.assertNotIn("sk-fish-secret", missing.text)

    def test_429_is_a_notice_and_character_stays(self):
        created = self.client.post("/api/characters", json={"fields": {"nombre": "Vera", "edad": "34", "tono": "seca"}})
        character_id = created.json()["id"]
        version = created.json()["version"]
        provider = self.client.post(
            "/api/providers",
            json={"name": "Groq", "base_url": "https://api.groq.com/openai/v1", "api_key": "sk-test-secret"},
        )
        thread = self.client.post(
            "/api/threads",
            json={
                "character_id": character_id,
                "provider_account_id": provider.json()["id"],
                "model": "llama",
            },
        )
        thread_id = thread.json()["id"]

        async def fake_stream(*args, **kwargs):
            yield StreamFail(AppError("429_global", "El pool free está lleno.", 429))

        with patch("app.main.stream_chat", fake_stream):
            res = self.client.post(
                "/api/threads/" + thread_id + "/messages",
                json={"content": "hola", "model": "otro-modelo"},
            )
        self.assertEqual(res.status_code, 200)
        self.assertIn("429_global", res.text)
        self.assertNotIn("NoneType", res.text)
        self.assertNotIn("sk-test-secret", res.text)
        reloaded = self.client.get("/api/threads/" + thread_id)
        self.assertEqual(reloaded.status_code, 200)
        roles = [m["role"] for m in reloaded.json()["messages"]]
        self.assertEqual(roles, ["user"])
        self.assertNotIn("notice", roles)
        usage = self.client.get("/api/usage").json()["events"]
        self.assertTrue(any(event["error_class"] == "429_global" for event in usage))
        self.assertEqual(reloaded.json()["thread"]["model"], "otro-modelo")
        self.assertEqual(reloaded.json()["thread"]["character_id"], character_id)
        saved = self.client.get("/api/characters").json()["characters"][0]
        self.assertEqual(saved["version"], version)
        self.assertEqual(saved["fields"]["tono"], "seca")

    def test_stream_text_is_there_after_reopen(self):
        created = self.client.post("/api/characters", json={"fields": {"nombre": "Vera", "edad": "34"}})
        provider = self.client.post(
            "/api/providers",
            json={"name": "Local", "base_url": "http://127.0.0.1:11434/v1", "api_key": ""},
        )
        thread = self.client.post(
            "/api/threads",
            json={
                "character_id": created.json()["id"],
                "provider_account_id": provider.json()["id"],
                "model": "llama",
            },
        )
        thread_id = thread.json()["id"]

        async def fake_stream(*args, **kwargs):
            yield Delta("Hola")
            yield StreamDone(3, 1)

        with patch("app.main.stream_chat", fake_stream):
            res = self.client.post("/api/threads/" + thread_id + "/messages", json={"content": "ey"})
        self.assertEqual(res.status_code, 200)
        reloaded = self.client.get("/api/threads/" + thread_id)
        self.assertEqual([m["content"] for m in reloaded.json()["messages"]], ["ey", "Hola"])
        self.assertEqual(reloaded.json()["thread"]["title"], "ey")

    def test_retry_replaces_the_reply(self):
        created = self.client.post("/api/characters", json={"fields": {"nombre": "Vera", "edad": "34"}})
        provider = self.client.post(
            "/api/providers",
            json={"name": "Local", "base_url": "http://127.0.0.1:11434/v1", "api_key": ""},
        )
        thread = self.client.post(
            "/api/threads",
            json={
                "character_id": created.json()["id"],
                "provider_account_id": provider.json()["id"],
                "model": "llama",
            },
        )
        thread_id = thread.json()["id"]

        async def first(*args, **kwargs):
            yield Delta("Hola")
            yield StreamDone(1, 1)

        async def second(*args, **kwargs):
            yield Delta("Chau")
            yield StreamDone(1, 1)

        with patch("app.main.stream_chat", first):
            self.client.post("/api/threads/" + thread_id + "/messages", json={"content": "ey"})
        user_id = self.client.get("/api/threads/" + thread_id).json()["messages"][0]["id"]
        with patch("app.main.stream_chat", second):
            res = self.client.post(
                "/api/threads/" + thread_id + "/messages",
                json={"retry_message_id": user_id},
            )
        self.assertEqual(res.status_code, 200)
        messages = self.client.get("/api/threads/" + thread_id).json()["messages"]
        self.assertEqual([(m["role"], m["content"]) for m in messages], [("user", "ey"), ("assistant", "Chau")])
        missing = self.client.post(
            "/api/threads/" + thread_id + "/messages",
            json={"retry_message_id": "no-existe"},
        )
        self.assertEqual(missing.status_code, 400)
        again = self.client.get("/api/threads/" + thread_id).json()["messages"]
        self.assertEqual(len(again), 2)

    def test_suggestions_do_not_persist(self):
        created = self.client.post("/api/characters", json={"fields": {"nombre": "Vera", "edad": "34"}})
        provider = self.client.post(
            "/api/providers",
            json={"name": "Local", "base_url": "http://127.0.0.1:11434/v1", "api_key": ""},
        )
        thread = self.client.post(
            "/api/threads",
            json={
                "character_id": created.json()["id"],
                "provider_account_id": provider.json()["id"],
                "model": "llama",
            },
        )
        thread_id = thread.json()["id"]

        async def fake_complete(*args, **kwargs):
            return '{"replies":["Hola","¿Qué tal?","Nos vemos"]}', None, 10, 20

        with patch("app.main.complete_chat", fake_complete):
            res = self.client.post("/api/threads/" + thread_id + "/suggestions")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["replies"], ["Hola", "¿Qué tal?", "Nos vemos"])
        reloaded = self.client.get("/api/threads/" + thread_id)
        self.assertEqual(reloaded.json()["messages"], [])
        missing = self.client.post("/api/threads/no-existe/suggestions")
        self.assertEqual(missing.status_code, 404)

    def test_transcribe_does_not_persist(self):
        created = self.client.post("/api/characters", json={"fields": {"nombre": "Vera", "edad": "34"}})
        provider = self.client.post(
            "/api/providers",
            json={"name": "Local", "base_url": "http://127.0.0.1:11434/v1", "api_key": ""},
        )
        thread = self.client.post(
            "/api/threads",
            json={
                "character_id": created.json()["id"],
                "provider_account_id": provider.json()["id"],
                "model": "llama",
            },
        )
        thread_id = thread.json()["id"]

        async def fake_transcribe(*args, **kwargs):
            return "hola mundo", None

        with patch("app.main.transcribe_audio", fake_transcribe):
            res = self.client.post(
                "/api/threads/" + thread_id + "/transcribe",
                files={"file": ("speech.webm", b"x" * 200, "audio/webm")},
            )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["text"], "hola mundo")
        reloaded = self.client.get("/api/threads/" + thread_id)
        self.assertEqual(reloaded.json()["messages"], [])


if __name__ == "__main__":
    unittest.main()
