import hashlib
import json
import os
import time
from typing import Any, Optional

import diskcache
import litellm
from litellm.caching.caching import Cache

from config import settings

KEY_ORDER = ("key_1", "key_2")
KEY_TO_MODEL = {
    "key_1": settings.groq_model,
    "key_2": settings.key_2_model,
}
KEY_TO_API_KEY = {
    "key_1": settings.groq_api_key,
    "key_2": settings.key_2_api_key,
}


class AllProvidersUnavailableError(Exception):
    pass


# ── Disk cache (diskcache library) ────────────────────────────────────────────
def _make_disk_cache() -> diskcache.Cache:
    cache_dir = settings.llm_cache_dir
    os.makedirs(cache_dir, exist_ok=True)
    dc = diskcache.Cache(cache_dir, size_limit=500 * 1024 * 1024)  # 500 MB
    print(f"[CACHE] disk cache ready at {cache_dir}", flush=True)
    return dc


_disk_cache = _make_disk_cache()

# Also keep LiteLLM local cache (for Router compat, unused for our logic)
litellm.cache = Cache(type="local")
litellm.suppress_debug_info = True


def _cache_key(model: str, messages: list[dict]) -> str:
    payload = json.dumps({"model": model, "messages": messages}, sort_keys=True)
    return "llm:" + hashlib.sha256(payload.encode()).hexdigest()


def parse_simulate_failure_header(header_value: Optional[str]) -> dict[str, int]:
    if not header_value:
        return {}
    if os.environ.get("ENABLE_FAILURE_SIMULATION", "").strip().lower() != "true":
        return {}
    simulated: dict[str, int] = {}
    for part in header_value.split(","):
        part = part.strip()
        if "=" not in part:
            continue
        key_part, status_part = part.split("=", 1)
        key_part = key_part.strip()
        try:
            status_code = int(status_part.strip())
        except ValueError:
            continue
        if key_part == "*":
            for k in KEY_ORDER:
                simulated[k] = status_code
        elif key_part in KEY_TO_MODEL:
            simulated[key_part] = status_code
    return simulated


def _extract_tokens(response: Any) -> tuple[int, int]:
    usage = getattr(response, "usage", None)
    if usage is None:
        return 0, 0
    prompt = getattr(usage, "prompt_tokens", None)
    completion = getattr(usage, "completion_tokens", None)
    if prompt is None and isinstance(usage, dict):
        prompt = usage.get("prompt_tokens", 0)
        completion = usage.get("completion_tokens", 0)
    return int(prompt or 0), int(completion or 0)


def generate_chat_reply(
    messages: list[dict[str, str]],
    simulate_failure_header: Optional[str] = None,
) -> tuple[str, dict[str, Any]]:
    simulated = parse_simulate_failure_header(simulate_failure_header)
    start = time.perf_counter()
    fallback_attempts = 0
    last_error: Optional[Exception] = None

    # ── Cache lookup (model-agnostic: keyed on messages only) ──────────────
    # Use first available model as cache key model so cross-session hits work
    cache_model = KEY_TO_MODEL["key_1"]
    ck = _cache_key(cache_model, messages)
    cached = _disk_cache.get(ck)
    if cached is not None:
        latency_ms = int((time.perf_counter() - start) * 1000)
        print(f"[CACHE] HIT latency={latency_ms}ms key={ck[:16]}", flush=True)
        return cached["reply"], {
            "resolution_source": "LLM_CACHE",
            "model": cached["model"],
            "latency_ms": latency_ms,
            "input_tokens": cached["input_tokens"],
            "output_tokens": cached["output_tokens"],
            "key_id": None,
            "fallback_attempts": 0,
        }

    # ── Live inference ──────────────────────────────────────────────────────
    for key_id in KEY_ORDER:
        if key_id in simulated:
            fallback_attempts += 1
            last_error = RuntimeError(f"Simulated {simulated[key_id]} on {key_id}")
            continue

        api_key = KEY_TO_API_KEY[key_id]
        if not api_key:
            fallback_attempts += 1
            last_error = RuntimeError(f"No API key for {key_id}")
            continue

        model = KEY_TO_MODEL[key_id]

        try:
            response = litellm.completion(
                model=model,
                messages=messages,
                api_key=api_key,
            )
            latency_ms = int((time.perf_counter() - start) * 1000)
            reply = response.choices[0].message.content or ""
            input_tok, output_tok = _extract_tokens(response)
            resolved_model = getattr(response, "model", None) or model

            # Store in disk cache (TTL: 7 days)
            _disk_cache.set(ck, {
                "reply": reply,
                "model": resolved_model,
                "input_tokens": input_tok,
                "output_tokens": output_tok,
            }, expire=7 * 24 * 3600)

            print(
                f"[CACHE] MISS stored key={ck[:16]} | "
                f"{key_id} latency={latency_ms}ms tokens={input_tok}+{output_tok}",
                flush=True,
            )

            return reply, {
                "resolution_source": "LIVE_INFERENCE",
                "model": resolved_model,
                "latency_ms": latency_ms,
                "input_tokens": input_tok,
                "output_tokens": output_tok,
                "key_id": key_id,
                "fallback_attempts": fallback_attempts,
            }

        except Exception as exc:
            fallback_attempts += 1
            last_error = exc
            print(f"[LLM] {key_id} failed: {type(exc).__name__}: {exc}", flush=True)
            continue

    raise AllProvidersUnavailableError(str(last_error or "all providers unavailable"))
