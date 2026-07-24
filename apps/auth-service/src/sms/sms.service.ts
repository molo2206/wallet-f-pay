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
    CD: '243', // RDC
    BJ: '229', // Bénin
  };

  /**
   * Normalise un numéro de téléphone en fonction du pays
   */
  private normalizePhoneNumber(phoneNumber: string, countryCode: string = 'CD'): string | null {
    // Nettoyer le numéro (garder uniquement les chiffres)
    let cleanPhone = phoneNumber.replace(/[^0-9]/g, '');

    // Obtenir l'indicatif du pays
    const prefix = this.countryCodes[countryCode] || '243';

    // Si le numéro commence déjà par l'indicatif, on le garde tel quel
    if (cleanPhone.startsWith(prefix)) {
      // Vérifier la longueur selon le pays
      const expectedLength = prefix === '243' ? 12 : 12;

      if (cleanPhone.length !== expectedLength) {
        console.error(`❌ Numéro invalide: ${cleanPhone} (doit faire ${expectedLength} chiffres pour ${countryCode})`);
        return null;
      }
      return cleanPhone;
    }

    // Si le numéro commence par 0, remplacer par l'indicatif
    if (cleanPhone.startsWith('0')) {
      cleanPhone = `${prefix}${cleanPhone.substring(1)}`;
    } else {
      // Ajouter l'indicatif
      cleanPhone = `${prefix}${cleanPhone}`;
    }

    // Vérification de la longueur finale
    const expectedLength = prefix === '243' ? 12 : 12;

    if (cleanPhone.length !== expectedLength) {
      console.error(`❌ Numéro invalide: ${cleanPhone} (doit faire ${expectedLength} chiffres pour ${countryCode})`);
      return null;
    }

    return cleanPhone;
  }

  /**
   * Envoie un SMS
   * @param phoneNumber - Numéro de téléphone
   * @param message - Message à envoyer
   * @param countryCode - Code pays (CD ou BJ), optionnel
   */
  async sendSms(
    phoneNumber: string,
    message: string,
    countryCode?: string
  ): Promise<boolean> {
    try {
      // Si countryCode n'est pas fourni, on le détecte automatiquement
      const detectedCountry = countryCode || this.detectCountry(phoneNumber);

      // Normaliser le numéro
      const cleanPhone = this.normalizePhoneNumber(phoneNumber, detectedCountry);

      if (!cleanPhone) {
        return false;
      }

      // Préparer la payload pour l'API LAFRICA MOBILE
      const payload = {
        accountid: this.accountId,
        password: this.password,
        sender: this.sender,
        ret_id: `SMS_${Date.now()}`,
        ret_url: 'https://mon-site.com/reception',
        priority: '2',
        text: message,
        to: [
          {
            ret_id_1: cleanPhone,
            ret_id_2: cleanPhone
          }
        ]
      };

      console.log(`📤 Envoi SMS à:`, cleanPhone);
      console.log('📝 Message:', message);

      const response = await axios.post(this.apiUrl, payload, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      console.log('📥 Réponse API brute:', response.data);

      // Vérifier la réponse
      let isSuccess = false;
      let messageId = 'N/A';

      if (typeof response.data === 'string') {
        // Si la réponse est une chaîne, c'est probablement un ID de message (succès)
        if (response.data.length > 0 && !response.data.includes('error')) {
          isSuccess = true;
          messageId = response.data;
          console.log(`✅ SMS envoyé avec succès! ID: ${messageId}`);
        } else {
          console.error('❌ Échec envoi SMS - Réponse string inattendue:', response.data);
          isSuccess = false;
        }
      } else if (typeof response.data === 'object' && response.data !== null) {
        // Si c'est un objet JSON
        if (response.data.status === 'success' || response.data.success === true) {
          isSuccess = true;
          messageId = response.data.message_id || response.data.id || 'N/A';
          console.log(`✅ SMS envoyé avec succès! ID: ${messageId}`);
        } else if (response.data.status === 'error' || response.data.error) {
          console.error('❌ Échec envoi SMS:', response.data);
          isSuccess = false;
        } else if (response.data.message_id) {
          isSuccess = true;
          messageId = response.data.message_id;
          console.log(`✅ SMS envoyé avec succès! ID: ${messageId}`);
        } else {
          console.error('❌ Échec envoi SMS - Format de réponse inconnu:', response.data);
          isSuccess = false;
        }
      } else {
        console.error('❌ Échec envoi SMS - Type de réponse inattendu:', typeof response.data);
        isSuccess = false;
      }

      return isSuccess;
    } catch (error) {
      console.error("❌ Erreur lors de l'envoi SMS:", error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', JSON.stringify(error.response.data));
      }
      return false;
    }
  }

  /**
   * Envoie un OTP
   */
  async sendOtpSms(
    phoneNumber: string,
    otpCode: string,
    countryCode?: string
  ): Promise<boolean> {
    const message = `Votre code F-Pay est : ${otpCode}`;
    return this.sendSms(phoneNumber, message, countryCode);
  }

  /**
   * Envoie un SMS de bienvenue
   */
  async sendWelcomeSms(
    phoneNumber: string,
    fullName: string,
    accountNumber: string,
    countryCode?: string
  ): Promise<boolean> {
    const message = `Bienvenue sur F-Pay, ${fullName} ! Votre compte ${accountNumber} a été créé avec succès.`;
    return this.sendSms(phoneNumber, message, countryCode);
  }

  /**
   * Envoie des SMS en masse
   */
  async sendBulkSms(
    recipients: {
      phone: string;
      message: string;
      countryCode?: string
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
   * Méthode utilitaire pour détecter automatiquement le pays
   * basé sur l'indicatif du numéro
   */
  detectCountry(phoneNumber: string): string {
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');

    if (cleanPhone.startsWith('243')) return 'CD';
    if (cleanPhone.startsWith('229')) return 'BJ';

    // Par défaut, considérer comme RDC
    return 'CD';
  }

  /**
   * Envoie un SMS avec détection automatique du pays
   */
  async sendSmsAuto(phoneNumber: string, message: string): Promise<boolean> {
    const countryCode = this.detectCountry(phoneNumber);
    return this.sendSms(phoneNumber, message, countryCode);
  }

  /**
   * Envoie un OTP avec détection automatique du pays
   */
  async sendOtpSmsAuto(phoneNumber: string, otpCode: string): Promise<boolean> {
    const countryCode = this.detectCountry(phoneNumber);
    return this.sendOtpSms(phoneNumber, otpCode, countryCode);
  }
}