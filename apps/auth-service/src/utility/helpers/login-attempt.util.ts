// libs/common/src/utils/login-attempt.util.ts
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

/**
 * Enregistre une tentative de connexion échouée dans la table login_attempt
 * @param prisma - Instance du client Prisma
 * @param userId - ID de l'utilisateur (peut être null si inexistant)
 * @param identifier - Identifiant utilisé (email ou téléphone)
 * @param ipAddress - Adresse IP de la requête
 * @param userAgent - User agent du client
 * @param failedPinAttempts - Nombre de tentatives PIN échouées (optionnel)
 * @param pinLockedUntil - Date de déblocage du PIN (optionnel)
 */
export async function logFailedLoginAttempt(
  prisma: PrismaClient,
  userId: string | null,
  identifier: string,
  ipAddress?: string,
  userAgent?: string,
  failedPinAttempts?: number,
  pinLockedUntil?: Date | null,
): Promise<void> {
  try {
    await prisma.login_attempt.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        identifier,
        success: false,
        ipAddress,
        userAgent,
        failed_pin_attempts: failedPinAttempts ?? null,
        pin_locked_until: pinLockedUntil ?? null,
      },
    });
  } catch (err) {
    console.error('Failed to log login attempt:', err);
  }
}
