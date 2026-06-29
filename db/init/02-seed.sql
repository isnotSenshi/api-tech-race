-- ============================================================================
-- 02-seed.sql — Siembra de datos ficticios.
--
-- Llena la base con ~1.000.000 de filas SIN scripts externos ni librerías:
-- lo hace el propio Postgres con generate_series(). Es la forma más rápida y
-- reproducible de generar volumen.
--
-- ¿Por qué 1M? Es suficiente para que se note la diferencia entre stacks y
-- para que las consultas usen los índices de verdad, pero liviano (~100-300 MB)
-- para una notebook. Para un modo "stress" basta cambiar el número de abajo.
-- ============================================================================

-- 1) Categorías (10 filas fijas). generate_series genera los ids 1..10 y
--    armamos un nombre simple para cada uno.
INSERT INTO categories (id, name)
SELECT g, 'category_' || g
FROM generate_series(1, 10) AS g;

-- 2) Items (1M filas). Un único INSERT ... SELECT es órdenes de magnitud más
--    rápido que insertar fila por fila, porque Postgres lo procesa como una
--    sola operación masiva.
--
--    Por cada número g del 1 al 1.000.000 generamos:
--      name        -> 'item_<g>'
--      value       -> entero aleatorio 0..1000
--      category_id -> categoría aleatoria 1..10
--      created_at  -> una fecha aleatoria dentro del último año
INSERT INTO items (name, value, category_id, created_at)
SELECT
    'item_' || g,
    (random() * 1000)::int,
    (floor(random() * 10) + 1)::smallint,
    now() - (random() * interval '365 days')
FROM generate_series(1, 1000000) AS g;

-- 3) Actualizamos las estadísticas del planner. Tras una carga masiva, ANALYZE
--    le da a Postgres datos frescos sobre la distribución de las filas para que
--    elija buenos planes de ejecución (usar índice vs. scan). Es buena práctica
--    siempre después de un seed grande.
ANALYZE items;
ANALYZE categories;
