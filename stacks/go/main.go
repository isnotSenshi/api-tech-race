// ============================================================================
// main.go — Stack Go + Gin de api-tech-race.
//
// Implementa el MISMO contrato HTTP que el stack de referencia (Fastify) y le
// pega a la MISMA base Postgres. Lo único que cambia es la tecnología: acá
// usamos Go + Gin (framework web) + pgx/v5 (driver de PostgreSQL con pool).
//
// La gracia del benchmark es que todos los stacks hagan EXACTAMENTE el mismo
// trabajo (mismas queries, mismos defaults, mismas validaciones, mismo pool),
// así la comparación mide tecnología y no implementaciones distintas.
//
// Endpoints:
//   GET  /health        -> ping, no toca la DB
//   GET  /read/:id      -> #1 lectura simple (SELECT por PK)
//   GET  /read-heavy    -> #2 lectura pesada (JOIN, muchas filas)
//   POST /write         -> #3 escritura (INSERT)
//   GET  /aggregate     -> #5 agregación (GROUP BY sobre 1M)
//   GET  /compute       -> #6 CPU-bound, no toca la DB
// ============================================================================

package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ── Constantes de "fairness" (equidad) ──────────────────────────────────────
// Estos valores DEBEN ser idénticos en los 8 stacks o la carrera se sesga.

// Tamaño del pool de conexiones a Postgres. Cada request "pide prestada" una
// conexión y la devuelve al terminar. Si el pool es chico, bajo concurrencia
// los requests hacen cola esperando conexión. Lo fijamos en 10 para todos.
const poolMax = 10

// Límite de filas de /read-heavy. Acotado para que nadie pida el millón entero
// y para que la prueba sea comparable entre stacks.
const (
	heavyDefault = 1000
	heavyMax     = 10000
)

// Parámetro de /compute. fib(35) ≈ 9 millones de llamadas recursivas: pesado
// pero rápido. El tope evita que un n gigante cuelgue el servidor.
const (
	fibDefault = 35
	fibMax     = 45
)

// pool es global: se crea UNA vez al arrancar y se reutiliza en todos los
// requests. Abrir una conexión nueva por request sería carísimo; el pool las
// recicla. pgxpool es concurrency-safe, así que compartirlo entre las
// goroutines de Gin (una por request) es seguro.
var pool *pgxpool.Pool

// isoTime envuelve time.Time SOLO para controlar cómo se serializa a JSON.
//
// Por qué: el stack de referencia (Node/pg) serializa los TIMESTAMPTZ como
// ISO-8601 en UTC con milisegundos y sufijo 'Z' (ej. "2025-11-18T09:25:08.901Z").
// El time.Time de Go, por defecto, marshaliza en RFC3339Nano conservando el
// offset original (ej. "+00:00" y con nanosegundos), lo que NO coincidiría.
// Con un MarshalJSON propio forzamos exactamente el mismo formato que la
// referencia y el JSON queda byte a byte comparable entre stacks.
type isoTime time.Time

// MarshalJSON convierte el instante a UTC y lo formatea con milisegundos y 'Z'.
// El layout ".000" fuerza SIEMPRE 3 decimales (con relleno de ceros), igual que
// el toISOString() de JavaScript. Las comillas las agregamos nosotros porque un
// valor JSON string debe ir entrecomillado.
func (t isoTime) MarshalJSON() ([]byte, error) {
	s := time.Time(t).UTC().Format(`"2006-01-02T15:04:05.000Z"`)
	return []byte(s), nil
}

// ── Modelos de respuesta ─────────────────────────────────────────────────────
// Structs con tags json para que la salida tenga EXACTAMENTE las claves del
// contrato. El orden de los campos define el orden en el JSON.

// item es la respuesta de /read/:id. id es int64 -> número en JSON (no string).
type item struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	Value      int32   `json:"value"`
	CategoryID int16   `json:"category_id"`
	CreatedAt  isoTime `json:"created_at"`
}

// heavyRow es cada fila de /read-heavy: incluye la categoría (nombre) del JOIN.
type heavyRow struct {
	ID        int64   `json:"id"`
	Name      string  `json:"name"`
	Value     int32   `json:"value"`
	CreatedAt isoTime `json:"created_at"`
	Category  string  `json:"category"`
}

// aggregateRow es cada grupo de /aggregate. total y avg_value son enteros.
type aggregateRow struct {
	Category string `json:"category"`
	Total    int64  `json:"total"`
	AvgValue int64  `json:"avg_value"`
}

