# Chat IA

Cliente local: personaje, proveedores OpenAI-compatible, voz y avatar VRM.

## Arrancar

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run.py
```

Abrí http://127.0.0.1:8765

## Parar

En la terminal, Ctrl+C. O:

```bash
fuser -k 8765/tcp
```

## Assets

- `assets/avatars/` — modelos VRM (`atlas.vrm` por defecto)
- `assets/animations/` — clips Mixamo (`.fbx`)

La base SQLite y las API keys quedan en `data/` (no se sube).
