// ============================================================================
// main.rs — Stack Rust + Axum de api-tech-race.
//
// Implementa EXACTAMENTE el mismo contrato HTTP que el stack de referencia
// (Fastify): mismos endpoints, mismas respuestas JSON, mismos defaults. Lo único
// que cambia es la tecnología. Así la carrera entre los 8 stacks es justa.
//
// Endpoints (los 6 del contrato):
//   GET  /health        -> ping, no toca la DB
//   GET  /read/:id       -> #1 lectura simple (SELECT por PK)
//   GET  /read-heavy     -> #2 lectura pesada (JOIN, muchas filas)
//   POST /write          -> #3 escritura (INSERT)
//   GET  /aggregate      -> #5 agregación (GROUP BY sobre 1M)
//   GET  /compute        -> #6 CPU-bound, no toca la DB
// ============================================================================

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, SecondsFormat, Utc};
use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use serde::Serialize;
use serde_json::{json, Value};
use tokio_postgres::NoTls;

// ── Constantes de "fairness" (equidad) ──────────────────────────────────────
// Estas constantes DEBEN ser iguales en los 8 stacks, o la carrera se sesga.

// Tamaño del pool de conexiones a Postgres. Cada request "pide prestada" una
// conexión y la devuelve al terminar. Fijo en 10 para todos los stacks.
const POOL_MAX: usize = 10;

// Límite de filas de /read-heavy. Acotado para que nadie pida el millón entero.
const HEAVY_DEFAULT: i64 = 1000;
const HEAVY_MAX: i64 = 10_000;

// Parámetro de /compute. fib(35) ≈ 9M de llamadas recursivas: pesado pero rápido.
const FIB_DEFAULT: i64 = 35;
const FIB_MAX: i64 = 45;

// ── Estado compartido ────────────────────────────────────────────────────────
// El pool se crea UNA vez al arrancar y se comparte (clonando el Arc interno de
// deadpool, que es barato) entre todos los handlers vía el State de Axum.
#[derive(Clone)]
struct AppState {
    pool: Pool,
}

// ── Helpers de serialización ───────────────────────────────────────────────

// Serializa created_at IGUAL que el driver pg de Node: ISO-8601 en UTC con
// milisegundos y sufijo 'Z' (ej. "2025-11-18T09:25:08.901Z"). chrono por
// defecto usaría "+00:00" en vez de "Z" y precisión variable; lo forzamos a
// mano para clavar el mismo string que el stack de referencia.
fn iso8601(ts: &DateTime<Utc>) -> String {
    ts.to_rfc3339_opts(SecondsFormat::Millis, true)
}

// ── Error handling mínimo ──────────────────────────────────────────────────
// Cualquier fallo de DB se traduce a 500. Mantenemos el overhead al mínimo:
// no logueamos por request (sesgaría el benchmark de latencia).
struct AppError(StatusCode, Value);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

// Conversión automática de errores de DB -> 500. Con esto los handlers pueden
// usar el operador `?` sobre las queries y devolver el error sin boilerplate.
impl From<tokio_postgres::Error> for AppError {
    fn from(_: tokio_postgres::Error) -> Self {
        AppError(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "db" }))
    }
}

impl From<deadpool_postgres::PoolError> for AppError {
    fn from(_: deadpool_postgres::PoolError) -> Self {
        AppError(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "pool" }))
    }
}

// ── #0  GET /health ───────────────────────────────────────────────────────────
// Ping simple. No toca la base. Sirve para saber si el servicio está vivo.
async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

// ── #1  GET /read/:id ─────────────────────────────────────────────────────────
// Lectura simple: una fila por clave primaria. Mide red + driver + serialización
// JSON, con la DB haciendo lo mínimo (lookup por índice de PK).
//
// El id lo recibimos como String y lo validamos a mano (en vez de tipar Path<i64>)
// para controlar el código de error: si no es un entero positivo devolvemos 400,
// igual que el stack de referencia. Path<i64> daría un error genérico distinto.
#[derive(Serialize)]
struct ReadItem {
    id: i64, // i64 -> viaja como NÚMERO en el JSON (no string)
    name: String,
    value: i32,
    category_id: i16,
    created_at: String, // ya formateado a ISO-8601
}

