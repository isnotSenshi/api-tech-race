// ============================================================================
// server.js — ORQUESTADOR (motor de medición) de api-tech-race.
//
// Es el "árbitro" de la carrera. El front le manda una config
//   { stack, op, requests, concurrency }
// y el orquestador:
//   1) arma la URL del stack elegido (por la red interna de Docker),
//   2) corre `oha` (generador de carga HTTP) contra ese endpoint,
//   3) parsea la salida JSON de oha y devuelve métricas limpias.
//
// ¿Por qué un orquestador y no disparar desde el navegador? El browser limita
// las conexiones concurrentes y mide mal. oha, en cambio, está hecho para esto:
// genera carga real y reporta percentiles (p50/p95/p99), throughput, etc.
// ============================================================================

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// execFile en versión promesa: corremos oha como proceso hijo y esperamos su salida.
const execFileAsync = promisify(execFile)

// ── Registro de stacks ────────────────────────────────────────────────────
// Nombre lógico -> framework (para mostrar) + URL base en la red interna de
// Compose. El host es el NOMBRE del servicio (no localhost): dentro de la red
// de Docker, "http://fastify:3000" resuelve al contenedor del stack Fastify.
// Están los 8 aunque hoy solo exista Fastify; los demás se van sumando en Fase 4.
const STACKS = {
  express: { framework: 'Express', base: 'http://express:3000' },
  nest: { framework: 'NestJS', base: 'http://nest:3000' },
  fastify: { framework: 'Fastify', base: 'http://fastify:3000' },
  go: { framework: 'Gin (Go)', base: 'http://go:3000' },
  rust: { framework: 'Axum (Rust)', base: 'http://rust:3000' },
  python: { framework: 'FastAPI (Python)', base: 'http://python:3000' },
  java: { framework: 'Spring Boot (Java)', base: 'http://java:3000' },
  dotnet: { framework: 'ASP.NET Core (.NET)', base: 'http://dotnet:3000' },
}

// ── Operaciones medibles ────────────────────────────────────────────────────
// Cada operación = método + path del contrato común. Los parámetros fijos
// (n=35, limit=1000) salen del contrato; más adelante el front podría variarlos.
const OPERATIONS = {
  read: { method: 'GET', path: '/read/500000' },
  'read-heavy': { method: 'GET', path: '/read-heavy?limit=1000' },
  write: { method: 'POST', path: '/write' },
  aggregate: { method: 'GET', path: '/aggregate' },
  compute: { method: 'GET', path: '/compute?n=35' },
}

// ── Topes de seguridad ──────────────────────────────────────────────────────
// Evitan que una config absurda (10 millones de requests, 100k de concurrencia)
// cuelgue la máquina. Son límites del orquestador, no del contrato.
const MAX_REQUESTS = 2_000_000
const MAX_CONCURRENCY = 2_000

const app = Fastify({ logger: true })

// CORS: el front corre en otro origen (ej. http://localhost:5173) y el browser
// bloquearía las llamadas sin estos permisos. En dev abrimos a cualquier origen.
await app.register(cors, { origin: true })

// ── GET /stacks ───────────────────────────────────────────────────────────
// Lista los stacks y pinga el /health de cada uno para marcar cuáles están
// arriba. El front usa esto para armar el selector y deshabilitar los caídos.
app.get('/stacks', async () => {
  const entries = Object.entries(STACKS)
  const checked = await Promise.all(
    entries.map(async ([name, info]) => {
      let available = false
      try {
        // AbortController: si /health no responde en 1.5s, lo damos por caído.
        // (Los stacks aún no construidos cuelgan en el DNS; por eso, además,
        // subimos UV_THREADPOOL_SIZE en compose para que sus lookups lentos no
        // saturen el threadpool de libuv y dejen al resto esperando).
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 1500)
        const res = await fetch(`${info.base}/health`, { signal: ctrl.signal })
        clearTimeout(t)
        available = res.ok
      } catch {
        available = false
      }
      return { name, framework: info.framework, available }
    }),
  )
  return { stacks: checked, operations: Object.keys(OPERATIONS) }
})

// ── validate ────────────────────────────────────────────────────────────────
// Valida op/requests/concurrency. Devuelve {n, c} o lanza un Error con .code=400.
function validate(op, requests, concurrency) {
  if (!OPERATIONS[op]) throw Object.assign(new Error(`operación desconocida: ${op}`), { code: 400 })
  const n = Number(requests)
  const c = Number(concurrency)
  if (!Number.isInteger(n) || n < 1 || n > MAX_REQUESTS)
    throw Object.assign(new Error(`requests debe ser 1..${MAX_REQUESTS}`), { code: 400 })
  if (!Number.isInteger(c) || c < 1 || c > MAX_CONCURRENCY)
    throw Object.assign(new Error(`concurrency debe ser 1..${MAX_CONCURRENCY}`), { code: 400 })
  return { n, c }
}

