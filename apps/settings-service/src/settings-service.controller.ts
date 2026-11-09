// apps/settings-service/src/settings-service.controller.ts
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { GeneralSettingsService } from './general-settings/general-settings.service';
import { SecurityPoliciesService } from './security-policies/security-policies.service';
import { UserTransactionLimitService } from './user-transaction-limit/user-transaction-limit.service';
import { UpdateGeneralSettingsDto } from './general-settings/dto/update-general-settings.dto';
import { UpdateSecurityPoliciesDto } from './security-policies/dto/update-security-policies.dto';
import { UpdateUserTransactionLimitDto } from './user-transaction-limit/dto/update-user-transaction-limit.dto';

@Controller()
export class SettingsServiceController {
  private readonly logger = new Logger(SettingsServiceController.name);

  constructor(
    private readonly generalSettingsService: GeneralSettingsService,
    private readonly securityPoliciesService: SecurityPoliciesService,
    private readonly userTransactionLimitService: UserTransactionLimitService,
  ) {}

  @MessagePattern('get_general_settings')
  async getGeneralSettings() {
    this.logger.log('Received get_general_settings');
    return this.generalSettingsService.getSettings();
  }

  @MessagePattern('update_general_settings')
  async updateGeneralSettings(@Payload() dto: UpdateGeneralSettingsDto) {
    console.log('[SettingsController] Received update_general_settings:', dto);
    const result = await this.generalSettingsService.updateSettings(dto);
    console.log('[SettingsController] Result:', result);
    return result;
  }

  @MessagePattern('ping')
  async ping() {
    return { message: 'pong' };
  }

  @MessagePattern('get_security_policies')
  async getSecurityPolicies() {
    this.logger.log('Received get_security_policies');
    return this.securityPoliciesService.getPolicies();
  }

  @MessagePattern('update_security_policies')
  async updateSecurityPolicies(@Payload() dto: UpdateSecurityPoliciesDto) {
    this.logger.log(
      `Received update_security_policies: ${JSON.stringify(dto)}`,
    );
    return this.securityPoliciesService.updatePolicies(dto);
  }

  @MessagePattern('get_user_transaction_limit')
  async getUserTransactionLimit(@Payload() data: { userId: string }) {
    this.logger.log(
      `Received get_user_transaction_limit for user ${data.userId}`,
    );
    return this.userTransactionLimitService.getLimitByUserId(data.userId);
  }

  @MessagePattern('update_user_transaction_limit')
  async updateUserTransactionLimit(
    @Payload() data: { userId: string; dto: UpdateUserTransactionLimitDto },
  ) {
    this.logger.log(
      `Received update_user_transaction_limit for user ${data.userId}`,
    );
    return this.userTransactionLimitService.updateLimit(data.userId, data.dto);
  }

  @MessagePattern('check_transaction_limit')
  async checkTransactionLimit(
    @Payload() data: { userId: string; amount: number },
  ) {
    this.logger.log(
      `Received check_transaction_limit for user ${data.userId}, amount ${data.amount}`,
    );
    return this.userTransactionLimitService.checkTransactionLimit(
      data.userId,
      data.amount,
    );
  }
}
