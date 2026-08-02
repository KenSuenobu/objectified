# Container image for apiome/diff-action (CTG-2.2) and shared CI recipes (CTG-2.4).
# Build context is this directory only (GitHub Actions docker actions constraint).
# Override APIOME_CLI_REF to pin the CLI commit/tag installed into the image.
FROM python:3.12-slim-bookworm

ARG APIOME_CLI_REF=main
ARG APIOME_CLI_REPO=https://github.com/apiome/apiome.git

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "apiome-cli @ git+${APIOME_CLI_REPO}@${APIOME_CLI_REF}#subdirectory=apiome-cli"

COPY entrypoint.sh ci_entrypoint.sh sticky_comment.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh \
    /usr/local/bin/ci_entrypoint.sh \
    /usr/local/bin/sticky_comment.sh

# Dual-mode entrypoint:
#   no arguments  -> GitHub Action mode (reads INPUT_* env vars, CTG-2.2)
#   any arguments -> passed through to the apiome CLI for bare CI recipes (CTG-2.4):
#     docker run --rm -e APIOME_API_KEY -e APIOME_TENANT_ID -v "$PWD:/work" -w /work \
#       <image> diff ./openapi.yaml --against proj@latest --fail-on breaking
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
