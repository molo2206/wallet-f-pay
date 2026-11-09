// apps/api-gateway/src/work-schedules/rpc-client.util.ts
import { HttpException, HttpStatus } from '@nestjs/common';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';

export function createRmqClient(queueEnv: string, defaultQueue: string): ClientProxy {
  return ClientProxyFactory.create({
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'],
      queue: process.env[queueEnv] || defaultQueue,
      queueOptions: { durable: false },
      persistent: true,
      noAck: true,
    },
  });
}

/** Envoie un message RMQ et convertit les erreurs du microservice en HttpException (message + code conservés) */
export async function rpcSend<T = any>(client: ClientProxy, pattern: string, data: any, timeoutMs = 30000): Promise<T> {
  try {
    return await firstValueFrom(client.send<T>(pattern, data).pipe(timeout(timeoutMs)));
  } catch (error: any) {
    if (error?.name === 'TimeoutError') {
      throw new HttpException({ statusCode: 504, message: 'Le service ne répond pas, réessayez dans un instant.' }, HttpStatus.GATEWAY_TIMEOUT);
    }
    const src = typeof error?.response === 'object' && error.response ? error.response : error || {};
    const status = Number(src.statusCode || src.status) || HttpStatus.INTERNAL_SERVER_ERROR;
    const httpStatus = status >= 400 && status < 600 ? status : HttpStatus.INTERNAL_SERVER_ERROR;
    const body: any = { status: 'error', statusCode: httpStatus, message: src.message || 'Erreur interne' };
    if (src.code) body.code = src.code;
    if (src.nextStartAt !== undefined) body.nextStartAt = src.nextStartAt;
    throw new HttpException(body, httpStatus);
  }
}

/**
 * Autorisation d'administration : SUPER_ADMIN toujours ; ADMIN seulement s'il possède la ressource `resource`
 * (table user_has_resources, droit lecture ou écriture selon `write`, non expiré).
 */
export async function assertAdminResource(
  prisma: PrismaService,
  user: any,
  resource: string,
  write: boolean,
): Promise<void> {
  if (user?.role === 'SUPER_ADMIN') return;
  if (user?.role === 'ADMIN') {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
      'SELECT uhr.`canCreate`, uhr.`canRead`, uhr.`canUpdate`, uhr.`canDelete` FROM `user_has_resources` uhr ' +
        'INNER JOIN `resources` r ON r.`id` = uhr.`resourceId` ' +
        'WHERE uhr.`userId` = ? AND r.`name` = ? AND (uhr.`expiresAt` IS NULL OR uhr.`expiresAt` > UTC_TIMESTAMP()) LIMIT 1',
      user.id,
      resource,
    );
    const r = rows?.[0];
    const ok = r && (write ? Number(r.canCreate) || Number(r.canUpdate) || Number(r.canDelete) : Number(r.canRead) || Number(r.canUpdate));
    if (ok) return;
  }
  throw new HttpException({ statusCode: 403, message: 'Accès interdit' }, HttpStatus.FORBIDDEN);
}
