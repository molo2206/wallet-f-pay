// apps/api-gateway/src/app.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core'; // ✅ IMPORTER APP_GUARD
import { ApiGatewayController } from './api-gateway.controller';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { I18nModule } from '@app/common';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { ApiKeyGuard } from './guards/api-key.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    I18nModule,
  ],
  controllers: [ApiGatewayController],
  providers: [
    PrismaService,
    ConfigService,
    ApiKeyGuard,
    // ✅ AJOUTER JwtAuthGuard comme guard GLOBAL
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
  exports: [PrismaService],
})
export class AppModule { }