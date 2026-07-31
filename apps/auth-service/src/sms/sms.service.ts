// apps/auth-service/src/sms/sms.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class SmsService {
  private readonly accountId = 'FAVOR_GROUP_01';
  private readonly password = '8CRbywkWE1F2Z4I';
  private readonly sender = 'F-pay';
  private readonly apiUrl = 'https://lamsms.lafricamobile.com/api';

  async sendSms(phoneNumber: string, message: string): Promise<boolean> {
    try {
      const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');

      console.log(`Numero: ${cleanPhone}`);

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

  async sendOtpSms(phoneNumber: string, otpCode: string): Promise<boolean> {
    const message = `Votre code F-Pay est : ${otpCode}`;
    return this.sendSms(phoneNumber, message);
  }

  async sendWelcomeSms(phoneNumber: string, fullName: string, accountNumber: string): Promise<boolean> {
    const message = `Bienvenue sur F-Pay, ${fullName} ! Votre compte ${accountNumber} a ete cree avec succes.`;
    return this.sendSms(phoneNumber, message);
  }

  async sendBulkSms(
    recipients: {
      phone: string;
      message: string;
    }[]
  ): Promise<{
    success: boolean;
    results: { phone: string; status: boolean; error?: string }[];
  }> {
    const results: { phone: string; status: boolean; error?: string }[] = [];
    let allSuccess = true;

    for (const recipient of recipients) {
      try {
        const success = await this.sendSms(recipient.phone, recipient.message);
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
}