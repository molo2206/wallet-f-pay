// apps/auth-service/src/sms/sms.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class SmsService {
  private readonly accountId = 'FAVOR_GROUP_01';
  private readonly password = '8CRbywkWE1F2Z4I';
  private readonly sender = 'F-pay';
  private readonly apiUrl = 'https://lamsms.lafricamobile.com/api';

  // Configuration des indicatifs par pays
  private readonly countryCodes = {
    CD: '243',
    BJ: '229',
  };

  private normalizePhoneNumber(phoneNumber: string, countryCode: string = 'CD'): string | null {
    let cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    const prefix = this.countryCodes[countryCode] || '243';

    // BENIN : format 229 + 01 + 9 chiffres = 13 chiffres
    if (countryCode === 'BJ') {
      if (cleanPhone.startsWith('229')) {
        if (cleanPhone.startsWith('22901')) {
          if (cleanPhone.length === 13) return cleanPhone;
          console.error(`Numero Benin invalide: ${cleanPhone} (13 chiffres requis)`);
          return null;
        }
        if (cleanPhone.startsWith('2290')) {
          cleanPhone = cleanPhone.substring(0, 4) + '1' + cleanPhone.substring(4);
          if (cleanPhone.length === 13) return cleanPhone;
          console.error(`Numero Benin invalide: ${cleanPhone} (13 chiffres requis)`);
          return null;
        }
        cleanPhone = cleanPhone.substring(0, 3) + '01' + cleanPhone.substring(3);
        if (cleanPhone.length === 13) return cleanPhone;
        console.error(`Numero Benin invalide: ${cleanPhone} (13 chiffres requis)`);
        return null;
      }

      if (cleanPhone.startsWith('0')) {
        cleanPhone = `22901${cleanPhone.substring(1)}`;
      } else {
        cleanPhone = `22901${cleanPhone}`;
      }

      if (cleanPhone.length === 13) return cleanPhone;
      console.error(`Numero Benin invalide: ${cleanPhone} (13 chiffres requis)`);
      return null;
    }

    // RDC : format 243 + 9 chiffres = 12 chiffres
    if (cleanPhone.startsWith(prefix)) {
      if (cleanPhone.length === 12) return cleanPhone;
      console.error(`Numero RDC invalide: ${cleanPhone} (12 chiffres requis)`);
      return null;
    }

    if (cleanPhone.startsWith('0')) {
      cleanPhone = `${prefix}${cleanPhone.substring(1)}`;
    } else {
      cleanPhone = `${prefix}${cleanPhone}`;
    }

    if (cleanPhone.length === 12) return cleanPhone;
    console.error(`Numero RDC invalide: ${cleanPhone} (12 chiffres requis)`);
    return null;
  }

  async sendSms(phoneNumber: string, message: string, countryCode?: string): Promise<boolean> {
    try {
      const detectedCountry = countryCode || this.detectCountry(phoneNumber);
      const cleanPhone = this.normalizePhoneNumber(phoneNumber, detectedCountry);

      if (!cleanPhone) {
        console.error(`Numero invalide: ${phoneNumber}`);
        return false;
      }

      console.log(`Numero normalise: ${cleanPhone} (${detectedCountry})`);

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

  detectCountry(phoneNumber: string): string {
    const clean = phoneNumber.replace(/[^0-9]/g, '');
    if (clean.startsWith('229')) return 'BJ';
    if (clean.startsWith('243')) return 'CD';
    return 'CD';
  }

  async sendOtpSms(phoneNumber: string, otpCode: string, countryCode?: string): Promise<boolean> {
    return this.sendSms(phoneNumber, `Votre code F-Pay est : ${otpCode}`, countryCode);
  }

  async sendWelcomeSms(phoneNumber: string, fullName: string, accountNumber: string, countryCode?: string): Promise<boolean> {
    return this.sendSms(phoneNumber, `Bienvenue sur F-Pay, ${fullName} ! Votre compte ${accountNumber} a ete cree avec succes.`, countryCode);
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

  async sendSmsAuto(phoneNumber: string, message: string): Promise<boolean> {
    return this.sendSms(phoneNumber, message, this.detectCountry(phoneNumber));
  }

  async sendOtpSmsAuto(phoneNumber: string, otpCode: string): Promise<boolean> {
    return this.sendOtpSms(phoneNumber, otpCode, this.detectCountry(phoneNumber));
  }
}