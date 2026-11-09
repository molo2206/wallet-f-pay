import { Module } from '@nestjs/common';
import { AuditController } from './audit-service.controller';
import { AuditService } from './audit-service.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService, PrismaService],
})
export class AuditModule {}
