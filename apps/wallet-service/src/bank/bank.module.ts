// apps/wallet-service/src/bank/bank.module.ts
import { Module } from '@nestjs/common';
import { BankService } from './bank.service';
import { EncryptionService } from './encryption.service';

@Module({
  providers: [BankService, EncryptionService],
  exports: [BankService, EncryptionService],
})
export class BankModule {}
