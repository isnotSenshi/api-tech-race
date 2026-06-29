// ============================================================================
// main.ts — Bootstrap del servicio NestJS.
//
// Arranca la app y la pone a escuchar. Dos cosas importantes para el benchmark:
//   1) logger: false -> apagamos el logger de Nest. Loguear por request agrega
//      latencia y sesga la medición; el middleware/overhead va al mínimo.
//   2) listen en '0.0.0.0' -> obligatorio dentro de Docker para que el servicio
//      sea accesible desde fuera del contenedor. Con '127.0.0.1' solo escucharía
//      dentro del propio contenedor y nadie podría conectarse.
// ============================================================================

// reflect-metadata DEBE importarse antes que nada: Nest lo usa para leer por
// reflexión los tipos de los constructores y resolver la inyección de dependencias.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // logger: false desactiva por completo el logger de Nest (incluido el banner
  // y los logs de arranque), para no agregar overhead durante el benchmark.
  const app = await NestFactory.create(AppModule, { logger: false });

  // Por defecto Nest sobre Express ya acepta cualquier POST sin parsear body si
  // no usamos @Body(); el endpoint /write ignora el body por completo, así que
  // no hace falta configurar parsers extra ni validar Content-Type.

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  // Un único log al arrancar (no por request): no afecta la medición.
  console.log(`[nest] escuchando en :${port} (pool max=10)`);
}

bootstrap();
