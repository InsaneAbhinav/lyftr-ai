from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, field_validator

from auth import create_access_token, get_current_user, hash_password, verify_password
from config import settings
from db import (
    create_user,
    delete_session,
    get_all_sessions,
    get_session_messages,
    get_user_by_email,
    init_db,
    save_turn,
)
from llm import AllProvidersUnavailableError, generate_chat_reply


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Lyftr AI — LLM Chatbot", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    print(f"[ERROR] Unhandled: {type(exc).__name__}: {exc}", flush=True)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


# Auth schemas

class AuthRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)


# Auth endpoints

@app.post("/auth/register", status_code=201)
def register(payload: AuthRequest) -> dict:
    hashed = hash_password(payload.password)
    user = create_user(str(payload.email), hashed)
    if user is None:
        raise HTTPException(status_code=409, detail="email already registered")
    token = create_access_token(user["id"], user["email"])
    return {"token": token, "email": user["email"]}


@app.post("/auth/login")
def login(payload: AuthRequest) -> dict:
    user = get_user_by_email(str(payload.email))
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="invalid email or password")
    token = create_access_token(user["id"], user["email"])
    return {"token": token, "email": user["email"]}


# Chat schemas

class ChatRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=128)
    message: str = Field(...)
    system_prompt: Optional[str] = Field(default=None)

    @field_validator("message")
    @classmethod
    def validate_trimmed_message(cls, v: str) -> str:
        trimmed = v.strip()
        if len(trimmed) < 1 or len(trimmed) > 4000:
            raise ValueError("message must be between 1 and 4000 characters after trim")
        return trimmed


class ChatMetadata(BaseModel):
    resolution_source: str
    model: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    key_id: Optional[str]
    fallback_attempts: int


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    metadata: ChatMetadata


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "keys_configured": settings.keys_configured, "cache_enabled": True}


@app.post("/chat", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    x_simulate_failure: Optional[str] = Header(default=None, alias="X-Simulate-Failure"),
    current_user: dict = Depends(get_current_user),
) -> ChatResponse:
    user_id = int(current_user["sub"])
    history = get_session_messages(payload.session_id, user_id) or []

    llm_messages: list[dict[str, str]] = []
    if payload.system_prompt and payload.system_prompt.strip():
        llm_messages.append({"role": "system", "content": payload.system_prompt.strip()})
    for msg in history:
        llm_messages.append({"role": msg["role"], "content": msg["content"]})
    llm_messages.append({"role": "user", "content": payload.message})

    try:
        reply_text, metadata = generate_chat_reply(
            messages=llm_messages,
            simulate_failure_header=x_simulate_failure,
        )
    except AllProvidersUnavailableError:
        raise HTTPException(status_code=503, detail="all providers unavailable")

    save_turn(
        session_id=payload.session_id,
        user_message=payload.message,
        assistant_reply=reply_text,
        metadata=metadata,
        user_id=user_id,
    )

    return ChatResponse(
        session_id=payload.session_id,
        reply=reply_text,
        metadata=ChatMetadata(**metadata),
    )


@app.get("/sessions")
def list_sessions(current_user: dict = Depends(get_current_user)) -> dict[str, Any]:
    return {"sessions": get_all_sessions(int(current_user["sub"]))}


@app.delete("/sessions/{session_id}", status_code=204)
def delete_session_endpoint(
    session_id: str,
    current_user: dict = Depends(get_current_user),
) -> None:
    deleted = delete_session(session_id, int(current_user["sub"]))
    if not deleted:
        raise HTTPException(status_code=404, detail="session not found")


@app.get("/sessions/{session_id}/messages")
def session_messages(
    session_id: str,
    current_user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    messages = get_session_messages(session_id, int(current_user["sub"]))
    if messages is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id, "messages": messages}
