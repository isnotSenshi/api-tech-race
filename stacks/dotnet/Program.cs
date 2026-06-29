// ============================================================================
// Program.cs — Stack .NET de api-tech-race (ASP.NET Core Minimal API + Npgsql)
//
// Replica EXACTAMENTE el contrato del stack de referencia (Fastify). Mismos
// endpoints, mismas respuestas JSON, mismos defaults. Lo único que cambia es la
// tecnología: acá es .NET 8 + Npgsql contra la MISMA base Postgres.
//
// Endpoints (cubren los tipos de benchmark):
//   GET  /health        -> ping, no toca la DB
//   GET  /read/{id}     -> #1 lectura simple (SELECT por PK)
//   GET  /read-heavy    -> #2 lectura pesada (JOIN, muchas filas)
//   POST /write         -> #3 escritura (INSERT)
//   GET  /aggregate     -> #5 agregación (GROUP BY sobre 1M)
//   GET  /compute       -> #6 CPU-bound, no toca la DB
// ============================================================================

using System.Globalization;
using Npgsql;

// ── Constantes de "fairness" (equidad) ──────────────────────────────────────
// DEBEN coincidir con los demás stacks, o la carrera se sesga.

// Tamaño del pool de conexiones. Cada request "pide prestada" una conexión y la
// devuelve al terminar. Npgsql poolea solo: el límite va en el connection string
// ("Maximum Pool Size=10"). Lo fijamos en 10 para todos.
const int PoolMax = 10;

// Límite de filas de /read-heavy. Acotado para que nadie pida el millón entero.
const int HeavyDefault = 1000;
const int HeavyMax = 10000;

// Parámetro de /compute. fib(35) ≈ 9M de llamadas recursivas: pesado pero rápido.
// El tope evita que un n gigante cuelgue el proceso.
const int FibDefault = 35;
const int FibMax = 45;

// ── Connection string a PostgreSQL ──────────────────────────────────────────
// Los datos llegan por variables de entorno (las define docker-compose). El host
// es "postgres" -> NOMBRE del servicio en la red interna de Compose.
//
// Soportamos las dos formas que pide el contrato:
//   - DATABASE_URL (formato URL postgresql://user:pass@host:port/db), si está.
//   - Variables sueltas PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE en su defecto.
// En ambos casos forzamos "Maximum Pool Size=10" para igualar la carrera.
string connString = BuildConnectionString(PoolMax);

// NpgsqlDataSource es la forma recomendada en Npgsql 8: encapsula el pool y se
// crea UNA sola vez al arrancar. Abrir/cerrar conexiones por request es barato
// porque en realidad se reciclan del pool interno.
await using var dataSource = NpgsqlDataSource.Create(connString);

// CreateBuilder (no CreateSlimBuilder): el slim builder está pensado para AOT/
// trimming y configura el JSON con source-generators; como acá serializamos tipos
// anónimos y records por reflexión, usamos el builder normal para que Results.Json
// funcione sin sorpresas. El overhead extra es despreciable para el benchmark.
var builder = WebApplication.CreateBuilder(args);

// Logging al MÍNIMO: como el logger:false de Fastify. Loguear por request agrega
// latencia y sesga la medición. Dejamos solo warnings/errores.
builder.Logging.ClearProviders();
builder.Logging.SetMinimumLevel(LogLevel.Warning);

// Escuchar en 0.0.0.0:3000 DENTRO del contenedor (obligatorio en Docker: con
// localhost solo sería visible dentro del propio contenedor). Se puede pisar con
// ASPNETCORE_URLS; si no, este default.
builder.WebHost.UseUrls("http://0.0.0.0:3000");

var app = builder.Build();

// ── #0  GET /health ─────────────────────────────────────────────────────────
// Ping simple. No toca la base. Results.Json serializa con System.Text.Json.
app.MapGet("/health", () => Results.Json(new { status = "ok" }));

