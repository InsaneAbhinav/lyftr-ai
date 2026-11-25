import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    groq_api_key: str = os.getenv("GROQ_API_KEY", "").strip()
    groq_api_key_2: str = os.getenv("GROQ_API_KEY_2", "").strip()
    # key_1: first Groq account — gpt-oss-20b
    groq_model: str = os.getenv("GROQ_MODEL", "groq/openai/gpt-oss-20b").strip()
    # key_2: second Groq account — gpt-oss-120b (more powerful)
    groq_model_2: str = os.getenv("GROQ_MODEL_2", "groq/openai/gpt-oss-120b").strip()
    secret_key: str = os.getenv("SECRET_KEY", "change-me-in-production-use-32-chars-min").strip()
    access_token_expire_minutes: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "10080"))  # 7 days
    enable_failure_simulation: bool = (
        os.getenv("ENABLE_FAILURE_SIMULATION", "false").strip().lower() == "true"
    )
    database_url: str = os.getenv("DATABASE_URL", "sqlite:////data/app.db").strip()
    frontend_origin: str = os.getenv("FRONTEND_ORIGIN", "*").strip()
    llm_cache_dir: str = os.getenv("LLM_CACHE_DIR", "/data/llm_cache").strip()

    @property
    def key_2_api_key(self) -> str:
        return self.groq_api_key_2

    @property
    def key_2_model(self) -> str:
        return self.groq_model_2

    @property
    def keys_configured(self) -> int:
        count = 0
        if self.groq_api_key:
            count += 1
        if self.key_2_api_key:
            count += 1
        return count

    @property
    def cors_origins(self) -> list[str]:
        if not self.frontend_origin or self.frontend_origin == "*":
            return ["*"]
        return [o.strip() for o in self.frontend_origin.split(",") if o.strip()]


settings = Settings()
