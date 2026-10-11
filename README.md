# Chat IA

Cliente local: personaje, proveedores OpenAI-compatible, voz y avatar VRM.

## Instalar (una vez)

### Windows (PowerShell)

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt -r requirements-dev.txt
.venv\Scripts\python -m playwright install chromium
```

### Linux / macOS

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m playwright install chromium
```

`requirements-dev.txt` y Playwright solo hacen falta para los tests de navegador.

## Arrancar

- Windows: doble clic en `start.bat`, o `.venv\Scripts\python run.py`
- Linux / macOS: `.venv/bin/python run.py`

Abrí http://127.0.0.1:8765

## Parar

En la terminal, Ctrl+C. Si quedó colgado:

```powershell
Get-NetTCPConnection -LocalPort 8765 | ForEach-Object { Stop-Process -Id $_.OwningProcess }
```

```bash
fuser -k 8765/tcp
```

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests -v
```

Los tests de navegador prueban con Chrome, después Edge y por último el Chromium de Playwright.

## Voz

- **Navegador**: usa las voces del sistema (Web Speech API). Si el navegador no ve ninguna, el server lee en voz alta:
  - Windows: voz SAPI en español (por ejemplo, *Microsoft Sabina*). Si no hay, agregala en Configuración > Hora e idioma > Voz.
  - Linux: `spd-say` (instalá `speech-dispatcher` y `espeak-ng`).
- **Fish Audio**: necesita API key y el `reference_id` de la voz.
- **Dictado (mic)**: usa el endpoint Whisper de la conexión del hilo (por ejemplo, Groq u OpenAI).

## Assets

- `assets/avatars/` — modelos VRM (`atlas.vrm` por defecto)
- `assets/animations/` — clips Mixamo (`.fbx`)
- El avatar carga three.js desde jsDelivr: necesita internet.

La base SQLite y las API keys quedan en `data/` (no se sube).