// ── benchmark ─────────────────────────────────────────────────────────────
// Corre oha contra un stack/op y devuelve el resultado normalizado. Es el núcleo
// que reusan tanto /run (un stack) como /race (todos, en secuencia).
async function benchmark(stack, op, n, c) {
  const { base } = STACKS[stack]
  const { method, path } = OPERATIONS[op]
  const url = base + path

  // Argumentos de oha:
  //   --no-tui                : sin interfaz interactiva (corremos sin terminal)
  //   --output-format json    : salida en JSON para parsear (en oha 1.14 NO es --json)
  //   -n / -c                 : nº de peticiones / concurrencia
  //   -m POST                 : método (solo para /write)
  const args = ['--no-tui', '--output-format', 'json', '-n', String(n), '-c', String(c)]
  if (method !== 'GET') args.push('-m', method)
  args.push(url)

  app.log.info(`oha ${args.join(' ')}`)
  // maxBuffer alto: con muchos requests la salida JSON puede crecer.
  const { stdout } = await execFileAsync('oha', args, { maxBuffer: 64 * 1024 * 1024 })
  const raw = JSON.parse(stdout)
  return { stack, framework: STACKS[stack].framework, op, requests: n, concurrency: c, url, metrics: normalize(raw) }
}

// ── POST /run ───────────────────────────────────────────────────────────────
// Corre un benchmark contra UN stack. Body: { stack, op, requests, concurrency }
app.post('/run', async (req, reply) => {
  const { stack, op, requests, concurrency } = req.body ?? {}
  if (!STACKS[stack]) return reply.code(400).send({ error: `stack desconocido: ${stack}` })
  let n, c
  try {
    ;({ n, c } = validate(op, requests, concurrency))
  } catch (e) {
    return reply.code(e.code || 400).send({ error: e.message })
  }
  try {
    return await benchmark(stack, op, n, c)
  } catch (err) {
    app.log.error(err)
    return reply.code(502).send({ error: 'falló el benchmark (¿el stack está arriba?)', detail: String(err.stderr || err.message || err) })
  }
})

// ── POST /race ──────────────────────────────────────────────────────────────
// Corre la MISMA operación contra TODOS los stacks, UNO POR UNO (en secuencia).
// La secuencialidad es clave para la equidad: si corrieran a la vez, competirían
// por CPU y por la DB y las métricas no serían comparables. Devuelve los
// resultados ordenados por throughput (req/s) descendente. Los stacks caídos se
// reportan con error en vez de cortar la carrera.
// Body: { op, requests, concurrency }
app.post('/race', async (req, reply) => {
  const { op, requests, concurrency } = req.body ?? {}
  let n, c
  try {
    ;({ n, c } = validate(op, requests, concurrency))
  } catch (e) {
    return reply.code(e.code || 400).send({ error: e.message })
  }

  const results = []
  for (const stack of Object.keys(STACKS)) {
    try {
      results.push(await benchmark(stack, op, n, c))
    } catch (err) {
      app.log.warn(`[race] ${stack} falló: ${err.message}`)
      results.push({ stack, framework: STACKS[stack].framework, op, error: 'no disponible' })
    }
  }
  // Ordenamos por req/s desc; los que fallaron (sin metrics) van al final.
  results.sort((a, b) => (b.metrics?.requestsPerSec ?? -1) - (a.metrics?.requestsPerSec ?? -1))
  return { op, requests: n, concurrency: c, results }
})

// ── normalize ─────────────────────────────────────────────────────────────
// Extrae de la salida de oha solo las métricas que nos importan, con un formato
// estable y a prueba de cambios de versión (busca varias claves posibles).
// Las latencias de oha vienen en SEGUNDOS; el front las pasará a ms.
function normalize(raw) {
  const s = raw.summary ?? {}
  const p = raw.latencyPercentiles ?? raw.percentiles ?? {}
  return {
    requestsPerSec: s.requestsPerSec ?? null,
    totalTimeSec: s.total ?? null,
    successRate: s.successRate ?? null,
    slowestSec: s.slowest ?? null,
    fastestSec: s.fastest ?? null,
    averageSec: s.average ?? null,
    p50Sec: p.p50 ?? null,
    p90Sec: p.p90 ?? null,
    p95Sec: p.p95 ?? null,
    p99Sec: p.p99 ?? null,
    statusCodes: raw.statusCodeDistribution ?? null,
    errors: raw.errorDistribution ?? null,
  }
}

// ── Arranque ────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 4000
try {
  await app.listen({ host: '0.0.0.0', port: PORT })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
