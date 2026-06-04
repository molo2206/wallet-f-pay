/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/wallet-service/src/bank/bank.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { EncryptionService } from './encryption.service';

@Injectable()
export class BankService {
  private readonly logger = new Logger(BankService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly authToken: string;
  private readonly encryptionService: EncryptionService;
  private readonly timeoutMs: number;

  constructor(encryptionService: EncryptionService) {
    this.baseUrl =
      process.env.BANK_BASE_URL ||
      'http://10.10.97.165/AccessFinace_Wallet_UAT/Service1.asmx';
    this.apiKey = process.env.BANK_API_KEY || '';
    this.authToken = process.env.BANK_AUTH_TOKEN || '';
    this.encryptionService = encryptionService;
    // ⏱️ Timeout par défaut : 120 secondes (modifiable via .env)
    this.timeoutMs = parseInt(process.env.BANK_TIMEOUT_MS || '120000', 10);

    this.logger.log(`BankService initialized, timeout: ${this.timeoutMs}ms`);
  }

  private generateRequestId(): string {
    return crypto.randomUUID();
  }

  /**
   * Traduit un message d'erreur selon la langue
   */
  private translate(key: string, lang: string): string {
    const messages: Record<string, Record<string, string>> = {
      bank_timeout: {
        fr: 'Le service bancaire ne répond pas. Veuillez réessayer dans quelques instants.',
        en: 'The bank service is not responding. Please try again in a few moments.',
        sw: 'Huduma ya benki haijibu. Tafadhali jaribu tena baada ya muda mfupi.',
      },
      bank_unavailable: {
        fr: 'Le service bancaire est temporairement indisponible. Veuillez réessayer plus tard.',
        en: 'The bank service is temporarily unavailable. Please try again later.',
        sw: 'Huduma ya benki haipatikani kwa muda. Tafadhali jaribu tena baadaye.',
      },
      bank_invalid_response: {
        fr: 'La réponse de la banque est illisible. Veuillez réessayer.',
        en: 'The bank response is unreadable. Please try again.',
        sw: 'Jibu la benki halisomeki. Tafadhali jaribu tena.',
      },
    };
    return messages[key]?.[lang] || messages[key]?.fr || key;
  }

  private async callBankApi(
    endpoint: string,
    payload?: any,
    lang: string = 'fr',
  ): Promise<any> {
    let url: string;
    let body: string | undefined;
    let method: string = 'GET';

    if (payload) {
      method = 'POST';
      url = `${this.baseUrl}/${endpoint}`;
      body = this.encryptionService.encryptRequest(payload);
      this.logger.log(`Encrypted request body: ${body}`);
    } else {
      url = `${this.baseUrl}/${endpoint}`;
    }

    this.logger.log(`Calling Bank API: ${method} ${url}`);

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': 'text/plain',
    };

    if (this.authToken) {
      headers['Authorization'] = this.authToken.startsWith('Bearer ')
        ? this.authToken
        : `Bearer ${this.authToken}`;
    }

    const maxRetries = 3;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const rawResponse = await response.text();

        this.logger.log(`Bank API status: ${response.status}`);
        this.logger.log(
          `Bank API raw response: ${rawResponse.substring(0, 100)}...`,
        );

        let finalResponse: any;

        try {
          finalResponse = JSON.parse(rawResponse);
          this.logger.log('Response is plain JSON');
        } catch (jsonError) {
          try {
            finalResponse = this.encryptionService.decryptResponse(rawResponse);
            this.logger.log('Response decrypted successfully');
          } catch (decryptError) {
            this.logger.error('Failed to decode bank response');
            throw new RpcException({
              status: 'error',
              message: this.translate('bank_invalid_response', lang),
              statusCode: 500,
            });
          }
        }

        this.logger.log(
          `Final bank response: ${JSON.stringify(finalResponse)}`,
        );
        return finalResponse;
      } catch (error) {
        lastError = error;
        this.logger.error(
          `Bank API call failed (attempt ${attempt}/${maxRetries}):`,
          error.message,
        );
        if (attempt < maxRetries) {
          const delay = 1000 * attempt;
          this.logger.log(`Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError?.name === 'AbortError') {
      throw new RpcException({
        status: 'error',
        message: this.translate('bank_timeout', lang),
        statusCode: 504,
      });
    }

    throw new RpcException({
      status: 'error',
      message: this.translate('bank_unavailable', lang),
      statusCode: 502,
    });
  }

  async linkAccount(
    accountNumber: string,
    requestId?: string,
    lang: string = 'fr',
  ): Promise<any> {
    const cleanAccountNumber = accountNumber.trim();
    this.logger.log(
      `Linking account: "${accountNumber}" -> "${cleanAccountNumber}"`,
    );
    const reqId = requestId || this.generateRequestId();
    const endpoint = `WalletLinking?accountNumber=${cleanAccountNumber}&requestId=${reqId}`;
    return this.callBankApi(endpoint, undefined, lang);
  }

  async topup(
    accountNumber: string,
    amount: number,
    requestId?: string,
    lang: string = 'fr',
  ): Promise<any> {
    const cleanAccountNumber = accountNumber.trim();
    this.logger.log(
      `Topup account ${cleanAccountNumber} with amount ${amount}`,
    );
    const payload = {
      requestId: requestId || this.generateRequestId(),
      accountNumber: cleanAccountNumber,
      amount: amount,
    };
    return this.callBankApi('WalletTopup', payload, lang);
  }

  async cashout(
    accountNumber: string,
    amount: number,
    requestId?: string,
    lang: string = 'fr',
  ): Promise<any> {
    const cleanAccountNumber = accountNumber.trim();
    this.logger.log(
      `Cashout account ${cleanAccountNumber} with amount ${amount}`,
    );
    const payload = {
      requestId: requestId || this.generateRequestId(),
      accountNumber: cleanAccountNumber,
      amount: amount,
    };
    return this.callBankApi('WalletCashout', payload, lang);
  }
}
