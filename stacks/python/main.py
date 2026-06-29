# ============================================================================
# main.py â€” Stack Python + FastAPI de api-tech-race.
#
# Es uno de los 8 contenders de la carrera. TODOS exponen exactamente el mismo
# contrato HTTP y le pegan a la MISMA base Postgres; lo Ãºnico que cambia es la
# tecnologÃ­a, para que la comparaciÃ³n sea justa. El stack de REFERENCIA es
# Fastify (JavaScript): este archivo copia su comportamiento al pie de la letra
# (mismos endpoints, mismos defaults, mismas respuestas JSON).
#
# Stack: Python 3.12 + FastAPI + uvicorn + asyncpg.
#   - FastAPI/uvicorn: framework web ASGI async, de los mÃ¡s rÃ¡pidos en Python.
#   - asyncpg: driver async nativo de Postgres (no usa el protocolo de psycopg;
#     habla el wire protocol directo -> es el driver mÃ¡s veloz del ecosistema).
#
# Endpoints (cubren los tipos de benchmark):
#   GET  /health       -> ping, no toca la DB
#   GET  /read/{id}    -> #1 lectura simple (SELECT por PK)
#   GET  /read-heavy   -> #2 lectura pesada (JOIN, muchas filas)
#   POST /write        -> #3 escritura (INSERT)
#   GET  /aggregate    -> #5 agregaciÃ³n (GROUP BY sobre 1M)
#   GET  /compute      -> #6 CPU-bound, no toca la DB
# ============================================================================

import os
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, ORJSONResponse

# â”€â”€ Constantes de "fairness" (equidad) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Estas constantes DEBEN ser iguales en los 8 stacks, o la carrera se sesga.

# TamaÃ±o del pool de conexiones a Postgres. Cada request "pide prestada" una
# conexiÃ³n y la devuelve al terminar. Con asyncpg fijamos min == max == 10 para
# que el pool tenga SIEMPRE 10 conexiones abiertas y calientes (sin pagar el
# costo de abrir conexiones nuevas bajo carga). Igual a 10 en todos los stacks.
POOL_SIZE = 10

# LÃ­mite de filas que devuelve /read-heavy. Acotado para que nadie pueda pedir
# el millÃ³n entero y tumbar el proceso (y para que la prueba sea comparable).
HEAVY_DEFAULT = 1000
HEAVY_MAX = 10000

# ParÃ¡metro de /compute. fib(35) â‰ˆ 9 millones de llamadas recursivas: pesado
# pero rÃ¡pido. El tope evita que un n gigante cuelgue el servidor.
FIB_DEFAULT = 35
FIB_MAX = 45


