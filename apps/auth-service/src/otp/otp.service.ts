import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SmsService } from '../sms/sms.service';

@Injectable()
export class OtpService {
  private prisma = new PrismaClient();

  constructor(private readonly smsService: SmsService) { }

  async sendOtp(phoneNumber: string): Promise<string> {
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Désactiver les anciens OTP
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this.prisma.otp.updateMany({
      where: {
        email: phoneNumber, // Stocker le numéro dans le champ email
        isUsed: false,
      },
      data: { isUsed: true },
    });

    // Sauvegarder le nouvel OTP
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this.prisma.otp.create({
      data: {
        id: crypto.randomUUID(),  // <-- AJOUTER CETTE LIGNE
        email: phoneNumber,
        otpCode,
        expiresAt,
        isUsed: false,
      },
    });

    // Envoyer par SMS
    const message = `Votre code de vérification Wallet System est : ${otpCode}. Valable 10 minutes.`;
    const sent = await this.smsService.sendSms(phoneNumber, message);

    if (!sent) {
      throw new BadRequestException(
        "Impossible d'envoyer le SMS de vérification.",
      );
    }

    return otpCode;
  }

  async verifyOtp(phoneNumber: string, otpCode: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const otpEntry = await this.prisma.otp.findFirst({
      where: {
        email: phoneNumber,
        otpCode,
        isUsed: false,
      },
    });

    if (!otpEntry) {
      throw new BadRequestException('Code OTP invalide');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (new Date() > otpEntry.expiresAt!) {
      throw new BadRequestException('Code OTP expiré');
    }

    return true;
  }

  async markOtpAsUsed(
    phoneNumber: string,
    otpCode: string,
    userId: string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this.prisma.otp.updateMany({
      where: {
        email: phoneNumber,
        otpCode,
        isUsed: false,
      },
      data: { isUsed: true, userId },
    });
  }
}
