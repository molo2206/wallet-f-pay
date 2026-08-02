// apps/auth-service/src/sms/sms.module.ts
import { Module } from '@nestjs/common';
import { SmsService } from './sms.service';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';

@Module({
  providers: [
    SmsService,
    PrismaService, // ✅ AJOUTER PrismaService
  ],
  exports: [SmsService], // ✅ Exporter SmsService
})
export class SmsModule {}