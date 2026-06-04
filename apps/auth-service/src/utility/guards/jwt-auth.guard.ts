/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { verify, TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { I18nService } from '@app/common';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private authClient: ClientProxy;

  constructor(
    private readonly configService: ConfigService,
    private readonly i18nService: I18nService,
  ) {
    const rmqUrl =
      process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
    const authQueue = process.env.AUTH_QUEUE || 'auth_queue';
    this.authClient = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: authQueue,
        queueOptions: { durable: false },
        persistent: true,
        noAck: true,
      },
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    const lang = request.headers['lang'] || 'fr';
    const url = request.url;
    const isLogoutRoute = url === '/auth/logout';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (isLogoutRoute) {
        // Pour logout, on accepte l'absence de token (déjà déconnecté)
        return true;
      }
      throw new UnauthorizedException('Token manquant');
    }

    const token = authHeader.split(' ')[1];

    try {
      const secretKey =
        this.configService.get<string>('JWT_SECRET') || 'secret';

      // Pour logout, on ignore l'expiration du token
      const options: any = {};
      if (isLogoutRoute) {
        options.ignoreExpiration = true;
      }

      const payload = verify(token, secretKey, options) as any;

      if (!payload.id || !payload.role) {
        throw new UnauthorizedException('Payload JWT invalide');
      }

      // Récupérer le statut uniquement si ce n'est pas logout
      let currentStatus: string = 'ACTIVE';
      if (!isLogoutRoute) {
        try {
          currentStatus = await firstValueFrom(
            this.authClient
              .send('get_UserStatus', { userId: payload.id })
              .pipe(timeout(5000)),
          );
        } catch (err) {
          console.error('Erreur lors de la récupération du statut:', err);
          throw new UnauthorizedException(
            'Impossible de vérifier le statut du compte',
          );
        }
      }

      // Vérifier le statut (sauf logout)
      if (!isLogoutRoute && currentStatus !== 'ACTIVE') {
        let messageKey: string;
        let statusCode: number;
        switch (currentStatus) {
          case 'SUSPENDED':
            messageKey = 'account_suspended';
            statusCode = HttpStatus.FORBIDDEN;
            break;
          case 'INACTIVE':
            messageKey = 'account_inactive';
            statusCode = HttpStatus.FORBIDDEN;
            break;
          case 'BLOCKED':
            messageKey = 'account_blocked';
            statusCode = HttpStatus.PAYMENT_REQUIRED;
            break;
          default:
            messageKey = 'account_not_active';
            statusCode = HttpStatus.FORBIDDEN;
        }
        const message = this.i18nService.translate(messageKey, lang);
        throw new HttpException(message, statusCode);
      }

      // Valider la session (sauf logout)
      if (!isLogoutRoute) {
        if (!payload.sessionToken) {
          throw new UnauthorizedException('Token sans session');
        }
        try {
          const response = await firstValueFrom(
            this.authClient
              .send('validate_session', {
                userId: payload.id,
                sessionToken: payload.sessionToken,
              })
              .pipe(timeout(5000)),
          );
          if (!response?.valid) {
            throw new UnauthorizedException('Session expirée ou révoquée');
          }
        } catch (err) {
          console.error('Erreur lors de la validation de la session:', err);
          throw new UnauthorizedException('Session invalide');
        }
      }

      // Attacher l'utilisateur à la requête
      request.currentUser = {
        id: payload.id,
        email: payload.email ?? null,
        phone: payload.phone ?? null,
        full_name: payload.full_name ?? null,
        role: payload.role,
        status: currentStatus,
        account_number: payload.account_number ?? null,
        deleted: payload.deleted ?? false,
        createdAt: payload.createdAt ? new Date(payload.createdAt) : new Date(),
        updatedAt: payload.updatedAt ? new Date(payload.updatedAt) : new Date(),
        sessionToken: payload.sessionToken,
      };

      return true;
    } catch (err) {
      // En cas d'erreur sur logout, on laisse passer (on considère que la déconnexion est possible)
      if (isLogoutRoute) {
        // On peut tout de même attacher un utilisateur minimal si besoin
        request.currentUser = { id: null };
        return true;
      }
      if (err instanceof TokenExpiredError) {
        throw new ForbiddenException('Token expiré');
      }
      if (err instanceof JsonWebTokenError) {
        throw new UnauthorizedException('Token invalide');
      }
      throw err;
    }
  }
}
