// apps/user-service/src/prisma/prisma.service.tsimport { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      // ✅ Performance : journaliser chaque requête SQL ralentit fortement la production.
      // PRISMA_LOG=query,info,warn,error pour le diagnostic ; défaut : warn,error.
      log: (process.env.PRISMA_LOG || 'warn,error').split(',').map((l) => l.trim()).filter(Boolean) as any,
    });  }

  async onModuleInit() {
    await this.$connect();
    console.log('✅ Connected to database');  }

  async onModuleDestroy() {
    await this.$disconnect();
    console.log('❌ Disconnected from database');  }
}
