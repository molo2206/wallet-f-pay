/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly pendingNotifications = new Map<string, Promise<any>>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!admin.apps.length) {
      const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      };
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('✅ Firebase Admin initialized');
    }
  }

  private ensureStringValues(obj: any): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] =
        typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return result;
  }

  async sendNotificationToUser(
    userId: string,
    title: string,
    body: string,
    type: string,
    data?: any,
  ) {
    const entityId = data?.entityId;
    let dedupKey = `${userId}:${type}`;
    if (entityId) dedupKey += `:${entityId}`;

    // Si une notification pour cette clé est déjà en cours, on attend sa fin
    if (this.pendingNotifications.has(dedupKey)) {
      console.log(
        `⏳ [DEDUP] Attente de la notification en cours pour ${dedupKey}`,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return this.pendingNotifications.get(dedupKey);
    }

    // Sinon, on crée une promesse pour cette notification
    const promise = this._sendNotification(
      userId,
      title,
      body,
      type,
      data,
    ).finally(() => {
      // Nettoyage après un court délai (pour éviter de bloquer une future notification identique)
      setTimeout(() => this.pendingNotifications.delete(dedupKey), 2000);
    });
    this.pendingNotifications.set(dedupKey, promise);
    return promise;
  }

  private async _sendNotification(
    userId: string,
    title: string,
    body: string,
    type: string,
    data?: any,
  ) {
    // Récupérer le token le plus récent (un seul)
    const device = await this.prisma.device_tokens.findFirst({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      select: { token: true },
    });
    const tokens = device ? [device.token] : [];
    console.log(`📱 [PUSH] User ${userId} – ${tokens.length} token(s)`);

    // Envoi Firebase
    if (tokens.length > 0) {
      const stringData = data ? this.ensureStringValues(data) : {};
      const messages = tokens.map((token) => ({
        token,
        notification: { title, body },
        data: stringData,
      }));
      try {
        const response = await admin.messaging().sendEach(messages);
        console.log('✅ [FCM] Réponse:', JSON.stringify(response, null, 2));
        response.responses.forEach((resp, idx) => {
          if (
            !resp.success &&
            resp.error?.code === 'messaging/registration-token-not-registered'
          ) {
            console.log(`🗑️ [FCM] Token invalide supprimé pour user ${userId}`);
            this.prisma.device_tokens
              .delete({ where: { token: tokens[idx] } })
              .catch((e) => console.error(e));
          }
        });
      } catch (error) {
        console.error('❌ [FCM] Erreur:', error);
      }
    } else {
      console.log(`⚠️ [PUSH] Aucun token pour l'utilisateur ${userId}`);
    }

    // Sauvegarde en base (une seule ligne)
    const notification = await this.prisma.user_notifications.create({
      data: {
        id: crypto.randomUUID(),
        user_id: userId,
        title,
        body,
        type,
        data: data ? JSON.stringify(data) : null,
        has_seen: false,
        created_at: new Date(),
      },
    });
    console.log(`💾 [DB] Notification enregistrée : ${notification.id}`);
    return notification;
  }

  async listUserNotifications(userId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [notifications, total] = await Promise.all([
      this.prisma.user_notifications.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user_notifications.count({ where: { user_id: userId } }),
    ]);
    return {
      message: 'Notifications retrieved',
      data: notifications,
      total,
      page,
      limit,
    };
  }

  async markNotificationAsSeen(notificationId: string, userId: string) {
    const notification = await this.prisma.user_notifications.findFirst({
      where: {
        id: notificationId,
        user_id: userId,
      },
    });

    if (!notification) {
      throw new Error('Notification non trouvée ou non autorisée');
    }

    const updated = await this.prisma.user_notifications.update({
      where: { id: notificationId },
      data: { has_seen: true },
    });

    return {
      message: 'Notification marquée comme lue',
      data: updated,
    };
  }

  async markAllNotificationsAsSeen(userId: string) {
    const result = await this.prisma.user_notifications.updateMany({
      where: {
        user_id: userId,
        has_seen: false,
      },
      data: { has_seen: true },
    });

    return {
      message: `${result.count} notification(s) marquée(s) comme lue(s)`,
      count: result.count,
    };
  }
}
