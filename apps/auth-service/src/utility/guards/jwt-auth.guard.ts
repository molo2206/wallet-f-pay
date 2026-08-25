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
        return true;
      }
      throw new UnauthorizedException('Token manquant');
    }

    const token = authHeader.split(' ')[1];

    try {
      const secretKey =
        this.configService.get<string>('JWT_SECRET') || 'secret';

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

      // ✅ Récupérer l'utilisateur complet avec branchId et branch depuis la base de données
      let userWithBranch: any = null;
      if (!isLogoutRoute) {
        try {
          userWithBranch = await firstValueFrom(
            this.authClient
              .send('get_user_by_id', { userId: payload.id })
              .pipe(timeout(5000)),
          );
          
          console.log('[JwtAuthGuard] User data from DB:', {
            id: userWithBranch?.id,
            branchId: userWithBranch?.branchId,
            branch: userWithBranch?.branch,
            hasBranch: !!userWithBranch?.branch,
          });
        } catch (err) {
          console.error('Erreur lors de la récupération des infos utilisateur:', err);
        }
      }

      // ✅ Si userWithBranch n'est pas trouvé, utiliser les données du payload
      const userData = userWithBranch || payload;

      // ✅ Construire l'utilisateur complet
      const currentUser = {
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
        // ✅ Récupérer branchId depuis les données utilisateur
        branchId: userData.branchId || null,
        branch: userData.branch || null,
        countryCode: userData.countryCode || payload.countryCode || null,
        kycStatus: userData.kycStatus || payload.kycStatus || 'NOT_SUBMITTED',
        profileImage: userData.profileImage || payload.profileImage || null,
        pin: payload.pin || null,
        passwordStatus: payload.passwordStatus || null,
        pinstatus: payload.pinstatus || false,
        merchantCode: payload.merchantCode || null,
        businessName: payload.businessName || null,
        locked_by_admin: payload.locked_by_admin || false,
      };

      console.log('[JwtAuthGuard] CurrentUser final:', {
        id: currentUser.id,
        branchId: currentUser.branchId,
        hasBranch: !!currentUser.branch,
      });

      // ✅ Attacher l'utilisateur à la requête
      request.currentUser = currentUser;
      request.user = currentUser;

      return true;
    } catch (err) {
      if (isLogoutRoute) {
        request.currentUser = { id: null };
        request.user = request.currentUser;
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