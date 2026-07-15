# Persona Arena Tier-0 backend (spec 217).
# Stage 1 builds lc0 (CPU, openblas) — the server has no GPU; the BT3 net is
# volume-mounted, not baked in (190MB, pinned sha verified at app startup).

FROM debian:bookworm-slim AS lc0-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ meson ninja-build pkg-config zlib1g-dev libopenblas-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 -b v0.31.2 --recurse-submodules \
    https://github.com/LeelaChessZero/lc0.git /lc0
WORKDIR /lc0
RUN ./build.sh release -Dgtest=false -Dblas=true \
    && strip build/release/lc0

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopenblas0 zlib1g curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=lc0-build /lc0/build/release/lc0 /usr/local/bin/lc0
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
# Single worker on purpose: one warm lc0 + one sqlite connection live in-process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
