// apps/api-gateway/src/work-schedules/work-schedules.gateway.controller.ts
import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AuthentificationGuard } from 'apps/auth-service/src/utility/guards/authentification.guard';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { CurrentUser } from 'apps/auth-service/src/utility/decorators/current-user-decorator';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { assertAdminResource, createRmqClient, rpcSend } from './rpc-client.util';

const RESOURCE = 'WORK_SCHEDULES';

/**
 * ✅ PROGRAMMES DE TRAVAIL
 *  - Administration : SUPER_ADMIN, ou ADMIN disposant de la ressource WORK_SCHEDULES.
 *  - GET /work-schedules/me : chaque utilisateur consulte son programme et l'heure de fin de son accès.
 *
 *  Corps d'un programme :
 *  { name, description?, timezone? (ex. Africa/Lubumbashi), graceMinutes? (0-120), warnMinutes? (0-120, défaut 10),
 *    isActive?, slots: [{ dayOfWeek: 1..7 (lundi=1), startTime: 'HH:mm', endTime: 'HH:mm' }] }
 *  Jour sans plage = repos. Plage de nuit possible (22:00 → 06:00).
 */
@Controller()
@UseGuards(JwtAuthGuard, AuthentificationGuard)
export class WorkSchedulesGatewayController {
  private readonly auth: ClientProxy = createRmqClient('AUTH_QUEUE', 'auth_queue');

  constructor(private readonly prisma: PrismaService) {}

  @Get('work-schedules/me')
  me(@CurrentUser() user: any, @Headers('lang') lang?: string) {
    return rpcSend(this.auth, 'work_schedules.me', { userId: user.id, lang: lang || 'fr' });
  }

  @Get('admin/work-schedules')
  async list(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.auth, 'work_schedules.list', { search: q.search, page: q.page, limit: q.limit });
  }

  @Get('admin/work-schedules/exceptions')
  async listExceptions(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.auth, 'work_schedules.exceptions.list', {
      userId: q.userId,
      status: q.status,
      page: q.page,
      limit: q.limit,
    });
  }

  /** Programme et état d'accès d'un utilisateur précis */
  @Get('admin/work-schedules/users/:userId')
  async userAccess(@CurrentUser() user: any, @Param('userId') userId: string, @Headers('lang') lang?: string) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.auth, 'work_schedules.me', { userId, lang: lang || 'fr' });
  }

  @Get('admin/work-schedules/:id')
  async get(@CurrentUser() user: any, @Param('id') id: string) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.auth, 'work_schedules.get', { id });
  }

  @Post('admin/work-schedules')
  async create(@CurrentUser() user: any, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.auth, 'work_schedules.save', { dto, adminId: user.id });
  }

  @Patch('admin/work-schedules/:id')
  async update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.auth, 'work_schedules.save', { id, dto, adminId: user.id });
  }

  @Delete('admin/work-schedules/:id')
  async remove(@CurrentUser() user: any, @Param('id') id: string) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.auth, 'work_schedules.delete', { id, adminId: user.id });
  }

  /** { targetType: USER | BRANCH | ROLE, targetId, scheduleId (null = retirer) } */
  @Put('admin/work-schedules/assignments')
  async assign(@CurrentUser() user: any, @Body() body: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.auth, 'work_schedules.assign', {
      targetType: body?.targetType,
      targetId: body?.targetId,
      scheduleId: body?.scheduleId ?? null,
      adminId: user.id,
    });
  }

  /** { type: ALLOW | DENY, userId | userIds[], startsAt, endsAt, reason } */
  @Post('admin/work-schedules/exceptions')
  async createException(@CurrentUser() user: any, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.auth, 'work_schedules.exceptions.create', { dto, adminId: user.id });
  }

  @Patch('admin/work-schedules/exceptions/:id/revoke')
  async revokeException(@CurrentUser() user: any, @Param('id') id: string) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.auth, 'work_schedules.exceptions.revoke', { id, adminId: user.id });
  }
}
