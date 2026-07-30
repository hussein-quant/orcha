# orcha/runner — the sandbox wake image (spec §3.3a). Version-pinned to the CLI minor.
# Runs as a NON-ROOT user: Claude Code hard-refuses --dangerously-skip-permissions
# under root, and least-privilege is the right default anyway. On Linux hosts the
# bind-mounted workspace must be writable by uid 1000 (see docs/sandbox-mode.md);
# Docker Desktop (macOS/Windows) maps ownership transparently.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ripgrep python3 python3-venv jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
# node:22 ships a "node" user at uid 1000 — rename semantics matter less than the
# uid; reuse it as the runner identity with a real writable HOME.
ENV HOME=/home/node
USER node
WORKDIR /workspace
