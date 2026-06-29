// ============================================================================
// server.js â€” Stack "express" de api-tech-race (JavaScript + Express 5)
//
// Mismo CONTRATO que el stack de referencia (Fastify): mismos endpoints, mismas
// respuestas JSON, mismos defaults, misma base Postgres. Lo Ãºnico que cambia es
// la tecnologÃ­a (acÃ¡ Express en vez de Fastify), para que la carrera sea justa.
//
// Endpoints (cubren los tipos de benchmark):
//   GET  /health        -> ping, no toca la DB
//   GET  /read/:id       -> #1 lectura simple (SELECT por PK)
//   GET  /read-heavy     -> #2 lectura pesada (JOIN, muchas filas)
//   POST /write          -> #3 escritura (INSERT)
//   GET  /aggregate      -> #5 agregaciÃ³n (GROUP BY sobre 1M)
//   GET  /compute        -> #6 CPU-bound, NO toca la DB
// (#4 mixto y #7 concurrencia los maneja el orquestador, no son endpoints).
// ============================================================================

import express from 'express'
import pg from 'pg'

const { Pool } = pg

// El driver pg devuelve los BIGINT (OID 20) como STRING para no perder precisiÃ³n
// (un bigint puede superar el entero seguro de JS, 2^53). Nuestros ids son chicos
// (< 1M), asÃ­ que los parseamos a nÃºmero para que el JSON sea consistente con los
// otros stacks (que devuelven el id como nÃºmero). setTypeParser es global a pg.
pg.types.setTypeParser(20, (v) => parseInt(v, 10))

// â”€â”€ Constantes de "fairness" (equidad) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Estas constantes DEBEN ser iguales en los 8 stacks, o la carrera se sesga.

// TamaÃ±o del pool de conexiones a Postgres. Cada request "pide prestada" una
// conexiÃ³n del pool y la devuelve al terminar. Si el pool es chico, bajo alta
// concurrencia los requests hacen cola esperando conexiÃ³n -> impacta el
// benchmark de escritura y de concurrencia. Lo fijamos en 10 para todos.
const POOL_MAX = 10

// LÃ­mite de filas que devuelve /read-heavy. Acotado para que nadie pueda pedir
// el millÃ³n entero y tumbar el proceso (y para que la prueba sea comparable).
const HEAVY_DEFAULT = 1000
const HEAVY_MAX = 10000

// ParÃ¡metro de /compute. fib(35) â‰ˆ 9 millones de llamadas recursivas: pesado
// pero rÃ¡pido. El tope evita que un n gigante cuelgue el servidor.
const FIB_DEFAULT = 35
const FIB_MAX = 45

// â”€â”€ Pool de conexiones a PostgreSQL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// El pool se crea UNA sola vez al arrancar y se reutiliza en todos los requests.
// Abrir una conexiÃ³n nueva por request serÃ­a lentÃ­simo; el pool las recicla.
// Los datos de conexiÃ³n llegan por variables de entorno (las define docker-compose).
// El host es "postgres" -> el NOMBRE del servicio en la red interna de Compose.
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'race',
  password: process.env.PGPASSWORD || 'race',
  database: process.env.PGDATABASE || 'race',
  max: POOL_MAX,
})

const app = express()

// Apagamos el header "X-Powered-By: Express". Es ruido y un byte menos por
// respuesta; no cambia el resultado pero es buena higiene en un benchmark.
app.disable('x-powered-by')

// IMPORTANTE: NO usamos express.json() ni ningÃºn body parser.
// NingÃºn endpoint LEE el body (los valores de /write son fijos por diseÃ±o, para
// que la carrera sea justa). Sin parser, Express simplemente ignora el cuerpo
// del POST sin intentar leerlo, asÃ­ que /write acepta cualquier Content-Type
// (o ninguno) sin devolver 415 ni pagar el overhead de parsear/buffrear.

// â”€â”€ #0  GET /health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ping simple. No toca la base. Sirve para saber si el servicio estÃ¡ vivo.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// â”€â”€ #1  GET /read/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Lectura simple: una fila por clave primaria. Es el "piso" del benchmark:
// mide red + parseo + driver + serializaciÃ³n JSON, con la DB haciendo lo mÃ­nimo
// (un lookup por Ã­ndice de PK, instantÃ¡neo).
app.get('/read/:id', async (req, res, next) => {
  const id = Number(req.params.id)
  // ValidaciÃ³n en el borde: si el id no es un entero positivo, 400 (Bad Request).
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id invÃ¡lido' })
  }
  try {
    // $1 es un parÃ¡metro: NUNCA concatenamos valores en el SQL (eso serÃ­a
    // vulnerable a inyecciÃ³n SQL). El driver los envÃ­a por separado y a salvo.
    const { rows } = await pool.query(
      'SELECT id, name, value, category_id, created_at FROM items WHERE id = $1',
      [id],
    )
    if (rows.length === 0) {
      return res.status(404).json({ error: 'no encontrado' })
    }
    res.json(rows[0])
  } catch (err) {
    // En Express 5 los rechazos de async handlers NO se capturan solos del todo
    // en todas las rutas; delegamos al manejador de errores con next(err) para
    // responder un 500 limpio en vez de dejar la promesa colgada.
    next(err)
  }
})

