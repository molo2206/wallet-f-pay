// apps/api-gateway/src/maintenance/maintenance.controller.ts
import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthentificationGuard } from 'apps/auth-service/src/utility/guards/authentification.guard';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { CurrentUser } from 'apps/auth-service/src/utility/decorators/current-user-decorator';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { assertAdminResource } from '../work-schedules/rpc-client.util';
import { MaintenanceService } from './maintenance.service';

/**
 * ✅ MODE MAINTENANCE
 *  Public      GET  /maintenance/status                 (bannière / écran des applications ; en-tête lang)
 *  Gestion     /admin/maintenance/…                     SUPER_ADMIN, ou ADMIN avec la ressource MAINTENANCE
 *
 *  Corps d'une fenêtre :
 *  { title, scope: FULL | READ_ONLY | MODULES, modules?: [DEPOSITS, WITHDRAWALS, TRANSFERS, PAYMENTS, CONVERSION,
 *    LOGIN, REGISTRATION, EXTERNAL_API, KYC, CASH_DESK], messages?: { fr, en, sw },
 *    startsAt? (ISO, absent = maintenant), endsAt? (ISO) | durationMinutes?, allowRoles?, allowUserIds?, allowIps?,
 *    notifyUsers?: true, notifyBeforeMinutes?: 30 }
 */
@Controller()
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('maintenance/status')
  status(@Headers('lang') lang?: string) {
    return this.maintenance.status(lang || 'fr');
  }

  @Get('admin/maintenance/windows')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async list(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', false);
    return this.maintenance.list(q);
  }

  @Get('admin/maintenance/windows/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async get(@CurrentUser() user: any, @Param('id') id: string) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', false);
    return { message: 'Fenêtre de maintenance', data: await this.maintenance.get(id) };
  }

  @Post('admin/maintenance/windows')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async create(@CurrentUser() user: any, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', true);
    return this.maintenance.create(dto, user);
  }

  @Patch('admin/maintenance/windows/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', true);
    return this.maintenance.update(id, dto, user);
  }

  @Post('admin/maintenance/windows/:id/start')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async start(@CurrentUser() user: any, @Param('id') id: string) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', true);
    return this.maintenance.startNow(id, user);
  }

  /** { minutes } */
  @Post('admin/maintenance/windows/:id/extend')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async extend(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', true);
    return this.maintenance.extend(id, body?.minutes, user);
  }

  /** { reason? } — termine maintenant (id « legacy » = ancien interrupteur des paramètres) */
  @Post('admin/maintenance/windows/:id/end')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async end(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', true);
    return this.maintenance.end(id, user, body?.reason, false);
  }

  /** { reason? } — annule une maintenance planifiée (ou en cours) */
  @Post('admin/maintenance/windows/:id/cancel')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async cancel(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', true);
    return this.maintenance.end(id, user, body?.reason, true);
  }

  /** Raccourci : maintenance immédiate. { scope?, modules?, durationMinutes?, title?, messages?, notifyUsers? } */
  @Post('admin/maintenance/quick')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async quick(@CurrentUser() user: any, @Body() body: any) {
    await assertAdminResource(this.prisma, user, 'MAINTENANCE', true);
    if (!body || typeof body !== 'object') throw new HttpException('Corps invalide', HttpStatus.BAD_REQUEST);
    return this.maintenance.create({ title: body.title || 'Maintenance', scope: body.scope || 'FULL', ...body, startsAt: undefined }, user);
  }
}
