# Dockerfile â€” empaqueta el stack Express en una imagen lista para correr.
#
# node:22-alpine -> Node.js 22 sobre Alpine Linux (imagen mÃ­nima, ~50MB base).
# VersiÃ³n fija (22) para que sea reproducible: hoy y dentro de un aÃ±o baja lo mismo.
FROM node:22-alpine

# Directorio de trabajo dentro del contenedor. Todo lo demÃ¡s es relativo a acÃ¡.
WORKDIR /app

# Truco de CACHE de capas de Docker:
# Copiamos PRIMERO solo el package.json y hacemos el install. Como esta capa solo
# cambia si cambian las dependencias, Docker la reutiliza en builds futuros aunque
# editemos server.js. Resultado: rebuilds mucho mÃ¡s rÃ¡pidos.
COPY package.json ./
RUN npm install --omit=dev

# ReciÃ©n ahora copiamos el resto del cÃ³digo (lo que cambia seguido).
COPY . .

# Puerto interno en el que escucha el server. Es documentativo; el mapeo real
# al host lo define docker-compose.yml.
EXPOSE 3000

# Comando que arranca el contenedor.
CMD ["node", "server.js"]