// â”€â”€ #2  GET /read-heavy?limit=1000 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Lectura pesada: muchas filas + JOIN con categories. AcÃ¡ pesa cuÃ¡nto tarda cada
// stack en SERIALIZAR a JSON un payload grande. Suele ser donde mÃ¡s se separan.
app.get('/read-heavy', async (req, res, next) => {
  let limit = Number(req.query.limit) || HEAVY_DEFAULT
  if (limit > HEAVY_MAX) limit = HEAVY_MAX
  if (limit < 1) limit = HEAVY_DEFAULT
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.name, i.value, i.created_at, c.name AS category
         FROM items i
         JOIN categories c ON c.id = i.category_id
        ORDER BY i.id
        LIMIT $1`,
      [limit],
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// â”€â”€ #3  POST /write â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Escritura: un INSERT. Mide cÃ³mo maneja transacciones y el pool bajo carga.
// Insertamos valores FIJOS a propÃ³sito: asÃ­ los 8 stacks hacen EXACTAMENTE el
// mismo trabajo en la DB y no dependemos de que oha mande un body. RETURNING id
// nos devuelve el id generado en la misma query (sin un segundo viaje a la DB).
app.post('/write', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO items (name, value, category_id) VALUES ($1, $2, $3) RETURNING id',
      ['bench_write', 42, 1],
    )
    res.json({ inserted: rows[0].id })
  } catch (err) {
    next(err)
  }
})

// â”€â”€ #5  GET /aggregate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AgregaciÃ³n: GROUP BY sobre el millÃ³n de filas. Castiga a los drivers/ORM
// lentos y mide trabajo real de la DB + serializaciÃ³n del resultado.
// Los ::int castean los bigint de count() a entero para que viajen como nÃºmero.
app.get('/aggregate', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.name AS category,
              count(*)::int        AS total,
              round(avg(i.value))::int AS avg_value
         FROM items i
         JOIN categories c ON c.id = i.category_id
        GROUP BY c.name
        ORDER BY c.name`,
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// â”€â”€ #6  GET /compute?n=35 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CPU-bound puro: SACA a la base de la ecuaciÃ³n y mide el lenguaje/runtime.
// Usamos Fibonacci RECURSIVO ingenuo a propÃ³sito: es O(2^n), idÃ©ntico de
// implementar en cualquier lenguaje, y exige CPU de verdad. AcÃ¡ es donde
// Rust/Go vuelan y Node/Python sufren.
//
// OJO didÃ¡ctico: Node es de UN solo hilo. Un fib(n) grande BLOQUEA el event
// loop y congela TODAS las peticiones concurrentes mientras calcula. Eso no es
// un bug: es justo la lecciÃ³n que el benchmark de concurrencia sobre /compute
// va a mostrar (modelo single-thread vs. goroutines/threads).
function fib(n) {
  if (n < 2) return n
  return fib(n - 1) + fib(n - 2)
}

app.get('/compute', (req, res) => {
  let n = Number(req.query.n)
  if (!Number.isInteger(n)) n = FIB_DEFAULT
  if (n > FIB_MAX) n = FIB_MAX
  if (n < 0) n = 0
  const result = fib(n)
  res.json({ n, result })
})

// â”€â”€ Manejador de errores central â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Express enruta acÃ¡ lo que llega por next(err). Respondemos un 500 escueto.
// No logueamos por request en el camino feliz; solo acÃ¡, ante un error real.
// eslint-disable-next-line no-unused-vars  (Express detecta el handler de error por su aridad de 4)
app.use((err, _req, res, _next) => {
  console.error('[express] error:', err)
  res.status(500).json({ error: 'error interno' })
})

// â”€â”€ Arranque del servidor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// host '0.0.0.0' (no 'localhost'): obligatorio dentro de Docker para que el
// servicio sea accesible desde fuera del contenedor. Con 'localhost' solo
// escucharÃ­a dentro del propio contenedor y nadie podrÃ­a conectarse.
const PORT = Number(process.env.PORT) || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[express] escuchando en :${PORT} (pool max=${POOL_MAX})`)
})
