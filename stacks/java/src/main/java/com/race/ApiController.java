package com.race;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * Controller con los 6 endpoints del contrato común de api-tech-race.
 *
 * <p>Usamos {@link JdbcTemplate} (JDBC "pelado", sin JPA/ORM) para que el costo
 * sea comparable con los otros stacks y sin overhead de mapeo de entidades.
 * Spring Boot nos inyecta el {@code JdbcTemplate} ya cableado al pool HikariCP
 * configurado en application.properties.</p>
 *
 * <p>Decisiones de serialización que igualan al stack de referencia (Fastify):
 * <ul>
 *   <li><b>id como número</b>: la PK es BIGSERIAL (bigint). La leemos como
 *       {@code long}, así Jackson la emite como número JSON (no string).</li>
 *   <li><b>created_at como ISO-8601 UTC</b>: la columna es TIMESTAMPTZ. La
 *       leemos como {@link OffsetDateTime} y la pasamos a {@link Instant}
 *       (instante en UTC). Con {@code write-dates-as-timestamps=false} Jackson
 *       la escribe como "2025-11-18T09:25:08.901Z" — idéntico a Fastify/pg.</li>
 * </ul></p>
 *
 * <p>Devolvemos {@code Map}/{@code List} (no DTOs) a propósito: el contrato es
 * un JSON plano y simple; un Map ordenado (LinkedHashMap) deja claro el orden de
 * las claves y evita boilerplate de clases sin comportamiento.</p>
 */
@RestController
public class ApiController {

    // ── Constantes de "fairness" (deben coincidir en los 8 stacks) ──────────
    /** Límite por defecto de filas de /read-heavy. */
    private static final int HEAVY_DEFAULT = 1000;
    /** Tope duro de /read-heavy: nadie puede pedir el millón entero. */
    private static final int HEAVY_MAX = 10000;
    /** n por defecto de /compute. fib(35) ≈ 9M llamadas: pesado pero rápido. */
    private static final int FIB_DEFAULT = 35;
    /** Tope de /compute para que un n gigante no cuelgue el proceso. */
    private static final int FIB_MAX = 45;

    private final JdbcTemplate jdbc;

