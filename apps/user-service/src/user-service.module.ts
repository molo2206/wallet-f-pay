// apps/user-service/src/user-service.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { UserServiceController } from './user-service.controller';
import { UserServiceService } from './user-service.service';
import { PrismaService } from './prisma/prisma.service';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { MailModule } from 'apps/auth-service/src/email/email.module';
import { I18nModule } from '../../../libs/common/src/i18n/i18n.module';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';

@Module({
  imports: [
    MailModule,
    I18nModule,
    ClientsModule.register([
      {
        name: 'NOTIFICATION_CLIENT',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'],
          queue: process.env.NOTIFICATION_QUEUE || 'notification_queue',
          queueOptions: { durable: false },
          persistent: true,
          noAck: true,
        },
      },
    ]),
  ],
  controllers: [UserServiceController],
  providers: [
    UserServiceService,
    PrismaService,
    SmsService,
    NotificationHelper,
  ],
  exports: [UserServiceService, PrismaService],
})
export class UserServiceModule {}