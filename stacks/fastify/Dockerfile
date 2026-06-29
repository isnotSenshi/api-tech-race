# Dockerfile — empaqueta el stack Fastify en una imagen lista para correr.
#
# node:22-alpine -> Node.js 22 sobre Alpine Linux (imagen mínima, ~50MB base).
# Versión fija (22) para que sea reproducible: hoy y dentro de un año baja lo mismo.
FROM node:22-alpine

# Directorio de trabajo dentro del contenedor. Todo lo demás es relativo a acá.
WORKDIR /app

# Truco de CACHE de capas de Docker:
# Copiamos PRIMERO solo el package.json y hacemos el install. Como esta capa solo
# cambia si cambian las dependencias, Docker la reutiliza en builds futuros aunque
# editemos server.js. Resultado: rebuilds mucho más rápidos.
COPY package.json ./
RUN npm install --omit=dev

# Recién ahora copiamos el resto del código (lo que cambia seguido).
COPY . .

# Puerto interno en el que escucha el server. Es documentativo; el mapeo real
# al host lo define docker-compose.yml.
EXPOSE 3000

# Comando que arranca el contenedor.
CMD ["node", "server.js"]
