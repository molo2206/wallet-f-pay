import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateSecurityPoliciesDto } from './dto/update-security-policies.dto';

@Injectable()
export class SecurityPoliciesService implements OnModuleInit {
  private readonly SINGLETON_ID = '1';
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.prisma.security_policies.upsert({
      where: { id: this.SINGLETON_ID },
      update: {},
      create: {
        id: this.SINGLETON_ID,
        password_min_length: 8,
        password_require_uppercase: true,
        password_require_lowercase: true,
        password_require_numbers: true,
        password_require_special: true,
        password_expiry_days: 90,
        password_history_count: 5,
        session_timeout_minutes: 30,
        max_concurrent_sessions: 3,
        remember_me_duration_days: 30,
        max_login_attempts: 5,
        lockout_duration_minutes: 30,
        require_captcha_after_attempts: 3,
        enforce_2fa: true,
        enforce_2fa_for_admins: true,
        allowed_2fa_methods: 'sms,email',
        enable_ip_whitelist: false,
        enable_ip_blacklist: true,
      },
    });
  }

  async getPolicies() {
    const policies = await this.prisma.security_policies.findUnique({
      where: { id: this.SINGLETON_ID },
    });
    return {
      ...policies,
      allowed_2fa_methods: policies?.allowed_2fa_methods?.split(',') || [],
    };
  }

  async updatePolicies(dto: UpdateSecurityPoliciesDto) {
    const data: any = { ...dto };
    if (dto.allowed_2fa_methods) {
      data.allowed_2fa_methods = dto.allowed_2fa_methods.join(',');
    }
    return this.prisma.security_policies.update({
      where: { id: this.SINGLETON_ID },
      data,
    });
  }
}
