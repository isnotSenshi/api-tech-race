# api-tech-race 🏎️

Carrera de **8 backend stacks** para comparar, de forma medible y visual, cómo cada
tecnología maneja **lectura, escritura y CPU** bajo carga — todos peleando contra la
**misma** base PostgreSQL para que la comparación sea justa.

> Elegís una operación y una carga (nº de peticiones + concurrencia), apretás **Race**
> y ves el ranking en vivo: throughput (req/s) y latencias p50/p95/p99.

## Los 8 contenders

| Lenguaje | Framework | | Lenguaje | Framework |
|---|---|---|---|---|
| Rust | Axum | | JavaScript | Express |
| Go | Gin | | JavaScript | Nest |
| Java | Spring Boot | | JavaScript | Fastify |
| .NET | ASP.NET Core | | Python | FastAPI |

Los 3 de JavaScript son a propósito: una sub-carrera *mismo lenguaje, distinto framework*.

## Arquitectura

```
  navegador → FRONT (:8080) → ORQUESTADOR (:4000) → corre `oha` → cada STACK → PostgreSQL
                                                                     (8 stacks)   (compartido, 1M filas)
```

- **Front** (nginx + Chart.js): elegís operación/carga, ves el ranking y los gráficos.
- **Orquestador** (Node + Fastify): recibe la config, corre el generador de carga
  [`oha`](https://github.com/hatoo/oha) contra cada stack **en secuencia** (para no sesgar
  la medición) y devuelve las métricas.
- **8 stacks**: cada uno expone el mismo contrato HTTP. Lo único que cambia es la tecnología.
- **PostgreSQL**: un único servidor compartido, sembrado con 1.000.000 de filas.

## Requisitos

Solo **[Docker](https://www.docker.com/products/docker-desktop/)** (Desktop en Windows/Mac
o el engine en Linux). No hace falta instalar ningún lenguaje: todo vive en contenedores.

## Cómo levantarlo (paso a paso)

**1. Tener Docker corriendo.** Abrí **Docker Desktop** y esperá a que diga *"Engine running"* (verde, abajo a la izquierda).

**2. Abrir una terminal en la carpeta del proyecto.** Recomendado **PowerShell** (en Windows el comando `docker` se reconoce ahí):
```powershell
cd "C:\Program Files\Milk Codes\api-tech-race"
```

**3. Levantar todo:**
```powershell
docker compose up -d --build
```
> La **primera vez** baja imágenes y compila los 8 stacks (Rust y Java son los más lentos): puede tardar varios minutos. Las siguientes veces arranca en segundos.

**4. Esperar ~15 s y abrir** 👉 **http://localhost:8080** → botón **🏁 Race all 8**.

### Comandos útiles

```powershell
docker compose ps        # ver qué está arriba
docker compose logs -f   # logs en vivo (Ctrl+C para salir)
docker compose down      # apagar todo
docker compose down -v   # apagar Y borrar los datos (re-siembra al volver a subir)
```

> **Si la terminal dice `docker: command not found`:** cerrala y abrí una **PowerShell nueva**
> (el PATH se refresca al abrir, después de que Docker Desktop esté corriendo).

## Operaciones (qué mide cada una)

| Operación | Endpoint | Qué estresa |
|---|---|---|
| `read` | `GET /read/:id` | Lectura simple por PK (el "piso") |
| `read-heavy` | `GET /read-heavy?limit=N` | Serializar muchas filas + JOIN |
| `write` | `POST /write` | Escritura (INSERT) y el pool |
| `aggregate` | `GET /aggregate` | `GROUP BY` sobre 1M de filas |
| `compute` | `GET /compute?n=N` | CPU puro (Fibonacci recursivo), sin DB |

Más dos dimensiones que se ajustan desde el front: **concurrencia** y **nº de peticiones**.

## Puertos

| Servicio | Puerto | | Stack | Puerto |
|---|---|---|---|---|
| Front | 8080 | | express | 3001 |
| Orquestador | 4000 | | nest | 3002 |
| PostgreSQL | 5432 | | fastify | 3003 |
| | | | go | 3004 |
| | | | rust | 3005 |
| | | | python | 3006 |
| | | | java | 3007 |
| | | | dotnet | 3008 |

## Modo "stress" (10M de filas)

El seed por defecto son 1.000.000 de filas (suficiente para que se note la diferencia).
Para subirlo, editá el número en [`db/init/02-seed.sql`](db/init/02-seed.sql)
(`generate_series(1, 1000000)` → `10000000`) y re-sembrá desde cero:

```bash
docker compose down -v        # borra el volumen de datos
docker compose up -d          # vuelve a sembrar con el nuevo número
```

## Estructura

```
api-tech-race/
├── docker-compose.yml      # orquesta todo (8 stacks + postgres + orquestador + front)
├── db/init/                # esquema + seed (se corren solos al crear Postgres)
├── stacks/                 # un directorio por contender (mismo contrato, distinta tech)
│   ├── fastify/  express/  nest/  go/  rust/  python/  java/  dotnet/
├── orchestrator/           # motor de medición (corre oha y normaliza métricas)
├── front/                  # página estática con el ranking y los gráficos
```

## El contrato común

Los 8 stacks implementan exactamente los mismos endpoints y las mismas reglas de equidad
(pool de 10 conexiones, mismos defaults, middleware al mínimo).
