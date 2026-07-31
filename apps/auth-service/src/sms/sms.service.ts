// apps/auth-service/src/sms/sms.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import axios from 'axios';

@Injectable()
export class SmsService implements OnModuleInit {
  private readonly accountId = 'FAVOR_GROUP_01';
  private readonly password = '8CRbywkWE1F2Z4I';
  private readonly sender = 'F-pay';
  private readonly apiUrl = 'https://lamsms.lafricamobile.com/api';

  // Cache des pays
  private countryCache: Map<string, {
    prefix: string;
    code: string;
    countryCode: string;
    minLength: number;
    maxLength: number;
  }> = new Map();

  private defaultCountry: any = null;

  constructor(private readonly prisma: PrismaClient) { }

  async onModuleInit() {
    await this.loadCountries();
  }

  /**
   * Charge les pays depuis la base de données
   */
  private async loadCountries() {
    try {
      const countries = await this.prisma.country_provider.findMany({
        where: { status: 'ACTIVE' },
        select: {
          prefix: true,
          code: true,
          countryCode: true,
        },
        orderBy: { prefix: 'asc' },
      });

      this.countryCache.clear();

      // Définir les longueurs par pays
      const countryLengths: Record<string, { min: number; max: number }> = {
        '243': { min: 12, max: 12 }, // RDC
        '229': { min: 13, max: 13 }, // Bénin
        '237': { min: 12, max: 12 }, // Cameroun
        '242': { min: 12, max: 12 }, // Congo
        '225': { min: 12, max: 13 }, // Côte d'Ivoire
        '241': { min: 12, max: 12 }, // Gabon
        '254': { min: 12, max: 12 }, // Kenya
        '256': { min: 12, max: 12 }, // Ouganda
        '250': { min: 12, max: 12 }, // Rwanda
        '221': { min: 12, max: 12 }, // Sénégal
        '232': { min: 12, max: 12 }, // Sierra Leone
        '260': { min: 12, max: 12 }, // Zambie
      };

      for (const country of countries) {
        if (country.prefix) {
          const lengths = countryLengths[country.prefix] || { min: 10, max: 13 };
          this.countryCache.set(country.prefix, {
            prefix: country.prefix,
            code: country.code,
            countryCode: country.countryCode || '',
            minLength: lengths.min,
            maxLength: lengths.max,
          });
        }
      }

      this.defaultCountry = this.countryCache.get('243') || {
        prefix: '243',
        code: 'CD',
        countryCode: 'CD',
        minLength: 12,
        maxLength: 12,
      };

      console.log(`[SmsService] ${this.countryCache.size} pays chargés`);
    } catch (error) {
      console.error('[SmsService] Erreur chargement pays:', error);
      // Pays par défaut en cas d'erreur
      this.defaultCountry = {
        prefix: '243',
        code: 'CD',
        countryCode: 'CD',
        minLength: 12,
        maxLength: 12,
      };
    }
  }

  /**
   * Normalise un numéro comme Facebook - NE BLOQUE JAMAIS
   */
  private normalizePhone(phoneNumber: string, countryCode?: string): string {
    if (!phoneNumber) return phoneNumber;

    try {
      let clean = phoneNumber.replace(/[^0-9+]/g, '');

      const hasPlus = clean.startsWith('+');
      if (hasPlus) {
        clean = clean.substring(1);
      }

      let country = this.detectCountry(clean);

      if (countryCode) {
        const found = this.getCountryByCode(countryCode);
        if (found) country = found;
      }

      if (!country && this.defaultCountry) {
        country = this.defaultCountry;
      }

      if (!country) return clean;

      return this.applyCountryFormat(clean, country);
    } catch (error) {
      console.error('[SmsService] Erreur normalisation:', error);
      return phoneNumber.replace(/[^0-9]/g, '');
    }
  }