def _build_dsn() -> str:
    """Arma el DSN de conexiÃ³n a Postgres desde las variables de entorno.

    Acepta tanto DATABASE_URL completo como las variables individuales
    (PGHOST, PGPORT, ...). Usa los mismos defaults que el resto de los stacks.
    El host por defecto es "postgres": el nombre del servicio en la red interna
    de Docker Compose.
    """
    if url := os.getenv("DATABASE_URL"):
        return url
    host = os.getenv("PGHOST", "postgres")
    port = os.getenv("PGPORT", "5432")
    user = os.getenv("PGUSER", "race")
    password = os.getenv("PGPASSWORD", "race")
    database = os.getenv("PGDATABASE", "race")
    return f"postgresql://{user}:{password}@{host}:{port}/{database}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Ciclo de vida de la app: crea el pool al arrancar y lo cierra al apagar.

    El pool se crea UNA sola vez en el startup y se reutiliza en todos los
    requests. Abrir una conexiÃ³n nueva por request serÃ­a lentÃ­simo; el pool las
    recicla. Lo guardamos en app.state para que los handlers lo alcancen.
    """
    app.state.pool = await asyncpg.create_pool(
        dsn=_build_dsn(),
        # min == max: 10 conexiones fijas y siempre listas (ver POOL_SIZE).
        min_size=POOL_SIZE,
        max_size=POOL_SIZE,
    )
    yield
    await app.state.pool.close()


# default_response_class = ORJSONResponse: serializamos el JSON con orjson, que
# es notablemente mÃ¡s rÃ¡pido que el json de la stdlib y, clave acÃ¡, serializa
# datetime a ISO-8601 solo (sin tener que convertir a mano en cada fila). Esto
# importa sobre todo en /read-heavy, donde el costo dominante es serializar
# miles de filas a JSON.
app = FastAPI(default_response_class=ORJSONResponse, lifespan=lifespan)


# â”€â”€ #0  GET /health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Ping simple. No toca la base. Sirve para saber si el servicio estÃ¡ vivo.
@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# â”€â”€ #1  GET /read/{item_id} â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Lectura simple: una fila por clave primaria. Es el "piso" del benchmark: mide
# red + parseo + driver + serializaciÃ³n JSON, con la DB haciendo lo mÃ­nimo (un
# lookup por Ã­ndice de PK, instantÃ¡neo).
#
# OJO: el path param se declara como str (no int) a propÃ³sito. Si lo tipÃ¡ramos
# como int, FastAPI devolverÃ­a 422 ante un id no numÃ©rico; el contrato pide 400.
# Por eso validamos a mano y replicamos exactamente la lÃ³gica del stack de
# referencia: entero positivo o 400.
@app.get("/read/{item_id}")
async def read(item_id: str, request: Request):
    # int(item_id) parsea "123" pero lanza ValueError ante "abc", "1.5", etc.
    # El check < 1 cubre 0 y negativos. AsÃ­ un id no-entero-positivo -> 400.
    try:
        parsed = int(item_id)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "id invÃ¡lido"})
    if parsed < 1:
        return JSONResponse(status_code=400, content={"error": "id invÃ¡lido"})

    # $1 es un parÃ¡metro: NUNCA concatenamos valores en el SQL (serÃ­a vulnerable
    # a inyecciÃ³n). asyncpg los envÃ­a por separado y a salvo.
    row = await request.app.state.pool.fetchrow(
        "SELECT id, name, value, category_id, created_at FROM items WHERE id = $1",
        parsed,
    )
    if row is None:
        return JSONResponse(status_code=404, content={"error": "no encontrado"})

    # asyncpg devuelve un Record (tipo tupla/dict de solo lectura). Lo pasamos a
    # dict para que sea serializable. id viaja como nÃºmero (asyncpg ya devuelve
    # el BIGINT como int de Python, sin perder precisiÃ³n), y created_at como
    # datetime -> orjson lo serializa a ISO-8601 string automÃ¡ticamente.
    return dict(row)


# â”€â”€ #2  GET /read-heavy?limit=1000 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Lectura pesada: muchas filas + JOIN con categories. AcÃ¡ pesa cuÃ¡nto tarda cada
# stack en SERIALIZAR a JSON un payload grande. Suele ser donde mÃ¡s se separan.
#
# El parÃ¡metro entra como str para poder replicar al milÃ­metro la lÃ³gica del
# stack de referencia (JS: `Number(limit) || 1000`, luego clamps): un valor no
# numÃ©rico, ausente o 0 cae al default 1000; > 10000 se topea; < 1 vuelve a 1000.
@app.get("/read-heavy")
async def read_heavy(request: Request, limit: str | None = None):
    try:
        n = int(limit) if limit is not None else HEAVY_DEFAULT
    except ValueError:
        n = HEAVY_DEFAULT
    # Falsy (0) -> default, igual que `Number(x) || HEAVY_DEFAULT` en JS.
    if n == 0:
        n = HEAVY_DEFAULT
    if n > HEAVY_MAX:
        n = HEAVY_MAX
    if n < 1:
        n = HEAVY_DEFAULT

    rows = await request.app.state.pool.fetch(
        """
        SELECT i.id, i.name, i.value, i.created_at, c.name AS category
          FROM items i
          JOIN categories c ON c.id = i.category_id
         ORDER BY i.id
         LIMIT $1
        """,
        n,
    )
    # Convertimos cada Record a dict. orjson serializa la lista resultante.
    return [dict(r) for r in rows]


# â”€â”€ #3  POST /write â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Escritura: un INSERT. Mide cÃ³mo maneja el pool bajo carga.
# Insertamos valores FIJOS a propÃ³sito (ignoramos el body): asÃ­ los 8 stacks
# hacen EXACTAMENTE el mismo trabajo en la DB y no dependemos de que el cliente
# mande un body. RETURNING id nos devuelve el id generado en la misma query.
#
# No declaramos parÃ¡metro de body ni dependemos del Content-Type, asÃ­ que
# aceptamos el POST venga como venga (con o sin body, con o sin Content-Type).
@app.post("/write")
async def write(request: Request) -> dict:
    new_id = await request.app.state.pool.fetchval(
        "INSERT INTO items (name, value, category_id) VALUES ($1, $2, $3) RETURNING id",
        "bench_write",
        42,
        1,
    )
    return {"inserted": new_id}


# â”€â”€ #5  GET /aggregate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# AgregaciÃ³n: GROUP BY sobre el millÃ³n de filas. Castiga a los drivers lentos y
# mide trabajo real de la DB + serializaciÃ³n del resultado.
# count() y round(avg()) devuelven numeric/bigint; los casteamos a ::int para
# que viajen como nÃºmero entero (y para que asyncpg los entregue como int).
@app.get("/aggregate")
async def aggregate(request: Request):
    rows = await request.app.state.pool.fetch(
        """
        SELECT c.name AS category,
               count(*)::int             AS total,
               round(avg(i.value))::int  AS avg_value
          FROM items i
          JOIN categories c ON c.id = i.category_id
         GROUP BY c.name
         ORDER BY c.name
        """
    )
    return [dict(r) for r in rows]


# â”€â”€ #6  GET /compute?n=35 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# CPU-bound puro: SACA a la base de la ecuaciÃ³n y mide el lenguaje/runtime.
# Usamos Fibonacci RECURSIVO ingenuo a propÃ³sito: es O(2^n), idÃ©ntico de
# implementar en cualquier lenguaje, y exige CPU de verdad. NO memoizar ni pasar
# a iterativo: el punto es quemar la misma CPU en todos. AcÃ¡ es donde Rust/Go
# vuelan y Python sufre (es la lecciÃ³n del benchmark).
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


# El parÃ¡metro entra como str para replicar la lÃ³gica del stack de referencia
# (JS: si n no es entero -> default 35; > 45 -> 45; < 0 -> 0).
@app.get("/compute")
async def compute(n: str | None = None) -> dict:
    try:
        value = int(n) if n is not None else FIB_DEFAULT
    except ValueError:
        value = FIB_DEFAULT
    if value > FIB_MAX:
        value = FIB_MAX
    if value < 0:
        value = 0
    # Python maneja enteros de precisiÃ³n arbitraria, asÃ­ que el resultado de
    # fib(45) entra de sobra (cabrÃ­a incluso en 64 bits). Lo devolvemos como int.
    return {"n": value, "result": fib(value)}
