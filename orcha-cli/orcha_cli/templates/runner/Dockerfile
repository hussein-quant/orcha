# orcha/runner — the sandbox wake image (spec §3.3a). Version-pinned to the CLI minor.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ripgrep python3 python3-venv jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
    && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /workspace