  /**
   * Détecte le pays à partir d'un numéro
   */
  private detectCountry(phoneNumber: string): any | null {
    try {
      const sortedPrefixes = Array.from(this.countryCache.keys()).sort((a, b) => b.length - a.length);

      for (const prefix of sortedPrefixes) {
        if (phoneNumber.startsWith(prefix)) {
          return this.countryCache.get(prefix)!;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Récupère un pays par son code
   */
  private getCountryByCode(code: string) {
    try {
      const upperCode = code.toUpperCase();
      for (const [, country] of this.countryCache) {
        if (country.code === upperCode || country.countryCode === upperCode) {
          return country;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Applique le format du pays au numéro
   */
  private applyCountryFormat(phoneNumber: string, country: any): string {
    try {
      const prefix = country.prefix;

      if (phoneNumber.startsWith(prefix)) {
        return phoneNumber;
      }

      if (phoneNumber.startsWith('0')) {
        return `${prefix}${phoneNumber.substring(1)}`;
      }

      if (phoneNumber.startsWith(`+${prefix}`)) {
        return phoneNumber.substring(1);
      }

      return `${prefix}${phoneNumber}`;
    } catch (error) {
      return phoneNumber;
    }
  }

  /**
   * Valide un numéro - RETOURNE UN RÉSULTAT, NE BLOQUE PAS
   */
  isValidPhone(phoneNumber: string, countryCode?: string): { valid: boolean; message?: string } {
    try {
      const normalized = this.normalizePhone(phoneNumber, countryCode);
      if (!normalized) {
        return { valid: true };
      }

      let country = this.detectCountry(normalized);
      if (countryCode) {
        const found = this.getCountryByCode(countryCode);
        if (found) country = found;
      }

      if (!country) {
        return { valid: true };
      }

      const length = normalized.length;
      const { minLength, maxLength } = country;

      if (length < minLength || length > maxLength) {
        return {
          valid: false,
          message: `Format invalide. Longueur attendue: ${minLength}-${maxLength} chiffres`
        };
      }

      return { valid: true };
    } catch (error) {
      return { valid: true };
    }
  }

  /**
   * Récupère le code pays d'un numéro
   */
  getCountryCodeFromPhone(phoneNumber: string): string | null {
    try {
      const clean = phoneNumber.replace(/[^0-9+]/g, '');
      let number = clean;
      if (number.startsWith('+')) {
        number = number.substring(1);
      }
      const country = this.detectCountry(number);
      return country ? country.countryCode : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Récupère l'indicatif d'un numéro
   */
  getPrefixFromPhone(phoneNumber: string): string | null {
    try {
      const clean = phoneNumber.replace(/[^0-9+]/g, '');
      let number = clean;
      if (number.startsWith('+')) {
        number = number.substring(1);
      }
      const country = this.detectCountry(number);
      return country ? country.prefix : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Rafraîchit le cache des pays
   */
  async refreshCountries() {
    await this.loadCountries();
  }

  // ============ MÉTHODES D'ENVOI SMS ============

  async sendSms(phoneNumber: string, message: string, countryCode?: string): Promise<boolean> {
    try {
      // Normaliser le numéro
      const cleanPhone = this.normalizePhone(phoneNumber, countryCode);

      if (!cleanPhone) {
        console.error(`Numero invalide apres normalisation: ${phoneNumber}`);
        return false;
      }

      console.log(`Numero normalise: ${cleanPhone}`);

      const payload = {
        accountid: this.accountId,
        password: this.password,
        sender: this.sender,
        datacoding: 0,
        text: message,
        ret_url: 'https://webhook.site/160cd4e1-65b6-4220-873c-c60a3e6dc8c2',
        to: [{ ret_id_1: cleanPhone }]
      };

      console.log('Payload:', JSON.stringify(payload, null, 2));

      const response = await axios.post(this.apiUrl, payload, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      });

      console.log('Reponse:', response.data);

      let isSuccess = false;
      if (typeof response.data === 'string') {
        isSuccess = response.data.length > 0 && !response.data.includes('error');
        if (isSuccess) console.log(`SMS envoye! ID: ${response.data}`);
        else console.error('Echec:', response.data);
      } else if (response.data?.status === 'success' || response.data?.success === true) {
        isSuccess = true;
        console.log(`SMS envoye! ID: ${response.data.message_id || 'N/A'}`);
      } else {
        console.error('Echec:', response.data);
      }

      return isSuccess;
    } catch (error) {
      console.error('Erreur SMS:', error.message);
      if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Data:', JSON.stringify(error.response.data));
      }
      return false;
    }
  }

  async sendOtpSms(phoneNumber: string, otpCode: string, countryCode?: string): Promise<boolean> {
    const message = `Votre code F-Pay est : ${otpCode}`;
    return this.sendSms(phoneNumber, message, countryCode);
  }

  async sendWelcomeSms(phoneNumber: string, fullName: string, accountNumber: string, countryCode?: string): Promise<boolean> {
    const message = `Bienvenue sur F-Pay, ${fullName} ! Votre compte ${accountNumber} a ete cree avec succes.`;
    return this.sendSms(phoneNumber, message, countryCode);
  }

  async sendBulkSms(
    recipients: {
      phone: string;
      message: string;
      countryCode?: string;
    }[]
  ): Promise<{
    success: boolean;
    results: { phone: string; status: boolean; error?: string }[];
  }> {
    const results: { phone: string; status: boolean; error?: string }[] = [];
    let allSuccess = true;

    for (const recipient of recipients) {
      try {
        const success = await this.sendSms(
          recipient.phone,
          recipient.message,
          recipient.countryCode
        );
        results.push({
          phone: recipient.phone,
          status: success,
        });
        if (!success) allSuccess = false;
      } catch (error) {
        results.push({
          phone: recipient.phone,
          status: false,
          error: error.message,
        });
        allSuccess = false;
      }
    }

    return {
      success: allSuccess,
      results,
    };
  }

  /**
   * Envoi SMS avec détection automatique du pays
   */
  async sendSmsAuto(phoneNumber: string, message: string): Promise<boolean> {
    const countryCode = this.getCountryCodeFromPhone(phoneNumber);
    return this.sendSms(phoneNumber, message, countryCode || undefined);
  }

  /**
   * Envoi OTP avec détection automatique du pays
   */
  async sendOtpSmsAuto(phoneNumber: string, otpCode: string): Promise<boolean> {
    const countryCode = this.getCountryCodeFromPhone(phoneNumber);
    return this.sendOtpSms(phoneNumber, otpCode, countryCode || undefined);
  }
}