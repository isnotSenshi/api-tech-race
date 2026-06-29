// ============================================================================
// server.js — Stack de REFERENCIA de api-tech-race (JavaScript + Fastify)
//
// Este archivo define el CONTRATO COMÚN que los otros 7 stacks van a copiar.
// Todos exponen exactamente los mismos endpoints, con el mismo comportamiento,
// pegándole a la misma base Postgres. Lo único que cambia entre stacks es la
// tecnología; así la carrera es justa.
//
// Endpoints (cubren los 7 tipos de benchmark):
//   GET  /health        -> ping, no toca la DB
//   GET  /read/:id       -> #1 lectura simple (SELECT por PK)
//   GET  /read-heavy     -> #2 lectura pesada (JOIN, muchas filas)
//   POST /write          -> #3 escritura (INSERT)
//   GET  /aggregate      -> #5 agregación (GROUP BY sobre 1M)
//   GET  /compute        -> #6 CPU-bound, NO toca la DB
// (#4 mixto y #7 concurrencia los maneja el orquestador, no son endpoints).
// ============================================================================

import Fastify from 'fastify'
import pg from 'pg'

const { Pool } = pg

// El driver pg devuelve los BIGINT (OID 20) como STRING para no perder precisión
// (un bigint puede superar el entero seguro de JS, 2^53). Nuestros ids son chicos
// (< 1M), así que los parseamos a número para que el JSON sea consistente con los
// otros stacks (que devuelven el id como número). setTypeParser es global a pg.
pg.types.setTypeParser(20, (v) => parseInt(v, 10))

// ── Constantes de "fairness" (equidad) ──────────────────────────────────────
// Estas dos constantes DEBEN ser iguales en los 8 stacks, o la carrera se sesga.

// Tamaño del pool de conexiones a Postgres. Cada request "pide prestada" una
// conexión del pool y la devuelve al terminar. Si el pool es chico, bajo alta
// concurrencia los requests hacen cola esperando conexión -> impacta el
// benchmark de escritura y de concurrencia. Lo fijamos en 10 para todos.
const POOL_MAX = 10

// Límite de filas que devuelve /read-heavy. Acotado para que nadie pueda pedir
// el millón entero y tumbar el proceso (y para que la prueba sea comparable).
const HEAVY_DEFAULT = 1000
const HEAVY_MAX = 10000

// Parámetro de /compute. fib(35) ≈ 9 millones de llamadas recursivas: pesado
// pero rápido. El tope evita que un n gigante cuelgue el servidor.
const FIB_DEFAULT = 35
const FIB_MAX = 45

// ── Pool de conexiones a PostgreSQL ─────────────────────────────────────────
// El pool se crea UNA sola vez al arrancar y se reutiliza en todos los requests.
// Abrir una conexión nueva por request sería lentísimo; el pool las recicla.
// Los datos de conexión llegan por variables de entorno (las define docker-compose).
// El host es "postgres" -> el NOMBRE del servicio en la red interna de Compose.
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'race',
  password: process.env.PGPASSWORD || 'race',
  database: process.env.PGDATABASE || 'race',
  max: POOL_MAX,
})

// logger: false -> apagamos el log por request. Loguear cada petición agregaría
// latencia y ensuciaría la medición. El middleware/overhead va al mínimo.
const app = Fastify({ logger: false })

// Ningún endpoint LEE el body (los valores de /write son fijos por diseño, para
// que la carrera sea justa). Por defecto Fastify devuelve 415 si llega un POST
// con un Content-Type que no sabe parsear. Con este parser comodín aceptamos
// cualquier content-type y descartamos el body sin intentar parsearlo.
app.addContentTypeParser('*', (_req, _payload, done) => done(null, null))

// ── #0  GET /health ─────────────────────────────────────────────────────────
// Ping simple. No toca la base. Sirve para saber si el servicio está vivo.
app.get('/health', async () => {
  return { status: 'ok' }
})

