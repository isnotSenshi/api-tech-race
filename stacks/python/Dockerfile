# Dockerfile â€” empaqueta el stack Python + FastAPI en una imagen lista para correr.
#
# python:3.12-slim -> Python 3.12 sobre Debian slim (imagen chica, sin las
# herramientas de compilaciÃ³n pesadas). VersiÃ³n fija para que sea reproducible.
# No hace falta multi-stage: Python es interpretado, no hay paso de compilaciÃ³n
# y las wheels de asyncpg/orjson/uvicorn ya vienen precompiladas para esta plataforma.
FROM python:3.12-slim

# Variables de entorno de buenas prÃ¡cticas para Python en contenedores:
#   PYTHONUNBUFFERED       -> stdout/stderr sin buffer (los logs salen al instante).
#   PYTHONDONTWRITEBYTECODE -> no escribir archivos .pyc (no aportan en un contenedor).
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Directorio de trabajo dentro del contenedor. Todo lo demÃ¡s es relativo a acÃ¡.
WORKDIR /app

# Truco de CACHE de capas de Docker:
# Copiamos PRIMERO solo requirements.txt e instalamos. Como esta capa solo
# cambia si cambian las dependencias, Docker la reutiliza en builds futuros
# aunque editemos main.py. Resultado: rebuilds mucho mÃ¡s rÃ¡pidos.
# --no-cache-dir: no guardar la cachÃ© de pip -> imagen final mÃ¡s liviana.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# ReciÃ©n ahora copiamos el resto del cÃ³digo (lo que cambia seguido).
COPY . .

# Puerto interno en el que escucha el server. Es documentativo; el mapeo real
# al host lo define docker-compose.yml.
EXPOSE 3000

# Comando que arranca el contenedor.
#   --host 0.0.0.0   -> obligatorio en Docker para ser accesible desde fuera del
#                       contenedor (con 127.0.0.1 solo escucharÃ­a adentro).
#   --port 3000      -> puerto del contrato.
#   --log-level warning -> SIN access log por request: loguear cada peticiÃ³n
#                       agrega latencia y sesga el benchmark. Middleware al mÃ­nimo.
#   (sin --reload: el reload es para desarrollo y mete overhead.)
#   (sin --workers: 1 solo proceso. Esto deja en evidencia el modelo single-thread
#    de Python en /compute, que es justo lo que el benchmark quiere mostrar; y
#    mantiene el pool de 10 conexiones a un Ãºnico proceso, comparable al resto.)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000", "--log-level", "warning"]