// ── #1  GET /read/{id} ──────────────────────────────────────────────────────
// Lectura simple por PK. Es el "piso" del benchmark: red + driver + serialización
// con la DB haciendo lo mínimo (lookup por índice de PK).
//
// El {id} llega como string en la ruta. Validamos en el borde: si no es entero
// positivo -> 400. Usamos long porque el id de la columna es BIGSERIAL; así viaja
// como NÚMERO en el JSON (System.Text.Json serializa long como número, no string).
app.MapGet("/read/{id}", async (string id) =>
{
    // Parseo estricto: solo dígitos. long.TryParse aceptaría "+5" o espacios según
    // estilo; con NumberStyles.None exigimos dígitos puros, y luego > 0 el positivo.
    if (!long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out long parsedId) || parsedId < 1)
    {
        return Results.Json(new { error = "id inválido" }, statusCode: 400);
    }

    // $1 es un parámetro: NUNCA concatenamos valores en el SQL (inyección).
    await using var cmd = dataSource.CreateCommand(
        "SELECT id, name, value, category_id, created_at FROM items WHERE id = $1");
    cmd.Parameters.AddWithValue(parsedId);

    await using var reader = await cmd.ExecuteReaderAsync();
    if (!await reader.ReadAsync())
    {
        return Results.Json(new { error = "no encontrado" }, statusCode: 404);
    }

    // Leemos por índice de columna (más rápido que por nombre). created_at es
    // TIMESTAMPTZ -> lo trae como DateTime en UTC; System.Text.Json lo serializa
    // ISO-8601 con sufijo Z, igual que el stack de referencia.
    var item = new
    {
        id = reader.GetInt64(0),
        name = reader.GetString(1),
        value = reader.GetInt32(2),
        category_id = reader.GetInt16(3),
        created_at = reader.GetDateTime(4),
    };
    return Results.Json(item);
});

