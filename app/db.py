import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from app.personality import coerce_fields, compile_prompt

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "chat.db"


def db_path() -> Path:
    return Path(os.environ.get("CHAT_IA_DB", str(DEFAULT_DB)))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


@contextmanager
def connect():
    path = db_path()
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
    try:
        os.chmod(path, 0o600)
        os.chmod(path.parent, 0o700)
    except OSError:
        pass


def _add_column(conn: sqlite3.Connection, table: str, name: str, ddl: str) -> None:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if name not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def init() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS provider_accounts (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              api_key TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS characters (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              fields_json TEXT NOT NULL,
              prompt_compiled TEXT NOT NULL,
              max_tokens INTEGER NOT NULL,
              temperature REAL NOT NULL,
              version INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS threads (
              id TEXT PRIMARY KEY,
              character_id TEXT,
              provider_account_id TEXT,
              model TEXT NOT NULL DEFAULT '',
              context_tokens INTEGER NOT NULL DEFAULT 8192,
              title TEXT NOT NULL DEFAULT 'Nuevo hilo',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_events (
              id TEXT PRIMARY KEY,
              thread_id TEXT,
              model TEXT,
              tokens_in INTEGER,
              tokens_out INTEGER,
              http_status INTEGER,
              error_class TEXT,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
            CREATE TABLE IF NOT EXISTS voice_accounts (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              provider TEXT NOT NULL,
              api_key TEXT NOT NULL DEFAULT '',
              voice_id TEXT NOT NULL DEFAULT '',
              model TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
        _add_column(conn, "threads", "voice_account_id", "TEXT")
        _add_column(conn, "threads", "speak", "INTEGER NOT NULL DEFAULT 0")


def _row(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return dict(row)


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 4:
        return "••••"
    return "••••" + key[-4:]


def public_provider(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "base_url": row["base_url"],
        "has_key": bool(row.get("api_key")),
        "key_hint": mask_key(row.get("api_key") or ""),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def public_character(row: dict) -> dict:
    fields = coerce_fields(json.loads(row["fields_json"]))
    return {
        "id": row["id"],
        "name": row["name"],
        "fields": fields,
        "prompt_compiled": row["prompt_compiled"],
        "max_tokens": row["max_tokens"],
        "temperature": row["temperature"],
        "version": row["version"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_providers() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM provider_accounts ORDER BY updated_at DESC"
        ).fetchall()
    return [public_provider(dict(r)) for r in rows]


def get_provider(provider_id: str, secret: bool = False) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM provider_accounts WHERE id = ?",
            (provider_id,),
        ).fetchone()
    data = _row(row)
    if data is None:
        return None
    if secret:
        return data
    return public_provider(data)


def create_provider(name: str, base_url: str, api_key: str) -> dict:
    pid = new_id()
    ts = now()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO provider_accounts (id, name, base_url, api_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (pid, name, base_url, api_key, ts, ts),
        )
    return get_provider(pid)


def update_provider(provider_id: str, name: str, base_url: str, api_key: str) -> dict | None:
    current = get_provider(provider_id, secret=True)
    if current is None:
        return None
    with connect() as conn:
        conn.execute(
            """
            UPDATE provider_accounts
            SET name = ?, base_url = ?, api_key = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, base_url, api_key, now(), provider_id),
        )
    return get_provider(provider_id)


def delete_provider(provider_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM provider_accounts WHERE id = ?", (provider_id,))
        return cur.rowcount > 0


def list_characters() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM characters ORDER BY updated_at DESC").fetchall()
    return [public_character(dict(r)) for r in rows]


def get_character(character_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM characters WHERE id = ?", (character_id,)).fetchone()
    data = _row(row)
    if data is None:
        return None
    return public_character(data)


def save_character(fields: dict, character_id: str | None = None) -> dict:
    clean = coerce_fields(fields)
    prompt = compile_prompt(clean)
    name = clean["nombre"] or "Sin nombre"
    ts = now()
    payload = json.dumps(clean, ensure_ascii=False)
    if character_id:
        current = get_character(character_id)
        if current is None:
            raise KeyError(character_id)
        version = int(current["version"]) + 1
        with connect() as conn:
            conn.execute(
                """
                UPDATE characters
                SET name = ?, fields_json = ?, prompt_compiled = ?, max_tokens = ?,
                    temperature = ?, version = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    name,
                    payload,
                    prompt,
                    clean["max_tokens"],
                    clean["temperatura"],
                    version,
                    ts,
                    character_id,
                ),
            )
        return get_character(character_id)
    cid = new_id()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO characters (
              id, name, fields_json, prompt_compiled, max_tokens, temperature, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (cid, name, payload, prompt, clean["max_tokens"], clean["temperatura"], ts, ts),
        )
    return get_character(cid)


def delete_character(character_id: str) -> bool:
    with connect() as conn:
        used = conn.execute(
            "SELECT 1 FROM threads WHERE character_id = ? LIMIT 1",
            (character_id,),
        ).fetchone()
        if used:
            return False
        cur = conn.execute("DELETE FROM characters WHERE id = ?", (character_id,))
        return cur.rowcount > 0


def character_in_use(character_id: str) -> bool:
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM threads WHERE character_id = ? LIMIT 1",
            (character_id,),
        ).fetchone()
    return row is not None


def list_threads() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT t.*, c.name AS character_name, p.name AS provider_name
            FROM threads t
            LEFT JOIN characters c ON c.id = t.character_id
            LEFT JOIN provider_accounts p ON p.id = t.provider_account_id
            ORDER BY t.updated_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def get_thread(thread_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT t.*, c.name AS character_name, p.name AS provider_name
            FROM threads t
            LEFT JOIN characters c ON c.id = t.character_id
            LEFT JOIN provider_accounts p ON p.id = t.provider_account_id
            WHERE t.id = ?
            """,
            (thread_id,),
        ).fetchone()
    return _row(row)


def create_thread(character_id: str, provider_id: str, model: str, context_tokens: int) -> dict:
    tid = new_id()
    ts = now()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO threads (
              id, character_id, provider_account_id, model, context_tokens, title, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'Nuevo hilo', ?, ?)
            """,
            (tid, character_id, provider_id, model, context_tokens, ts, ts),
        )
    return get_thread(tid)


def update_thread(
    thread_id: str,
    model: str | None = None,
    context_tokens: int | None = None,
    provider_account_id: str | None = None,
    title: str | None = None,
    voice_account_id: str | None = None,
    speak: int | None = None,
) -> dict | None:
    current = get_thread(thread_id)
    if current is None:
        return None
    with connect() as conn:
        conn.execute(
            """
            UPDATE threads
            SET model = ?, context_tokens = ?, provider_account_id = ?, title = ?,
                voice_account_id = ?, speak = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                current["model"] if model is None else model,
                current["context_tokens"] if context_tokens is None else context_tokens,
                current["provider_account_id"] if provider_account_id is None else provider_account_id,
                current["title"] if title is None else title,
                current.get("voice_account_id") if voice_account_id is None else voice_account_id,
                int(current.get("speak") or 0) if speak is None else (1 if speak else 0),
                now(),
                thread_id,
            ),
        )
    return get_thread(thread_id)


def delete_thread(thread_id: str) -> bool:
    with connect() as conn:
        conn.execute("DELETE FROM messages WHERE thread_id = ?", (thread_id,))
        cur = conn.execute("DELETE FROM threads WHERE id = ?", (thread_id,))
        return cur.rowcount > 0


def list_messages(thread_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, thread_id, role, content, created_at
            FROM messages
            WHERE thread_id = ?
            ORDER BY created_at ASC, rowid ASC
            """,
            (thread_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def user_message(thread_id: str, message_id: str) -> dict | None:
    for msg in list_messages(thread_id):
        if msg["id"] == message_id and msg["role"] == "user":
            return msg
    return None


def truncate_after(thread_id: str, message_id: str) -> None:
    messages = list_messages(thread_id)
    idx = next((i for i, msg in enumerate(messages) if msg["id"] == message_id), -1)
    if idx < 0:
        return
    later = [msg["id"] for msg in messages[idx + 1 :]]
    if not later:
        return
    with connect() as conn:
        conn.executemany(
            "DELETE FROM messages WHERE thread_id = ? AND id = ?",
            [(thread_id, mid) for mid in later],
        )


def add_message(thread_id: str, role: str, content: str) -> dict:
    mid = new_id()
    ts = now()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO messages (id, thread_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (mid, thread_id, role, content, ts),
        )
        conn.execute("UPDATE threads SET updated_at = ? WHERE id = ?", (ts, thread_id))
    return {"id": mid, "thread_id": thread_id, "role": role, "content": content, "created_at": ts}


def add_usage(
    thread_id: str | None,
    model: str,
    tokens_in: int | None,
    tokens_out: int | None,
    http_status: int | None,
    error_class: str | None,
) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO usage_events (
              id, thread_id, model, tokens_in, tokens_out, http_status, error_class, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (new_id(), thread_id, model, tokens_in, tokens_out, http_status, error_class or "", now()),
        )


def public_voice(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "provider": row["provider"],
        "has_key": bool(row.get("api_key")),
        "key_hint": mask_key(row.get("api_key") or ""),
        "voice_id": row.get("voice_id") or "",
        "model": row.get("model") or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_voices() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM voice_accounts ORDER BY created_at ASC").fetchall()
    return [public_voice(dict(r)) for r in rows]


def get_voice(voice_id: str, secret: bool = False) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM voice_accounts WHERE id = ?", (voice_id,)).fetchone()
    data = _row(row)
    if data is None:
        return None
    if secret:
        return data
    return public_voice(data)


def ensure_browser_voice() -> dict:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM voice_accounts WHERE provider = 'browser' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
    if row:
        return public_voice(dict(row))
    return create_voice("Navegador", "browser", "", "", "")


def create_voice(name: str, provider: str, api_key: str, voice_ref: str, model: str) -> dict:
    vid = new_id()
    ts = now()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO voice_accounts (id, name, provider, api_key, voice_id, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (vid, name, provider, api_key, voice_ref, model, ts, ts),
        )
    return get_voice(vid)


def update_voice(voice_id: str, name: str, provider: str, api_key: str, voice_ref: str, model: str) -> dict | None:
    if get_voice(voice_id) is None:
        return None
    with connect() as conn:
        conn.execute(
            """
            UPDATE voice_accounts
            SET name = ?, provider = ?, api_key = ?, voice_id = ?, model = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, provider, api_key, voice_ref, model, now(), voice_id),
        )
    return get_voice(voice_id)


def delete_voice(voice_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM voice_accounts WHERE id = ?", (voice_id,))
        return cur.rowcount > 0


def list_usage(limit: int = 12) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, thread_id, model, tokens_in, tokens_out, http_status, error_class, created_at
            FROM usage_events
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]
