# Dockerfile — empaqueta el stack Rust + Axum en una imagen lista para correr.
#
# Multi-stage: compilamos en una imagen GRANDE con todo el toolchain de Rust y
# después copiamos SOLO el binario a una runtime CHICA. La imagen final no lleva
# el compilador ni las fuentes -> mucho más liviana y con menos superficie.

# ── Stage 1: build ───────────────────────────────────────────────────────────
# rust:1-slim -> toolchain de Rust 1.x sobre Debian slim. Versión de la línea 1
# fijada para reproducibilidad (no usamos "latest").
FROM rust:1-slim AS builder

WORKDIR /app

# Truco de CACHE de capas de Docker para el (lento) build de Rust:
# 1) Copiamos PRIMERO solo el Cargo.toml y compilamos un main.rs vacío. Esto baja
#    y compila TODAS las dependencias en una capa que solo se invalida si cambia
#    Cargo.toml. Editar src/main.rs después NO re-baja ni re-compila las deps.
COPY Cargo.toml ./
RUN mkdir src \
    && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src

# 2) Ahora sí copiamos el código real y compilamos el binario final. Las deps ya
#    están cacheadas del paso anterior, así que este build es incremental.
#    El `touch` fuerza a cargo a recompilar el binario (si no, ve el .rs viejo).
COPY src ./src
RUN touch src/main.rs && cargo build --release

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# debian:bookworm-slim -> base mínima de Debian. Le agregamos solo ca-certificates
# (buenas prácticas para TLS salientes; acá la DB es sin TLS pero no estorba).
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiamos ÚNICAMENTE el binario compilado desde el stage de build.
COPY --from=builder /app/target/release/race-rust /usr/local/bin/race-rust

# Puerto interno (documentativo; el mapeo real al host lo define docker-compose).
EXPOSE 3000

# Arranca el binario.
CMD ["race-rust"]