// fib calcula Fibonacci RECURSIVO ingenuo (O(2^n)) a propósito: NO memoizar ni
// iterar. El objetivo es quemar CPU de forma idéntica en todos los lenguajes.
// Devuelve int64 (entero de 64 bits) como exige el contrato.
func fib(n int) int64 {
	if n < 2 {
		return int64(n)
	}
	return fib(n-1) + fib(n-2)
}

func main() {
	// Modo release: apaga el modo debug de Gin (warnings, logs de arranque,
	// recarga de plantillas) que solo sirve en desarrollo y agrega overhead.
	gin.SetMode(gin.ReleaseMode)

	// El pool se construye al inicio y vive durante todo el proceso.
	pool = mustConnect()
	defer pool.Close()

	// gin.New() crea un engine SIN middlewares. A diferencia de gin.Default(),
	// no monta Logger ni Recovery. Logger imprimiría una línea por request,
	// agregando latencia y sesgando el benchmark; lo queremos al mínimo.
	r := gin.New()

	r.GET("/health", handleHealth)
	r.GET("/read/:id", handleRead)
	r.GET("/read-heavy", handleReadHeavy)
	r.POST("/write", handleWrite)
	r.GET("/aggregate", handleAggregate)
	r.GET("/compute", handleCompute)

	// host 0.0.0.0 (no localhost): obligatorio dentro de Docker para que el
	// servicio sea accesible desde fuera del contenedor.
	addr := "0.0.0.0:" + port()
	log.Printf("[go] escuchando en %s (pool max=%d)", addr, poolMax)
	if err := r.Run(addr); err != nil {
		log.Fatalf("[go] error al arrancar: %v", err)
	}
}

// mustConnect arma la configuración del pool y abre las conexiones. Si algo
// falla, aborta el proceso: sin DB el servicio no tiene sentido.
func mustConnect() *pgxpool.Pool {
	cfg, err := pgxpool.ParseConfig(connString())
	if err != nil {
		log.Fatalf("[go] config de conexión inválida: %v", err)
	}
	// MaxConns = 10: la constante de fairness compartida por todos los stacks.
	cfg.MaxConns = poolMax

	p, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		log.Fatalf("[go] no se pudo crear el pool: %v", err)
	}
	return p
}

// connString construye la cadena de conexión. Preferimos DATABASE_URL si está;
// si no, la armamos desde las variables individuales con los defaults del
// contrato. pgx entiende el formato URL "postgresql://user:pass@host:port/db".
func connString() string {
	if url := os.Getenv("DATABASE_URL"); url != "" {
		return url
	}
	return "postgresql://" +
		env("PGUSER", "race") + ":" +
		env("PGPASSWORD", "race") + "@" +
		env("PGHOST", "postgres") + ":" +
		env("PGPORT", "5432") + "/" +
		env("PGDATABASE", "race")
}

// port devuelve el puerto de escucha (3000 por defecto, igual que la referencia).
func port() string {
	return env("PORT", "3000")
}

// env lee una variable de entorno con un valor por defecto si está vacía.
func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ── #0  GET /health ───────────────────────────────────────────────────────────
// Ping simple, no toca la base. Sirve para saber si el proceso está vivo.
func handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// ── #1  GET /read/:id ───────────────────────────────────────────────────────────
// Lectura simple: una fila por clave primaria. Es el "piso" del benchmark.
func handleRead(c *gin.Context) {
	// Validación en el borde: el id debe ser un entero positivo. strconv.Atoi
	// rechaza no-numéricos; además exigimos > 0. Si no, 400 (Bad Request).
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	// $1 es un parámetro: NUNCA concatenamos valores en el SQL (inyección).
	// pgx envía el valor por separado y a salvo.
	row := pool.QueryRow(c.Request.Context(),
		`SELECT id, name, value, category_id, created_at FROM items WHERE id = $1`,
		id)

	var it item
	// created_at lo escaneamos a un time.Time y lo convertimos a isoTime para
	// que el JSON salga con el formato del contrato. Scan necesita un *time.Time,
	// así que usamos una variable intermedia.
	var createdAt time.Time
	if err := row.Scan(&it.ID, &it.Name, &it.Value, &it.CategoryID, &createdAt); err != nil {
		// pgx.ErrNoRows = no había fila con ese id -> 404 (Not Found).
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no encontrado"})
			return
		}
		// Cualquier otro error es de la DB/servidor -> 500.
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error interno"})
		return
	}
	it.CreatedAt = isoTime(createdAt)
	c.JSON(http.StatusOK, it)
}

