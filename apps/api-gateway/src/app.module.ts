/* eslint-disable prettier/prettier */
// apps/api-gateway/src/app.module.ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './inrceptor/idempotency.interceptor';
import { MoneyFormatInterceptor } from './inrceptor/money-format.interceptor';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApiGatewayController } from './api-gateway.controller';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { I18nModule } from '@app/common'; // ← import manquant
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { ApiKeyGuard } from './guards/api-key.guard';
import { WorkSchedulesGatewayController } from './work-schedules/work-schedules.gateway.controller';
import { SupervisionController } from './supervision/supervision.controller';
import { ControlsGatewayController } from './controls/controls.gateway.controller';
import { AdminApprovalService } from './controls/admin-approval.service';
import { LimitsInterceptor } from './controls/limits.interceptor';
import { MaintenanceController } from './maintenance/maintenance.controller';
import { MaintenanceService } from './maintenance/maintenance.service';
import { MaintenanceInterceptor } from './maintenance/maintenance.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    I18nModule, // ← indispensable pour que JwtAuthGuard puisse injecter I18nService
  ],
  controllers: [ApiGatewayController, WorkSchedulesGatewayController, SupervisionController, ControlsGatewayController, MaintenanceController],
  providers: [
    PrismaService,
    ConfigService,
    JwtAuthGuard, // ← ajoutez JwtAuthGuard dans les providers pour qu'il soit instancié avec ses dépendances
    ApiKeyGuard,
    // ✅ Mode maintenance (EN PREMIER : une requête bloquée n'atteint aucun autre traitement)
    MaintenanceService,
    { provide: APP_INTERCEPTOR, useClass: MaintenanceInterceptor },
    // ✅ Montants arrondis à 3 décimales dans toutes les réponses (enregistré avant l'idempotence : s'applique aussi aux réponses rejouées)
    { provide: APP_INTERCEPTOR, useClass: MoneyFormatInterceptor },
    // ✅ Plafonds par niveau KYC (LIMITS_MODE : monitor par défaut, enforce pour bloquer)
    AdminApprovalService,
    LimitsInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: LimitsInterceptor },
    // ✅ Anti double traitement des opérations financières (Idempotency-Key + empreinte automatique)
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [PrismaService],
})
export class AppModule { }
