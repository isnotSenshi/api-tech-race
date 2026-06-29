// ============================================================================
// app.module.ts — Módulo raíz de la app Nest.
//
// Cablea las piezas: declara el controller (los endpoints) y el DbService como
// provider. Al ser provider, Nest crea un único DbService (singleton) y se lo
// inyecta al controller. No usamos ConfigModule ni nada extra: el overhead va al
// mínimo para no sesgar el benchmark.
// ============================================================================

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { DbService } from './db.service';

@Module({
  controllers: [AppController],
  providers: [DbService],
})
export class AppModule {}
