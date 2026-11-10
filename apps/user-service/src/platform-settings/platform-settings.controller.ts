// apps/user-service/src/platform-settings/platform-settings.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { PlatformSettingsService } from './platform-settings.service';

/** Messages autrefois destinés au settings-service (jamais démarré), désormais servis par le user-service */
@Controller()
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @MessagePattern('get_general_settings')
  getGeneral() {
    return this.settings.getGeneral();
  }

  @MessagePattern('update_general_settings')
  updateGeneral(@Payload() dto: any) {
    return this.settings.updateGeneral(dto);
  }

  @MessagePattern('get_security_policies')
  getSecurity() {
    return this.settings.getSecurity();
  }

  @MessagePattern('update_security_policies')
  updateSecurity(@Payload() dto: any) {
    return this.settings.updateSecurity(dto);
  }

  @MessagePattern('get_user_transaction_limit')
  getUserLimit(@Payload() data: { userId: string }) {
    return this.settings.getUserLimit(data?.userId);
  }

  @MessagePattern('update_user_transaction_limit')
  updateUserLimit(@Payload() data: { userId: string; dto: any }) {
    return this.settings.updateUserLimit(data?.userId, data?.dto);
  }

  @MessagePattern('wallets.ensure_account_currencies')
  ensureAccountCurrencies(@Payload() data: { adminId: string; dryRun?: boolean; includeAdmins?: boolean; userId?: string }) {
    return this.settings.ensureAccountCurrencies(data || ({} as any));
  }

  @MessagePattern('settings_ping')
  ping() {
    return { message: 'pong' };
  }
}