async fn read_one(
    State(state): State<AppState>,
    Path(id_raw): Path<String>,
) -> Result<Response, AppError> {
    // Validación en el borde: entero positivo. parse a i64; si falla o es < 1,
    // 400 Bad Request. Aceptamos solo dígitos (parse::<i64> rechaza "1.5", "abc",
    // signos raros, etc.).
    let id: i64 = match id_raw.parse() {
        Ok(n) if n >= 1 => n,
        _ => {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "id inválido" })),
            )
                .into_response())
        }
    };

    let client = state.pool.get().await?;
    // $1 es un parámetro: NUNCA concatenamos valores en el SQL (inyección).
    let row = client
        .query_opt(
            "SELECT id, name, value, category_id, created_at FROM items WHERE id = $1",
            &[&id],
        )
        .await?;

    match row {
        None => Ok((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no encontrado" })),
        )
            .into_response()),
        Some(r) => {
            let created_at: DateTime<Utc> = r.get("created_at");
            let item = ReadItem {
                id: r.get("id"),
                name: r.get("name"),
                value: r.get("value"),
                category_id: r.get("category_id"),
                created_at: iso8601(&created_at),
            };
            Ok(Json(item).into_response())
        }
    }
}

// ── #2  GET /read-heavy?limit=1000 ────────────────────────────────────────────
// Lectura pesada: muchas filas + JOIN con categories. Acá pesa cuánto tarda cada
// stack en SERIALIZAR a JSON un payload grande.
#[derive(Serialize)]
struct HeavyItem {
    id: i64,
    name: String,
    value: i32,
    created_at: String,
    category: String,
}

