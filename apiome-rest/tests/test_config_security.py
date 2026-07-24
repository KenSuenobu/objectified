"""Security-hardening behaviour of app.config.Settings (RC1-0.3, #3610).

Covers the fail-closed JWT secret and the configuration-driven CORS allow-list.
"""

import pytest

from app.config import (
    DEFAULT_CORS_ORIGIN_REGEX,
    DEFAULT_CORS_ORIGINS,
    INSECURE_JWT_SECRET_FALLBACK,
    Settings,
)


def test_effective_jwt_secret_prefers_better_auth_over_jwt():
    s = Settings(better_auth_secret="better-auth-value", jwt_secret="jwt-value")
    assert s.effective_jwt_secret == "better-auth-value"


def test_effective_jwt_secret_falls_back_to_jwt_secret():
    s = Settings(better_auth_secret=None, jwt_secret="jwt-value")
    assert s.effective_jwt_secret == "jwt-value"


def test_effective_jwt_secret_dev_uses_insecure_default():
    s = Settings(better_auth_secret=None, jwt_secret=None, app_env="development")
    assert s.is_production is False
    assert s.effective_jwt_secret == INSECURE_JWT_SECRET_FALLBACK


@pytest.mark.parametrize("env", ["production", "PRODUCTION", "prod", " Prod "])
def test_effective_jwt_secret_production_fails_closed(env):
    s = Settings(better_auth_secret=None, jwt_secret=None, app_env=env)
    assert s.is_production is True
    with pytest.raises(RuntimeError, match="JWT secret is not configured"):
        _ = s.effective_jwt_secret


def test_effective_jwt_secret_production_with_secret_is_ok():
    s = Settings(better_auth_secret="real-secret", app_env="production")
    assert s.effective_jwt_secret == "real-secret"


def test_cors_origins_default_when_unset():
    s = Settings(cors_allowed_origins=None)
    assert s.cors_allowed_origins_list == DEFAULT_CORS_ORIGINS


def test_cors_origins_parsed_and_trimmed():
    s = Settings(cors_allowed_origins="https://a.example.com, https://b.example.com ,, ")
    assert s.cors_allowed_origins_list == [
        "https://a.example.com",
        "https://b.example.com",
    ]


def test_cors_origin_regex_default_when_unset():
    s = Settings(cors_allowed_origin_regex=None)
    assert s.effective_cors_origin_regex == DEFAULT_CORS_ORIGIN_REGEX
    assert "apiome\\.app" in DEFAULT_CORS_ORIGIN_REGEX


def test_cors_origin_regex_custom_value():
    s = Settings(cors_allowed_origin_regex=r"https://.*\.example\.com")
    assert s.effective_cors_origin_regex == r"https://.*\.example\.com"


def test_cors_origin_regex_empty_string_disables():
    s = Settings(cors_allowed_origin_regex="")
    assert s.effective_cors_origin_regex is None
