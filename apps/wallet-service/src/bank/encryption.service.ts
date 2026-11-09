// apps/wallet-service/src/bank/encryption.service.ts
import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;
  private readonly iv: Buffer;

  constructor() {
    // La clé doit faire 32 bytes pour AES-256
    const keyString =
      process.env.BANK_ENCRYPTION_KEY || '12345678901234567890123456789012';
    const ivString = process.env.BANK_IV || '1234567890123456';

    this.key = Buffer.from(keyString, 'utf8');
    this.iv = Buffer.from(ivString, 'utf8');

    // Vérifier que la clé fait 32 bytes
    if (this.key.length !== 32) {
      console.warn(
        `Key length is ${this.key.length} bytes, AES-256 requires 32 bytes`,
      );
    }
  }

  encrypt(plainText: string): string {
    const cipher = crypto.createCipheriv('aes-256-cbc', this.key, this.iv);
    let encrypted = cipher.update(plainText, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

  decrypt(encryptedText: string): string {
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.key, this.iv);
    let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  decryptResponse(encryptedResponse: string): any {
    try {
      const decrypted = this.decrypt(encryptedResponse);
      return JSON.parse(decrypted);
    } catch (error) {
      console.error('Decryption failed:', error);
      throw new Error(`Failed to decrypt bank response: ${error.message}`);
    }
  }

  encryptRequest(payload: any): string {
    const jsonString = JSON.stringify(payload);
    return this.encrypt(jsonString);
  }
}
