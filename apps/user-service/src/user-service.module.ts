import { Module } from '@nestjs/common';
import { UserServiceController } from './user-service.controller';
import { UserServiceService } from './user-service.service';
import { PrismaService } from './prisma/prisma.service';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { MailModule } from 'apps/auth-service/src/email/email.module';
import { I18nModule } from '../../../libs/common/src/i18n/i18n.module';

@Module({
  imports: [MailModule, I18nModule],
  controllers: [UserServiceController],
  providers: [UserServiceService, PrismaService, SmsService],
  exports: [UserServiceService, PrismaService],
})
export class UserServiceModule {}
