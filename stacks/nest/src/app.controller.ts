// ============================================================================
// app.controller.ts — Los 6 endpoints del contrato común de api-tech-race.
//
// Todos los stacks exponen EXACTAMENTE estos endpoints, con el mismo
// comportamiento y los mismos defaults, pegándole a la misma base Postgres.
// Lo único que cambia entre stacks es la tecnología. La referencia es Fastify;
// acá replicamos su comportamiento usando NestJS sobre Express.
//
// Nest serializa el valor retornado a JSON automáticamente (status 200 por
// defecto en GET). Para los códigos 400/404 lanzamos HttpException, que Nest
// traduce al status correspondiente.
// ============================================================================

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { DbService } from './db.service';

// ── Constantes de "fairness" (equidad) ──────────────────────────────────────
// Estos topes DEBEN ser iguales en los 8 stacks o la carrera se sesga.

// Límite de filas que devuelve /read-heavy. Acotado para que nadie pueda pedir
// el millón entero y tumbar el proceso (y para que la prueba sea comparable).
const HEAVY_DEFAULT = 1000;
const HEAVY_MAX = 10000;

// Parámetro de /compute. fib(35) ≈ 9 millones de llamadas recursivas: pesado
// pero rápido. El tope evita que un n gigante cuelgue el servidor.
const FIB_DEFAULT = 35;
const FIB_MAX = 45;

// Tipos de las filas que devuelve cada query. No son DTOs con validación
// (queremos overhead mínimo): solo le dan forma al resultado para TypeScript.
interface ItemRow {
  id: number;
  name: string;
  value: number;
  category_id: number;
  created_at: Date;
}

@Controller()
export class AppController {
  // Inyección por constructor: el contenedor de DI le pasa el singleton de
  // DbService (el dueño del Pool). El controller no sabe cómo se creó el pool.
  constructor(private readonly db: DbService) {}

  // ── #0  GET /health ────────────────────────────────────────────────────────
  // Ping simple. No toca la base. Sirve para saber si el servicio está vivo.
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  // ── #1  GET /read/:id ────────────────────────────────────────────────────────
  // Lectura simple: una fila por clave primaria. Es el "piso" del benchmark:
  // mide red + driver + serialización JSON, con la DB haciendo lo mínimo (un
  // lookup por índice de PK, instantáneo).
  @Get('read/:id')
  async read(@Param('id') idParam: string): Promise<ItemRow> {
    // El :id llega como string (Express no tipa los params). Number() lo convierte;
    // Validación en el borde: si no es un entero positivo, 400 (Bad Request).
    const id = Number(idParam);
    if (!Number.isInteger(id) || id < 1) {
      throw new HttpException({ error: 'id inválido' }, HttpStatus.BAD_REQUEST);
    }

    // $1 es un parámetro: NUNCA concatenamos valores en el SQL (inyección).
    const rows = await this.db.query<ItemRow>(
      'SELECT id, name, value, category_id, created_at FROM items WHERE id = $1',
      [id],
    );
    if (rows.length === 0) {
      throw new HttpException({ error: 'no encontrado' }, HttpStatus.NOT_FOUND);
    }
    // El created_at viene como Date; al serializar a JSON, JSON.stringify lo
    // convierte a ISO-8601 ("...Z") automáticamente, igual que la referencia.
    return rows[0];
  }

  // ── #2  GET /read-heavy?limit=1000 ────────────────────────────────────────────
  // Lectura pesada: muchas filas + JOIN con categories. Acá pesa cuánto tarda
  // cada stack en SERIALIZAR a JSON un payload grande. Suele ser donde más se
  // separan los frameworks.
  @Get('read-heavy')
  async readHeavy(@Query('limit') limitParam?: string): Promise<unknown[]> {
    // Number(undefined) -> NaN, y "NaN || DEFAULT" cae al default: mismo
    // comportamiento que `Number(req.query.limit) || HEAVY_DEFAULT` de la ref.
    let limit = Number(limitParam) || HEAVY_DEFAULT;
    if (limit > HEAVY_MAX) limit = HEAVY_MAX;
    if (limit < 1) limit = HEAVY_DEFAULT;

    return this.db.query(
      `SELECT i.id, i.name, i.value, i.created_at, c.name AS category
         FROM items i
         JOIN categories c ON c.id = i.category_id
        ORDER BY i.id
        LIMIT $1`,
      [limit],
    );
  }

  // ── #3  POST /write ────────────────────────────────────────────────────────────
  // Escritura: un INSERT. Mide cómo maneja el pool bajo carga. Insertamos valores
  // FIJOS a propósito: así los 8 stacks hacen EXACTAMENTE el mismo trabajo en la DB
  // y no dependemos del body. RETURNING id trae el id generado en la misma query
  // (sin un segundo viaje a la base). El body se IGNORA por completo: por eso no
  // declaramos @Body() ni validamos Content-Type, y Express acepta el POST igual.
  @Post('write')
  async write(): Promise<{ inserted: number }> {
    const rows = await this.db.query<{ id: number }>(
      'INSERT INTO items (name, value, category_id) VALUES ($1, $2, $3) RETURNING id',
      ['bench_write', 42, 1],
    );
    return { inserted: rows[0].id };
  }

  // ── #5  GET /aggregate ─────────────────────────────────────────────────────────
  // Agregación: GROUP BY sobre el millón de filas. Castiga a drivers lentos y mide
  // trabajo real de la DB + serialización del resultado. Los ::int castean los
  // bigint de count() a entero para que viajen como número (no como string).
  @Get('aggregate')
  async aggregate(): Promise<unknown[]> {
    return this.db.query(
      `SELECT c.name AS category,
              count(*)::int            AS total,
              round(avg(i.value))::int AS avg_value
         FROM items i
         JOIN categories c ON c.id = i.category_id
        GROUP BY c.name
        ORDER BY c.name`,
    );
  }

  // ── #6  GET /compute?n=35 ──────────────────────────────────────────────────────
  // CPU-bound puro: SACA a la base de la ecuación y mide el lenguaje/runtime.
  // Fibonacci RECURSIVO ingenuo a propósito: O(2^n), idéntico de implementar en
  // cualquier lenguaje, exige CPU de verdad. Acá Rust/Go vuelan y Node/Nest sufren.
  //
  // OJO didáctico: Node es de UN solo hilo. Un fib(n) grande BLOQUEA el event loop
  // y congela TODAS las peticiones concurrentes mientras calcula. No es un bug: es
  // justo la lección del benchmark de concurrencia (single-thread vs goroutines).
  @Get('compute')
  compute(@Query('n') nParam?: string): { n: number; result: number } {
    let n = Number(nParam);
    if (!Number.isInteger(n)) n = FIB_DEFAULT;
    if (n > FIB_MAX) n = FIB_MAX;
    if (n < 0) n = 0;
    const result = AppController.fib(n);
    return { n, result };
  }

  // Fibonacci recursivo ingenuo. Usamos number, que es un double de 64 bits:
  // fib(45) = 1134903170, muy por debajo del entero seguro (2^53), así que el
  // resultado es exacto. Es estático para no arrastrar el `this` del controller.
  private static fib(n: number): number {
    if (n < 2) return n;
    return AppController.fib(n - 1) + AppController.fib(n - 2);
  }
}
