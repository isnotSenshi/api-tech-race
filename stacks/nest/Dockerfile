# Dockerfile multi-stage — empaqueta el stack NestJS en una imagen lista para correr.
#
# Multi-stage = dos etapas:
#   1) "build": instala TODO (incluidas devDependencies como el compilador TS y el
#      CLI de Nest) y compila el TypeScript a JavaScript en dist/.
#   2) runtime: parte de una imagen limpia, instala SOLO dependencias de producción
#      y copia el dist/ ya compilado. Así la imagen final no carga el compilador ni
#      las dev-deps -> más chica y con menos superficie.

# ── Etapa 1: build ──────────────────────────────────────────────────────────
# node:22-alpine -> Node.js 22 sobre Alpine Linux (imagen mínima). Versión fija
# (22-alpine) para que el build sea reproducible hoy y dentro de un año.
FROM node:22-alpine AS build
WORKDIR /app

# Truco de CACHE de capas: copiamos primero solo el package.json. Esta capa
# (npm install) solo se rehace si cambian las dependencias; si solo editamos
# código fuente, Docker la reutiliza y el rebuild es mucho más rápido.
COPY package.json ./
# npm install (no 'npm ci') porque no versionamos el package-lock.json: se deja
# que se resuelva en el build. Necesitamos también las devDependencies acá para
# poder compilar (tsc + @nestjs/cli), por eso NO usamos --omit=dev en esta etapa.
RUN npm install

# Ahora sí, el resto: config de TS/Nest y el código fuente.
COPY tsconfig.json nest-cli.json ./
COPY src ./src

# Compila TypeScript -> JavaScript en /app/dist (entrypoint: dist/main.js).
RUN npm run build

# ── Etapa 2: runtime ─────────────────────────────────────────────────────────
# Misma base fija, pero esta imagen quedará liviana: solo prod-deps + dist/.
FROM node:22-alpine AS runtime
WORKDIR /app

# NODE_ENV=production: deshabilita comportamientos de desarrollo de algunas libs
# y asegura que dependencias instaladas se traten como de producción.
ENV NODE_ENV=production

# Instalamos SOLO las dependencias de producción (--omit=dev): nada de compilador
# ni CLI de Nest en la imagen final.
COPY package.json ./
RUN npm install --omit=dev

# Copiamos el JS ya compilado desde la etapa de build. No copiamos src/ ni tsconfig:
# en runtime solo se ejecuta JavaScript.
COPY --from=build /app/dist ./dist

# Puerto interno donde escucha el server. Documentativo; el mapeo real al host lo
# define docker-compose.yml.
EXPOSE 3000

# Arranca el servicio compilado.
CMD ["node", "dist/main.js"]
