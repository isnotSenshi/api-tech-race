// ============================================================================
// db.service.ts — Provider que encapsula el Pool de conexiones a PostgreSQL.
//
// En Nest, en vez de crear el pool como un global suelto (como hace el stack de
// referencia Fastify), lo envolvemos en un @Injectable. Así el contenedor de DI
// crea UNA sola instancia (los providers son singletons por defecto) y se la
// inyecta al controller por constructor. El pool sigue siendo único y reutilizado
// en todos los requests, igual que en la referencia.
// ============================================================================

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, types, QueryResultRow } from 'pg';

// El driver pg devuelve los BIGINT (OID 20) como STRING para no perder precisión:
// un bigint puede superar el entero seguro de JS (2^53). Nuestros ids son chicos
// (< 1M), así que los parseamos a número para que el JSON sea consistente con los
// otros stacks (que devuelven el id como número). setTypeParser es GLOBAL a pg,
// por eso se llama una vez acá a nivel de módulo y aplica a todas las queries.
types.setTypeParser(20, (v: string) => parseInt(v, 10));

// Tamaño del pool de conexiones a Postgres. DEBE ser igual en los 8 stacks o la
// carrera se sesga: bajo alta concurrencia, un pool chico hace que los requests
// hagan cola esperando una conexión libre. Lo fijamos en 10 para todos.
const POOL_MAX = 10;

@Injectable()
export class DbService implements OnModuleDestroy {
  // El pool se crea UNA sola vez (al instanciar el provider, al arrancar) y se
  // reutiliza en todos los requests. Abrir una conexión nueva por request sería
  // lentísimo; el pool las recicla. Los datos llegan por variables de entorno
  // (las define docker-compose). El host por defecto es "postgres" -> el NOMBRE
  // del servicio en la red interna de Docker.
  private readonly pool = new Pool({
    host: process.env.PGHOST ?? 'postgres',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER ?? 'race',
    password: process.env.PGPASSWORD ?? 'race',
    database: process.env.PGDATABASE ?? 'race',
    max: POOL_MAX,
  });

  /**
   * Ejecuta una query parametrizada y devuelve solo las filas.
   * SIEMPRE con parámetros ($1, $2, ...): nunca concatenamos valores en el SQL,
   * eso sería vulnerable a inyección. El driver los manda por separado y a salvo.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, params as unknown[]);
    return result.rows;
  }

  // Hook de ciclo de vida de Nest: al apagar la app cerramos el pool de forma
  // ordenada para no dejar conexiones colgadas contra Postgres.
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
