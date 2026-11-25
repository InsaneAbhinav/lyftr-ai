# Lyftr AI - LLM Chatbot with Key Failover and Response Caching

A full-stack LLM chatbot built with FastAPI, LiteLLM, SQLite, React (Vite), and Docker. It supports automatic multi-provider key failover (`groq/openai/gpt-oss-20b` -> `groq/openai/gpt-oss-120b`), deterministic response caching via LiteLLM, failure simulation headers, and persistent session history.

## 1. Live URLs

- **Frontend UI (Docker / Vite):** https://lyftr-ai.vercel.app (deployed)
- **Local Frontend:** http://localhost:3000
- **Backend API:** https://lyftr-ai-backend-x6is.onrender.com (deployed)
- **Local Backend:** http://localhost:8000
- **Backend Health Check:** https://lyftr-ai-backend-x6is.onrender.com (deployed)
- **Local Backend:** http://localhost:8000/health
- **Backend OpenAPI Docs:** https://lyftr-ai-backend-x6is.onrender.com (deployed)
- **Local Backend:** http://localhost:8000/docs

## 2. Run locally: with Docker and without

### With Docker

1. Copy the root environment template and add your API keys:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set `GROQ_API_KEY` and `GROQ_API_KEY_2`.

2. Build and start both services:
   ```bash
   make up
   ```
   To stop and remove containers:
   ```bash
   make down
   ```

### Without Docker

1. **Backend (FastAPI):**
   ```bash
   cd backend
   cp .env.example .env
   # Set GROQ_API_KEY, GROQ_API_KEY_2, and e.g. DATABASE_URL=sqlite:///./app.db, LLM_CACHE_DIR=./llm_cache
   python -m venv .venv
   # Windows: .venv\Scripts\activate  |  macOS/Linux: source .venv/bin/activate
   pip install -r requirements.txt
   uvicorn main:app --host 0.0.0.0 --port 8000 --reload
   ```

2. **Frontend (React + Vite):**
   ```bash
   cd frontend
   cp .env.example .env
   npm install
   npm run dev -- --port 3000
   ```

## 3. Design decisions: key fallback, caching, SQLite session storage

- **Key Fallback (`backend/llm.py`):**
  Uses `litellm.Router` configured with two distinct provider keys: `key_1` (`groq/openai/gpt-oss-20b`) and `key_2` (`groq/openai/gpt-oss-120b`), plus `fallbacks=[{"key_1": ["key_2"]}, {"key_2": ["key_1"]}]`. A deterministic per-key loop invokes `router.completion(model=key_id, ...)` so that simulated failures (via `X-Simulate-Failure` when `ENABLE_FAILURE_SIMULATION=true`) short-circuit before hitting the provider while counting `fallback_attempts`. If all keys fail, the API returns HTTP `503` with `{"detail":"all providers unavailable"}` and never writes the failed turn to SQLite.

- **Caching (`backend/llm.py`):**
  Enables LiteLLM's disk cache (`Cache(type="disk", disk_cache_dir="/data/llm_cache")`) via `litellm.enable_cache()` and passes `cache={"no-cache": False, "no-store": False}` on every completion call. Cache keys are discriminated by the model plus the full `messages` array (`[system_prompt?, ...history, new_message]`). Cache hits are detected from `response._hidden_params.get("cache_hit") == True`, returning `resolution_source="LLM_CACHE"`, `key_id=null`, and `fallback_attempts=0`.

- **SQLite Session Storage (`backend/db.py`):**
  Uses Python's built-in `sqlite3` with `DATABASE_URL` (defaulting to `sqlite:////data/app.db` persisted on the `appdata` Docker volume). On startup, `init_db()` creates the `messages` table and an index on `session_id`. Only completed turns (both `user` and `assistant` with serialized JSON `metadata`) are persisted; `422` validation errors and `503` provider failures are never saved. `GET /sessions/{session_id}/messages` returns ordered non-system messages or `404` if the session has no rows.

## 4. Verification: how to see failover, cache hits and per-message token usage

1. **Health Check:**
   ```bash
   curl https://lyftr-ai-backend-x6is.onrender.com (deployed)
- **Local Backend:** http://localhost:8000/health
   ```
   Verify `keys_configured` is `2` and `cache_enabled` is `true`.

2. **Live Inference & Per-Message Token Usage:**
   Send a message in the UI (or via `curl` to `POST /chat`). The assistant card displays `LIVE_INFERENCE` (`data-testid="meta-source"`), model name, latency in `ms`, `input_tokens`, and `output_tokens`.

3. **Cache Hits (Same Session or New Session):**
   Click **New Session** (or use a new `session_id` in `curl`) and send the exact same first message (with the same system prompt). The response returns `resolution_source: "LLM_CACHE"`, `key_id: null`, `fallback_attempts: 0`, and near-zero latency. Sending a different message triggers `LIVE_INFERENCE`.

4. **Failover Simulation:**
   Enter `key_1=429` in the **X-Simulate-Failure** field in the UI (or pass `-H "X-Simulate-Failure: key_1=429"` in `curl`). The backend skips `key_1` without calling Groq, falls back to `key_2` (`groq/openai/gpt-oss-120b`), and returns the real Gemini response with `fallback_attempts: 1` and `key_id: "key_2"`. Sending `*=429` returns HTTP `503` (`all providers unavailable`) and is not saved to session history.

## 5. Setup Used: your editor and AI tools

- **Editor:** VS Code / Antigravity IDE
- **AI Tools:** Antigravity AI coding assistant

## 6. Bonus features

- **Interactive Failure Simulation Input in UI:** Optional `X-Simulate-Failure` input in the chat header bar so reviewers can test `key_1=429` or `*=429` directly from the browser without needing `curl`.
- **Live Health Badge & Session Switcher:** Header displays live `keys_configured` and `cache_enabled` status from `/health`, alongside a **New Session** button to immediately test cross-session cache hits.
- **Structured Error Handling:** Both `422` Pydantic validation details and `503` provider-unavailable errors render cleanly as inline chat error cards.