// ── #2  GET /read-heavy?limit=1000 ──────────────────────────────────────────
// Lectura pesada: muchas filas + JOIN. Acá pesa cuánto tarda en SERIALIZAR a JSON
// un payload grande. Default 1000, tope 10000; valores raros -> default.
app.MapGet("/read-heavy", async (HttpRequest req) =>
{
    int limit = HeavyDefault;
    // El parseo replica al de referencia: si "limit" no es número válido o es < 1,
    // cae al default; si supera el tope, se recorta.
    if (int.TryParse(req.Query["limit"], NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed))
    {
        limit = parsed;
    }
    if (limit > HeavyMax) limit = HeavyMax;
    if (limit < 1) limit = HeavyDefault;

    await using var cmd = dataSource.CreateCommand(
        @"SELECT i.id, i.name, i.value, i.created_at, c.name AS category
            FROM items i
            JOIN categories c ON c.id = i.category_id
           ORDER BY i.id
           LIMIT $1");
    cmd.Parameters.AddWithValue(limit);

    // Materializamos la lista para serializarla de una. Pre-dimensionamos con la
    // capacidad esperada para evitar realocaciones del List al crecer.
    var rows = new List<HeavyRow>(limit);
    await using var reader = await cmd.ExecuteReaderAsync();
    while (await reader.ReadAsync())
    {
        rows.Add(new HeavyRow(
            reader.GetInt64(0),
            reader.GetString(1),
            reader.GetInt32(2),
            reader.GetDateTime(3),
            reader.GetString(4)));
    }
    return Results.Json(rows);
});

// ── #3  POST /write ─────────────────────────────────────────────────────────
// Escritura: un INSERT con valores FIJOS a propósito (así los 8 stacks hacen el
// mismo trabajo en la DB y no dependemos del body). IGNORAMOS el body: el handler
// no lo lee, así que aceptamos el POST venga con o sin Content-Type.
// RETURNING id evita un segundo viaje a la DB para conocer el id generado.
app.MapPost("/write", async () =>
{
    await using var cmd = dataSource.CreateCommand(
        "INSERT INTO items (name, value, category_id) VALUES ($1, $2, $3) RETURNING id");
    cmd.Parameters.AddWithValue("bench_write");
    cmd.Parameters.AddWithValue(42);
    cmd.Parameters.AddWithValue((short)1);

    // ExecuteScalar devuelve la primera columna de la primera fila: el id (bigint).
    var inserted = (long)(await cmd.ExecuteScalarAsync())!;
    return Results.Json(new { inserted });
});

// ── #5  GET /aggregate ──────────────────────────────────────────────────────
// Agregación: GROUP BY sobre el millón de filas. Castiga drivers lentos y mide
// trabajo real de la DB + serialización. Los ::int castean los bigint de count()
// y el numeric de round(avg()) a entero, para que viajen como NÚMERO entero.
app.MapGet("/aggregate", async () =>
{
    await using var cmd = dataSource.CreateCommand(
        @"SELECT c.name AS category,
                 count(*)::int            AS total,
                 round(avg(i.value))::int AS avg_value
            FROM items i
            JOIN categories c ON c.id = i.category_id
           GROUP BY c.name
           ORDER BY c.name");

    var rows = new List<AggregateRow>();
    await using var reader = await cmd.ExecuteReaderAsync();
    while (await reader.ReadAsync())
    {
        rows.Add(new AggregateRow(
            reader.GetString(0),
            reader.GetInt32(1),
            reader.GetInt32(2)));
    }
    return Results.Json(rows);
});

// ── #6  GET /compute?n=35 ───────────────────────────────────────────────────
// CPU-bound puro: SACA la base de la ecuación y mide el runtime. Fibonacci
// RECURSIVO ingenuo (O(2^n)) a propósito: NO memoizar, NO iterativo. El punto es
// quemar CPU igual en todos. Resultado en long (64 bits): fib(45) entra holgado.
app.MapGet("/compute", (HttpRequest req) =>
{
    int n = FibDefault;
    // Si "n" no es un entero válido, cae al default 35 (igual que la referencia).
    if (int.TryParse(req.Query["n"], NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed))
    {
        n = parsed;
    }
    if (n > FibMax) n = FibMax;
    if (n < 0) n = 0;

    long result = Fib(n);
    return Results.Json(new { n, result });
});

app.Run();

// Fibonacci recursivo ingenuo. Definido como función local al final del archivo:
// en .NET las funciones locales pueden usarse antes de su declaración (no hace
// falta declararla arriba). long para soportar fib(45) = 1134903170 sin desbordar.
static long Fib(int n)
{
    if (n < 2) return n;
    return Fib(n - 1) + Fib(n - 2);
}

// Construye el connection string respetando DATABASE_URL o las variables sueltas,
// y SIEMPRE fija el tamaño máximo del pool para igualar la carrera.
static string BuildConnectionString(int poolMax)
{
    string? databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");

    NpgsqlConnectionStringBuilder csb;
    if (!string.IsNullOrWhiteSpace(databaseUrl))
    {
        // Formato URL: postgresql://user:pass@host:port/db. Lo parseamos a mano
        // porque Npgsql no acepta URLs directamente (usa pares clave=valor).
        var uri = new Uri(databaseUrl);
        var userInfo = uri.UserInfo.Split(':', 2);
        csb = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.IsDefaultPort ? 5432 : uri.Port,
            Username = Uri.UnescapeDataString(userInfo[0]),
            Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : "",
            Database = uri.AbsolutePath.TrimStart('/'),
        };
    }
    else
    {
        // Variables sueltas, con los defaults que pide el contrato.
        csb = new NpgsqlConnectionStringBuilder
        {
            Host = Environment.GetEnvironmentVariable("PGHOST") ?? "postgres",
            Port = int.TryParse(Environment.GetEnvironmentVariable("PGPORT"), out int p) ? p : 5432,
            Username = Environment.GetEnvironmentVariable("PGUSER") ?? "race",
            Password = Environment.GetEnvironmentVariable("PGPASSWORD") ?? "race",
            Database = Environment.GetEnvironmentVariable("PGDATABASE") ?? "race",
        };
    }

    // Tamaño de pool obligatorio e igual para todos los stacks.
    csb.MaxPoolSize = poolMax;
    return csb.ConnectionString;
}

// ── Tipos de fila para serializar ───────────────────────────────────────────
// records con nombres en minúscula para que el JSON salga con EXACTAMENTE las
// claves del contrato (System.Text.Json usa el nombre de la propiedad tal cual,
// y como acá no hay PropertyNamingPolicy global, respeta estos nombres).
record HeavyRow(long id, string name, int value, DateTime created_at, string category);
record AggregateRow(string category, int total, int avg_value);
