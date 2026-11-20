import { Module } from '@nestjs/common';
import { GeneralSettingsService } from './general-settings/general-settings.service';
import { SecurityPoliciesService } from './security-policies/security-policies.service';
import { UserTransactionLimitService } from './user-transaction-limit/user-transaction-limit.service';
import { PrismaService } from './prisma/prisma.service';

@Module({
  providers: [
    PrismaService,
    GeneralSettingsService,
    SecurityPoliciesService,
    UserTransactionLimitService,
  ],
  exports: [
    GeneralSettingsService,
    SecurityPoliciesService,
    UserTransactionLimitService,
  ],
})
export class SettingsModule {}