// ── #2  GET /read-heavy?limit=1000 ──────────────────────────────────────────────
// Lectura pesada: muchas filas + JOIN. Acá pesa cuánto tarda cada stack en
// SERIALIZAR a JSON un payload grande; suele ser donde más se separan.
func handleReadHeavy(c *gin.Context) {
	// Misma lógica de defaults que la referencia: si no parsea o es 0 -> default;
	// si supera el máximo -> se recorta al máximo; si es < 1 -> vuelve al default.
	limit := heavyDefault
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v != 0 {
		limit = v
	}
	if limit > heavyMax {
		limit = heavyMax
	}
	if limit < 1 {
		limit = heavyDefault
	}

	rows, err := pool.Query(c.Request.Context(),
		`SELECT i.id, i.name, i.value, i.created_at, c.name AS category
		   FROM items i
		   JOIN categories c ON c.id = i.category_id
		  ORDER BY i.id
		  LIMIT $1`,
		limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error interno"})
		return
	}
	defer rows.Close()

	// Preasignamos el slice con capacidad = limit para evitar realocaciones del
	// array a medida que crece (optimización barata que ayuda en payloads grandes).
	out := make([]heavyRow, 0, limit)
	for rows.Next() {
		var hr heavyRow
		var createdAt time.Time
		if err := rows.Scan(&hr.ID, &hr.Name, &hr.Value, &createdAt, &hr.Category); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "error interno"})
			return
		}
		hr.CreatedAt = isoTime(createdAt)
		out = append(out, hr)
	}
	// rows.Err() reporta errores ocurridos DURANTE la iteración (no los captura Next).
	if rows.Err() != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error interno"})
		return
	}
	c.JSON(http.StatusOK, out)
}

// ── #3  POST /write ─────────────────────────────────────────────────────────────
// Escritura: un INSERT con valores FIJOS a propósito, así los 8 stacks hacen
// EXACTAMENTE el mismo trabajo y no dependemos del body (lo ignoramos). Gin no
// lee el body si no se lo pedimos, así que aceptamos el POST con o sin
// Content-Type sin problema. RETURNING id trae el id generado en la misma query.
func handleWrite(c *gin.Context) {
	var insertedID int64
	err := pool.QueryRow(c.Request.Context(),
		`INSERT INTO items (name, value, category_id) VALUES ($1, $2, $3) RETURNING id`,
		"bench_write", 42, 1).Scan(&insertedID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error interno"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"inserted": insertedID})
}

// ── #5  GET /aggregate ──────────────────────────────────────────────────────────
// Agregación: GROUP BY sobre el millón de filas. Mide trabajo real de la DB +
// serialización del resultado. round(avg(...)) devuelve numeric; lo casteamos a
// entero en la query para que viaje como número entero, igual que la referencia.
func handleAggregate(c *gin.Context) {
	rows, err := pool.Query(c.Request.Context(),
		`SELECT c.name AS category,
		        count(*)              AS total,
		        round(avg(i.value))::bigint AS avg_value
		   FROM items i
		   JOIN categories c ON c.id = i.category_id
		  GROUP BY c.name
		  ORDER BY c.name`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error interno"})
		return
	}
	defer rows.Close()

	out := make([]aggregateRow, 0)
	for rows.Next() {
		var ar aggregateRow
		if err := rows.Scan(&ar.Category, &ar.Total, &ar.AvgValue); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "error interno"})
			return
		}
		out = append(out, ar)
	}
	if rows.Err() != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error interno"})
		return
	}
	c.JSON(http.StatusOK, out)
}

// ── #6  GET /compute?n=35 ───────────────────────────────────────────────────────
// CPU-bound puro: saca la base de la ecuación y mide el lenguaje/runtime.
// Mismos defaults que la referencia: n no entero -> 35; n > 45 -> 45; n < 0 -> 0.
//
// Nota didáctica: Go corre cada request en su propia goroutine sobre varios
// hilos del SO, así que un fib(n) pesado NO congela a los demás requests (al
// contrario del modelo single-thread de Node). Esa diferencia es justo lo que
// el benchmark de concurrencia sobre /compute busca mostrar.
func handleCompute(c *gin.Context) {
	n := fibDefault
	if v, err := strconv.Atoi(c.Query("n")); err == nil {
		n = v
	}
	if n > fibMax {
		n = fibMax
	}
	if n < 0 {
		n = 0
	}
	c.JSON(http.StatusOK, gin.H{"n": n, "result": fib(n)})
}