async fn read_heavy(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Vec<HeavyItem>>, AppError> {
    // Defaults idénticos al de referencia: limit default 1000, tope 10000, y un
    // limit < 1 (o no numérico) cae al default. Parseamos el query param a mano.
    let mut limit = params
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(HEAVY_DEFAULT);
    if limit > HEAVY_MAX {
        limit = HEAVY_MAX;
    }
    if limit < 1 {
        limit = HEAVY_DEFAULT;
    }

    let client = state.pool.get().await?;
    let rows = client
        .query(
            "SELECT i.id, i.name, i.value, i.created_at, c.name AS category
               FROM items i
               JOIN categories c ON c.id = i.category_id
              ORDER BY i.id
              LIMIT $1",
            &[&limit],
        )
        .await?;

    let items = rows
        .iter()
        .map(|r| {
            let created_at: DateTime<Utc> = r.get("created_at");
            HeavyItem {
                id: r.get("id"),
                name: r.get("name"),
                value: r.get("value"),
                created_at: iso8601(&created_at),
                category: r.get("category"),
            }
        })
        .collect();

    Ok(Json(items))
}

// ── #3  POST /write ───────────────────────────────────────────────────────────
// Escritura: un INSERT. Insertamos valores FIJOS a propósito ('bench_write', 42,
// 1) para que los 8 stacks hagan EXACTAMENTE el mismo trabajo en la DB y no
// dependamos del body. IGNORAMOS el body por completo (no lo extraemos), así que
// el POST se acepta venga con el Content-Type que venga, o sin ninguno.
// RETURNING id nos da el id generado en la misma query (sin segundo viaje).
async fn write(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let client = state.pool.get().await?;
    let row = client
        .query_one(
            "INSERT INTO items (name, value, category_id) VALUES ($1, $2, $3) RETURNING id",
            &[&"bench_write", &42_i32, &1_i16],
        )
        .await?;
    let inserted: i64 = row.get("id");
    Ok(Json(json!({ "inserted": inserted })))
}

// ── #5  GET /aggregate ────────────────────────────────────────────────────────
// Agregación: GROUP BY sobre el millón de filas. Mide trabajo real de la DB +
// serialización del resultado. Casteamos en SQL para que total y avg_value
// viajen como enteros: count(*) es bigint -> ::int; round(avg) es numeric -> ::int.
#[derive(Serialize)]
struct AggRow {
    category: String,
    total: i32,
    avg_value: i32,
}

async fn aggregate(State(state): State<AppState>) -> Result<Json<Vec<AggRow>>, AppError> {
    let client = state.pool.get().await?;
    let rows = client
        .query(
            "SELECT c.name AS category,
                    count(*)::int            AS total,
                    round(avg(i.value))::int AS avg_value
               FROM items i
               JOIN categories c ON c.id = i.category_id
              GROUP BY c.name
              ORDER BY c.name",
            &[],
        )
        .await?;

    let agg = rows
        .iter()
        .map(|r| AggRow {
            category: r.get("category"),
            total: r.get("total"),
            avg_value: r.get("avg_value"),
        })
        .collect();

    Ok(Json(agg))
}

// ── #6  GET /compute?n=35 ─────────────────────────────────────────────────────
// CPU-bound puro: SACA la base de la ecuación y mide el lenguaje/runtime.
// Fibonacci RECURSIVO ingenuo a propósito (O(2^n)): NO memoizar, NO iterativo.
// El punto es quemar CPU igual en todos. Acá es donde Rust vuela.
//
// Resultado en i64 (entero de 64 bits): fib(45) = 1.134.903.170 entra de sobra.
// Lo corremos en un hilo de bloqueo (spawn_blocking) para no clavar un worker
// async de Tokio durante el cálculo; así el resto de los requests siguen fluyendo.
fn fib(n: i64) -> i64 {
    if n < 2 {
        n
    } else {
        fib(n - 1) + fib(n - 2)
    }
}

async fn compute(Query(params): Query<HashMap<String, String>>) -> Json<Value> {
    // Defaults idénticos al de referencia: n default 35 (también si no es entero
    // o falta), tope 45, y n < 0 -> 0.
    let mut n = params
        .get("n")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(FIB_DEFAULT);
    if n > FIB_MAX {
        n = FIB_MAX;
    }
    if n < 0 {
        n = 0;
    }

    // spawn_blocking mueve el cálculo CPU-bound a un hilo dedicado del pool de
    // bloqueo de Tokio. Si lo corriéramos inline, bloquearíamos un worker del
    // runtime async y degradaríamos la concurrencia del resto de endpoints.
    let result = tokio::task::spawn_blocking(move || fib(n))
        .await
        .expect("fib task no debería fallar");

    Json(json!({ "n": n, "result": result }))
}

// ── Arranque del servidor ─────────────────────────────────────────────────────
#[tokio::main]
async fn main() {
    // Configuración del pool de conexiones. Los datos llegan por variables de
    // entorno (las define docker-compose). Soportamos tanto las variables
    // individuales (PGHOST, etc.) como DATABASE_URL, con los mismos defaults que
    // el resto de los stacks. deadpool lee directo de las env PG* si usamos
    // Config::new() + from_env, pero acá las seteamos explícitas para tener
    // control de los defaults.
    let mut cfg = Config::new();

    if let Ok(url) = std::env::var("DATABASE_URL") {
        // Si viene DATABASE_URL, tokio-postgres la parsea entera.
        cfg.url = Some(url);
    } else {
        cfg.host = Some(env_or("PGHOST", "postgres"));
        cfg.port = Some(env_or("PGPORT", "5432").parse().expect("PGPORT inválido"));
        cfg.user = Some(env_or("PGUSER", "race"));
        cfg.password = Some(env_or("PGPASSWORD", "race"));
        cfg.dbname = Some(env_or("PGDATABASE", "race"));
    }

    // Recycling Fast: deadpool reutiliza la conexión sin chequearla al devolverla
    // al pool (menos overhead). Suficiente para un benchmark contra una DB local.
    cfg.manager = Some(ManagerConfig {
        recycling_method: RecyclingMethod::Fast,
    });
    // POOL_MAX = 10: obligatorio e igual en todos los stacks.
    cfg.pool = Some(deadpool_postgres::PoolConfig::new(POOL_MAX));

    let pool = cfg
        .create_pool(Some(Runtime::Tokio1), NoTls)
        .expect("no se pudo crear el pool de Postgres");

    let state = AppState { pool };

    // Router: registramos los 6 endpoints. Middleware/logging al MÍNIMO (no
    // metemos ningún layer de tracing por request: agregaría latencia).
    let app = Router::new()
        .route("/health", get(health))
        .route("/read/:id", get(read_one))
        .route("/read-heavy", get(read_heavy))
        .route("/write", post(write))
        .route("/aggregate", get(aggregate))
        .route("/compute", get(compute))
        .with_state(state);

    // host 0.0.0.0 (no localhost): obligatorio dentro de Docker para que el
    // servicio sea accesible desde fuera del contenedor.
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("no se pudo bindear 0.0.0.0:3000");
    println!("[rust] escuchando en :3000 (pool max={POOL_MAX})");

    axum::serve(listener, app)
        .await
        .expect("el servidor terminó con error");
}

// Lee una variable de entorno o devuelve el default si falta.
fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
