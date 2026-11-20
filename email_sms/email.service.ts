// apps/auth-service/src/email_sms/email.service.ts
import { Injectable } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MailService {
  constructor(private readonly mailerService: MailerService) {}

  async sendHtmlEmail(
    to: string,
    subject: string,
    htmlPageName: string,
    context: any = {},
  ) {
    const basePath = path.join(process.cwd(), 'templates', 'auth');
    const htmlPath = path.join(basePath, htmlPageName);

    let htmlContent = fs.readFileSync(htmlPath, 'utf-8');

    htmlContent = htmlContent.replace(/{{\s*([\w.]+)\s*}}/g, (_, match) => {
      const keys = match.split('.');
      let value = context;
      for (const key of keys) {
        if (value && key in value) {
          value = value[key];
        } else {
          value = undefined;
          break;
        }
      }
      return value !== undefined ? value : '';
    });

    await this.mailerService.sendMail({
      to,
      subject,
      html: htmlContent,
    });
  }

  async sendOtpEmail(to: string, otpCode: string): Promise<void> {
    await this.sendHtmlEmail(to, 'Votre code de verification', 'sendOtp.html', {
      otpCode,
      email: to,
      year: new Date().getFullYear(),
    });
  }

  async sendWelcomeEmail(
    to: string,
    fullName: string,
    accountNumber: string,
  ): Promise<void> {
    await this.sendHtmlEmail(
      to,
      'Bienvenue sur AccesPay',
      'welcome.html',
      {
        fullName,
        accountNumber,
        year: new Date().getFullYear(),
      },
    );
  }
}
