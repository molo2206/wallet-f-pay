// apps/auth-service/src/work-schedules/work-schedules.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { WorkSchedulesService } from './work-schedules.service';

/** Messages RabbitMQ (auth_queue) des programmes de travail — appelés par l'api-gateway */
@Controller()
export class WorkSchedulesController {
  constructor(private readonly service: WorkSchedulesService) {}

  @MessagePattern('work_schedules.list')
  list(@Payload() q: any) {
    return this.service.listSchedules(q || {});
  }

  @MessagePattern('work_schedules.get')
  get(@Payload() data: { id: string }) {
    return this.service.getSchedule(data.id);
  }

  @MessagePattern('work_schedules.save')
  save(@Payload() data: { id?: string; dto: any; adminId: string }) {
    return this.service.saveSchedule(data);
  }

  @MessagePattern('work_schedules.delete')
  remove(@Payload() data: { id: string; adminId: string }) {
    return this.service.deleteSchedule(data);
  }

  @MessagePattern('work_schedules.assign')
  assign(@Payload() data: { targetType: any; targetId: string; scheduleId?: string | null; adminId: string }) {
    return this.service.assign(data);
  }

  @MessagePattern('work_schedules.exceptions.create')
  createException(@Payload() data: { dto: any; adminId: string }) {
    return this.service.createException(data);
  }

  @MessagePattern('work_schedules.exceptions.list')
  listExceptions(@Payload() q: any) {
    return this.service.listExceptions(q || {});
  }

  @MessagePattern('work_schedules.exceptions.revoke')
  revokeException(@Payload() data: { id: string; adminId: string }) {
    return this.service.revokeException(data);
  }

  @MessagePattern('work_schedules.me')
  me(@Payload() data: { userId: string; lang?: string }) {
    return this.service.me(data);
  }

  /** Lancement manuel du contrôle (supervision) */
  @MessagePattern('work_schedules.enforce')
  async enforce() {
    await this.service.enforce();
    return { message: 'OK' };
  }
}
