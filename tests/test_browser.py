import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)

INIT_JS = """
(() => {
  window.__mic = { getUserMediaCalls: 0, recorder: null };
  const md = navigator.mediaDevices || {};
  md.getUserMedia = async () => {
    window.__mic.getUserMediaCalls += 1;
    return { getTracks: () => [{ stop() {} }] };
  };
  navigator.mediaDevices = md;
  window.MediaRecorder = class FakeRec {
    static isTypeSupported() { return true; }
    constructor(stream, opts) {
      this.stream = stream;
      this.mimeType = (opts && opts.mimeType) || "audio/webm";
      this.ondataavailable = null;
      this.onstop = null;
      window.__mic.recorder = this;
    }
    start() {}
    stop() {
      const data = new Blob([new Uint8Array(2048)], { type: this.mimeType });
      if (this.ondataavailable) this.ondataavailable({ data });
      if (this.onstop) this.onstop();
    }
  };
})();
"""


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class BrowserMicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise unittest.SkipTest("playwright no está instalado") from exc

        cls._tmp = tempfile.TemporaryDirectory()
        os.environ["CHAT_IA_DB"] = str(Path(cls._tmp.name) / "chat.db")
        cls.port = _free_port()
        cls.base = f"http://127.0.0.1:{cls.port}"

        import uvicorn
        from app.main import app

        cls._server = threading.Thread(
            target=lambda: uvicorn.run(app, host="127.0.0.1", port=cls.port, log_level="error"),
            daemon=True,
        )
        cls._server.start()
        cls._wait_health()

        import httpx

        char = httpx.post(
            cls.base + "/api/characters",
            json={"fields": {"nombre": "Vera", "edad": "34"}},
        )
        char.raise_for_status()
        prov = httpx.post(
            cls.base + "/api/providers",
            json={"name": "Local", "base_url": "http://127.0.0.1:11434/v1", "api_key": ""},
        )
        prov.raise_for_status()
        thread = httpx.post(
            cls.base + "/api/threads",
            json={
                "character_id": char.json()["id"],
                "provider_account_id": prov.json()["id"],
                "model": "llama",
            },
        )
        thread.raise_for_status()
        cls.thread_id = thread.json()["id"]
        cls._pw = sync_playwright().start()
        cls._browser = None
        for channel in ("chrome", "msedge", None):
            try:
                cls._browser = cls._pw.chromium.launch(channel=channel, headless=True)
                break
            except Exception:
                continue
        if cls._browser is None:
            cls._pw.stop()
            raise unittest.SkipTest("no se pudo abrir Chrome, Edge ni Chromium")

    @classmethod
    def _wait_health(cls):
        import httpx

        for _ in range(50):
            try:
                res = httpx.get(cls.base + "/api/health", timeout=0.3)
                if res.status_code == 200:
                    return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("el server de prueba no arrancó")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "_browser", None):
            cls._browser.close()
        if getattr(cls, "_pw", None):
            cls._pw.stop()
        if getattr(cls, "_tmp", None):
            cls._tmp.cleanup()

    def setUp(self):
        self.context = self._browser.new_context()
        self.context.add_init_script(INIT_JS)
        self.page = self.context.new_page()
        self.page.goto(self.base + "/chat/" + self.thread_id, wait_until="networkidle")
        self.page.wait_for_selector("#mic:not([disabled])")

    def tearDown(self):
        self.context.close()

    def test_mic_stays_on_until_clicked_again(self):
        self.page.route(
            "**/transcribe",
            lambda route: route.fulfill(status=200, content_type="application/json", body='{"text":"hola"}'),
        )
        mic = self.page.locator("#mic")
        mic.click()
        self.page.wait_for_function("() => window.__mic.getUserMediaCalls > 0 && document.getElementById('mic').classList.contains('on')")
        self.page.wait_for_timeout(400)
        self.assertTrue(mic.evaluate("el => el.classList.contains('on')"))
        mic.click()
        self.page.wait_for_function("() => !document.getElementById('mic').classList.contains('on')")

    def test_mic_writes_punctuated_text(self):
        self.page.route(
            "**/transcribe",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body='{"text":"como estas"}',
            ),
        )
        self.page.locator("#mic").click()
        self.page.wait_for_function("() => document.getElementById('mic').classList.contains('on')")
        self.page.locator("#mic").click()
        self.page.wait_for_function("() => document.getElementById('draft').value.includes('est')")
        value = self.page.locator("#draft").input_value()
        self.assertIn("¿", value)
        self.assertIn("?", value)

    def test_punctuate_speech_helpers(self):
        self.assertEqual(
            self.page.evaluate("() => punctuateSpeech('como estas')"),
            "¿Como estas?",
        )
        self.assertEqual(
            self.page.evaluate("() => punctuateSpeech('hola che')"),
            "Hola che.",
        )
        self.assertEqual(
            self.page.evaluate("() => punctuateSpeech('basta ya')"),
            "¡Basta ya!",
        )

    def test_suggest_menu_width_and_last_item(self):
        self.page.route(
            "**/api/threads/*/suggestions",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body='{"replies":["primera opción bastante larga para ver el ancho del menú","segunda opción","tercera no cortada"]}',
            ),
        )
        self.page.locator("#suggest").click()
        self.page.wait_for_selector("#suggest-menu:not(.hidden) .suggest-item")
        items = self.page.locator("#suggest-menu .suggest-item")
        self.assertEqual(items.count(), 3)
        self.assertIn("tercera no cortada", items.nth(2).inner_text())
        menu = self.page.locator("#suggest-menu").bounding_box()
        composer = self.page.locator("#composer").bounding_box()
        self.assertIsNotNone(menu)
        self.assertIsNotNone(composer)
        self.assertGreater(menu["width"], composer["width"] * 0.7)
        last = items.nth(2).bounding_box()
        self.assertLessEqual(last["y"] + last["height"], menu["y"] + menu["height"] + 2)
        items.nth(2).click()
        self.assertEqual(self.page.locator("#draft").input_value(), "tercera no cortada")


if __name__ == "__main__":
    unittest.main()

