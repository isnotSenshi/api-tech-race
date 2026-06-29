# Dockerfile — empaqueta el stack Go en una imagen mínima, en DOS etapas.
#
# Go es compilado: produce un binario único y autocontenido. Por eso usamos
# multi-stage: una etapa "builder" pesada (con todo el toolchain de Go) para
# COMPILAR, y una etapa final chiquita que solo lleva el binario. La imagen que
# se publica no arrastra compilador ni código fuente: pesa unos pocos MB.

# ── Etapa 1: build ────────────────────────────────────────────────────────────
# golang:1.23-alpine -> toolchain de Go 1.23 sobre Alpine. Versión fija para que
# el build sea reproducible.
FROM golang:1.23-alpine AS builder

WORKDIR /src

# Copiamos el código fuente y el manifiesto.
# NO usamos 'go mod tidy': tidy resuelve el grafo COMPLETO incluyendo las deps de
# TEST de nuestras dependencias, y una de ellas (rogpeppe/go-internal) exige un
# Go más nuevo que el del builder, rompiendo el build. En cambio compilamos con
# GOFLAGS=-mod=mod: Go baja y agrega al go.sum SOLO lo que el código realmente
# importa en runtime (gin, pgx y sus deps), sin tocar las deps de test ajenas.
COPY . .
ENV GOFLAGS=-mod=mod

# Compilamos un binario estático.
#   CGO_ENABLED=0 -> sin dependencias de C; el binario no necesita libc en runtime,
#                    así corre en una imagen base mínima sin sorpresas de linking.
#   GOOS=linux    -> binario para Linux (el SO de la imagen final).
#   -ldflags="-s -w" -> quita tabla de símbolos e info de debug: binario más liviano.
# El módulo se llama race-go (ver go.mod); compilamos el paquete main del directorio.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/server .

# ── Etapa 2: runtime ──────────────────────────────────────────────────────────
# alpine:3.20 -> base mínima (~7MB). Alcanza de sobra para correr un binario
# estático de Go. Versión fija para reproducibilidad.
FROM alpine:3.20

WORKDIR /app

# Copiamos SOLO el binario compilado desde la etapa builder. Nada de fuente ni
# toolchain: eso es lo que mantiene la imagen final tan chica.
COPY --from=builder /bin/server /app/server

# Puerto interno en el que escucha el server. Documentativo; el mapeo real al
# host lo define docker-compose.yml.
EXPOSE 3000

# Comando que arranca el contenedor: ejecuta el binario directamente.
CMD ["/app/server"]
