"""Environment-driven security settings for API runtime behavior."""

from __future__ import annotations

from dataclasses import dataclass
import os


def _parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _parse_csv(value: str | None) -> list[str]:
    if value is None:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass
class SecurityConfig:
    app_env: str
    cors_allowed_origins: list[str]
    cors_allowed_origin_regex: str | None
    cors_allow_credentials: bool
    require_workspace_auth: bool
    expose_verbose_errors: bool

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def cors_is_configured(self) -> bool:
        """False means no browser origin can reach this API at all."""
        return bool(self.cors_allowed_origins) or bool(self.cors_allowed_origin_regex)


def load_security_config() -> SecurityConfig:
    app_env = os.getenv("APP_ENV", "development").strip().lower() or "development"
    is_production = app_env == "production"

    configured_origins = _parse_csv(os.getenv("CORS_ALLOWED_ORIGINS"))
    if configured_origins:
        cors_allowed_origins = configured_origins
    elif is_production:
        cors_allowed_origins = []
    else:
        cors_allowed_origins = [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]

    # A regex is how Vercel preview deployments get covered: their hostnames
    # change per branch and per commit, so an exact-match list can never keep up.
    cors_allowed_origin_regex = (os.getenv("CORS_ALLOWED_ORIGIN_REGEX") or "").strip() or None

    cors_allow_credentials_default = bool(cors_allowed_origins) and "*" not in cors_allowed_origins
    cors_allow_credentials = _parse_bool(
        os.getenv("CORS_ALLOW_CREDENTIALS"),
        cors_allow_credentials_default,
    )
    if "*" in cors_allowed_origins and cors_allow_credentials:
        cors_allow_credentials = False

    require_workspace_auth = _parse_bool(
        os.getenv("REQUIRE_WORKSPACE_AUTH"),
        is_production,
    )
    expose_verbose_errors = _parse_bool(
        os.getenv("EXPOSE_VERBOSE_ERRORS"),
        not is_production,
    )

    return SecurityConfig(
        app_env=app_env,
        cors_allowed_origins=cors_allowed_origins,
        cors_allowed_origin_regex=cors_allowed_origin_regex,
        cors_allow_credentials=cors_allow_credentials,
        require_workspace_auth=require_workspace_auth,
        expose_verbose_errors=expose_verbose_errors,
    )
