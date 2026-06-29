# ============================================================================
# Dockerfile — empaqueta el stack Java + Spring Boot en una imagen para correr.
#
# Multi-stage (obligatorio en lenguajes compilados): compilamos con el JDK +
# Maven completos en una etapa "build", y corremos el jar resultante en una
# imagen runtime CHICA con solo el JRE. Así la imagen final no arrastra el
# compilador ni el repositorio de dependencias de Maven.
#
# OJO: este build es pesado y lento (Maven baja medio ecosistema Spring la
# primera vez y compila el fat jar). Es lo esperado para Java.
# ============================================================================

# ── Etapa 1: BUILD ──────────────────────────────────────────────────────────
# Imagen oficial con Maven 3.9 + Eclipse Temurin (OpenJDK) 21. Versión fija
# para que el build sea reproducible.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app

# Truco de CACHE de capas de Docker:
# Copiamos PRIMERO solo el pom.xml y bajamos las dependencias. Esta capa solo
# se invalida si cambian las dependencias (el pom), así que editar el código
# fuente NO vuelve a bajar medio internet en cada rebuild.
# go-offline deja el repositorio local de Maven poblado de antemano.
COPY pom.xml ./
RUN mvn -B dependency:go-offline

# Recién ahora copiamos el código fuente (lo que cambia seguido).
COPY src ./src

# Compilamos y empaquetamos el fat jar. -DskipTests: no corremos tests en el
# build de la imagen (no son parte del benchmark y alargan el build). -B = modo
# batch (sin colores/animaciones, log más limpio en CI/Docker).
RUN mvn -B clean package -DskipTests

# ── Etapa 2: RUNTIME ──────────────────────────────────────────────────────────
# Imagen mínima con SOLO el JRE 21 (sin compilador). Mucho más liviana.
FROM eclipse-temurin:21-jre
WORKDIR /app

# Copiamos ÚNICAMENTE el fat jar generado en la etapa de build y lo renombramos
# a app.jar (nombre estable, independiente de la versión del pom).
COPY --from=build /app/target/race-java-1.0.0.jar app.jar

# Puerto interno donde escucha Tomcat embebido. Documentativo; el mapeo real al
# host lo define docker-compose.yml.
EXPOSE 3000

# Arranca el servicio. El fat jar es autoejecutable: trae Tomcat embebido dentro.
ENTRYPOINT ["java", "-jar", "app.jar"]