// ── #1  GET /read/:id ─────────────────────────────────────────────────────────
// Lectura simple: una fila por clave primaria. Es el "piso" del benchmark:
// mide red + parseo + driver + serialización JSON, con la DB haciendo lo mínimo
// (un lookup por índice de PK, instantáneo).
app.get('/read/:id', async (req, reply) => {
  const id = Number(req.params.id)
  // Validación en el borde: si el id no es un entero positivo, 400 (Bad Request).
  if (!Number.isInteger(id) || id < 1) {
    return reply.code(400).send({ error: 'id inválido' })
  }
  // $1 es un parámetro: NUNCA concatenamos valores en el SQL (eso sería
  // vulnerable a inyección SQL). El driver los envía por separado y a salvo.
  const { rows } = await pool.query(
    'SELECT id, name, value, category_id, created_at FROM items WHERE id = $1',
    [id],
  )
  if (rows.length === 0) {
    return reply.code(404).send({ error: 'no encontrado' })
  }
  return rows[0]
})

// ── #2  GET /read-heavy?limit=1000 ────────────────────────────────────────────
// Lectura pesada: muchas filas + JOIN con categories. Acá pesa cuánto tarda cada
// stack en SERIALIZAR a JSON un payload grande. Suele ser donde más se separan.
app.get('/read-heavy', async (req) => {
  let limit = Number(req.query.limit) || HEAVY_DEFAULT
  if (limit > HEAVY_MAX) limit = HEAVY_MAX
  if (limit < 1) limit = HEAVY_DEFAULT
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i.value, i.created_at, c.name AS category
       FROM items i
       JOIN categories c ON c.id = i.category_id
      ORDER BY i.id
      LIMIT $1`,
    [limit],
  )
  return rows
})

// ── #3  POST /write ───────────────────────────────────────────────────────────
// Escritura: un INSERT. Mide cómo maneja transacciones y el pool bajo carga.
// Insertamos valores FIJOS a propósito: así los 8 stacks hacen EXACTAMENTE el
// mismo trabajo en la DB y no dependemos de que oha mande un body. RETURNING id
// nos devuelve el id generado en la misma query (sin un segundo viaje a la DB).
app.post('/write', async () => {
  const { rows } = await pool.query(
    'INSERT INTO items (name, value, category_id) VALUES ($1, $2, $3) RETURNING id',
    ['bench_write', 42, 1],
  )
  return { inserted: rows[0].id }
})

// ── #5  GET /aggregate ────────────────────────────────────────────────────────
// Agregación: GROUP BY sobre el millón de filas. Castiga a los drivers/ORM
// lentos y mide trabajo real de la DB + serialización del resultado.
// Los ::int castean los bigint de count() a entero para que viajen como número.
app.get('/aggregate', async () => {
  const { rows } = await pool.query(
    `SELECT c.name AS category,
            count(*)::int        AS total,
            round(avg(i.value))::int AS avg_value
       FROM items i
       JOIN categories c ON c.id = i.category_id
      GROUP BY c.name
      ORDER BY c.name`,
  )
  return rows
})

// ── #6  GET /compute?n=35 ─────────────────────────────────────────────────────
// CPU-bound puro: SACA a la base de la ecuación y mide el lenguaje/runtime.
// Usamos Fibonacci RECURSIVO ingenuo a propósito: es O(2^n), idéntico de
// implementar en cualquier lenguaje, y exige CPU de verdad. Acá es donde
// Rust/Go vuelan y Node/Python sufren.
//
// OJO didáctico: Node es de UN solo hilo. Un fib(n) grande BLOQUEA el event
// loop y congela TODAS las peticiones concurrentes mientras calcula. Eso no es
// un bug: es justo la lección que el benchmark de concurrencia sobre /compute
// va a mostrar (modelo single-thread vs. goroutines/threads).
function fib(n) {
  if (n < 2) return n
  return fib(n - 1) + fib(n - 2)
}

app.get('/compute', async (req) => {
  let n = Number(req.query.n)
  if (!Number.isInteger(n)) n = FIB_DEFAULT
  if (n > FIB_MAX) n = FIB_MAX
  if (n < 0) n = 0
  const result = fib(n)
  return { n, result }
})

// ── Arranque del servidor ─────────────────────────────────────────────────────
// host '0.0.0.0' (no 'localhost'): obligatorio dentro de Docker para que el
// servicio sea accesible desde fuera del contenedor. Con 'localhost' solo
// escucharía dentro del propio contenedor y nadie podría conectarse.
const PORT = Number(process.env.PORT) || 3000
try {
  await app.listen({ host: '0.0.0.0', port: PORT })
  console.log(`[fastify] escuchando en :${PORT} (pool max=${POOL_MAX})`)
} catch (err) {
  console.error('[fastify] error al arrancar:', err)
  process.exit(1)
}
