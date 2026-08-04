import logging
from typing import Optional

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

# Insecure development-only JWT secret. Used (with a warning) when no secret is configured
# outside production; production fails closed instead — see Settings.effective_jwt_secret.
INSECURE_JWT_SECRET_FALLBACK = "your-secret-key-here"

# Insecure development-only Slate artifact signing key (APX-3.1, private-suite#2456). Used
# (with a warning) outside production; production fails closed instead — see
# Settings.effective_slate_artifact_signing_key.
INSECURE_SLATE_SIGNING_KEY_FALLBACK = "slate-artifact-signing-key-development-only"

# Insecure development-only secret for deriving custom-domain ownership tokens (Slate 10.1,
# private-suite#119). Used (with a warning) outside production; production fails closed — see
# Settings.effective_slate_domain_verification_secret.
INSECURE_SLATE_DOMAIN_SECRET_FALLBACK = "slate-domain-verification-development-only"

# Default CORS allow-list applied when APIOME_CORS_ALLOWED_ORIGINS is unset.
DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",  # apiome-ui (main app)
    "http://localhost:3001",  # alternate Next.js port
    "http://localhost:3003",  # studio (designer)
]

# Default CORS origin regex applied when APIOME_CORS_ALLOWED_ORIGIN_REGEX is unset.
DEFAULT_CORS_ORIGIN_REGEX = r"https://.*\.apiome\.app"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Database settings - can use DATABASE_URL directly or build from components
    database_url: Optional[str] = None
    postgres_user: str = "postgres"
    postgres_password: str = "password"
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "apiome"

    host: str = "0.0.0.0"
    port: int = 8000
    reload: bool = True

    # Deployment environment. "production"/"prod" enables fail-closed checks (e.g. the JWT
    # secret must be configured — no insecure built-in fallback). Defaults to development.
    app_env: str = Field(
        default="development",
        validation_alias=AliasChoices(
            "APIOME_ENV",
            "APP_ENV",
            "ENVIRONMENT",
            "app_env",
        ),
    )

    # JWT settings — must match apiome-ui's BETTER_AUTH_SECRET.
    # Prefer BETTER_AUTH_SECRET; JWT_SECRET remains a secondary fallback.
    jwt_secret: Optional[str] = None
    better_auth_secret: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "BETTER_AUTH_SECRET",
            "better_auth_secret",
        ),
    )
    jwt_algorithm: str = "HS256"

    # CORS allow-list. Comma-separated exact origins via APIOME_CORS_ALLOWED_ORIGINS
    # (defaults to the local Next.js dev ports). A regex for trusted subdomains is supplied
    # via APIOME_CORS_ALLOWED_ORIGIN_REGEX (defaults to *.apiome.dev); set it to an
    # empty string to disable subdomain matching entirely.
    cors_allowed_origins: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_CORS_ALLOWED_ORIGINS",
            "cors_allowed_origins",
        ),
    )
    cors_allowed_origin_regex: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_CORS_ALLOWED_ORIGIN_REGEX",
            "cors_allowed_origin_regex",
        ),
    )

    # Embedding (Ollama) for data_snapshot vectorization
    ollama_base_url: str = "http://localhost:11434"

    # "Similar servers" semantic-embedding signal (MCAT-18.4, #4648). Off by default: the feature's
    # always-available signal is capability-name overlap (Jaccard), which needs no embedding. When this
    # flag is off, the semantic cosine nearest-neighbour signal is skipped entirely (no vectors are read
    # or ranked) and the reindex/backfill step no-ops — so the endpoint page shows overlap-only similar
    # servers. Enable it (with the Ollama embedding service reachable) to add the semantic signal.
    mcp_similarity_embeddings_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_MCP_SIMILARITY_EMBEDDINGS_ENABLED",
            "mcp_similarity_embeddings_enabled",
        ),
    )

    # Natural-language server digest + usage examples (MCAT-18.5, #4649). An opt-in, gated AI step that
    # writes a short "this server lets you …" summary of a cataloged MCP server via the Claude API and
    # caches it per surface_fingerprint. OFF by default: when disabled (or when no API key is set), the
    # generate route no-ops with a labelled reason and never calls the model, and the read route simply
    # returns whatever is already cached (usually nothing). The per-tool example calls are synthesized
    # deterministically from each tool's input_schema and never require the model or tool execution, so
    # they are unaffected by this flag. See app.mcp_digest_service.
    mcp_ai_digest_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_MCP_AI_DIGEST_ENABLED",
            "mcp_ai_digest_enabled",
        ),
    )
    # Key used to sign Slate deployment artifacts (APX-3.1, private-suite#2456). Deliberately
    # separate from the JWT secret: see effective_slate_artifact_signing_key. Never logged.
    slate_artifact_signing_key: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_SLATE_ARTIFACT_SIGNING_KEY",
            "slate_artifact_signing_key",
        ),
    )
    # Identifier recorded next to every signature so stored artifacts stay verifiable across
    # key rotation: an artifact signed before a rotation names the key that signed it.
    slate_artifact_signing_key_id: str = Field(
        default="slate-local-dev",
        validation_alias=AliasChoices(
            "APIOME_SLATE_ARTIFACT_SIGNING_KEY_ID",
            "slate_artifact_signing_key_id",
        ),
    )
    # Lifetime of an ephemeral git-triggered preview lane, in hours (APX-3.3, private-suite#2458).
    # A preview is a review aid, not a durable deployment, so it expires and is reaped rather than
    # lingering as an unbounded set of half-finished branches. One week by default.
    slate_preview_default_ttl_hours: int = Field(
        default=168,
        validation_alias=AliasChoices(
            "APIOME_SLATE_PREVIEW_DEFAULT_TTL_HOURS",
            "slate_preview_default_ttl_hours",
        ),
    )
    # The platform hostname tenants point a custom domain at (Slate 10.1, private-suite#119).
    # It is the value printed in the CNAME row of the DNS instructions and the value ownership
    # verification compares an observed CNAME against, so the instruction and the check can never
    # disagree about where traffic is supposed to go.
    slate_domain_dns_target: str = Field(
        default="sites.apiome.app",
        validation_alias=AliasChoices(
            "APIOME_SLATE_DOMAIN_DNS_TARGET",
            "slate_domain_dns_target",
        ),
    )
    # The platform's own DNS zone. Hosts inside it are refused as custom domains: a tenant
    # "verifying" a name in a zone they cannot publish records for would be verifying our DNS.
    # Defaults to the DNS target's own zone, which is the correct answer for every deployment
    # that has not split them — see effective_slate_domain_zone.
    slate_domain_reserved_zone: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_SLATE_DOMAIN_RESERVED_ZONE",
            "slate_domain_reserved_zone",
        ),
    )
    # Secret the per-domain ownership token is derived from. Deliberately separate from the JWT
    # secret and the artifact signing key: a token is published in public DNS by design, so it must
    # not be derived from a value whose exposure would matter. Never logged.
    slate_domain_verification_secret: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_SLATE_DOMAIN_VERIFICATION_SECRET",
            "slate_domain_verification_secret",
        ),
    )
    # Claude API key used only for the server-digest generation above. Read from the environment; never
    # logged. When unset the feature stays a no-op even if the flag is on.
    anthropic_api_key: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_ANTHROPIC_API_KEY",
            "ANTHROPIC_API_KEY",
            "anthropic_api_key",
        ),
    )
    # Which Claude model produces the digest. Defaults to the latest cost-effective summarization model;
    # override to trade cost for capability. Recorded alongside each cached digest so a model change is
    # visible in the stored provenance.
    mcp_ai_digest_model: str = Field(
        default="claude-sonnet-5",
        validation_alias=AliasChoices(
            "APIOME_MCP_AI_DIGEST_MODEL",
            "mcp_ai_digest_model",
        ),
    )

    # Pre-commit policy default when project metadata omits maxCommitPayloadBytes (#2565)
    commit_policy_max_payload_bytes_default: int = 5_242_880

    # HMAC-SHA256 secret signing lint gate attestation envelopes (CLX-4.2, #4860). Unset =>
    # attestations are emitted unsigned (empty signatures list). Share with CI verifiers.
    lint_attestation_signing_secret: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_LINT_ATTESTATION_SIGNING_SECRET",
            "lint_attestation_signing_secret",
        ),
    )

    # HMAC-SHA256 secret signing portable mock bundle manifests (PMR-1.1, #4741). Unset => bundles
    # are exported unsigned ("signature": null). Share with the portable runtime and CI verifiers.
    mock_bundle_signing_secret: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_MOCK_BUNDLE_SIGNING_SECRET",
            "mock_bundle_signing_secret",
        ),
    )

    # How far ahead of expiry the lint.waiver.expiring webhook fires (CLX-4.2, #4860).
    lint_waiver_expiry_warning_hours: int = Field(
        default=72,
        validation_alias=AliasChoices(
            "APIOME_LINT_WAIVER_EXPIRY_WARNING_HOURS",
            "lint_waiver_expiry_warning_hours",
        ),
    )

    # Fernet key (url-safe base64) from `Fernet.generate_key()` — encrypts webhook signing secrets at rest (#2588)
    webhook_signing_secret_encryption_key: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEY",
            "webhook_signing_secret_encryption_key",
        ),
    )

    # Envelope encryption-at-rest for outbound MCP credentials (MCAT-6.2, #3678).
    # A JSON object mapping an integer key-version to a base64-encoded 32-byte (AES-256) master
    # key, e.g. {"1": "<base64 key>", "2": "<base64 key>"}. Several versions may be configured at
    # once so the active key can be rotated while older rows stay decryptable. Generate a key with:
    #   python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"
    mcp_credential_encryption_keys: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_MCP_CREDENTIAL_ENCRYPTION_KEYS",
            "mcp_credential_encryption_keys",
        ),
    )
    # Which key-version new MCP credential secrets are sealed under. Defaults to the highest
    # version present in mcp_credential_encryption_keys when unset.
    mcp_credential_active_key_version: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_MCP_CREDENTIAL_ACTIVE_KEY_VERSION",
            "mcp_credential_active_key_version",
        ),
    )

    # Envelope encryption-at-rest for server-global OAuth provider secrets (OLO-8.3, #4969). The
    # key-encryption-key (KEK) that seals the client secret stored in
    # apiome.auth_provider_config.client_secret_encrypted (V196, OLO-8.2). The KEK lives in the
    # environment — never in the DB — so ciphertext at rest is useless without it. See
    # app.auth_provider_secret_crypto.
    #
    # Two accepted forms:
    #   * A single base64-encoded 32-byte (AES-256) key — the common case:
    #       AUTH_CONFIG_ENC_KEY=<base64 key>
    #     sealed under the key id in auth_config_enc_active_key_id (default "default").
    #   * A JSON object mapping a string key id to a base64 key, for flag-day-free rotation:
    #       AUTH_CONFIG_ENC_KEY={"v1": "<base64 key>", "v2": "<base64 key>"}
    #     Several ids may be configured at once so the active key can be rotated while older rows
    #     stay decryptable under the id (enc_key_id) that sealed them.
    # Generate a key with:
    #   python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"
    auth_config_enc_key: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_AUTH_CONFIG_ENC_KEY",
            "AUTH_CONFIG_ENC_KEY",
            "auth_config_enc_key",
        ),
    )
    # Which key id new provider secrets are sealed under (written to enc_key_id). Optional. For the
    # single-key form it defaults to "default"; for the JSON-map form it defaults to the sole id
    # when exactly one is configured, otherwise it must be set explicitly so rotation is unambiguous.
    auth_config_enc_active_key_id: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_AUTH_CONFIG_ENC_ACTIVE_KEY_ID",
            "AUTH_CONFIG_ENC_ACTIVE_KEY_ID",
            "auth_config_enc_active_key_id",
        ),
    )

    # Super-admin session verification (OLO-8.4, #4970). The provider-config admin surface
    # (GET/PUT /v1/admin/auth-providers) is gated by the SAME HMAC-signed session the Next.js
    # `/admin` portal mints (OLO-8.1, lib/auth/admin-session.ts). REST verifies that token
    # server-side, so the signing key MUST match the UI's. Resolution mirrors the UI exactly:
    # the dedicated ``ADMIN_SESSION_SECRET`` is preferred; otherwise a key is derived from
    # ``ADMIN_PASSWORD`` (the admin login already requires it). With neither set the surface
    # fails closed — no token can be verified, so every caller is rejected.
    admin_session_secret: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_ADMIN_SESSION_SECRET",
            "ADMIN_SESSION_SECRET",
            "admin_session_secret",
        ),
    )
    admin_password: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_ADMIN_PASSWORD",
            "ADMIN_PASSWORD",
            "admin_password",
        ),
    )

    # Internal service-to-service token gating the resolved auth-provider read path (OLO-8.5,
    # #4971). The DB-over-env merge resolver in apiome-ui reads decrypted provider config from
    # ``GET /v1/internal/auth-providers/resolved`` while building NextAuth providers *during a
    # login request* — a context with no user or admin session. So that endpoint is gated not by a
    # user identity but by a shared secret both services hold: the caller must present it in
    # ``X-Internal-Service-Token`` and REST compares it in constant time. Unset ⇒ the endpoint
    # fails closed (503): decrypted secrets are never served without a configured token. Must match
    # the ``INTERNAL_SERVICE_TOKEN`` given to apiome-ui.
    internal_service_token: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_INTERNAL_SERVICE_TOKEN",
            "INTERNAL_SERVICE_TOKEN",
            "internal_service_token",
        ),
    )

    # Repository auto-refresh cadence (RAR-3.1, #3522). Per-repo cadence is stored
    # in apiome.tenant_repositories.refresh_interval_seconds; these set the default
    # applied when a repo has no explicit value and the global minimum floor that
    # clamps sub-floor per-repo values at read time.
    refresh_default_interval_seconds: int = Field(
        default=300,
        validation_alias=AliasChoices(
            "APIOME_REFRESH_DEFAULT_INTERVAL",
            "refresh_default_interval_seconds",
        ),
    )
    refresh_min_interval_seconds: int = Field(
        default=60,
        validation_alias=AliasChoices(
            "APIOME_REFRESH_MIN_INTERVAL",
            "refresh_min_interval_seconds",
        ),
    )

    # Refresh backoff + auto-pause (RAR-3.4, #3525), extending REPO-4.5 to the
    # refresh loop. Consecutive refresh failures defer a repo by its interval times
    # an exponential multiplier (×2, ×4 … ×32) capped at the max below; after the
    # threshold the repo auto-pauses (requires a manual resume). A threshold of 0
    # or below disables auto-pause (backoff still applies).
    refresh_auto_pause_threshold: int = Field(
        default=8,
        validation_alias=AliasChoices(
            "APIOME_REFRESH_AUTO_PAUSE_THRESHOLD",
            "refresh_auto_pause_threshold",
        ),
    )
    refresh_backoff_max_seconds: int = Field(
        default=7 * 24 * 60 * 60,
        validation_alias=AliasChoices(
            "APIOME_REFRESH_BACKOFF_MAX_INTERVAL",
            "refresh_backoff_max_seconds",
        ),
    )

    # Per-tenant polling quotas / fairness (REPO-4.6 #2784, RAR-3.5 #3526). The
    # sweep round-robins due repos across tenants and bounds the poll (refresh)
    # jobs one tenant may enqueue per rolling window; a tenant over its quota
    # has its remaining due repos deferred (not failed) until the window rolls.
    #
    # The bound itself is persisted per tenant on
    # apiome.tenants.repository_polls_per_hour (default 60, elevated/enterprise
    # 600, 0 = that tenant is unlimited). APIOME_REFRESH_TENANT_QUOTA is the
    # deployment-wide fallback for tenants whose row cannot be read, and the
    # kill switch: 0 or below disables quota enforcement everywhere (fairness
    # interleaving still applies). Manual "Refresh Now" (RAR-5.2) is never
    # quota-limited.
    refresh_tenant_quota_jobs: int = Field(
        default=60,
        validation_alias=AliasChoices(
            "APIOME_REFRESH_TENANT_QUOTA",
            "refresh_tenant_quota_jobs",
        ),
    )
    refresh_tenant_quota_window_seconds: int = Field(
        default=3600,
        validation_alias=AliasChoices(
            "APIOME_REFRESH_TENANT_QUOTA_WINDOW",
            "refresh_tenant_quota_window_seconds",
        ),
    )

    # Quota & rate-limit telemetry retention (REPO-7.3, #2801). The rolling-window
    # counter rows in apiome.repository_quota_window are aggregates, not events, so
    # they are cheap to keep — this only stops the table growing with the age of the
    # deployment. The default is comfortably longer than the widest range the API
    # will serve (repository_quota_window.MAX_TELEMETRY_DAYS), so retention can
    # never truncate a supported read. 0 or below keeps counters forever.
    repository_quota_window_retention_days: int = Field(
        default=120,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_QUOTA_WINDOW_RETENTION_DAYS",
            "repository_quota_window_retention_days",
        ),
    )

    # Large-monorepo repository walk (REPO-2.5, #2766). A scan pass runs under a
    # per-tenant wall-clock budget stored in
    # apiome.tenants.repository_scan_budget_seconds; these set the default applied
    # when a tenant has no explicit value and the floor/ceiling that clamp it at
    # read time. When the budget is spent the walker stores a resume cursor and the
    # scan continues on the next sweep tick.
    #
    # repository_scan_chunk_size bounds how many walked entries are buffered before
    # being written, so a monorepo tree never materializes in memory. It is capped
    # at repository_scan_budget.MAX_WALK_CHUNK_SIZE (1000) regardless of this value.
    repository_scan_budget_seconds: int = Field(
        default=300,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_SCAN_BUDGET_DEFAULT",
            "repository_scan_budget_seconds",
        ),
    )
    repository_scan_budget_min_seconds: int = Field(
        default=5,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_SCAN_BUDGET_MIN",
            "repository_scan_budget_min_seconds",
        ),
    )
    repository_scan_budget_max_seconds: int = Field(
        default=3600,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_SCAN_BUDGET_MAX",
            "repository_scan_budget_max_seconds",
        ),
    )
    repository_scan_chunk_size: int = Field(
        default=1000,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_SCAN_CHUNK_SIZE",
            "repository_scan_chunk_size",
        ),
    )

    # Per-spec quality scoring for discovered repository files (REPO-2.8, #2769). A
    # background sweep downloads each newly discovered *classified* spec once and runs
    # the existing import lint engines over it, storing a 0-100 score on
    # apiome.tenant_repository_files.quality_score. The score is informational only.
    #
    # repository_quality_scoring_enabled turns the sweep off entirely (no provider
    # traffic at all); repository_quality_batch_size bounds how many files one tick
    # downloads, which is what caps the sweep's provider rate; and
    # repository_quality_interval_seconds is how often a tick runs.
    repository_quality_scoring_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_QUALITY_SCORING",
            "repository_quality_scoring_enabled",
        ),
    )
    repository_quality_batch_size: int = Field(
        default=10,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_QUALITY_BATCH_SIZE",
            "repository_quality_batch_size",
        ),
    )
    repository_quality_interval_seconds: int = Field(
        default=30,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_QUALITY_INTERVAL",
            "repository_quality_interval_seconds",
        ),
    )

    # Primitives type-registry entitlement gating (#3478). When False (default), the
    # advanced Type Registry surface (resolver, namespaces, settings, stats, import) is
    # open to every authenticated tenant — current behavior, unchanged. When True, those
    # routes require the calling tenant/user to hold the ``primitives-registry`` feature
    # flag (per-user override > per-tenant override > license default); non-entitled
    # callers get 403. Baseline primitives CRUD and /health are never gated.
    primitives_registry_gating_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_PRIMITIVES_REGISTRY_GATING",
            "primitives_registry_gating_enabled",
        ),
    )

    # License seat/capacity enforcement (OLO-5.3, #4213). When True (default), the
    # member-invite route and the suspended-member reinstate path refuse to exceed the
    # tenant license's ``seats.max_users_per_tenant`` (structured 403, code
    # ``license-seats-exhausted``). Set to False as an operator kill switch to restore
    # pre-5.3 behavior without redeploying; the tenant-cap check in first-tenant
    # provisioning (``user_entitlements.max_tenants``) is transactional and is NOT
    # affected by this switch.
    license_enforcement_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_LICENSE_ENFORCEMENT_ENABLED",
            "license_enforcement_enabled",
        ),
    )

    # SSRF guard (#3612). When False (default), user-supplied URLs fetched by the
    # import-from-URL and public repository-registration paths are resolved and
    # rejected if they point at non-public addresses (loopback, RFC1918,
    # link-local incl. the 169.254.169.254 metadata IP, etc.). Set to True only
    # for local development where importing from localhost is intentional; the
    # http/https-only and no-credentials-in-URL checks always apply.
    ssrf_allow_private: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_SSRF_ALLOW_PRIVATE",
            "ssrf_allow_private",
        ),
    )

    # Remote $ref resolution (MFI-29.4, #4391). An import resolves external `$ref` URLs
    # only when it explicitly asks for it (``SpecImportOptions.resolve_remote_refs``,
    # default false) — these settings bound what that opt-in may do and let an operator
    # switch the capability off entirely:
    #
    #   remote_ref_resolution_allowed   Kill switch. False makes every import behave as if
    #                                   resolution were off (external refs are reported as
    #                                   findings, nothing is fetched), regardless of the
    #                                   per-import flag.
    #   remote_ref_max_refs             Maximum references inlined per import.
    #   remote_ref_max_depth            Maximum nesting depth of chained remote references.
    #   remote_ref_max_bytes            Total fetched-bytes ceiling per import.
    #   remote_ref_fetch_timeout_seconds  Per-request timeout.
    #   remote_ref_total_timeout_seconds  Wall-clock deadline for a whole resolution run;
    #                                   keep it below the intake guard's per-stage wall
    #                                   clock so the resolver's own budget fires first.
    #   remote_ref_cache_*              Bounds for the process-wide content-addressed cache
    #                                   that keeps a re-import from re-fetching.
    remote_ref_resolution_allowed: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_REMOTE_REF_RESOLUTION_ALLOWED",
            "remote_ref_resolution_allowed",
        ),
    )
    remote_ref_max_refs: int = Field(
        default=50,
        validation_alias=AliasChoices("APIOME_REMOTE_REF_MAX_REFS", "remote_ref_max_refs"),
    )
    remote_ref_max_depth: int = Field(
        default=5,
        validation_alias=AliasChoices("APIOME_REMOTE_REF_MAX_DEPTH", "remote_ref_max_depth"),
    )
    remote_ref_max_bytes: int = Field(
        default=4 * 1024 * 1024,
        validation_alias=AliasChoices("APIOME_REMOTE_REF_MAX_BYTES", "remote_ref_max_bytes"),
    )
    remote_ref_fetch_timeout_seconds: float = Field(
        default=5.0,
        validation_alias=AliasChoices(
            "APIOME_REMOTE_REF_FETCH_TIMEOUT_SECONDS",
            "remote_ref_fetch_timeout_seconds",
        ),
    )
    remote_ref_total_timeout_seconds: float = Field(
        default=15.0,
        validation_alias=AliasChoices(
            "APIOME_REMOTE_REF_TOTAL_TIMEOUT_SECONDS",
            "remote_ref_total_timeout_seconds",
        ),
    )
    remote_ref_cache_max_entries: int = Field(
        default=64,
        validation_alias=AliasChoices(
            "APIOME_REMOTE_REF_CACHE_MAX_ENTRIES",
            "remote_ref_cache_max_entries",
        ),
    )
    remote_ref_cache_max_bytes: int = Field(
        default=16 * 1024 * 1024,
        validation_alias=AliasChoices(
            "APIOME_REMOTE_REF_CACHE_MAX_BYTES",
            "remote_ref_cache_max_bytes",
        ),
    )
    remote_ref_cache_ttl_seconds: float = Field(
        default=900.0,
        validation_alias=AliasChoices(
            "APIOME_REMOTE_REF_CACHE_TTL_SECONDS",
            "remote_ref_cache_ttl_seconds",
        ),
    )

    # Per-tenant rate limiting (#3612). The limiter buckets requests per API key
    # / tenant slug / client IP and enforces a fixed window. Authenticated
    # traffic (API key or Authorization header) uses the higher limit; public
    # traffic uses the lower one. Set ``APIOME_RATE_LIMIT_ENABLED=false`` to
    # disable entirely. Limits are per replica (in-process counter).
    rate_limit_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_RATE_LIMIT_ENABLED",
            "rate_limit_enabled",
        ),
    )
    rate_limit_authenticated_per_minute: int = Field(
        default=600,
        validation_alias=AliasChoices(
            "APIOME_RATE_LIMIT_AUTHENTICATED_PER_MINUTE",
            "rate_limit_authenticated_per_minute",
        ),
    )
    rate_limit_public_per_minute: int = Field(
        default=120,
        validation_alias=AliasChoices(
            "APIOME_RATE_LIMIT_PUBLIC_PER_MINUTE",
            "rate_limit_public_per_minute",
        ),
    )
    rate_limit_window_seconds: int = Field(
        default=60,
        validation_alias=AliasChoices(
            "APIOME_RATE_LIMIT_WINDOW_SECONDS",
            "rate_limit_window_seconds",
        ),
    )

    # Auth-surface rate limiting (OLO-7.1, #4223). The onboarding endpoints
    # (``/v1/onboarding/*``) complete signup and membership activation, so they get
    # dedicated per-IP and per-account budgets on top of the global middleware.
    # Both budgets share ``rate_limit_window_seconds`` and honour the global
    # ``rate_limit_enabled`` kill switch.
    auth_rate_limit_ip_per_minute: int = Field(
        default=20,
        validation_alias=AliasChoices(
            "APIOME_AUTH_RATE_LIMIT_IP_PER_MINUTE",
            "auth_rate_limit_ip_per_minute",
        ),
    )
    auth_rate_limit_account_per_minute: int = Field(
        default=10,
        validation_alias=AliasChoices(
            "APIOME_AUTH_RATE_LIMIT_ACCOUNT_PER_MINUTE",
            "auth_rate_limit_account_per_minute",
        ),
    )

    # Mock Server (#3615, RC1-2.2). Free-tier mocks auto-expire after a default TTL (capped at a
    # maximum) and are rate limited per instance on the data plane. Set
    # APIOME_MOCK_SERVER_ENABLED=false to disable provisioning + serving entirely.
    mock_server_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_MOCK_SERVER_ENABLED",
            "mock_server_enabled",
        ),
    )
    mock_default_ttl_hours: int = Field(
        default=24,
        validation_alias=AliasChoices(
            "APIOME_MOCK_DEFAULT_TTL_HOURS",
            "mock_default_ttl_hours",
        ),
    )
    mock_max_ttl_hours: int = Field(
        default=168,  # 7 days
        validation_alias=AliasChoices(
            "APIOME_MOCK_MAX_TTL_HOURS",
            "mock_max_ttl_hours",
        ),
    )
    mock_rate_limit_per_minute: int = Field(
        default=60,
        validation_alias=AliasChoices(
            "APIOME_MOCK_RATE_LIMIT_PER_MINUTE",
            "mock_rate_limit_per_minute",
        ),
    )
    mock_public_base_url: str = Field(
        default="http://localhost:8775",
        validation_alias=AliasChoices(
            "APIOME_MOCK_PUBLIC_BASE_URL",
            "mock_public_base_url",
        ),
        description="Public base URL for hosted mock runtime (no trailing slash).",
    )
    slate_portal_base_url: str = Field(
        default="https://portal.apiome.dev",
        validation_alias=AliasChoices(
            "APIOME_SLATE_PORTAL_BASE_URL",
            "slate_portal_base_url",
        ),
        description=(
            "Canonical base URL of published Slate documentation portals, used to build "
            "the human-page and agent-output URLs a project's portal is served under "
            "(no trailing slash). A project's portal root is this value plus '/<project_slug>'."
        ),
    )

    # MCP test harness (#3689, V2-MCP-22.3 / MCAT-8.3). Each live test invocation against a
    # cataloged endpoint hits a real external server, so the test console is rate limited
    # *per endpoint* (in addition to the global per-tenant middleware) to protect that server
    # from a flood of test traffic. The fixed window matches the global limiter's
    # ``rate_limit_window_seconds``, and the per-endpoint limit honours the global
    # ``rate_limit_enabled`` kill switch.
    mcp_test_rate_limit_per_minute: int = Field(
        default=30,
        validation_alias=AliasChoices(
            "APIOME_MCP_TEST_RATE_LIMIT_PER_MINUTE",
            "mcp_test_rate_limit_per_minute",
        ),
    )

    # Public browse export guards (MFX-7.3, #3862). The anonymous
    # ``/v1/browse/.../export/*`` surface runs emitters without auth, so it gets a
    # dedicated per-IP rate limit (in addition to the global middleware) and a hard
    # cap on ``/document`` response size. Both honour ``rate_limit_enabled`` for the
    # limiter only; set ``public_browse_export_document_max_bytes`` to ``0`` to disable
    # the size cap.
    public_browse_export_rate_limit_per_minute: int = Field(
        default=30,
        validation_alias=AliasChoices(
            "APIOME_PUBLIC_BROWSE_EXPORT_RATE_LIMIT_PER_MINUTE",
            "public_browse_export_rate_limit_per_minute",
        ),
    )
    public_browse_export_document_max_bytes: int = Field(
        default=8_388_608,  # 8 MiB — matches archive_max_file_bytes
        validation_alias=AliasChoices(
            "APIOME_PUBLIC_BROWSE_EXPORT_DOCUMENT_MAX_BYTES",
            "public_browse_export_document_max_bytes",
        ),
    )

    # Async export job artifact retention (MFX-4.3, #3850). A completed export job keeps its
    # emitted artifact bytes in memory so the download route can serve them without re-emitting.
    # That retained artifact is *temporary*: after this many hours it is dropped and the
    # download route returns 410 Gone (the poller must resubmit the job). Set to ``0`` (or any
    # non-positive value) to disable expiry entirely — the artifact is then retained for the
    # process lifetime, matching the pre-4.3 behaviour.
    export_artifact_retention_hours: int = Field(
        default=24,
        validation_alias=AliasChoices(
            "APIOME_EXPORT_ARTIFACT_RETENTION_HOURS",
            "export_artifact_retention_hours",
        ),
    )

    # Shared export artifact size guards (IXH-6.1, #5120). At emit time the delivery payload
    # (single-file UTF-8 or multi-file zip) must fit under ``export_artifact_max_bytes`` or the
    # job fails with a clear error rather than storing a truncated body. Artifacts at or below
    # ``export_artifact_db_max_bytes`` are stored as a DB BYTEA; larger ones (still under the
    # hard cap) select the object-store driver. Defaults are equal so production always uses
    # the DB backend until an object store is configured and the DB threshold is lowered.
    export_artifact_max_bytes: int = Field(
        default=33_554_432,  # 32 MiB
        validation_alias=AliasChoices(
            "APIOME_EXPORT_ARTIFACT_MAX_BYTES",
            "export_artifact_max_bytes",
        ),
    )
    export_artifact_db_max_bytes: int = Field(
        default=33_554_432,  # 32 MiB — same as hard cap → DB-only until object store lands
        validation_alias=AliasChoices(
            "APIOME_EXPORT_ARTIFACT_DB_MAX_BYTES",
            "export_artifact_db_max_bytes",
        ),
    )

    # Async job row retention (IXH-6.3, #5122). Terminal jobs older than these windows
    # (measured from updated_at) are claimed by the scheduled sweep, summarized into
    # async_job_history, then deleted (export artifacts CASCADE). ``0`` disables reap for
    # that (kind, state) pair. Defaults: completed/canceled 7d, failed 30d.
    async_job_retention_export_completed_hours: int = Field(
        default=168,
        validation_alias=AliasChoices(
            "APIOME_ASYNC_JOB_RETENTION_EXPORT_COMPLETED_HOURS",
            "async_job_retention_export_completed_hours",
        ),
    )
    async_job_retention_export_failed_hours: int = Field(
        default=720,
        validation_alias=AliasChoices(
            "APIOME_ASYNC_JOB_RETENTION_EXPORT_FAILED_HOURS",
            "async_job_retention_export_failed_hours",
        ),
    )
    async_job_retention_export_canceled_hours: int = Field(
        default=168,
        validation_alias=AliasChoices(
            "APIOME_ASYNC_JOB_RETENTION_EXPORT_CANCELED_HOURS",
            "async_job_retention_export_canceled_hours",
        ),
    )
    async_job_retention_spec_import_completed_hours: int = Field(
        default=168,
        validation_alias=AliasChoices(
            "APIOME_ASYNC_JOB_RETENTION_SPEC_IMPORT_COMPLETED_HOURS",
            "async_job_retention_spec_import_completed_hours",
        ),
    )
    async_job_retention_spec_import_failed_hours: int = Field(
        default=720,
        validation_alias=AliasChoices(
            "APIOME_ASYNC_JOB_RETENTION_SPEC_IMPORT_FAILED_HOURS",
            "async_job_retention_spec_import_failed_hours",
        ),
    )
    async_job_retention_spec_import_canceled_hours: int = Field(
        default=168,
        validation_alias=AliasChoices(
            "APIOME_ASYNC_JOB_RETENTION_SPEC_IMPORT_CANCELED_HOURS",
            "async_job_retention_spec_import_canceled_hours",
        ),
    )
    async_job_history_retention_days: int = Field(
        default=90,
        validation_alias=AliasChoices(
            "APIOME_ASYNC_JOB_HISTORY_RETENTION_DAYS",
            "async_job_history_retention_days",
        ),
    )
    async_job_retention_sweep_batch_size: int = Field(
        default=100,
        validation_alias=AliasChoices(
            "APIOME_ASYNC_JOB_RETENTION_SWEEP_BATCH_SIZE",
            "async_job_retention_sweep_batch_size",
        ),
    )

    # Quality-rank telemetry retention (IXH-2.7, #5102). Every grade an import or export
    # produces appends one apiome.quality_rank_observations row, so the table grows with
    # traffic. The default window is comfortably wider than the widest window the trends
    # API will aggregate (quality_rank_telemetry.MAX_WINDOW_DAYS), so retention can never
    # truncate a supported read. 0 or below keeps observations forever.
    quality_rank_retention_days: int = Field(
        default=180,
        validation_alias=AliasChoices(
            "APIOME_QUALITY_RANK_RETENTION_DAYS",
            "quality_rank_retention_days",
        ),
    )

    # Schema test suites (IXH-5.7, #5119). Suites persist payloads plus expected verdicts
    # and re-run them per revision, so both halves are bounded: content (payloads per suite,
    # 256 KiB per payload via the V240 CHECK, findings persisted per result) and history
    # (runs per suite pruned on write beyond the cap; runs older than the retention window
    # pruned by the IXH-6.3 sweep tick, always keeping each suite's newest ``keep_min`` so
    # a rarely-run suite never loses its regression baseline). retention_days of 0 or below
    # keeps runs forever; the per-suite cap still applies.
    schema_suite_max_payloads: int = Field(
        default=50,
        validation_alias=AliasChoices(
            "APIOME_SCHEMA_SUITE_MAX_PAYLOADS",
            "schema_suite_max_payloads",
        ),
    )
    schema_suite_result_findings_cap: int = Field(
        default=20,
        validation_alias=AliasChoices(
            "APIOME_SCHEMA_SUITE_RESULT_FINDINGS_CAP",
            "schema_suite_result_findings_cap",
        ),
    )
    schema_suite_run_retention_days: int = Field(
        default=180,
        validation_alias=AliasChoices(
            "APIOME_SCHEMA_SUITE_RUN_RETENTION_DAYS",
            "schema_suite_run_retention_days",
        ),
    )
    schema_suite_run_keep_min: int = Field(
        default=20,
        validation_alias=AliasChoices(
            "APIOME_SCHEMA_SUITE_RUN_KEEP_MIN",
            "schema_suite_run_keep_min",
        ),
    )
    schema_suite_run_max_per_suite: int = Field(
        default=200,
        validation_alias=AliasChoices(
            "APIOME_SCHEMA_SUITE_RUN_MAX_PER_SUITE",
            "schema_suite_run_max_per_suite",
        ),
    )

    # Global auto-refresh kill switch (RAR-3.3, #3524). When False, the refresh
    # sweep halts entirely (no repository is auto-refreshed) regardless of per-repo
    # auto_refresh_enabled. Intended for incident response. Manual "Refresh Now"
    # (RAR-5.2) is unaffected. Per-repo opt-out is the auto_refresh_enabled column.
    refresh_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_REFRESH_ENABLED",
            "refresh_enabled",
        ),
    )

    # Repository webhook ingestion (REPO-4.3, #2781). Provider push/PR deliveries make a
    # repository due for the RAR-3.2 sweep immediately instead of at the end of its cadence.
    #
    # repository_webhook_enabled       Kill switch for the ingestion endpoint. When False a
    #                                  delivery is accepted (so the provider stops retrying),
    #                                  recorded in the ledger, and dispatches nothing.
    # repository_webhook_pr_preview_enabled
    #                                  Deployment-wide gate on the pull-request preview scan.
    #                                  Overrides the per-subscription pr_preview_enabled flag;
    #                                  either being False disables PR scans.
    # repository_webhook_base_url      Public base URL deliveries arrive at, e.g.
    #                                  https://api.apiome.dev. Required to auto-create a
    #                                  provider hook at registration time; unset leaves every
    #                                  subscription in the `local` state, which honours signed
    #                                  deliveries but has no hook pointing at it.
    repository_webhook_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_ENABLED",
            "repository_webhook_enabled",
        ),
    )
    repository_webhook_pr_preview_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_PR_PREVIEW",
            "repository_webhook_pr_preview_enabled",
        ),
    )
    repository_webhook_base_url: str = Field(
        default="",
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_BASE_URL",
            "repository_webhook_base_url",
        ),
    )

    # Webhook signing-secret rotation (REPO-4.7, #2785). A rotation mints a new secret and
    # keeps the outgoing one verifying for a grace window, so deliveries already in flight —
    # and deliveries a provider keeps signing until its hook is updated — do not start
    # failing the moment an operator clicks "rotate".
    #
    # repository_webhook_secret_grace_seconds
    #                                  Default grace window, 24h per the ticket. A caller may
    #                                  ask for a different one per rotation; the request is
    #                                  clamped to [min, max] below rather than rejected, since
    #                                  a rotation refused on a validation technicality is a
    #                                  rotation that does not happen.
    # repository_webhook_secret_min_grace_seconds
    #                                  Floor. Zero would make rotation a hard cutover with no
    #                                  window at all, which is the failure mode this feature
    #                                  exists to remove; five minutes is the smallest window
    #                                  that still covers deliveries in flight.
    # repository_webhook_secret_max_grace_seconds
    #                                  Ceiling. A retired secret that verifies for a month is
    #                                  the audit finding the ticket opens with, so the window
    #                                  a tenant can ask for is bounded by the deployment.
    repository_webhook_secret_grace_seconds: int = Field(
        default=86400,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_SECRET_GRACE_SECONDS",
            "repository_webhook_secret_grace_seconds",
        ),
    )
    repository_webhook_secret_min_grace_seconds: int = Field(
        default=300,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_SECRET_MIN_GRACE_SECONDS",
            "repository_webhook_secret_min_grace_seconds",
        ),
    )
    repository_webhook_secret_max_grace_seconds: int = Field(
        default=604800,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_SECRET_MAX_GRACE_SECONDS",
            "repository_webhook_secret_max_grace_seconds",
        ),
    )

    # Webhook source-IP allowlist (REPO-7.6, #2804). The ingestion endpoint has no bearer
    # token, so without a network filter every unsigned POST on the internet buys a
    # subscription lookup and an HMAC comparison. These settings gate the filter that runs
    # *before* verification.
    #
    # repository_webhook_ip_allowlist_enabled
    #                                  Master switch, default OFF. Enforcement that turned
    #                                  itself on during an upgrade would silently 403 every
    #                                  existing deployment's deliveries, and providers retrying
    #                                  into a 403 is one of the quietest failures there is.
    #                                  Turn it on once the provider ranges have refreshed at
    #                                  least once (visible in the admin panel).
    # repository_webhook_ip_allowlist_strict
    #                                  What to do when a provider has *no* cached ranges — a
    #                                  fresh deployment, or an upstream endpoint that has never
    #                                  answered. Default False allows the delivery and logs a
    #                                  warning; True fails closed, for deployments that would
    #                                  rather take the outage than the exposure.
    # repository_webhook_trusted_proxy_hops
    #                                  How many reverse proxies the deployment operates in
    #                                  front of this service. 0 (default) trusts nothing but
    #                                  the socket peer and ignores X-Forwarded-For entirely,
    #                                  because an unverified header would let a caller name its
    #                                  own source address. N > 0 reads the Nth entry from the
    #                                  right of the header; a shorter header means the request
    #                                  did not traverse the chain we believe in, and is refused.
    # repository_webhook_ip_refresh_interval_seconds
    #                                  Cadence of the provider range refresh (daily per the
    #                                  ticket). Measured from the last *success*, so a failing
    #                                  provider endpoint is retried on the next sweep tick.
    # repository_webhook_ip_cache_seconds
    #                                  Process-local TTL on the cached ranges. The guard runs
    #                                  on an unauthenticated route, so without it a flood of
    #                                  blocked deliveries is a flood of queries. Ranges move
    #                                  daily; a minute of staleness costs nothing.
    # repository_webhook_ip_ranges_{github,gitlab,bitbucket}
    #                                  Comma-separated CIDRs merged into each provider's cache
    #                                  on every refresh. GitLab.com publishes no
    #                                  machine-readable range list, so its entry is the only
    #                                  source for that provider; the other two exist for
    #                                  self-hosted instances no public endpoint knows about.
    repository_webhook_ip_allowlist_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_IP_ALLOWLIST",
            "repository_webhook_ip_allowlist_enabled",
        ),
    )
    repository_webhook_ip_allowlist_strict: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_IP_ALLOWLIST_STRICT",
            "repository_webhook_ip_allowlist_strict",
        ),
    )
    repository_webhook_trusted_proxy_hops: int = Field(
        default=0,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_TRUSTED_PROXY_HOPS",
            "repository_webhook_trusted_proxy_hops",
        ),
    )
    repository_webhook_ip_refresh_interval_seconds: int = Field(
        default=86400,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_IP_REFRESH_INTERVAL_SECONDS",
            "repository_webhook_ip_refresh_interval_seconds",
        ),
    )
    repository_webhook_ip_cache_seconds: int = Field(
        default=60,
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_IP_CACHE_SECONDS",
            "repository_webhook_ip_cache_seconds",
        ),
    )
    repository_webhook_ip_ranges_github: str = Field(
        default="",
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_IP_RANGES_GITHUB",
            "repository_webhook_ip_ranges_github",
        ),
    )
    repository_webhook_ip_ranges_gitlab: str = Field(
        default="",
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_IP_RANGES_GITLAB",
            "repository_webhook_ip_ranges_gitlab",
        ),
    )
    repository_webhook_ip_ranges_bitbucket: str = Field(
        default="",
        validation_alias=AliasChoices(
            "APIOME_REPOSITORY_WEBHOOK_IP_RANGES_BITBUCKET",
            "repository_webhook_ip_ranges_bitbucket",
        ),
    )

    # MCP catalog periodic re-discovery sweep (V2-MCP-19.1 / MCAT-5.1, #3673). A background
    # async loop re-handshakes enabled endpoints whose discovery cadence has elapsed, mirroring
    # the repository auto-refresh sweep above.
    #
    # mcp_discovery_enabled              Global kill switch. When False the sweep halts entirely
    #                                    (no endpoint is auto-discovered) regardless of per-endpoint
    #                                    `enabled`. Intended for incident response. Manual discovery
    #                                    (POST .../discover) is unaffected.
    # mcp_discovery_default_cadence_seconds  Cadence applied to an endpoint that has no explicit
    #                                    `discovery_cadence_seconds` override. Defaults to ~hourly,
    #                                    the registry-recommended aggregator cadence
    #                                    (https://modelcontextprotocol.io/registry/about).
    # mcp_discovery_min_interval_seconds The sweep's tick floor: how often the loop wakes to look
    #                                    for due endpoints. The per-endpoint cadence (not this floor)
    #                                    decides which endpoints are actually due each tick, so a
    #                                    small floor never re-discovers an endpoint faster than its
    #                                    own cadence allows.
    # mcp_discovery_max_concurrency      Per-tick concurrency cap (MCAT-5.2): the most discovery runs
    #                                    the sweep drives at once. The remaining due endpoints wait on
    #                                    a semaphore so a large backlog never floods the event loop,
    #                                    the network, or the DB with simultaneous handshakes.
    # mcp_discovery_endpoint_timeout_seconds  Per-endpoint wall-clock ceiling (MCAT-5.2) for one
    #                                    sweep discovery run end-to-end (handshake + pagination +
    #                                    persist). A run that exceeds it is cancelled and recorded as a
    #                                    `budget_exceeded` failure so a single slow/hung endpoint can
    #                                    never pin a sweep slot indefinitely. Keep it above the
    #                                    discovery client's own network budget (~120s) so the timeout
    #                                    is a backstop, not the primary bound.
    mcp_discovery_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_MCP_DISCOVERY_ENABLED",
            "mcp_discovery_enabled",
        ),
    )
    mcp_discovery_default_cadence_seconds: int = Field(
        default=3600,
        validation_alias=AliasChoices(
            "APIOME_MCP_DISCOVERY_DEFAULT_CADENCE",
            "mcp_discovery_default_cadence_seconds",
        ),
    )
    mcp_discovery_min_interval_seconds: int = Field(
        default=60,
        validation_alias=AliasChoices(
            "APIOME_MCP_DISCOVERY_MIN_INTERVAL",
            "mcp_discovery_min_interval_seconds",
        ),
    )
    mcp_discovery_max_concurrency: int = Field(
        default=4,
        validation_alias=AliasChoices(
            "APIOME_MCP_DISCOVERY_MAX_CONCURRENCY",
            "mcp_discovery_max_concurrency",
        ),
    )
    mcp_discovery_endpoint_timeout_seconds: int = Field(
        default=150,
        validation_alias=AliasChoices(
            "APIOME_MCP_DISCOVERY_ENDPOINT_TIMEOUT",
            "mcp_discovery_endpoint_timeout_seconds",
        ),
    )

    # Polyglot toolchain runner (MFI-5.1, #3750). The shared service that runs external
    # parser/linter/diff CLIs (buf, tsp, smithy, …) in a constrained subprocess.
    # toolchain_max_concurrency   Global cap on simultaneously-running tool subprocesses, so a
    #                             burst of imports cannot fork-bomb the host. Excess calls queue.
    # toolchain_default_timeout_seconds  Per-call wall-clock ceiling when a caller passes none; the
    #                             process is killed and a structured timeout error is raised.
    toolchain_max_concurrency: int = Field(
        default=4,
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_MAX_CONCURRENCY",
            "toolchain_max_concurrency",
        ),
    )
    toolchain_default_timeout_seconds: float = Field(
        default=30.0,
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_DEFAULT_TIMEOUT",
            "toolchain_default_timeout_seconds",
        ),
    )

    # Toolchain sandbox security & resource limits (MFI-5.3, #3752). Third-party CLIs run on
    # user-supplied input (a security surface: SSRF, code exec, zip bombs), so every tool
    # subprocess is constrained. These tune the constraints; see app.toolchain_sandbox.
    #
    # toolchain_no_network            Isolate the child in a fresh network namespace so it cannot
    #                                 reach any network (the no-network default). A tool that needs
    #                                 live discovery opts out per-call; its fetches must then go
    #                                 through the SSRF guard (#3612).
    # toolchain_network_enforcement   How hard to insist on isolation: "best_effort" (isolate when
    #                                 the kernel allows it, else log + continue) or "strict" (refuse
    #                                 to run the tool if the network cannot be isolated — fail closed).
    # toolchain_max_input_bytes       Reject a stdin payload larger than this *before* spawning.
    # toolchain_max_output_bytes      Kill the tool if its combined stdout+stderr exceeds this
    #                                 (a zip-bomb / runaway-output guard) and raise.
    # toolchain_file_size_bytes       RLIMIT_FSIZE: max size of any single file the tool writes.
    # toolchain_open_files            RLIMIT_NOFILE: max open file descriptors.
    # toolchain_cpu_seconds           RLIMIT_CPU (CPU-seconds, not wall-clock). None → rely on the
    #                                 per-call wall-clock timeout as the time bound.
    # toolchain_memory_bytes          RLIMIT_AS (address space). None by default: an address-space
    #                                 cap can break JVM tools (smithy/amf reserve large virtual
    #                                 space), so memory limiting is opt-in.
    # toolchain_max_processes         RLIMIT_NPROC fork-bomb guard. None by default: NPROC is
    #                                 per-UID, so a low value can disturb co-tenant processes; opt
    #                                 in where the runtime is isolated.
    toolchain_no_network: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_NO_NETWORK",
            "toolchain_no_network",
        ),
    )
    toolchain_network_enforcement: str = Field(
        default="best_effort",
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_NETWORK_ENFORCEMENT",
            "toolchain_network_enforcement",
        ),
    )
    toolchain_max_input_bytes: int = Field(
        default=33_554_432,  # 32 MiB
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_MAX_INPUT_BYTES",
            "toolchain_max_input_bytes",
        ),
    )
    toolchain_max_output_bytes: int = Field(
        default=67_108_864,  # 64 MiB
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_MAX_OUTPUT_BYTES",
            "toolchain_max_output_bytes",
        ),
    )
    toolchain_file_size_bytes: int = Field(
        default=536_870_912,  # 512 MiB
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_FILE_SIZE_BYTES",
            "toolchain_file_size_bytes",
        ),
    )
    toolchain_open_files: int = Field(
        default=1024,
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_OPEN_FILES",
            "toolchain_open_files",
        ),
    )
    toolchain_cpu_seconds: Optional[float] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_CPU_SECONDS",
            "toolchain_cpu_seconds",
        ),
    )
    toolchain_memory_bytes: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_MEMORY_BYTES",
            "toolchain_memory_bytes",
        ),
    )
    toolchain_max_processes: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_TOOLCHAIN_MAX_PROCESSES",
            "toolchain_max_processes",
        ),
    )
    # Archive upload intake (MFI-29.1, #4388). Applied while unpacking .zip / .tar.gz uploads
    # before any adapter parse runs — aligned with toolchain input caps where sensible.
    archive_max_entries: int = Field(
        default=500,
        validation_alias=AliasChoices(
            "APIOME_ARCHIVE_MAX_ENTRIES",
            "archive_max_entries",
        ),
    )
    archive_max_total_bytes: int = Field(
        default=33_554_432,  # 32 MiB uncompressed total
        validation_alias=AliasChoices(
            "APIOME_ARCHIVE_MAX_TOTAL_BYTES",
            "archive_max_total_bytes",
        ),
    )
    archive_max_file_bytes: int = Field(
        default=8_388_608,  # 8 MiB per member
        validation_alias=AliasChoices(
            "APIOME_ARCHIVE_MAX_FILE_BYTES",
            "archive_max_file_bytes",
        ),
    )
    archive_max_depth: int = Field(
        default=32,
        validation_alias=AliasChoices(
            "APIOME_ARCHIVE_MAX_DEPTH",
            "archive_max_depth",
        ),
    )
    # IXH-6.5 (#5124): optional force of the intake GuardProfile tier. When unset,
    # resolution falls through license-plan hint → default. Values: default | elevated.
    intake_guard_profile: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_GUARD_PROFILE",
            "intake_guard_profile",
        ),
    )
    # Soft hint for GuardProfile resolution (paid-looking plans → elevated). Not a
    # license-enforcement control — only selects resource ceilings.
    license_plan_hint: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices(
            "APIOME_LICENSE_PLAN_HINT",
            "license_plan_hint",
        ),
    )
    # Bulk import of independent specs (MFI-29.5, #4392). Ceiling on how many separate
    # import jobs one archive/repository payload may start. A payload holding more
    # reports the overflow (truncated + skipped rows) instead of importing a prefix.
    bulk_import_max_items: int = Field(
        default=50,
        validation_alias=AliasChoices(
            "APIOME_BULK_IMPORT_MAX_ITEMS",
            "bulk_import_max_items",
        ),
    )
    # Archive compression-ratio ceiling (uncompressed total / compressed size).
    archive_max_compression_ratio: float = Field(
        default=100.0,
        validation_alias=AliasChoices(
            "APIOME_ARCHIVE_MAX_COMPRESSION_RATIO",
            "archive_max_compression_ratio",
        ),
    )

    # MCP discovery failure handling, backoff & quarantine (V2-MCP-19.3 / MCAT-5.3, #3675). A
    # flaky/dead endpoint must not wedge the sweep or spam failures: each failed discovery defers
    # the endpoint by an exponential backoff, and after enough consecutive failures it is
    # quarantined (auto-excluded from the sweep) until it recovers.
    #
    # mcp_discovery_quarantine_threshold  Consecutive failures after which an endpoint is
    #                                    quarantined and an event emitted. <= 0 disables quarantine
    #                                    (endpoints keep backing off but are never auto-disabled).
    # mcp_discovery_backoff_base_seconds The first-failure backoff delay and the exponential's unit:
    #                                    the Nth consecutive failure defers by base * 2**(N-1).
    # mcp_discovery_backoff_max_seconds  Ceiling on the exponential backoff so a long-dead endpoint
    #                                    is still re-checked periodically (and can recover). A
    #                                    server-supplied 429 Retry-After is honoured as a floor and
    #                                    may exceed this ceiling.
    mcp_discovery_quarantine_threshold: int = Field(
        default=5,
        validation_alias=AliasChoices(
            "APIOME_MCP_DISCOVERY_QUARANTINE_THRESHOLD",
            "mcp_discovery_quarantine_threshold",
        ),
    )
    mcp_discovery_backoff_base_seconds: int = Field(
        default=60,
        validation_alias=AliasChoices(
            "APIOME_MCP_DISCOVERY_BACKOFF_BASE",
            "mcp_discovery_backoff_base_seconds",
        ),
    )
    mcp_discovery_backoff_max_seconds: int = Field(
        default=21600,  # 6 hours
        validation_alias=AliasChoices(
            "APIOME_MCP_DISCOVERY_BACKOFF_MAX",
            "mcp_discovery_backoff_max_seconds",
        ),
    )

    # Scheduled catalog digest reports (V2-MCP-33.5 / MCAT-19.5, #4654). A background async loop
    # (app.mcp_catalog_digest_sweep) compiles a periodic per-tenant digest — new endpoints, grade
    # movements, breaking changes, discovery-health problems — over the window since the tenant's
    # last digest and delivers it over the tenant's push-webhook subscriptions. The feature is
    # opt-in per tenant (apiome.mcp_catalog_digest_configs.enabled); these settings govern the loop.
    #
    # mcp_digest_enabled               Global kill switch. When False the sweep halts entirely for a
    #                                  tick (no selection, no compile, no delivery), for incident
    #                                  response — independent of per-tenant opt-in.
    # mcp_digest_default_cadence_seconds  Cadence applied to a tenant whose config has no explicit
    #                                  cadence_seconds override. Defaults to weekly.
    # mcp_digest_min_interval_seconds  The sweep's tick floor: how often the loop wakes to look for
    #                                  due tenants. Cheap; the per-tenant cadence gates actual sends.
    mcp_digest_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "APIOME_MCP_DIGEST_ENABLED",
            "mcp_digest_enabled",
        ),
    )
    mcp_digest_default_cadence_seconds: int = Field(
        default=604800,  # 7 days
        validation_alias=AliasChoices(
            "APIOME_MCP_DIGEST_DEFAULT_CADENCE",
            "mcp_digest_default_cadence_seconds",
        ),
    )
    mcp_digest_min_interval_seconds: int = Field(
        default=300,
        validation_alias=AliasChoices(
            "APIOME_MCP_DIGEST_MIN_INTERVAL",
            "mcp_digest_min_interval_seconds",
        ),
    )

    # Dependency-vulnerability lookup for the MCP supply-chain scan (CLX-3.2, #4856). OFF by default:
    # the trust-posture scan is fully offline unless an operator turns this on, which is what the
    # roadmap asks for ("start with local/offline tools; third-party scanning APIs are optional
    # adapters").
    #
    # When enabled, app.mcp_vulnerability queries the OSV database with PACKAGE COORDINATES ONLY —
    # a list of purls, nothing else. No source, manifest text, file path, repository URL, tenant, or
    # endpoint identity is ever transmitted; app.mcp_vulnerability.query_payload_for_audit exposes the
    # exact request body so that guarantee is testable rather than merely asserted.
    #
    # When disabled (or when OSV cannot be reached), the scan records outcome `not_run` /
    # `unavailable` with a stated reason — never an empty vulnerability list. "We never asked" and
    # "we asked and the answer was zero" must not render the same way.
    mcp_vulnerability_scan_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_MCP_VULNERABILITY_SCAN_ENABLED",
            "mcp_vulnerability_scan_enabled",
        ),
    )

    # MCP dynamic probes (CLX-3.3, #4857). Consent-gated, sandboxed active probing of live MCP
    # servers, which sends the server crafted requests and classifies what it does as observed or
    # exploited-in-test. This is the most dangerous MCP feature in the product — it puts traffic on
    # the wire and, for stdio targets, executes untrusted code — so it is gated on multiple axes and
    # every one of these defaults to the safe value.
    #
    # mcp_probe_enabled  THE GLOBAL KILL SWITCH (AC5). When False (the default) NO active probe runs
    #                    for ANY tenant, regardless of consent — the single flag an operator flips to
    #                    freeze the feature during an incident. The read-only PASSIVE profile is
    #                    unaffected: it sends nothing, so it keeps classifying observed behaviour even
    #                    while active probing is off. Turning this on does not by itself run anything;
    #                    a run still needs an allowlisted target, a valid consent record, and (for
    #                    stdio) a least-privilege sandbox.
    mcp_probe_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices("APIOME_MCP_PROBE_ENABLED", "mcp_probe_enabled"),
    )
    # The most active probe runs one tenant may have IN FLIGHT at once (AC5 concurrency limit). The
    # authoritative in-flight count comes from the audit table (mcp_probe_runs in status 'running'),
    # so this cap holds across API replicas and restarts.
    mcp_probe_max_concurrent_per_tenant: int = Field(
        default=2,
        validation_alias=AliasChoices(
            "APIOME_MCP_PROBE_MAX_CONCURRENT_PER_TENANT",
            "mcp_probe_max_concurrent_per_tenant",
        ),
    )
    # The most active probe runs one tenant may START per rolling hour (AC5 rate limit).
    mcp_probe_max_runs_per_hour_per_tenant: int = Field(
        default=20,
        validation_alias=AliasChoices(
            "APIOME_MCP_PROBE_MAX_RUNS_PER_HOUR_PER_TENANT",
            "mcp_probe_max_runs_per_hour_per_tenant",
        ),
    )
    # The most JSON-RPC requests a single active run may send (a hard per-run cap, enforced by the
    # counting transport, not merely recorded). A probe run is a diagnostic, not a load test.
    mcp_probe_max_requests_per_run: int = Field(
        default=50,
        validation_alias=AliasChoices(
            "APIOME_MCP_PROBE_MAX_REQUESTS_PER_RUN",
            "mcp_probe_max_requests_per_run",
        ),
    )

    # MCP trust-baseline drift detection (CLX-3.4, #4858). A trust manifest (identity, transport, the
    # reused surface fingerprint, policy-relevant tool authority annotations, and source/SBOM digests)
    # is diffed against an operator-approved baseline, and each material change is classified as a
    # normal change, a quality regression, a security regression, or coverage loss.
    #
    # mcp_trust_drift_gate_enabled  When True, a drift report whose gate is BLOCKED (a configured risk
    #                               delta was detected against the approved baseline) is reported as a
    #                               hard gate. When False (the default) the same drift is still computed
    #                               and surfaced, but the gate is advisory only — an operator enables
    #                               blocking once baselines are established. Computing and viewing drift
    #                               never depends on this flag; only whether the gate blocks.
    mcp_trust_drift_gate_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_MCP_TRUST_DRIFT_GATE_ENABLED",
            "mcp_trust_drift_gate_enabled",
        ),
    )
    # THE NOTIFICATION KILL SWITCH. When False (the default) no drift alert is fanned out over the
    # push-webhook channel, regardless of severity — the single flag an operator flips to silence drift
    # notifications during noisy migrations without losing the on-demand drift view.
    mcp_trust_drift_notify_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "APIOME_MCP_TRUST_DRIFT_NOTIFY_ENABLED",
            "mcp_trust_drift_notify_enabled",
        ),
    )

    # Observability & error handling (RC1-3.2, #3617). Structured JSON logs, request-id
    # propagation, in-process request metrics, and an ops dashboard that surfaces backup status.
    #
    # log_level     standard logging level name (DEBUG/INFO/WARNING/ERROR/CRITICAL).
    # log_json      emit one JSON object per log line (production default). Set false for
    #               human-friendly console output in local development.
    # request_id_header  inbound/outbound header carrying the per-request correlation id. When a
    #               client (or upstream proxy) supplies it we reuse the value; otherwise we mint one.
    log_level: str = Field(
        default="INFO",
        validation_alias=AliasChoices("APIOME_LOG_LEVEL", "LOG_LEVEL", "log_level"),
    )
    log_json: bool = Field(
        default=True,
        validation_alias=AliasChoices("APIOME_LOG_JSON", "LOG_JSON", "log_json"),
    )
    request_id_header: str = Field(
        default="X-Request-ID",
        validation_alias=AliasChoices("APIOME_REQUEST_ID_HEADER", "request_id_header"),
    )

    # Backup status surfacing (RC1-3.2 reads RC1-1.3 manifests, #3617/#3613). The ops dashboard
    # scans this directory for ``*.manifest.json`` sidecars to report the latest backup per scope.
    # When unset, backup status is reported as "unconfigured" rather than failing.
    backup_dir: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("APIOME_BACKUP_DIR", "backup_dir"),
    )
    # A backup older than this many hours is flagged "stale" on the ops dashboard (RPO guard).
    backup_stale_after_hours: int = Field(
        default=24,
        validation_alias=AliasChoices(
            "APIOME_BACKUP_STALE_AFTER_HOURS",
            "backup_stale_after_hours",
        ),
    )

    @property
    def effective_log_level(self) -> int:
        """Resolve the configured ``log_level`` name to a stdlib logging integer (INFO fallback)."""
        return getattr(logging, str(self.log_level).strip().upper(), logging.INFO)

    @property
    def effective_database_url(self) -> str:
        """Get the database URL, preferring DATABASE_URL over building from components."""
        if self.database_url:
            return self.database_url
        return f"postgresql://{self.postgres_user}:{self.postgres_password}@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"

    @property
    def is_production(self) -> bool:
        """True when running in a production-like environment (fail-closed checks on)."""
        return self.app_env.strip().lower() in {"production", "prod"}

    @property
    def effective_jwt_secret(self) -> str:
        """
        Get the JWT secret, preferring BETTER_AUTH_SECRET over JWT_SECRET.

        Fail-closed in production: if neither secret is configured we refuse to fall back
        to the insecure built-in default (which would let anyone forge JWTs). In
        development the well-known default is returned with a warning so local setups
        keep working.

        Raises:
            RuntimeError: in production when no JWT secret is configured.
        """
        secret = self.better_auth_secret or self.jwt_secret
        if secret:
            return secret
        if self.is_production:
            raise RuntimeError(
                "JWT secret is not configured. Set BETTER_AUTH_SECRET (or JWT_SECRET) before "
                "starting apiome-rest in production; refusing to use the insecure default."
            )
        logger.warning(
            "Using the insecure built-in JWT secret. Set BETTER_AUTH_SECRET (or JWT_SECRET) "
            "for any non-local deployment."
        )
        return INSECURE_JWT_SECRET_FALLBACK

    @property
    def effective_slate_artifact_signing_key(self) -> str:
        """
        Get the key used to sign Slate deployment artifacts (APX-3.1, private-suite#2456).

        Deliberately *not* the JWT secret. An artifact signature answers "these are the bytes
        the build produced"; a JWT answers "this caller is who they claim". Sharing one key
        between them would mean a leaked session secret also lets an attacker mint artifact
        signatures that the activation gate accepts.

        Fail-closed in production, matching effective_jwt_secret: signing every artifact with
        a well-known value would make verification theatre, so we refuse to start instead. In
        development the built-in key is returned with a warning so local setups keep working.

        Raises:
            RuntimeError: in production when no artifact signing key is configured.
        """
        if self.slate_artifact_signing_key:
            return self.slate_artifact_signing_key
        if self.is_production:
            raise RuntimeError(
                "Slate artifact signing key is not configured. Set "
                "APIOME_SLATE_ARTIFACT_SIGNING_KEY before starting apiome-rest in production; "
                "refusing to sign deployment artifacts with the insecure default."
            )
        logger.warning(
            "Using the insecure built-in Slate artifact signing key. Set "
            "APIOME_SLATE_ARTIFACT_SIGNING_KEY for any non-local deployment."
        )
        return INSECURE_SLATE_SIGNING_KEY_FALLBACK

    @property
    def effective_slate_domain_zone(self) -> str:
        """
        Get the DNS zone this platform controls, which no tenant may claim (Slate 10.1, #119).

        Defaults to the configured DNS target itself. Every deployment points custom domains at a
        hostname inside its own zone, so deriving the reservation from the target means an
        operator who changes one cannot leave the other pointing at the previous platform — which
        would let a tenant attach a hostname the platform is still authoritative for.

        Returns:
            The reserved zone, lowercased and stripped of any trailing dot.
        """
        zone = (self.slate_domain_reserved_zone or self.slate_domain_dns_target or "").strip()
        return zone.rstrip(".").lower()

    @property
    def effective_slate_domain_verification_secret(self) -> str:
        """
        Get the secret custom-domain ownership tokens are derived from (Slate 10.1, #119).

        Fail-closed in production, matching effective_slate_artifact_signing_key. A token derived
        from a well-known value proves nothing: anyone could compute the token for a domain they
        do not own, publish it, and have this service confirm their ownership. In development the
        built-in value is returned with a warning so local setups keep working.

        Raises:
            RuntimeError: in production when no verification secret is configured.
        """
        if self.slate_domain_verification_secret:
            return self.slate_domain_verification_secret
        if self.is_production:
            raise RuntimeError(
                "Slate custom-domain verification secret is not configured. Set "
                "APIOME_SLATE_DOMAIN_VERIFICATION_SECRET before starting apiome-rest in "
                "production; refusing to derive ownership tokens from a well-known default."
            )
        logger.warning(
            "Using the insecure built-in Slate domain verification secret. Set "
            "APIOME_SLATE_DOMAIN_VERIFICATION_SECRET for any non-local deployment."
        )
        return INSECURE_SLATE_DOMAIN_SECRET_FALLBACK

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        """Exact CORS origins: configured comma-separated list, or the local dev defaults."""
        if self.cors_allowed_origins:
            return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]
        return list(DEFAULT_CORS_ORIGINS)

    @property
    def effective_cors_origin_regex(self) -> Optional[str]:
        """
        CORS origin regex: the configured value, or the *.apiome.dev default.

        An explicitly-empty string disables subdomain matching (returns None so the regex
        is not applied at all).
        """
        if self.cors_allowed_origin_regex is None:
            return DEFAULT_CORS_ORIGIN_REGEX
        stripped = self.cors_allowed_origin_regex.strip()
        return stripped or None

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,
        extra="ignore",
        populate_by_name=True,
    )


settings = Settings()

# Maximum number of HTTP delivery attempts before an event is moved to dead-letter.
# Shared by the delivery worker (push_webhook_delivery.py) and the DB query in database.py
# to ensure the retry policy is defined in exactly one place (#2588).
WEBHOOK_MAX_DELIVERY_ATTEMPTS: int = 4

