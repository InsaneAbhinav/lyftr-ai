import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Generator, Optional

from config import settings


def _resolve_sqlite_path(database_url: str) -> str:
    if database_url.startswith("sqlite:////"):
        return "/" + database_url[len("sqlite:////"):]
    if database_url.startswith("sqlite:///"):
        return database_url[len("sqlite:///"):]
    return database_url


DB_PATH = _resolve_sqlite_path(settings.database_url)


@contextmanager
def get_connection() -> Generator[sqlite3.Connection, None, None]:
    parent = os.path.dirname(DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 0,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT NOT NULL
            )
        """)
        # Add user_id column to existing tables if missing (migration)
        try:
            conn.execute("ALTER TABLE messages ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)")
        conn.commit()


# â”€â”€ Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def create_user(email: str, password_hash: str) -> Optional[dict]:
    now = datetime.now(timezone.utc).isoformat()
    try:
        with get_connection() as conn:
            cur = conn.execute(
                "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
                (email, password_hash, now),
            )
            conn.commit()
            return {"id": cur.lastrowid, "email": email}
    except sqlite3.IntegrityError:
        return None  # username taken


def get_user_by_email(email: str) -> Optional[dict]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash FROM users WHERE email = ?",
            (email,),
        ).fetchone()
    if row is None:
        return None
    return dict(row)


# â”€â”€ Messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def save_turn(
    session_id: str,
    user_message: str,
    assistant_reply: str,
    metadata: dict[str, Any],
    user_id: int = 0,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    metadata_json = json.dumps(metadata)
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO messages (user_id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, session_id, "user", user_message, None, now),
        )
        conn.execute(
            "INSERT INTO messages (user_id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, session_id, "assistant", assistant_reply, metadata_json, now),
        )
        conn.commit()


def get_all_sessions(user_id: int) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT
                session_id,
                MAX(created_at) as last_at,
                COUNT(*) as msg_count,
                (SELECT content FROM messages m2
                 WHERE m2.session_id = m.session_id AND m2.role = 'user' AND m2.user_id = ?
                 ORDER BY m2.id DESC LIMIT 1) as last_user_msg
            FROM messages m
            WHERE m.user_id = ?
            GROUP BY session_id
            ORDER BY last_at DESC
            """,
            (user_id, user_id),
        ).fetchall()
    seen = set()
    result = []
    for row in rows:
        sid = row["session_id"]
        if sid in seen:
            continue
        seen.add(sid)
        result.append({
            "session_id": sid,
            "last_at": row["last_at"],
            "msg_count": max(1, row["msg_count"] // 2),
            "preview": (row["last_user_msg"] or "")[:60],
        })
    return result


def get_session_messages(session_id: str, user_id: int = 0) -> Optional[list[dict[str, Any]]]:
    with get_connection() as conn:
        exists_row = conn.execute(
            "SELECT 1 FROM messages WHERE session_id = ? AND user_id = ? LIMIT 1",
            (session_id, user_id),
        ).fetchone()
        if exists_row is None:
            return None
        rows = conn.execute(
            """
            SELECT role, content, metadata
            FROM messages
            WHERE session_id = ? AND user_id = ? AND role != 'system'
            ORDER BY id ASC
            """,
            (session_id, user_id),
        ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        item: dict[str, Any] = {"role": row["role"], "content": row["content"]}
        if row["metadata"] is not None:
            item["metadata"] = json.loads(row["metadata"])
        result.append(item)
    return result


def delete_session(session_id: str, user_id: int) -> bool:
    with get_connection() as conn:
        cur = conn.execute(
            "DELETE FROM messages WHERE session_id = ? AND user_id = ?",
            (session_id, user_id),
        )
        conn.commit()
    return cur.rowcount > 0

