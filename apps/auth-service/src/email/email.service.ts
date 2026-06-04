/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/auth-service/src/email/email.service.ts
import { Injectable } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { I18nService } from '@app/common';
import * as fs from 'fs';
import * as path from 'path';
import * as ejs from 'ejs';
import * as puppeteer from 'puppeteer';

@Injectable()
export class MailService {
  constructor(
    private readonly mailerService: MailerService,
    private readonly i18nService: I18nService,
  ) {}

  /**
   * Méthode existante – gardée pour compatibilité
   */
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
        if (value && key in value) value = value[key];
        else return '';
      }
      return value !== undefined ? value : '';
    });

    await this.mailerService.sendMail({
      to,
      subject,
      html: htmlContent,
    });
  }

  /**
   * NOUVELLE méthode : envoie un email avec traduction automatique via i18n
   */
  async sendTemplateEmail(
    to: string,
    templateName: string,
    templateType: 'otp' | 'welcome' | 'reset',
    context: Record<string, any>,
    lang: string = 'fr',
  ) {
    // 1. Récupérer les traductions pour ce type
    const translations = this.getTranslationsForType(
      templateType,
      lang,
      context,
    );
    const fullContext = {
      ...context,
      ...translations,
      year: new Date().getFullYear(),
    };

    // 2. Lire le template
    const basePath = path.join(process.cwd(), 'templates', 'auth');
    const htmlPath = path.join(basePath, templateName);
    let htmlContent = fs.readFileSync(htmlPath, 'utf-8');

    // 3. Remplacer les placeholders
    htmlContent = htmlContent.replace(/{{\s*([\w.]+)\s*}}/g, (_, match) => {
      const keys = match.split('.');
      let value = fullContext;
      for (const key of keys) {
        if (value && key in value) value = value[key];
        else return '';
      }
      return value !== undefined ? value : '';
    });

    // 4. Sujet traduit
    const subjectKey = `email_${templateType}_title`;
    const subject = this.i18nService.translate(subjectKey, lang);

    // 5. Envoi
    await this.mailerService.sendMail({ to, subject, html: htmlContent });
  }

  private getTranslationsForType(type: string, lang: string, context: any) {
    const commonKeys = ['title', 'footer', 'sent_to', 'copyright'];
    const typeKeys: Record<string, string[]> = {
      welcome: [
        'greeting',
        'message',
        'credentials_label',
        'recommend',
        'support',
      ],
      otp: ['greeting', 'message', 'expiry', 'ignore', 'thanks', 'team'],
      reset: ['greeting', 'message', 'expiry', 'ignore', 'thanks', 'team'],
    };
    const keys = [...commonKeys, ...(typeKeys[type] || [])];
    const translations: any = {};
    for (const key of keys) {
      const i18nKey = `email_${type}_${key}`;
      const translation = this.i18nService.translate(i18nKey, lang);
      if (translation && translation !== i18nKey) {
        translations[key] = translation;
      }
    }
    // Pour welcome : construire les labels avec les valeurs du contexte
    if (type === 'welcome') {
      translations.phone_label = `${this.i18nService.translate('phone', lang)}: ${context.phone || ''}`;
      translations.account_label = `${this.i18nService.translate('account', lang)}: ${context.account_number || ''}`;
      translations.password_label = `${this.i18nService.translate('password', lang)}: ${context.defaultPassword || ''}`;
    }
    return translations;
  }

  /**
   * Génère un PDF de relevé de compte et l'envoie par email
   */
  async sendStatementEmail(
    to: string,
    user: {
      fullName: string;
      accountNumber?: string;
      phone?: string;
      email?: string;
      address?: string;
    },
    transactions: Array<{
      description: string;
      detail: string;
      reference: string;
      date: string;
      credit: number | null;
      debit: number | null;
      balance: number;
    }>,
    period: { startDate: Date; endDate: Date },
    currency: string,
    totals: { credits: number; debits: number; balance: number },
    lang: string = 'fr',
  ) {
    // 1. Préparer le contexte pour le template EJS
    const context = {
      logoUrl: process.env.LOGO_URL || './icon.png',
      periodStart: period.startDate.toLocaleDateString('fr-FR'),
      periodEnd: period.endDate.toLocaleDateString('fr-FR'),
      client: {
        fullName: user.fullName || 'N/A',
        accountNumber: user.accountNumber || 'N/A',
        phone: user.phone || 'N/A',
        email: user.email || 'N/A',
        address: user.address || 'Non spécifiée',
      },
      currency,
      totals: {
        credits: totals.credits.toFixed(2),
        debits: totals.debits.toFixed(2),
        balance: totals.balance.toFixed(2),
      },
      transactions,
      generatedDate: new Date().toLocaleString('fr-FR'),
    };

    // 2. Générer le PDF
    const templatePath = path.join(
      process.cwd(),
      process.env.NODE_ENV === 'production'
        ? 'dist/src/templates/wallet'
        : 'src/templates/wallet',
      'statement.ejs',
    );

    const htmlContent = await ejs.renderFile(templatePath, context, {
      async: true,
    });

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    // ✅ CORRECTION : Conversion explicite de Uint8Array vers Buffer
    const pdfUint8Array = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '30px', left: '20px', right: '20px' },
    });
    await browser.close();

    const pdfBuffer = Buffer.from(pdfUint8Array);

    // 3. Sujet et corps HTML de l'email (traduit)
    const subject = this.i18nService.translate('email_statement_subject', lang);
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 30px;">
        <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px; padding: 20px;">
          <h2 style="color: #233fc0;">${this.i18nService.translate('email_statement_title', lang)}</h2>
          <p>${this.i18nService.translate('email_statement_greeting', lang, { name: user.fullName })}</p>
          <p>${this.i18nService.translate('email_statement_body', lang, { start: period.startDate.toLocaleDateString('fr-FR'), end: period.endDate.toLocaleDateString('fr-FR') })}</p>
          <p>${this.i18nService.translate('email_statement_attachment', lang)}</p>
          <br/>
          <p>${this.i18nService.translate('email_statement_footer', lang)}</p>
        </div>
      </div>
    `;

    // 4. Envoyer l'email avec le PDF en pièce jointe
    await this.mailerService.sendMail({
      to,
      subject,
      html: emailHtml,
      attachments: [
        {
          filename: `releve_${period.startDate.toISOString().slice(0, 10)}_${period.endDate.toISOString().slice(0, 10)}.pdf`,
          content: pdfBuffer, // ✅ Maintenant c'est un Buffer valide
          contentType: 'application/pdf',
        },
      ],
    });
  }
}
