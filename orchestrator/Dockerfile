# Dockerfile — orquestador (Node + el binario oha adentro).
#
# Usamos node:22-slim (Debian, glibc) en vez de alpine (musl) porque el binario
# oficial de oha está compilado para glibc y no corre sobre musl.
FROM node:22-slim

WORKDIR /app

# Instalamos oha: generador de carga HTTP escrito en Rust. Bajamos el binario
# del último release oficial (URL "latest/download" -> sin fijar versión a mano).
# Luego limpiamos para no dejar la imagen inflada.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL -o /usr/local/bin/oha \
       https://github.com/hatoo/oha/releases/latest/download/oha-linux-amd64 \
    && chmod +x /usr/local/bin/oha \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Cache de capas: primero deps, después código (ver Dockerfile de fastify).
COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 4000
CMD ["node", "server.js"]