    // Inyección por constructor (forma idiomática y testeable en Spring).
    public ApiController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ── #0  GET /health ──────────────────────────────────────────────────────
    // Ping simple. No toca la base. Sirve para saber si el servicio está vivo.
    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    // ── #1  GET /read/:id ──────────────────────────────────────────────────────
    // Lectura simple por PK. Es el "piso" del benchmark: mide red + driver +
    // serialización, con la DB haciendo un lookup por índice (instantáneo).
    //
    // Recibimos el id como String para validarlo NOSOTROS en el borde: si lo
    // tipáramos como long, un id no numérico daría un 400 genérico de Spring
    // (con otro cuerpo). Validando a mano controlamos el contrato: 400 con
    // {"error": ...} si no es un entero positivo, igual que el de referencia.
    @GetMapping("/read/{id}")
    public ResponseEntity<?> read(@PathVariable String id) {
        long parsed;
        try {
            parsed = Long.parseLong(id);
        } catch (NumberFormatException e) {
            return ResponseEntity.badRequest().body(Map.of("error", "id inválido"));
        }
        if (parsed < 1) {
            return ResponseEntity.badRequest().body(Map.of("error", "id inválido"));
        }

        // $1 -> parámetro JDBC: NUNCA concatenamos valores en el SQL (inyección).
        // El RowMapper arma el JSON fila->Map respetando los tipos del contrato.
        List<Map<String, Object>> rows = jdbc.query(
                "SELECT id, name, value, category_id, created_at FROM items WHERE id = ?",
                (rs, rowNum) -> {
                    Map<String, Object> row = new java.util.LinkedHashMap<>();
                    row.put("id", rs.getLong("id"));               // bigint -> número
                    row.put("name", rs.getString("name"));
                    row.put("value", rs.getInt("value"));
                    row.put("category_id", rs.getShort("category_id"));
                    row.put("created_at", toInstant(rs.getObject("created_at", OffsetDateTime.class)));
                    return row;
                },
                parsed);

        if (rows.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "no encontrado"));
        }
        return ResponseEntity.ok(rows.get(0));
    }

    // ── #2  GET /read-heavy?limit=1000 ──────────────────────────────────────────
    // Lectura pesada: muchas filas + JOIN. Acá pesa cuánto tarda cada stack en
    // SERIALIZAR a JSON un payload grande (suele ser donde más se separan).
    //
    // required=false + parseo manual para replicar la semántica del referente:
    //   - sin limit (o no numérico) -> default 1000
    //   - limit > 10000             -> 10000 (tope)
    //   - limit < 1                 -> default 1000
    @GetMapping("/read-heavy")
    public List<Map<String, Object>> readHeavy(@RequestParam(required = false) String limit) {
        int n = HEAVY_DEFAULT;
        if (limit != null) {
            try {
                n = Integer.parseInt(limit);
            } catch (NumberFormatException e) {
                n = HEAVY_DEFAULT; // no numérico -> default, igual que Number(x)||1000
            }
        }
        if (n > HEAVY_MAX) n = HEAVY_MAX;
        if (n < 1) n = HEAVY_DEFAULT;

        return jdbc.query(
                "SELECT i.id, i.name, i.value, i.created_at, c.name AS category " +
                        "FROM items i " +
                        "JOIN categories c ON c.id = i.category_id " +
                        "ORDER BY i.id " +
                        "LIMIT ?",
                (rs, rowNum) -> {
                    Map<String, Object> row = new java.util.LinkedHashMap<>();
                    row.put("id", rs.getLong("id"));
                    row.put("name", rs.getString("name"));
                    row.put("value", rs.getInt("value"));
                    row.put("created_at", toInstant(rs.getObject("created_at", OffsetDateTime.class)));
                    row.put("category", rs.getString("category"));
                    return row;
                },
                n);
    }

    // ── #3  POST /write ──────────────────────────────────────────────────────────
    // Escritura: un INSERT con valores FIJOS a propósito (todos hacen el mismo
    // trabajo). IGNORAMOS el body: no declaramos @RequestBody y consumes acepta
    // cualquier content-type (o ninguno), así el POST entra venga como venga.
    // RETURNING id trae el id generado en la misma query (sin segundo viaje).
    @PostMapping(value = "/write", consumes = MediaType.ALL_VALUE)
    public Map<String, Object> write() {
        Long inserted = jdbc.queryForObject(
                "INSERT INTO items (name, value, category_id) VALUES (?, ?, ?) RETURNING id",
                Long.class,
                "bench_write", 42, 1);
        return Map.of("inserted", inserted);
    }

    // ── #5  GET /aggregate ─────────────────────────────────────────────────────
    // Agregación: GROUP BY sobre el millón de filas. Mide trabajo real de la DB
    // + serialización del resultado. Los ::int castean los bigint de count() y
    // el numeric de round(avg()) a entero, para que viajen como número JSON.
    @GetMapping("/aggregate")
    public List<Map<String, Object>> aggregate() {
        return jdbc.query(
                "SELECT c.name AS category, " +
                        "count(*)::int AS total, " +
                        "round(avg(i.value))::int AS avg_value " +
                        "FROM items i " +
                        "JOIN categories c ON c.id = i.category_id " +
                        "GROUP BY c.name " +
                        "ORDER BY c.name",
                (rs, rowNum) -> {
                    Map<String, Object> row = new java.util.LinkedHashMap<>();
                    row.put("category", rs.getString("category"));
                    row.put("total", rs.getInt("total"));
                    row.put("avg_value", rs.getInt("avg_value"));
                    return row;
                });
    }

    // ── #6  GET /compute?n=35 ────────────────────────────────────────────────────
    // CPU-bound puro: saca la base de la ecuación y mide el lenguaje/runtime.
    // Fibonacci RECURSIVO ingenuo a propósito (O(2^n)): mismo algoritmo en todos
    // los lenguajes y exige CPU de verdad. NO memoizar, NO iterativo.
    //
    // Semántica del referente: n no numérico -> 35; n > 45 -> 45; n < 0 -> 0.
    @GetMapping("/compute")
    public Map<String, Object> compute(@RequestParam(required = false) String n) {
        int nn = FIB_DEFAULT;
        if (n != null) {
            try {
                nn = Integer.parseInt(n);
            } catch (NumberFormatException e) {
                nn = FIB_DEFAULT;
            }
        }
        if (nn > FIB_MAX) nn = FIB_MAX;
        if (nn < 0) nn = 0;

        long result = fib(nn);
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("n", nn);
        out.put("result", result);
        return out;
    }

    /**
     * Fibonacci recursivo ingenuo. Devuelve {@code long} (64 bits) para que
     * fib(45)=1134903170 entre sin overflow, igual que el resto de los stacks.
     */
    private static long fib(int n) {
        if (n < 2) return n;
        return fib(n - 1) + fib(n - 2);
    }

    /**
     * Pasa un TIMESTAMPTZ (leído como OffsetDateTime) a Instant (instante en
     * UTC). Jackson serializa el Instant como ISO-8601 con sufijo 'Z'
     * (ej. "2025-11-18T09:25:08.901Z"), idéntico al stack de referencia.
     * Devuelve null si la columna fuese null (defensivo; en el esquema es NOT NULL).
     */
    private static Instant toInstant(OffsetDateTime odt) {
        return odt == null ? null : odt.toInstant();
    }
}
