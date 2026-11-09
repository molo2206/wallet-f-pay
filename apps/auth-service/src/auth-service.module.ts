// auth-service.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { AuthServiceController } from './auth-service.controller';
import { AuthServiceService } from './auth-service.service';
import { OtpModule } from './otp/otp.module';
import { SmsModule } from './sms/sms.module';
import { MailModule } from './email/email.module';
import { I18nModule } from '@app/common'; // ✅ import depuis la librairie
import { BankModule } from 'apps/wallet-service/src/bank/bank.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'secret',
      signOptions: { expiresIn: '30d' },
    }),
    SmsModule,
    OtpModule,
    MailModule,
    I18nModule, // ✅ ajout
    BankModule,
  ],
  controllers: [AuthServiceController],
  providers: [AuthServiceService],
})
export class AuthServiceModule {}
