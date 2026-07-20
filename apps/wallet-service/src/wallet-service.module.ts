// apps/wallet-service/src/wallet-service.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { WalletServiceController } from './wallet-service.controller';
import { WalletServiceService } from './wallet-service.service';
import { PrismaModule } from './prisma/prisma.module';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { I18nModule } from '@app/common';
import { BankService } from './bank/bank.service';
import { EncryptionService } from './bank/encryption.service';
import { PawapayService } from './pawapay/pawapay.service';
import { PawapayModule } from './pawapay/pawapay.module';
import { MailModule } from 'apps/auth-service/src/email/email.module'; // ✅ IMPORT
import { ScheduleModule } from '@nestjs/schedule';
@Module({
  imports: [
    ScheduleModule.forRoot(), 
    PrismaModule,
    PawapayModule,
    HttpModule,
    ConfigModule,
    MailModule, // ✅ AJOUTER LE MODULE MAIL
    ClientsModule.register([
      {
        name: 'NOTIFICATION_CLIENT',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'notification_queue',
          queueOptions: { durable: false },
        },
      },
    ]),
    I18nModule,
  ],
  controllers: [WalletServiceController],
  providers: [
    WalletServiceService,
    SmsService,
    // MailService est fourni par MailModule, pas besoin de le déclarer ici
    NotificationHelper,
    BankService,
    EncryptionService,
    PawapayService,
  ],
  exports: [WalletServiceService, BankService, EncryptionService],
})
export class WalletServiceModule {}