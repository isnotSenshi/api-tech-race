-- ============================================================================
-- 01-schema.sql — Esquema de la base de la carrera.
--
-- Se ejecuta automáticamente al crear el contenedor de Postgres por primera vez
-- (ver docker-compose.yml). Define las tablas que usarán los 5 endpoints del
-- contrato común. El diseño es deliberadamente simple pero permite cubrir todos
-- los tipos de benchmark:
--
--   GET /read/:id    -> SELECT por PK sobre items
--   GET /read-heavy  -> SELECT items JOIN categories (payload grande)
--   GET /aggregate   -> GROUP BY category sobre 1M filas (COUNT/SUM/AVG)
--   POST /write      -> INSERT en items
-- ============================================================================

-- Tabla chica de catálogo. Sirve para que /read-heavy tenga un JOIN realista
-- y para que /aggregate agrupe por algo con sentido.
CREATE TABLE categories (
    id   SMALLINT PRIMARY KEY,
    name TEXT NOT NULL
);

-- Tabla principal: acá viven el millón de filas.
CREATE TABLE items (
    id          BIGSERIAL PRIMARY KEY,                 -- PK -> índice automático, usado por /read/:id
    name        TEXT        NOT NULL,
    value       INTEGER     NOT NULL,                  -- número para agregaciones (SUM/AVG)
    category_id SMALLINT    NOT NULL REFERENCES categories(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice sobre la FK. Sin esto, el GROUP BY de /aggregate y el JOIN de
-- /read-heavy harían un scan secuencial de 1M filas en cada request.
-- Con índice, el planner puede agrupar/unir mucho más rápido.
CREATE INDEX idx_items_category_id ON items (category_id);

-- Índice temporal: útil si más adelante filtramos/ordenamos por fecha
-- (ej. "los últimos N"). Lo dejamos preparado.
CREATE INDEX idx_items_created_at ON items (created_at);
