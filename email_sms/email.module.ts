// apps/auth-service/src/email_sms/email.module.ts
import { Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { MailService } from './email.service';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const env = config.get<string>('NODE_ENV') || 'development';
        const isProd = env === 'production';

        return {
          transport: {
            host: config.get<string>('MAIL_HOST'),
            port: Number(config.get<string>('MAIL_PORT')),
            secure: isProd && config.get<string>('MAIL_SECURE') === 'true',
            requireTLS: config.get<string>('MAIL_REQUIRE_TLS') === 'true',
            auth: {
              user: config.get<string>('MAIL_USER'),
              pass: config.get<string>('MAIL_PASS'),
            },
            tls: {
              rejectUnauthorized: isProd
                ? config.get<string>('MAIL_REJECT_UNAUTHORIZED') === 'true'
                : false,
            },
          },
          defaults: {
            from: config.get<string>('MAIL_FROM'),
          },
        };
      },
    }),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
