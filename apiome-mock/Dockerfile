# syntax=docker/dockerfile:1

# Multi-stage image for apiome-mock (FastAPI). One image, two runtimes:
#
#   serve  hosted mock, resolves published versions from Postgres (the default CMD)
#   run    portable mock, serves a single PMR bundle with no database (#4742, PMR-1.2)
#
# Build from the repository root:
#   docker build -f apiome-mock/Dockerfile .
#
# Multi-architecture build (linux/amd64 + linux/arm64 — both base images and every wheel this
# runtime depends on publish for both):
#   apiome-mock/scripts/build-image.sh --push ghcr.io/apiome/apiome-mock:<tag>
#
# Run a bundle:
#   docker run --rm -p 8775:8775 -v "$PWD/mock-bundle.json:/bundle/mock-bundle.json:ro" \
#     ghcr.io/apiome/apiome-mock:<tag> run
#
# Prove the running container behaves like every other deployment of the runtime:
#   docker exec <container> apiome-mock conformance --base-url http://127.0.0.1:8775

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder
WORKDIR /build

COPY apiome-rest/pyproject.toml /build/apiome-rest/pyproject.toml
COPY apiome-rest/README.md /build/apiome-rest/README.md
COPY apiome-rest/src /build/apiome-rest/src
COPY apiome-mcp/pyproject.toml /build/apiome-mcp/pyproject.toml
COPY apiome-mcp/README.md /build/apiome-mcp/README.md
COPY apiome-mcp/src /build/apiome-mcp/src
COPY apiome-mock/pyproject.toml /build/apiome-mock/pyproject.toml
COPY apiome-mock/README.md /build/apiome-mock/README.md
COPY apiome-mock/uv.lock /build/apiome-mock/uv.lock
COPY apiome-mock/src /build/apiome-mock/src

WORKDIR /build/apiome-mock

ENV UV_PROJECT_ENVIRONMENT=/app/.venv
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --compile-bytecode --no-editable

FROM python:3.12-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="apiome-mock" \
      org.opencontainers.image.description="Apiome mock runtime: hosted (serve) and portable bundle (run)." \
      org.opencontainers.image.source="https://github.com/apiome/apiome" \
      org.opencontainers.image.licenses="MIT"

# /bundle is the documented mount point for a portable bundle; it exists in the image so a
# read-only bind mount lands on a real directory owned by the unprivileged runtime user.
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin mock \
    && mkdir -p /app /bundle \
    && chown mock:mock /app /bundle

WORKDIR /app

COPY --from=builder --chown=mock:mock /app/.venv /app/.venv

USER mock

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/app/.venv

ENV APIOME_MOCK_HTTP_HOST=0.0.0.0 \
    APIOME_MOCK_HTTP_PORT=8775 \
    APIOME_MOCK_BUNDLE=/bundle/mock-bundle.json

EXPOSE 8775

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('APIOME_MOCK_HTTP_PORT','8775')}/health\", timeout=4)"

ENTRYPOINT ["apiome-mock"]
CMD ["serve"]
