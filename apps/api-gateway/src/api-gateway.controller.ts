/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// apps/api-gateway/src/api-gateway.controller.ts
import {
  Controller,
  Post,
  Body,
  Get,
  Patch,
  Delete,
  Param,
  HttpException,
  HttpStatus,
  UseGuards,
  Headers,
  Logger,
  Query,
  BadRequestException,
  UseInterceptors,
  Request,
  Res,
} from '@nestjs/common';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { firstValueFrom, catchError, timeout } from 'rxjs';
import { LoginRequestDto, RegisterRequestDto } from './dto/api-getway.dto';
import { AuthResponseDto } from 'apps/auth-service/src/dto/auth-response.dto';
import { AuthentificationGuard } from 'apps/auth-service/src/utility/guards/authentification.guard';
import { CurrentUser } from 'apps/auth-service/src/utility/decorators/current-user-decorator';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import {
  CreateUserDto,
  UpdateUserDto,
  UserResponseDto,
} from '../../user-service/src/dto/create-user.dto';
import { Ip } from './decorators/ip.decorator';
import { IpInterceptor } from './inrceptor/ip.interceptor';
import { UpdateUserSettingsDto } from 'apps/user-service/src/dto/user-settings.dto';
import { response, type Response } from 'express';
import {
  AssignMultipleResourcesDto,
  AssignResourceDto,
} from 'apps/user-service/src/dto/assign-resource.dto';
import { UpdateResourceDto } from 'apps/user-service/src/resources/dto/update-resource.dto';
import { CreateResourceDto } from 'apps/user-service/src/resources/dto/create-resource.dto';
import { UpsertAppSettingsDto } from 'apps/user-service/src/dto/app-settings.dto';
import { Permissions } from 'apps/auth-service/src/utility/guards/permissions.guard';
import { UpdateNetworkDto } from 'apps/wallet-service/src/pawapay/dto/update-network.dto';
import { CreateCountryDto } from 'apps/wallet-service/src/pawapay/dto/create-country.dto';
import { UpdateCountryDto } from 'apps/wallet-service/src/pawapay/dto/update-country.dto';
import { CreateNetworkDto } from 'apps/wallet-service/src/pawapay/dto/create-network.dto';
import { I18nService } from '@app/common'; // ✅ ajout
import { ExchangeRateDto } from 'apps/wallet-service/src/dto/currency-convert.dto';
import { ApiKeyGuard } from './guards/api-key.guard';
import { PermissionsApi_Key } from './permissions/decorator';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { AdminApprovalService } from './controls/admin-approval.service';
import { FileFieldsInterceptor, FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { UploadedFile, UploadedFiles } from '@nestjs/common';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import { validateClientToken } from './constants/client-tokens.constants';
const gatewayLoginLocks = new Map<string, boolean>();

interface RpcError {
  status?: string;
  message?: string;
  statusCode?: number;
}

interface WalletPayResponse {
  status?: string;
  message: string;
  data: {
    wallet: {
      id: string;
      userId: string;
      balance: number;
      currency: string;
      isActive: boolean;
      createdAt: Date;
      updatedAt: Date;
    };
    transaction: {
      id: string;
      userId: string;
      walletId: string;
      amount: number;
      type: string;
      status: string;
      reference: string;
      description: string;
      movement: string;
      currency: string;
      paymentMethod: string;
      createdAt: Date;
      updatedAt: Date;
    };
  };
}

interface FpayAuthResponse {
  accessToken: string;
  refreshToken: string;
  message: string;
  sessionId?: string;
  oauthRedirectUrl?: string;
  requiresOtp?: boolean;
  data: {
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    role: string;
    status: string;
    profileImage: string | null;
    kycStatus: string;
    countryCode: string | null;
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresIn: number;
    [key: string]: any;
  };
}

interface FpaySendOtpResponse {
  success: boolean;
  message: string;
  requiresOtp: boolean;
  phone?: string;
}

interface AccountData {
  id: string;
  full_name: string;
  account_number: string;
  phone: string;
  branch: string | null;
  email: string | null;
  status: string;
  kyc_status: string;
  balance: number;
  currency: string;
  address: string | null;
  city: string | null;
  country: string | null;
  account_type: string;
  account_tier: string;
  opening_date: Date;
  createdAt: Date;
  updatedAt: Date;
  countryCode: string | null;
}

interface LinkUserResponse {
  accessToken: string;
  refreshToken: string;
  message: string;
  sessionId?: string;
  oauthRedirectUrl?: string;
  requiresOtp?: boolean;
  data: {
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    role: string;
    status: string;
    profileImage: string | null;
    kycStatus: string;
    countryCode: string | null;
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresIn: number;
    [key: string]: any;
  };
}

interface AccountResponse {
  success: boolean;
  data: AccountData;
}
const walletCache = new Map<string, { walletId: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Controller()
@UseInterceptors(IpInterceptor)
export class ApiGatewayController {
  private readonly logger = new Logger(ApiGatewayController.name);
  private authClient: ClientProxy;
  private userClient: ClientProxy;
  private walletClient: ClientProxy;
  private auditClient: ClientProxy;
  private notificationClient: ClientProxy;
  private settingsClient: ClientProxy;
  private fpayCache: Map<string, any> = new Map();


  constructor(
    private readonly i18nService: I18nService,
    private readonly prisma: PrismaService,
    private readonly approvals: AdminApprovalService, // ✅ double validation des recharges admin
  ) { // ✅ injection
    const rmqUrl =
      process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
    const authQueue = process.env.AUTH_QUEUE || 'auth_queue';
    const userQueue = process.env.USER_QUEUE || 'user_queue';
    const walletQueue = process.env.WALLET_QUEUE || 'wallet_queue';
    const auditQueue = process.env.AUDIT_QUEUE || 'audit_queue';
    const notificationQueue =
      process.env.NOTIFICATION_QUEUE || 'notification_queue';

    this.logger.log(`Connecting to RabbitMQ at ${rmqUrl}`);
    this.logger.log(
      `Auth queue: ${authQueue}, User queue: ${userQueue}, Wallet queue: ${walletQueue}, Audit queue: ${auditQueue}, Notification queue: ${notificationQueue}`,
    );

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

    this.userClient = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: userQueue,
        queueOptions: { durable: false },
        persistent: true,
        noAck: true,
      },
    });

    this.walletClient = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: walletQueue,
        queueOptions: { durable: false },
        persistent: true,
        noAck: true,
      },
    });

    this.auditClient = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: auditQueue,
        queueOptions: { durable: false },
        persistent: true,
        noAck: true,
      },
    });

    this.notificationClient = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: notificationQueue,
        queueOptions: { durable: false },
        persistent: true,
        noAck: true,
      },
    });

    this.settingsClient = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'],
        queue: 'settings_queue',
        queueOptions: { durable: false },
        persistent: true,
        noAck: true,
      },
    });
  }

  //=====================SETTINGS=============================
  private async sendSettingsMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000,
  ): Promise<T> {
    this.logger.debug(`Settings RPC → ${pattern}`, data);

    try {
      const result = await firstValueFrom(
        this.settingsClient.send(pattern, data).pipe(
          timeout(timeoutMs),
          catchError((error) => {
            this.handleRpcError(error, defaultMessage, defaultStatus);
          }),
        ),
      );

      return result as T;
    } catch (error) {
      this.logger.error(`Settings error ${pattern}`, error);
      throw error;
    }
  }
  // ==================== MÉTHODES D'ENVOI ====================
  private async sendFpayMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000,
  ): Promise<T> {
    this.logger.debug(`Fpay RPC → ${pattern}`, data);

    try {
      // ✅ Créer un client pour le service FPay
      const fpayClient = ClientProxyFactory.create({
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'],
          queue: process.env.FPAY_QUEUE || 'fpay_queue',
          queueOptions: { durable: false },
          persistent: true,
          noAck: true,
        },
      });

      const result = await firstValueFrom(
        fpayClient.send(pattern, data).pipe(
          timeout(timeoutMs),
          catchError((error) => {
            this.handleRpcError(error, defaultMessage, defaultStatus);
          }),
        ),
      );

      return result as T;
    } catch (error) {
      this.logger.error(`Fpay error ${pattern}`, error);
      throw error;
    }
  }
  private async sendAuthMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000,
  ): Promise<T> {
    this.logger.debug(`Sending auth message to ${pattern}:`, data);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = await firstValueFrom(
        this.authClient.send(pattern, data).pipe(
          timeout(timeoutMs),
          catchError((error: any) => {
            this.logger.error(`Error in ${pattern}:`, error);

            // ✅ Extraire correctement le message d'erreur du microservice
            let errorMessage = defaultMessage;
            let errorStatus = defaultStatus;

            // Vérifier si l'erreur contient la réponse du microservice
            if (error && error.response) {
              // Si error.response est un objet avec message et status
              if (typeof error.response === 'object') {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                errorMessage =
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                  error.response.message ||
                  error.response.error ||
                  defaultMessage;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                errorStatus =
                  error.response.statusCode ||
                  error.response.status ||
                  defaultStatus;
              }
              // Si error.response est une string (comme 'Nenosiri si sahihi')
              else if (typeof error.response === 'string') {
                errorMessage = error.response;
                errorStatus = error.status || defaultStatus;
              }
            }
            // Si l'erreur a directement les propriétés
            else if (error.message) {
              errorMessage = error.message;
              errorStatus = error.statusCode || error.status || defaultStatus;
            }

            this.logger.error(
              `Transformed error: ${errorMessage} (${errorStatus})`,
            );

            throw new HttpException(
              {
                status: 'error',
                message: errorMessage,
                statusCode: errorStatus,
              },
              errorStatus,
            );
          }),
        ),
      );
      this.logger.debug(`Auth message ${pattern} processed successfully`);
      return result as T;
    } catch (error) {
      this.logger.error(`Failed to send auth message ${pattern}:`, error);
      throw error;
    }
  }



  private async sendUserMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000,
  ): Promise<T> {
    // Recréer le client si nécessaire
    if (!this.userClient) {
      this.logger.warn('User client not initialized, creating new client...');
      this.userClient = ClientProxyFactory.create({
        transport: Transport.RMQ,
        options: {
          urls: [
            process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
          ],
          queue: process.env.USER_QUEUE || 'user_queue',
          queueOptions: { durable: false },
          persistent: true,
          noAck: true,
        },
      });
    }

    // Tenter de se connecter avec timeout (Promise.race)
    try {
      await Promise.race([
        this.userClient.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), 5000),
        ),
      ]);
    } catch (err) {
      this.logger.error('Failed to connect to RabbitMQ for user client', err);
      throw new HttpException(
        'Microservice connection error',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.debug(`Sending user message to ${pattern}:`, data);
    const result = await firstValueFrom(
      this.userClient.send(pattern, data).pipe(
        timeout(timeoutMs),
        catchError((error) => {
          this.handleRpcError(error, defaultMessage, defaultStatus);
        }),
      ),
    );
    return result as T;
  }

  /** Copie des données pour les logs, sans secrets (pin, password, otp, token, clés API) */
  private maskSecrets(value: any, depth = 0): any {
    if (value === null || value === undefined || depth > 8) return value;
    if (Array.isArray(value)) return value.map((v) => this.maskSecrets(v, depth + 1));
    if (typeof value !== 'object') return value;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /pin|password|otp|token|apikey|api_key|secret|authorization/i.test(k) ? '***' : this.maskSecrets(v, depth + 1);
    }
    return out;
  }

  private async sendWalletMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000,
  ): Promise<T> {
    this.logger.log(`[sendWalletMessage] 📤 Envoi: ${pattern}`);
    // ✅ PIN, mots de passe, OTP et clés API ne sont jamais écrits dans les logs
    this.logger.log(`[sendWalletMessage] 📤 Données:`, JSON.stringify(this.maskSecrets(data), null, 2));

    try {
      // ✅ Vérifier la connexion
      if (!this.walletClient) {
        this.logger.warn('[sendWalletMessage] Client non initialisé, reconnexion...');
        this.walletClient = ClientProxyFactory.create({
          transport: Transport.RMQ,
          options: {
            urls: [process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'],
            queue: process.env.WALLET_QUEUE || 'wallet_queue',
            queueOptions: { durable: false },
            persistent: true,
            noAck: true,
          },
        });
        await this.walletClient.connect();
      }

      const result = await firstValueFrom(
        this.walletClient.send(pattern, data).pipe(
          timeout(timeoutMs),
          catchError((error) => {
            this.logger.error(`[sendWalletMessage] ❌ Erreur RPC ${pattern}:`, error);

            let errorMessage = defaultMessage;
            let errorStatus = defaultStatus;

            if (error && error.message) {
              errorMessage = error.message;
            }
            if (error && error.statusCode) {
              errorStatus = error.statusCode;
            }
            // ✅ Pas de réponse du service wallet dans le délai : 504 (issue inconnue), pas un refus 400
            if (error?.name === 'TimeoutError') {
              errorStatus = HttpStatus.GATEWAY_TIMEOUT;
              errorMessage = `${defaultMessage} (timeout ${Math.round(timeoutMs / 1000)}s)`;
            }

            throw new HttpException(
              {
                status: 'error',
                message: errorMessage,
                statusCode: errorStatus,
              },
              errorStatus,
            );
          }),
        ),
      );

      this.logger.log(`[sendWalletMessage] ✅ Réponse reçue pour ${pattern}`);
      this.logger.log(`[sendWalletMessage] 📥 Réponse:`, JSON.stringify(this.maskSecrets(result), null, 2));

      return result as T;
    } catch (error) {
      this.logger.error(`[sendWalletMessage] ❌ Erreur ${pattern}:`, error);
      throw error;
    }
  }
  private async sendAuditMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000,
  ): Promise<T> {
    this.logger.debug(`Audit RPC → ${pattern}`, data);

    try {
      const result = await firstValueFrom(
        this.auditClient.send(pattern, data).pipe(
          timeout(timeoutMs),
          catchError((error) => {
            this.handleRpcError(error, defaultMessage, defaultStatus);
          }),
        ),
      );

      return result as T;
    } catch (error) {
      this.logger.error(`Audit error ${pattern}`, error);
      throw error;
    }
  }

  private async sendNotificationMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000,
  ): Promise<T> {
    this.logger.debug(`Notification RPC → ${pattern}`, data);

    try {
      const result = await firstValueFrom(
        this.notificationClient.send(pattern, data).pipe(
          timeout(timeoutMs),
          catchError((error) => {
            this.handleRpcError(error, defaultMessage, defaultStatus);
          }),
        ),
      );

      return result as T;
    } catch (error) {
      this.logger.error(`Notification error ${pattern}`, error);
      throw error;
    }
  }

  // ==================== AUTH ENDPOINTS ====================
  @Get('wallet/balance-transactions')
  async getWalletBalanceAndTransactions(
    @Query('userId') userId: string,
    @Query('walletId') walletId?: string,  // ✅ Optionnel
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('movement') movement?: string,
    @Query('search') search?: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    if (!userId) {
      throw new HttpException(
        'userId est requis',
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ walletId n'est pas obligatoire

    return this.sendWalletMessage(
      'get_wallet_balance_transactions',
      {
        userId,
        walletId,  // ✅ Peut être undefined
        lang,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 10,
        startDate,
        endDate,
        type,
        status,
        movement,
        search,
      },
      this.i18nService.translate('wallet.balance_transactions_error', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('auth/verify-token')
  async verifyToken(
    @Body() body: { accessToken: string },
    @Res() res: Response,
  ) {
    try {
      const { accessToken } = body;

      if (!accessToken) {
        return res.status(400).json({
          success: false,
          message: 'accessToken est requis'
        });
      }

      // Vérifier le token dans la base de données de FPay
      const tokenRecord = await this.prisma.oauthaccesstoken.findFirst({
        where: {
          token: accessToken,
          expiresAt: { gt: new Date() },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              full_name: true,
              role: true,
              status: true,
              kycStatus: true,
              countryCode: true,
            },
          },
        },
      });

      if (!tokenRecord) {
        return res.status(401).json({
          valid: false,
          message: 'Token invalide ou expiré'
        });
      }

      return res.status(200).json({
        valid: true,
        data: {
          id: tokenRecord.user.id,
          email: tokenRecord.user.email,
          phone: tokenRecord.user.phone,
          full_name: tokenRecord.user.full_name,
          role: tokenRecord.user.role,
          status: tokenRecord.user.status,
          kycStatus: tokenRecord.user.kycStatus || 'NOT_SUBMITTED',
          countryCode: tokenRecord.user.countryCode || 'CD',
        },
        message: 'Token valide'
      });

    } catch (error) {
      console.error('[verifyToken] ❌ Erreur:', error.message);
      return res.status(500).json({
        success: false,
        message: error.message || 'Erreur lors de la vérification'
      });
    }
  }

  @Post('auth/register')
  async register(
    @Body() body: RegisterRequestDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Headers('lang') langHeader?: string,
  ) {
    const deviceInfo = body.deviceInfo || userAgent || 'Appareil inconnu';
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';

    // ✅ Vérifier que le mot de passe est fourni
    if (!body.password || body.password.length < 8) {
      throw new HttpException(
        'Le mot de passe est requis et doit contenir au moins 8 caractères',
        HttpStatus.BAD_REQUEST,
      );
    }

    this.logger.log(`📝 Register request for ${body.phone} (lang: ${lang})`);
    return this.sendAuthMessage<AuthResponseDto>(
      'register_user',
      {
        account_number: body.account_number,
        full_name: body.full_name,
        phone: body.phone,
        branch: body.branch,
        fcmToken: body.fcmToken,
        platform: body.platform,
        deviceInfo,
        ipAddress,
        otpCode: body.otpCode,
        email: body.email,
        countryCode: body.countryCode,
        password: body.password, // ✅ Passer le mot de passe
        lang,
      },
      'Registration failed',
      HttpStatus.BAD_REQUEST,
      120000,
    );
  }

  @Post('admin/users/from-account')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createUserFromAccount(
    @CurrentUser() currentUser: any,
    @Body()
    body: {
      account_number: string;
      full_name: string;
      phone: string;
      branch?: string;
      email?: string;
      role?: 'USER' | 'MERCHANT';
    },
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const { account_number, full_name, phone, branch, email, role } = body;
    if (!account_number || !full_name || !phone) {
      throw new HttpException(
        'account_number, full_name et phone sont requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    this.logger.log(
      `👤 Admin ${currentUser.id} creating user from account ${account_number} (lang: ${lang})`,
    );
    return this.sendUserMessage(
      'create_user_from_account',
      {
        account_number,
        full_name,
        phone,
        branch,
        email,
        role,
        lang,
      },
      'Échec de la création de l’utilisateur',
      HttpStatus.BAD_REQUEST,
      120000,
    );
  }

  @Post('auth/login')
  async login(
    @Body() body: LoginRequestDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Headers('lang') langHeader?: string,
  ) {
    const identifier = body.identifier || body.email || body.phone;
    if (!identifier) {
      throw new HttpException('Identifiant requis', HttpStatus.BAD_REQUEST);
    }

    try {
      const deviceInfo = body.deviceInfo || userAgent || 'Appareil inconnu';
      const lang = langHeader || 'fr';

      // ✅ Appel direct sans passer par sendAuthMessage pour mieux contrôler l'erreur
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = await firstValueFrom(
        this.authClient
          .send('login_user', {
            identifier,
            password: body.password,
            ipAddress,
            fcmToken: body.fcmToken,
            platform: body.platform,
            deviceInfo,
            lang,
          })
          .pipe(
            timeout(120000),
            catchError((error: any) => {
              this.logger.error(`Login error for ${identifier}:`, error);

              // Extraire le message d'erreur original
              let errorMessage = 'Login failed';
              let errorStatus = HttpStatus.UNAUTHORIZED;

              if (error && error.response) {
                if (typeof error.response === 'string') {
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                  errorMessage = error.response;
                  errorStatus = error.status || 401;
                } else if (error.response.message) {
                  errorMessage = error.response.message;
                  errorStatus =
                    error.response.statusCode || error.response.status || 401;
                }
              } else if (error.message) {
                errorMessage = error.message;
                errorStatus = error.statusCode || error.status || 401;
              }

              throw new HttpException(
                {
                  status: 'error',
                  message: errorMessage,
                  statusCode: errorStatus,
                },
                errorStatus,
              );
            }),
          ),
      );

      return result;
    } finally {
      // setTimeout(() => gatewayLoginLocks.delete(lockKey), 120000);
    }
  }

  @Post('auth/verify-otp')
  async verifyOtp(
    @Body() body: { identifier: string; code: string },
    @Headers('lang') langHeader?: string,
  ): Promise<{ message: string }> {
    this.logger.log('Verify OTP request:', body.identifier);
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    return this.sendAuthMessage<{ message: string }>(
      'verify_otp',
      { identifier: body.identifier, code: body.code, lang },
      'Vérification OTP échouée',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('auth/send-reset-otp')
  async sendResetOtp(
    @Body() body: { identifier: string },
    @Headers('lang') langHeader?: string,
  ): Promise<{ message: string }> {
    if (!body?.identifier) {
      throw new BadRequestException('Identifier requis');
    }
    const lang = langHeader || 'fr';
    return this.sendAuthMessage<{ message: string }>(
      'send_reset_otp',
      { identifier: body.identifier, lang },
      'Échec envoi OTP',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('auth/reset-password')
  async resetPassword(
    @Body()
    body: {
      identifier: string;
      code: string;
      password?: string;
      newPassword?: string;
    },
    @Headers('lang') langHeader?: string,
  ): Promise<{ message: string }> {
    const password = body.password || body.newPassword;
    if (!password) {
      throw new HttpException(
        'Le nouveau mot de passe est requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    const lang = langHeader || 'fr';
    return this.sendAuthMessage<{ message: string }>(
      'reset_password',
      {
        identifier: body.identifier,
        code: body.code,
        password,
        lang,
      },
      'Échec réinitialisation mot de passe',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('auth/change-password')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async changePassword(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('authorization') authHeader: string,
    @Request() req: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.logger.log('=== API GATEWAY - CHANGE PASSWORD ===');
    const currentPassword = body.currentPswd || body.currentPassword;
    const newPassword = body.newPswd || body.newPassword;
    if (!currentUser?.id) {
      throw new HttpException(
        'Utilisateur non authentifié',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!currentPassword || currentPassword.trim() === '') {
      throw new HttpException(
        'Le mot de passe actuel est requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!newPassword || newPassword.trim() === '') {
      throw new HttpException(
        'Le nouveau mot de passe est requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (currentPassword === newPassword) {
      throw new HttpException(
        "Le nouveau mot de passe doit être différent de l'ancien",
        HttpStatus.BAD_REQUEST,
      );
    }
    const token = authHeader?.split(' ')[1];
    if (!token) {
      throw new HttpException('Token manquant', HttpStatus.UNAUTHORIZED);
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    const messageData = {
      userId: currentUser.id,
      currentPassword,
      newPassword,
      token,
      lang,
    };
    const result = await this.sendAuthMessage<{ message: string; data: any }>(
      'change_password',
      messageData,
      'Échec mise à jour mot de passe',
      HttpStatus.BAD_REQUEST,
    );
    return {
      data: result.data,
      message: result.message,
    };
  }

  // apps/api-gateway/src/api-gateway.controller.ts

  @Get('auth/account/:accountNumber')
  async getAccount(
    @Param('accountNumber') accountNumber: string,
    @Headers('lang') langHeader?: string,
  ): Promise<AccountResponse> {
    this.logger.log(`📞 Get account request: ${accountNumber}`);
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    try {
      const account = await firstValueFrom<AccountData>(
        this.authClient
          .send('get_account_by_number', { accountNumber, lang })
          .pipe(
            timeout(120000),
            catchError((error: RpcError) => {
              this.logger.error('Get account error caught:', error);
              throw new HttpException(
                error.message || 'Failed to get account',
                error.statusCode || HttpStatus.NOT_FOUND,
              );
            }),
          ),
      );
      return { success: true, data: account };
    } catch (error) {
      this.logger.error('Get account error:', error);
      throw error;
    }
  }

  @Get('auth/check-phone/:phone')
  async checkPhoneExists(
    @Param('phone') phone: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    return this.sendAuthMessage(
      'check_phone_exists',
      { phone, lang },
      'Erreur lors de la vérification',
      HttpStatus.BAD_REQUEST,
    );
  }

  // ==================== USER ENDPOINTS ====================
  @Post('users')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createUser(
    @CurrentUser() currentUser: any,
    @Body() createUserDto: CreateUserDto,
    @Headers('lang') langHeader?: string,
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log('📝 Create user request:', createUserDto.email);
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException(
        'Seul un administrateur peut créer des utilisateurs',
        HttpStatus.FORBIDDEN,
      );
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    const payload = { ...createUserDto, lang };
    return this.sendUserMessage<{ message: string; data: UserResponseDto }>(
      'create_user',
      payload,
      'Failed to create user',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('users/:id')
  async getUser(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log(`👤 Get user request: ${id}`);
    // ✅ PUBLIC_LOOKUP_PROTECTION=true : réservé au propriétaire ou à un administrateur
    const caller = this.optionalLookupCaller(authorization);
    if (caller && !caller.isAdmin && caller.id !== id) {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const response = await this.sendUserMessage<{
      message: string;
      data: UserResponseDto;
    }>('get_user', { id }, 'User not found', HttpStatus.NOT_FOUND);
    return response;
  }

  /**
   * ✅ Protection progressive des routes de consultation historiquement publiques (users/:id, wallet/transactions/:id).
   *  PUBLIC_LOOKUP_PROTECTION=false (défaut) : comportement inchangé (compatibilité des intégrations existantes).
   *  PUBLIC_LOOKUP_PROTECTION=true : jeton Bearer obligatoire ; un utilisateur ne voit que ses propres données.
   *  Retourne null quand la protection est désactivée.
   */
  private optionalLookupCaller(authorization?: string): { id: string; isAdmin: boolean } | null {
    if (String(process.env.PUBLIC_LOOKUP_PROTECTION ?? 'false').toLowerCase() !== 'true') return null;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) throw new HttpException('Token manquant', HttpStatus.UNAUTHORIZED);
    try {
      const payload: any = jwt.verify(token, process.env.JWT_SECRET || 'secret');
      if (!payload?.id) throw new Error('payload');
      return { id: String(payload.id), isAdmin: payload.role === 'ADMIN' || payload.role === 'SUPER_ADMIN' };
    } catch {
      throw new HttpException('Token invalide', HttpStatus.UNAUTHORIZED);
    }
  }

  @Get('admin/users/links')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listUsersLinks(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const response = await this.sendUserMessage<{
      users: UserResponseDto[];
      total: number;
      page: number;
      limit: number;
    }>(
      'list_users_links',
      { page: pageNum, limit: limitNum, role, status },
      'Échec de la récupération des utilisateurs',
      HttpStatus.BAD_REQUEST,
    );
    return {
      message: 'Utilisateurs avec compte bancaire récupérés avec succès',
      data: {
        data: response.users,
        total: response.total,
        page: response.page,
        limit: response.limit,
      },
    };
  }

  @Get('users/email/:email')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserByEmail(
    @CurrentUser() currentUser: any,
    @Param('email') email: string,
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log(`👤 Get user by email: ${email}`);
    if (
      currentUser?.role !== 'ADMIN' &&
      currentUser?.role !== 'SUPER_ADMIN' &&
      currentUser?.email !== email
    ) {
      throw new HttpException(
        'Accès non autorisé à cet utilisateur',
        HttpStatus.FORBIDDEN,
      );
    }
    const response = await this.sendUserMessage<{
      message: string;
      data: UserResponseDto;
    }>('get_user_by_email', { email }, 'User not found', HttpStatus.NOT_FOUND);
    return response;
  }

  @Get('users/phone/:phone')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserByPhone(
    @CurrentUser() currentUser: any,
    @Param('phone') phone: string,
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log(`👤 Get user by phone: ${phone}`);
    if (
      currentUser?.role !== 'ADMIN' &&
      currentUser?.role !== 'SUPER_ADMIN' &&
      currentUser?.phone !== phone
    ) {
      throw new HttpException(
        'Accès non autorisé à cet utilisateur',
        HttpStatus.FORBIDDEN,
      );
    }
    const response = await this.sendUserMessage<{
      message: string;
      data: UserResponseDto;
    }>('get_user_by_phone', { phone }, 'User not found', HttpStatus.NOT_FOUND);
    return response;
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateUser(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @Headers('lang') langHeader?: string,
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log(`✏️ Update user request: ${id}`);
    if (
      currentUser?.role !== 'ADMIN' &&
      currentUser?.role !== 'SUPER_ADMIN' &&
      currentUser?.id !== id
    ) {
      throw new HttpException(
        'Accès non autorisé à modifier cet utilisateur',
        HttpStatus.FORBIDDEN,
      );
    }
    if (
      updateUserDto.role &&
      currentUser?.role !== 'ADMIN' &&
      currentUser?.role !== 'SUPER_ADMIN'
    ) {
      delete updateUserDto.role;
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    const response = await this.sendUserMessage<{
      message: string;
      data: UserResponseDto;
    }>(
      'update_user',
      { id, ...updateUserDto, lang },
      'Failed to update user',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Patch('users/:id/status')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateUserStatus(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() body: { status: string },
    @Headers('lang') langHeader?: string,
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log(`🔄 Update user status: ${id} -> ${body.status}`);
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException(
        'Seul un administrateur peut modifier le statut',
        HttpStatus.FORBIDDEN,
      );
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    const response = await this.sendUserMessage<{
      message: string;
      data: UserResponseDto;
    }>(
      'update_user_status',
      { id, status: body.status, requesterId: currentUser?.id, lang },
      'Failed to update user status',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteUser(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Headers('lang') langHeader?: string,
  ): Promise<{ message: string }> {
    this.logger.log(`🗑️ Delete user request: ${id}`);
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException(
        'Seul un administrateur peut supprimer des utilisateurs',
        HttpStatus.FORBIDDEN,
      );
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    const response = await this.sendUserMessage<any>(
      'delete_user',
      { id, lang },
      'Failed to delete user',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Get('users/me/profile')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyProfile(
    @CurrentUser() currentUser: any,
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log(`👤 Get my profile: ${currentUser?.id}`);
    const response = await this.sendUserMessage<{
      message: string;
      data: UserResponseDto;
    }>(
      'get_user',
      { id: currentUser.id },
      'User not found',
      HttpStatus.NOT_FOUND,
    );
    return response;
  }

  @Patch('users/me/profile')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMyProfile(
    @CurrentUser() currentUser: any,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log(`✏️ Update my profile: ${currentUser?.id}`);
    delete updateUserDto.role;
    delete updateUserDto.status;
    delete updateUserDto.account_number;
    const response = await this.sendUserMessage<{
      message: string;
      data: UserResponseDto;
    }>(
      'update_user',
      { id: currentUser.id, ...updateUserDto },
      'Failed to update profile',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listUsers(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
  ): Promise<{
    message: string;
    data: {
      data: UserResponseDto[];
      total: number;
      page: number;
      limit: number;
    };
  }> {
    this.logger.log('📋 List users request');
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException(
        'Accès non autorisé. Seul un administrateur peut lister les utilisateurs.',
        HttpStatus.FORBIDDEN,
      );
    }
    const params = {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 10,
      role,
      status,
    };
    const response = await this.sendUserMessage<{
      users: UserResponseDto[];
      total: number;
      page: number;
      limit: number;
    }>('list_users', params, 'Failed to list users', HttpStatus.BAD_REQUEST);
    return {
      message: 'Users retrieved successfully',
      data: {
        data: response.users,
        total: response.total,
        page: response.page,
        limit: response.limit,
      },
    };
  }

  // ==================== WALLET ENDPOINTS ====================

  @Post('wallet')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createWallet(
    @CurrentUser() currentUser: any,
    @Body() body: { currency?: string },
  ) {
    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'create_wallet',
      { userId: currentUser.id, currency: body.currency || 'CDF' },
      'Failed to create wallet',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Get('wallet/me')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyWallet(@CurrentUser() currentUser: any) {
    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'get_wallet',
      { userId: currentUser.id },
      'Failed to get wallet',
      HttpStatus.NOT_FOUND,
    );
    return response;
  }

  @Get('wallet/by/userid')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getWalletByUser(@Query('userId') userId: string) {
    if (!userId) {
      throw new HttpException('userId is required', HttpStatus.BAD_REQUEST);
    }
    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'get_wallet_by_user',
      { userId },
      'Failed to get wallet',
      HttpStatus.NOT_FOUND,
    );
    return response;
  }

  @Post('wallet/credit')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async creditWallet(
    @CurrentUser() currentUser: any,
    @Body() body: { amount: number; description?: string },
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'credit_wallet',
      {
        userId: currentUser.id,
        amount: body.amount,
        description: body.description,
      },
      'Failed to credit wallet',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Post('wallet/debit')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async debitWallet(
    @CurrentUser() currentUser: any,
    @Body() body: { amount: number; description?: string },
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'debit_wallet',
      {
        userId: currentUser.id,
        amount: body.amount,
        description: body.description,
      },
      'Failed to debit wallet',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Post('wallet/transfer')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async transfer(
    @CurrentUser() currentUser: any,
    @Body() body: { toUserId: string; amount: number; description?: string },
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    if (!body.toUserId || !body.amount || body.amount <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.invalid_recipient_amount', lang), HttpStatus.BAD_REQUEST);
    }
    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'transfer',
      {
        fromUserId: currentUser.id,
        toUserId: body.toUserId,
        amount: body.amount,
        description: body.description,
      },
      'Failed to transfer',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Get('wallet/transactions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransactions(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('countryCode') countryCode?: string, // ✅ AJOUT
    @Query('branchId') branchId?: string, // ✅ AJOUT
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    let start: Date | undefined;
    let end: Date | undefined;
    if (startDate) start = new Date(startDate);
    if (endDate) end = new Date(endDate);

    // ✅ Construction du payload avec tous les filtres
    const payload: any = {
      userId: currentUser.id,
      page: pageNum,
      limit: limitNum,
      startDate: start,
      endDate: end,
    };

    // ✅ Ajouter les filtres si présents
    if (countryCode) payload.countryCode = countryCode;
    if (branchId) payload.branchId = branchId;

    // ✅ Si l'utilisateur est ADMIN ou SUPER_ADMIN, ajouter adminId
    if (currentUser?.role === 'ADMIN' || currentUser?.role === 'SUPER_ADMIN') {
      payload.adminId = currentUser.id;
    }

    console.log('[Gateway] getTransactions - Payload:', payload);

    const response = await this.sendWalletMessage<any>(
      'list_transactions',
      payload,
      'Failed to get transactions',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Get('wallet/transactions/by')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransactionsByUser(
    @CurrentUser() currentUser: any,
    @Query('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (!userId) {
      throw new HttpException('userId is required', HttpStatus.BAD_REQUEST);
    }
    // ✅ SÉCURITÉ : un utilisateur ne voit que SES transactions (les admins voient tout)
    if (userId !== currentUser?.id && currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    let start: Date | undefined;
    let end: Date | undefined;
    if (startDate) start = new Date(startDate);
    if (endDate) end = new Date(endDate);
    const response = await this.sendWalletMessage<any>(
      'list_transactions',
      { userId, page: pageNum, limit: limitNum, startDate: start, endDate: end },
      'Failed to get transactions',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Get('admin/transactions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAllTransactions(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,      // ✅ AJOUT
    @Query('countryCode') countryCode?: string, // ✅ AJOUT
  ) {
    // ✅ Vérification des droits
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    // ✅ Construction du payload avec tous les filtres
    const payload: any = {
      page: pageNum,
      limit: limitNum,
      adminId: currentUser.id, // ✅ AJOUT : L'ID de l'admin connecté
    };

    // ✅ Ajouter les filtres optionnels
    if (userId) payload.userId = userId;
    if (type) payload.type = type;
    if (status) payload.status = status;
    if (startDate) payload.startDate = startDate;
    if (endDate) payload.endDate = endDate;
    if (search) payload.search = search;
    if (branchId) payload.branchId = branchId;      // ✅ AJOUT
    if (countryCode) payload.countryCode = countryCode; // ✅ AJOUT

    console.log('[API Gateway] getAllTransactions - Payload:', payload);

    const response = await this.sendWalletMessage<any>(
      'list_all_transactions',
      payload,
      'Échec de la récupération des transactions',
      HttpStatus.BAD_REQUEST,
    );

    return response;
  }

  @Get('admin/transactions/all')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAllTransactionsUnpaginated(
    @CurrentUser() currentUser: any,
    @Query('userId') userId?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    let start: Date | undefined;
    let end: Date | undefined;
    if (startDate) start = new Date(startDate);
    if (endDate) end = new Date(endDate);
    return this.sendWalletMessage(
      'list_all_transactions_unpaginated',
      { userId, type, status, startDate: start, endDate: end, search },
      'Failed to retrieve transactions',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/all_transactions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAllTrans(
    @CurrentUser() currentUser: any,
    @Query('userId') userId?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const response = await this.sendWalletMessage<any>(
      'list_all_trans',
      { userId, type, status, startDate, endDate, search },
      'Échec de la récupération des transactions',
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Post('wallet/topup')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async topUp(
    @CurrentUser() currentUser: any,
    @Body() body: { amount: number; pin: string; walletId?: string; currency?: string; provider?: string; phone?: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.pin || body.pin.length < 4) {
      throw new HttpException(this.i18nService.translate('wallet.pin_min_length', lang), HttpStatus.BAD_REQUEST);
    }
    if (body.provider && !body.phone) {
      throw new HttpException(this.i18nService.translate('wallet.missing_phone_for_payment', lang), HttpStatus.BAD_REQUEST);
    }

    const payload: any = {
      userId: currentUser.id,
      amount: body.amount,
      pin: body.pin,
      lang,
      ipAddress,
    };
    if (body.walletId) payload.walletId = body.walletId;
    if (body.currency) payload.currency = body.currency;
    if (body.provider) payload.provider = body.provider;
    if (body.phone) payload.phone = body.phone;

    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'top_up',
      payload,
      this.i18nService.translate('wallet.top_up_failed', lang),
      HttpStatus.BAD_REQUEST,
      120000,
    );
    return response;
  }

  @Post('wallet/cashout')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async cashout(
    @CurrentUser() currentUser: any,
    @Body() body: {
      accountNumber?: string;
      amount: number;
      pin: string;
      walletId?: string;
      provider?: string;
      phone?: string
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    // Validation : soit accountNumber (bancaire), soit provider+phone (MOMO)
    if (!body.accountNumber && !body.provider) {
      throw new HttpException(this.i18nService.translate('wallet.account_or_provider_required', lang), HttpStatus.BAD_REQUEST);
    }
    if (body.provider && !body.phone) {
      throw new HttpException(this.i18nService.translate('wallet.missing_phone_for_payment', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.pin || body.pin.length < 4) {
      throw new HttpException(this.i18nService.translate('wallet.pin_min_length', lang), HttpStatus.BAD_REQUEST);
    }
    if (!/^\d+$/.test(body.pin)) {
      throw new HttpException(this.i18nService.translate('wallet.pin_digits_only', lang), HttpStatus.BAD_REQUEST);
    }

    const payload: any = {
      userId: currentUser.id,
      amount: body.amount,
      pin: body.pin,
      lang,
      ipAddress,
    };
    if (body.accountNumber) payload.accountNumber = body.accountNumber;
    if (body.walletId) payload.walletId = body.walletId;
    if (body.provider) payload.provider = body.provider;
    if (body.phone) payload.phone = body.phone;

    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'cashout',
      payload,
      this.i18nService.translate('wallet.cashout_failed', lang),
      HttpStatus.BAD_REQUEST,
      120000,
    );
    return response;
  }

  @Post('wallet/send')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async send(
    @CurrentUser() currentUser: any,
    @Body() body: {
      fromWalletId: string;
      toPhone: string;
      amount: number;
      pin: string;
      description?: string;
      countryCode?: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    if (!body.fromWalletId) {
      throw new HttpException('Le wallet source est requis', HttpStatus.BAD_REQUEST);
    }

    if (!body.toPhone) {
      throw new HttpException(this.i18nService.translate('wallet.missing_phone_or_code', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.pin || body.pin.length < 4 || !/^\d+$/.test(body.pin)) {
      throw new HttpException(this.i18nService.translate('wallet.pin_invalid', lang), HttpStatus.BAD_REQUEST);
    }

    const response = await this.sendWalletMessage(
      'send',
      {
        fromWalletId: body.fromWalletId,
        toPhone: body.toPhone,
        amount: body.amount,
        pin: body.pin,
        description: body.description,
        countryCode: body.countryCode,
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.transfer_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Post('wallet/pay')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async pay(
    @CurrentUser() currentUser: any,
    @Body() body: { fromWalletId: string; toPhone?: string; merchantCode?: string; amount: number; pin: string; description?: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    // ✅ Vérifier que fromWalletId est fourni
    if (!body.fromWalletId) {
      throw new HttpException('Le wallet source est requis', HttpStatus.BAD_REQUEST);
    }

    if (!body.toPhone && !body.merchantCode) {
      throw new HttpException(this.i18nService.translate('wallet.missing_phone_or_code', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.pin || body.pin.length < 4 || !/^\d+$/.test(body.pin)) {
      throw new HttpException(this.i18nService.translate('wallet.pin_invalid', lang), HttpStatus.BAD_REQUEST);
    }

    const response = await this.sendWalletMessage(
      'pay',
      {
        fromWalletId: body.fromWalletId,  // ✅ Utiliser fromWalletId
        toPhone: body.toPhone,
        merchantCode: body.merchantCode,
        amount: body.amount,
        pin: body.pin,
        description: body.description,
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.payment_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  /**
   * ✅ Propriétaire d'une clé API (JWT signé, ou clé enregistrée en base) ; null si la clé est invalide,
   * expirée ou désactivée.
   */
  private async apiKeyOwner(rawKey?: string | null): Promise<string | null> {
    const key = String(rawKey || '').replace(/^Bearer\s+/i, '').trim();
    if (!key) return null;
    const stored = await this.prisma.api_key.findFirst({
      where: { key, isActive: true },
      select: { userId: true, expiresAt: true },
    });
    if (stored && (!stored.expiresAt || stored.expiresAt > new Date())) return stored.userId ?? null;
    try {
      const secret = process.env.JWT_API_KEY_SECRET || 'your-secret-key-at-least-32-chars';
      const payload: any = jwt.verify(key, secret);
      const requireDb = String(process.env.API_KEY_JWT_REQUIRE_DB ?? 'true').toLowerCase() !== 'false';
      if (requireDb) return null; // clé signée mais inconnue en base (révoquée ou fabriquée)
      return payload?.sub || payload?.userId || null;
    } catch {
      return null;
    }
  }

  /** Permissions enregistrées en base pour une clé API (JSON) — lecture stricte */
  private async apiKeyPermissions(rawKey?: string | null): Promise<string[]> {
    const key = String(rawKey || '').replace(/^Bearer\s+/i, '').trim();
    if (!key) return [];
    const stored = await this.prisma.api_key.findFirst({
      where: { key, isActive: true },
      select: { permissions: true, expiresAt: true },
    });
    if (!stored || (stored.expiresAt && stored.expiresAt <= new Date())) return [];
    try {
      const list = typeof stored.permissions === 'string' ? JSON.parse(stored.permissions) : stored.permissions;
      return Array.isArray(list) ? list.map(String) : [];
    } catch {
      return [];
    }
  }

  // =====================================================================================
  // ✅ RETRAIT (cashout) DEPUIS UNE APPLICATION PARTENAIRE (Favor Help) — PROTÉGÉ PAR OTP F-PAY
  //   wallet F-Pay de l'UTILISATEUR ──payout PawaPay──▶ son numéro Mobile Money
  //
  //   1. POST api/external/cashout/request  { access_token, amount, provider, phone, walletId?, userId?, requestId? }
  //        → contrôles (compte, wallet, solde, frais) + OTP envoyé par SMS au numéro du compte F-Pay. Rien n'est débité.
  //   2. POST api/external/cashout/confirm  { access_token, requestId, otpCode }
  //        → OTP vérifié (5 essais, 10 min, usage unique) → retrait classique, SANS PIN.
  //   +  POST api/external/cashout/resend   { access_token, requestId }  nouvel OTP (1 par minute)
  //   +  GET  api/external/cashout/status/:requestId   issue du retrait (réponse perdue, coupure réseau)
  //   +  GET  api/external/cashout/providers?currency=  réseaux Mobile Money + frais
  //
  //   Sécurité : clé API du partenaire avec la permission « cashout » enregistrée en base (contrôle strict)
  //              + compte lié (userId) ou token F-Pay de l'utilisateur + OTP envoyé au téléphone du compte F-Pay.
  //   Portefeuille débité : UNIQUEMENT celui du client (titulaire du token F-Pay). Un walletId d'un autre
  //   compte est refusé ; le partenaire ne peut jamais débiter son propre wallet ni celui d'un tiers.
  //   Montant, réseau et numéro sont figés à la demande : l'OTP ne valide que CE retrait.
  // =====================================================================================

  /** Vérifie le token F-Pay de l'utilisateur (même règle que api/external/pay) et renvoie son id F-Pay */
  private externalUserFromToken(accessToken?: string | null): string {
    if (!accessToken) {
      throw new HttpException('access_token F-Pay de l\'utilisateur obligatoire', HttpStatus.BAD_REQUEST);
    }
    try {
      const jwtSecret = process.env.JWT_SECRET || 'fpay-super-secret-key-2024';
      const decoded: any = jwt.verify(String(accessToken).replace(/^Bearer\s+/i, ''), jwtSecret);
      if (!decoded?.id) throw new Error('Token invalide - id manquant');
      return String(decoded.id);
    } catch (e: any) {
      throw new HttpException(e?.message === 'jwt expired' ? 'Token FPay expiré' : 'Token FPay invalide', HttpStatus.UNAUTHORIZED);
    }
  }

  /**
   * Compte F-Pay du CLIENT qui retire.
   *  - Compte déjà lié chez le partenaire (Favor Help) : pas de token, userId = id F-Pay lié.
   *    Protégé par la clé API (permission « cashout ») + OTP envoyé au téléphone de CE compte.
   *  - Avec token : le userId éventuel doit être identique au titulaire du token.
   */
  private externalCashoutOwner(accessToken: string | undefined, expectedUserId?: string | null): string {
    if (!accessToken) {
      const linkedId = String(expectedUserId || '').trim();
      if (!linkedId) throw new HttpException('userId F-Pay (compte lié) obligatoire', HttpStatus.BAD_REQUEST);
      return linkedId;
    }
    const userId = this.externalUserFromToken(accessToken);
    if (expectedUserId && expectedUserId !== userId) {
      throw new HttpException('Ce token F-Pay appartient à un autre compte', HttpStatus.FORBIDDEN);
    }
    return userId;
  }

  /** Clé API du partenaire : utilisateur + permission « cashout » en base */
  private async externalCashoutPartner(req: any) {
    const partner = req.user;
    if (!partner) throw new HttpException('Utilisateur API Key non trouvé', HttpStatus.UNAUTHORIZED);
    const perms = await this.apiKeyPermissions(req.headers?.authorization);
    if (!perms.includes('cashout')) {
      throw new HttpException('Permission « cashout » requise sur la clé API', HttpStatus.FORBIDDEN);
    }
    return partner;
  }

  private externalRequestId(value?: string | null, required = false): string | null {
    const id = value ? String(value).trim().slice(0, 64) : '';
    if (!id) {
      if (required) throw new HttpException('requestId obligatoire', HttpStatus.BAD_REQUEST);
      return null;
    }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new HttpException('requestId invalide', HttpStatus.BAD_REQUEST);
    return id;
  }

  /** Retraits en cours de confirmation (anti double-clic sur le même requestId) */
  private readonly externalCashoutLocks = new Set<string>();

  /** Dernière issue (réussite / échec) d'un retrait partenaire pour ce requestId */
  private async externalCashoutTrace(requestId: string, userId?: string | null) {
    return this.prisma.audit_log.findFirst({
      where: {
        ...(userId ? { userId } : {}),
        action: { in: ['EXTERNAL_CASHOUT', 'EXTERNAL_CASHOUT_FAILED'] },
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
        details: { contains: `"requestId":"${requestId}"` },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('api/external/cashout/request')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('cashout')
  async externalCashoutRequest(
    @Request() req: any,
    @Body() body: { access_token?: string; amount: number; provider: string; phone: string; walletId?: string; userId?: string; requestId?: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const partner = await this.externalCashoutPartner(req);
    const userId = this.externalCashoutOwner(body?.access_token, body?.userId);
    if (!body.provider || !body.phone) {
      throw new HttpException(this.i18nService.translate('wallet.missing_phone_or_provider', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.amount || Number(body.amount) <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    const requestId = this.externalRequestId(body.requestId);
    return this.sendWalletMessage<{ message: string; data: any }>(
      'external_cashout_otp_request',
      {
        userId,
        amount: Math.round(Number(body.amount) * 100) / 100,
        provider: String(body.provider).trim(),
        phone: String(body.phone).replace(/[^\d]/g, ''),
        walletId: body.walletId || undefined,
        requestId: requestId || undefined,
        partnerId: partner.id,
        partnerName: partner.businessName || partner.full_name || null,
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.cashout_failed', lang),
      HttpStatus.BAD_REQUEST,
      30000,
    );
  }

  @Post('api/external/cashout/resend')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('cashout')
  async externalCashoutResend(
    @Request() req: any,
    @Body() body: { access_token?: string; requestId: string; userId?: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const partner = await this.externalCashoutPartner(req);
    const userId = this.externalCashoutOwner(body?.access_token, body?.userId);
    const requestId = this.externalRequestId(body?.requestId, true)!;
    return this.sendWalletMessage<{ message: string; data: any }>(
      'external_cashout_otp_request',
      { userId, requestId, resend: true, partnerId: partner.id, partnerName: partner.businessName || partner.full_name || null, lang, ipAddress },
      this.i18nService.translate('wallet.cashout_failed', lang),
      HttpStatus.BAD_REQUEST,
      30000,
    );
  }

  @Post('api/external/cashout/confirm')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('cashout')
  async externalCashoutConfirm(
    @Request() req: any,
    @Body() body: { access_token?: string; requestId: string; otpCode: string; userId?: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const partner = await this.externalCashoutPartner(req);
    const userId = this.externalCashoutOwner(body?.access_token, body?.userId);
    const requestId = this.externalRequestId(body?.requestId, true)!;
    const otpCode = String(body?.otpCode || '').trim();
    if (!/^\d{4}$/.test(otpCode)) {
      throw new HttpException(this.i18nService.translate('wallet.external_cashout_otp_invalid', lang), HttpStatus.BAD_REQUEST);
    }

    // Déjà réussi : renvoyer le résultat sans nouveau débit
    const previous = await this.externalCashoutTrace(requestId, userId);
    if (previous?.action === 'EXTERNAL_CASHOUT') {
      let details: any = {};
      try {
        details = JSON.parse(previous.details || '{}');
      } catch {
        details = {};
      }
      return { message: 'Retrait déjà effectué', data: { replayed: true, ...details } };
    }
    if (this.externalCashoutLocks.has(requestId)) {
      throw new HttpException('Ce retrait est déjà en cours de traitement', HttpStatus.CONFLICT);
    }
    this.externalCashoutLocks.add(requestId);

    const trace = (action: string, extra: Record<string, any>) =>
      this.prisma.audit_log
        .create({
          data: {
            id: crypto.randomUUID(),
            userId,
            action,
            details: JSON.stringify({ requestId, partnerId: partner.id, ...extra }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        })
        .catch(() => undefined);

    try {
      const response = await this.sendWalletMessage<{ message: string; data: any }>(
        'external_cashout_otp_confirm',
        { userId, requestId, otpCode, lang, ipAddress },
        this.i18nService.translate('wallet.cashout_failed', lang),
        HttpStatus.BAD_REQUEST,
        150000,
      );
      const tx = response?.data?.transaction ?? {};
      await trace('EXTERNAL_CASHOUT', {
        status: 'COMPLETED',
        transactionId: tx.id ?? null,
        transactionReference: tx.reference ?? null,
        amount: tx.amount ?? null,
        currency: response?.data?.wallet?.currency ?? tx.currency ?? null,
        balance: response?.data?.wallet?.balance ?? null,
      });
      return response;
    } catch (e: any) {
      const message = e?.response?.message || e?.message || 'Retrait échoué';
      // OTP faux / expiré : la demande reste ouverte. OTP accepté puis retrait refusé (PawaPay, solde…) : échec définitif.
      const otpAccepted = await this.prisma.audit_log.count({
        where: { userId, action: 'EXTERNAL_CASHOUT_OTP_CONFIRMED', details: { contains: `"requestId":"${requestId}"` } },
      });
      // ✅ Timeout (504) : le retrait peut encore aboutir côté wallet-service → pas marqué échoué
      const timedOut = (e?.getStatus?.() ?? e?.status) === HttpStatus.GATEWAY_TIMEOUT;
      if (otpAccepted > 0 && !timedOut) {
        await trace('EXTERNAL_CASHOUT_FAILED', { status: 'FAILED', message: String(message).slice(0, 500) });
      }
      throw e;
    } finally {
      this.externalCashoutLocks.delete(requestId);
    }
  }

  /** Issue d'un retrait partenaire : COMPLETED | FAILED | PROCESSING | PENDING_OTP | NOT_FOUND */
  @Get('api/external/cashout/status/:requestId')
  @UseGuards(ApiKeyGuard)
  async externalCashoutStatus(@Param('requestId') requestId: string, @Query('userId') userId?: string) {
    const id = this.externalRequestId(requestId, true)!;
    if (this.externalCashoutLocks.has(id)) return { message: 'OK', data: { requestId: id, status: 'PROCESSING' } };
    const trace = await this.externalCashoutTrace(id, userId || null);
    if (!trace) {
      const pending = await this.prisma.audit_log.findFirst({
        where: { ...(userId ? { userId } : {}), action: 'EXTERNAL_CASHOUT_OTP', details: { contains: `"requestId":"${id}"` } },
      });
      return { message: 'OK', data: { requestId: id, status: pending ? 'PENDING_OTP' : 'NOT_FOUND' } };
    }
    let details: any = {};
    try {
      details = JSON.parse(trace.details || '{}');
    } catch {
      details = {};
    }
    return {
      message: 'OK',
      data: { requestId: id, status: trace.action === 'EXTERNAL_CASHOUT' ? 'COMPLETED' : 'FAILED', at: trace.createdAt, ...details },
    };
  }

  /** Réseaux Mobile Money disponibles pour un retrait + frais (network_provider) */
  @Get('api/external/cashout/providers')
  @UseGuards(ApiKeyGuard)
  async externalCashoutProviders(@Query('currency') currency?: string) {
    const rows = await this.prisma.network_provider.findMany({ include: { country_provider: true }, orderBy: { name: 'asc' } });
    const cur = String(currency || '').trim().toUpperCase();
    const data = rows
      .filter((r: any) => !cur || String(r.currency || '').toUpperCase().split(/[,\s]+/).includes(cur))
      .map((r: any) => ({
        id: r.id,
        name: r.name,
        currency: r.currency,
        payoutFeePercent: r.pourcentage_payout ?? 0,
        image: r.image ?? null,
        country: r.country_provider ? { code: r.country_provider.code, name: r.country_provider.name, prefix: r.country_provider.prefix } : null,
      }));
    return { message: 'OK', data };
  }

  /**
   * ✅ Commission d'une course taxi payée en ESPÈCES (appelée par Favor Help quand le chauffeur valide « espèces reçues »).
   *   wallet F-Pay du CHAUFFEUR (userId + devise) ──débit──▶ wallet du compte TAXI (clé de l'en-tête, même devise)
   * Le solde du chauffeur peut devenir NÉGATIF (dette). Une seule fois par course (rideId).
   *
   * Sécurité : débite le wallet d'un AUTRE utilisateur → la clé doit avoir la permission « taxi_commission »
   * enregistrée en base, contrôlée ici même si API_KEY_PERMISSIONS_MODE=warn.
   *
   * Corps : { amount, currency, userId (id F-Pay du chauffeur), rideId, description?, paymentMethod? (CASH) }
   */
  @Post('taxi/driver/commission')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('taxi_commission')
  async driverCommission(
    @Request() req: any,
    @Body() body: {
      amount: number;
      currency: string;
      userId: string; // id F-Pay du CHAUFFEUR (wallet débité)
      rideId: string; // course Favor Help (anti-doublon)
      description?: string;
      paymentMethod?: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user; // propriétaire de la clé (compte TAXI) : wallet crédité

    if (!apiKeyUser) {
      throw new HttpException('Utilisateur API Key non trouvé', HttpStatus.UNAUTHORIZED);
    }
    if (apiKeyUser.status === 'BLOCKED') {
      throw new HttpException('Le compte TAXI est bloqué', HttpStatus.FORBIDDEN);
    }
    // ✅ Contrôle strict de la permission (indépendant du mode warn du guard)
    const perms = await this.apiKeyPermissions(req.headers?.authorization);
    if (!perms.includes('taxi_commission')) {
      throw new HttpException('Permission « taxi_commission » requise sur la clé API', HttpStatus.FORBIDDEN);
    }

    // ========== VALIDATIONS ==========
    if (!body.amount || Number(body.amount) <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    const currency = String(body.currency || '').trim().toUpperCase();
    const walletCurrencies = ['USD', 'EUR', 'CDF', 'XOF', 'XAF', 'KES', 'RWF', 'UGX', 'ZMW', 'SLE'];
    if (!walletCurrencies.includes(currency)) {
      throw new HttpException(`currency invalide. Valeurs acceptées: ${walletCurrencies.join(', ')}`, HttpStatus.BAD_REQUEST);
    }
    if (!body.userId) {
      throw new HttpException('userId du chauffeur obligatoire', HttpStatus.BAD_REQUEST);
    }
    const rideId = String(body.rideId || '').trim();
    if (!rideId || rideId.length > 64) {
      throw new HttpException('rideId obligatoire', HttpStatus.BAD_REQUEST);
    }
    if (body.userId === apiKeyUser.id) {
      throw new HttpException('Vous ne pouvez pas vous débiter vous-même', HttpStatus.BAD_REQUEST);
    }
    const paymentMethodMap: Record<string, string> = {
      CASH: 'CASH',
      CARD: 'CREDIT_DEBIT_CARD',
      CREDIT_DEBIT_CARD: 'CREDIT_DEBIT_CARD',
      INTERNAL: 'INTERNAL',
    };
    const paymentMethod = paymentMethodMap[String(body.paymentMethod || 'CASH').trim().toUpperCase()];
    if (!paymentMethod) {
      throw new HttpException(
        `paymentMethod invalide. Valeurs acceptées: ${Object.keys(paymentMethodMap).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const payload = {
      taxiUserId: apiKeyUser.id,
      driverUserId: body.userId,
      amount: Math.round(Number(body.amount) * 100) / 100,
      currency,
      rideId,
      description: body.description ? String(body.description).slice(0, 1000) : undefined,
      paymentMethod,
      lang,
      ipAddress,
    };

    const response = await this.sendWalletMessage<{ message: string; data: any }>(
      'taxi_commission',
      payload,
      this.i18nService.translate('wallet.taxi_commission_failed', lang),
      HttpStatus.BAD_REQUEST,
      60000,
    );

    await this.prisma.audit_log.create({
      data: {
        id: crypto.randomUUID(),
        userId: apiKeyUser.id,
        action: 'TAXI_DRIVER_COMMISSION',
        details: JSON.stringify({
          amount: payload.amount,
          currency: payload.currency,
          driverId: payload.driverUserId,
          rideId,
          driverBalance: response?.data?.driverWallet?.balance ?? null,
          driverDebt: response?.data?.driverDebt ?? null,
          transactionReference: response?.data?.transaction?.reference ?? null,
          replayed: response?.data?.replayed ?? false,
        }),
        ipAddress: ipAddress || null,
        createdAt: new Date(),
      },
    });

    return response;
  }

  @Post('taxi/driver/cashout')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('cashout')
  async driverCashout(
    @Request() req: any,
    @Body() body: {
      amount: number;
      description?: string;
      currency: string;
      countryCode?: string;
      paymentMethod?: string;
      userId: string; // id F-Pay du CHAUFFEUR (destinataire)
      toApiKey: string; // clé API du wallet qui sera DÉBITÉ
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user; // 🔥 propriétaire de la clé de l'en-tête (compte TAXI)

    if (!apiKeyUser) {
      throw new HttpException('Utilisateur API Key non trouvé', HttpStatus.UNAUTHORIZED);
    }
    if (apiKeyUser.status === 'BLOCKED') {
      throw new HttpException('Le compte TAXI est bloqué', HttpStatus.FORBIDDEN);
    }

    // ========== VALIDATIONS ==========
    if (!body.amount || Number(body.amount) <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    // ✅ Devises des wallets F-Pay (enum Prisma wallet_currency)
    const currency = String(body.currency || '').trim().toUpperCase();
    const walletCurrencies = ['USD', 'EUR', 'CDF', 'XOF', 'XAF', 'KES', 'RWF', 'UGX', 'ZMW', 'SLE'];
    if (!walletCurrencies.includes(currency)) {
      throw new HttpException(`currency invalide. Valeurs acceptées: ${walletCurrencies.join(', ')}`, HttpStatus.BAD_REQUEST);
    }
    if (!body.userId) {
      throw new HttpException('userId du chauffeur (destinataire) obligatoire', HttpStatus.BAD_REQUEST);
    }
    if (!body.toApiKey) {
      throw new HttpException('toApiKey (wallet à débiter) obligatoire', HttpStatus.BAD_REQUEST);
    }
    // ✅ paymentMethod → valeurs de l'enum Prisma transaction_paymentMethod
    //    (BANK_TRANSFER et CARD étaient acceptés mais n'existent pas en base : Prisma aurait planté)
    const paymentMethodMap: Record<string, string> = {
      MOBILE_MONEY: 'MOBILE_MONEY',
      CASH: 'CASH',
      BANK_TRANSFER: 'BANK_TRANSFERT',
      BANK_TRANSFERT: 'BANK_TRANSFERT',
      CARD: 'CREDIT_DEBIT_CARD',
      CREDIT_DEBIT_CARD: 'CREDIT_DEBIT_CARD',
      INTERNAL: 'INTERNAL',
      EXTERNAL_API: 'EXTERNAL_API',
    };
    const paymentMethod = paymentMethodMap[String(body.paymentMethod || 'INTERNAL').trim().toUpperCase()];
    if (!paymentMethod) {
      throw new HttpException(
        `paymentMethod invalide. Valeurs acceptées: ${Object.keys(paymentMethodMap).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ toApiKey = clé du wallet DÉBITÉ : signature vérifiée (ou clé trouvée en base, active),
    //    et elle doit appartenir au compte authentifié (clé de l'en-tête).
    //    Sinon n'importe quelle clé « cashout » pourrait vider le wallet d'un autre compte.
    const payerId = await this.apiKeyOwner(body.toApiKey);
    if (!payerId || payerId !== apiKeyUser.id) {
      throw new HttpException('toApiKey ne correspond pas au compte authentifié', HttpStatus.FORBIDDEN);
    }
    if (body.userId === payerId) {
      throw new HttpException('Vous ne pouvez pas vous envoyer d\'argent à vous-même', HttpStatus.BAD_REQUEST);
    }

    const payload = {
      payerUserId: payerId, // propriétaire de toApiKey : wallet débité
      driverUserId: body.userId, // chauffeur : wallet crédité
      amount: Math.round(Number(body.amount) * 100) / 100,
      currency,
      description: body.description ? String(body.description).slice(0, 1000) : undefined,
      countryCode: body.countryCode || 'CD',
      paymentMethod,
      lang,
      ipAddress,
    };

    console.log('[taxi/driver/cashout] 📤 Retrait chauffeur → compte F-Pay:', {
      payer: payload.payerUserId,
      driver: payload.driverUserId,
      amount: payload.amount,
      currency: payload.currency,
      paymentMethod: payload.paymentMethod,
    });

    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'taxi_cashout',
      payload,
      this.i18nService.translate('wallet.cashout_failed', lang),
      HttpStatus.BAD_REQUEST,
      60000,
    );

    await this.prisma.audit_log.create({
      data: {
        id: crypto.randomUUID(),
        userId: apiKeyUser.id,
        action: 'TAXI_DRIVER_CASHOUT',
        details: JSON.stringify({
          amount: payload.amount,
          currency: payload.currency,
          driverId: payload.driverUserId,
          driverWalletId: response?.data?.driverWallet?.id ?? null,
          description: payload.description ?? null,
          transactionReference: response?.data?.transaction?.reference ?? null,
          transactionStatus: response?.data?.transaction?.status ?? null,
          replayed: response?.data?.replayed ?? false,
        }),
        ipAddress: ipAddress || null,
        createdAt: new Date(),
      },
    });

    return response;
  }

  @Get('wallet/:walletId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getWalletById(
    @CurrentUser() currentUser: any,
    @Param('walletId') walletId: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const response = await this.sendWalletMessage(
      'get_wallet_by_id',
      { walletId, userId: currentUser.id, lang },
      this.i18nService.translate('wallet.wallet_not_found', lang),
      HttpStatus.NOT_FOUND,
    );
    return response;
  }

  @Get('wallet/:walletId/transactions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransactionsByWallet(
    @CurrentUser() currentUser: any,
    @Param('walletId') walletId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    if (!walletId) {
      throw new HttpException(
        this.i18nService.translate('wallet.wallet_id_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ SÉCURITÉ : le wallet doit appartenir à l'utilisateur connecté (les admins voient tout)
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      const owned = await (this.prisma as any).wallet.findFirst({ where: { id: walletId, userId: currentUser?.id }, select: { id: true } });
      if (!owned) throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    let start: Date | undefined;
    let end: Date | undefined;
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        throw new HttpException(
          this.i18nService.translate('wallet.invalid_start_date', lang),
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        throw new HttpException(
          this.i18nService.translate('wallet.invalid_end_date', lang),
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const response = await this.sendWalletMessage<any>(
      'get_transactions_by_wallet',
      {
        walletId,
        page: pageNum,
        limit: limitNum,
        startDate: start,
        endDate: end,
        lang,
      },
      this.i18nService.translate('wallet.transactions_retrieve_failed', lang),
      HttpStatus.BAD_REQUEST,
    );

    return response;
  }


  @Get('wallet/dashboard/by-currentUser')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getWalletDashboard(
    @CurrentUser() currentUser: any,
    @Query('walletId') walletId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    return this.sendWalletMessage(
      'get_wallet_dashboard',
      {
        userId: currentUser.id,
        walletId,
        startDate,
        endDate,
        lang,
      },
      'Failed to get dashboard',
      HttpStatus.BAD_REQUEST,
    );
  }

  // ==================== PIN ENDPOINTS ====================

  @Post('users/me/pin')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async changeMyPin(
    @CurrentUser() currentUser: any,
    @Body() body: { pin: string },
    @Request() req: any,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const { pin } = body;
    if (!pin) {
      throw new HttpException(this.i18nService.translate('wallet.pin_required', lang), HttpStatus.BAD_REQUEST);
    }
    if (pin.length < 4) {
      throw new HttpException(this.i18nService.translate('wallet.pin_min_length', lang), HttpStatus.BAD_REQUEST);
    }
    if (!/^\d+$/.test(pin)) {
      throw new HttpException(this.i18nService.translate('wallet.pin_digits_only', lang), HttpStatus.BAD_REQUEST);
    }
    const result = await this.sendUserMessage<{ message: string; data: any }>(
      'change_pin',
      { id: currentUser.id, pin, lang },
      this.i18nService.translate('wallet.pin_change_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
    return {
      data: result.data,
      message: result.message,
    };
  }

  @Post('users/update/pin')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updatePin(
    @CurrentUser() currentUser: any,
    @Body() body: { oldPin: string; newPin: string },
    @Request() req: any,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const { oldPin, newPin } = body;
    if (!oldPin || oldPin.length < 4) {
      throw new HttpException(this.i18nService.translate('wallet.pin_old_required', lang), HttpStatus.BAD_REQUEST);
    }
    if (!/^\d+$/.test(oldPin)) {
      throw new HttpException(this.i18nService.translate('wallet.pin_digits_only', lang), HttpStatus.BAD_REQUEST);
    }
    if (!newPin || newPin.length < 4) {
      throw new HttpException(this.i18nService.translate('wallet.pin_min_length', lang), HttpStatus.BAD_REQUEST);
    }
    if (!/^\d+$/.test(newPin)) {
      throw new HttpException(this.i18nService.translate('wallet.pin_digits_only', lang), HttpStatus.BAD_REQUEST);
    }
    const result = await this.sendUserMessage<{ message: string; data: any }>(
      'update_pin',
      { id: currentUser.id, oldPin, newPin, lang },
      this.i18nService.translate('wallet.pin_update_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
    return {
      data: result.data,
      message: result.message,
    };
  }

  // ==================== AUDIT ENDPOINTS ====================

  @Get('admin/audit-logs')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAuditLogs(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const currentPage = page ? parseInt(page, 10) : 1;
    const currentLimit = limit ? parseInt(limit, 10) : 10;
    const payload: any = { page: currentPage, limit: currentLimit };
    if (userId) payload.userId = userId;
    if (action) payload.action = action;
    if (startDate) payload.startDate = new Date(startDate);
    if (endDate) payload.endDate = new Date(endDate);
    const auditResponse = await this.sendAuditMessage<{
      message: string;
      data: {
        data: any[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
        hasNextPage: boolean;
        hasPrevPage: boolean;
      };
    }>(
      'get_audit_logs',
      payload,
      'Failed to retrieve audit logs',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return {
      message: auditResponse.message,
      data: {
        data: auditResponse.data.data,
        total: auditResponse.data.total,
        page: auditResponse.data.page,
        limit: auditResponse.data.limit,
        totalPages: auditResponse.data.totalPages,
        hasNextPage: auditResponse.data.hasNextPage,
        hasPrevPage: auditResponse.data.hasPrevPage,
      },
    };
  }

  @Get('admin/audit-logs/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAuditLogById(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    if (!id) {
      throw new HttpException('ID du log requis', HttpStatus.BAD_REQUEST);
    }
    const result = await this.sendAuditMessage<any>(
      'get_audit_log_by_id',
      { id },
      'Failed to retrieve audit log',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return {
      message: 'Audit log retrieved successfully',
      data: result,
    };
  }

  @Patch('admin/audit-logs/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteAuditLogById(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    // ✅ SÉCURITÉ : la suppression d'une trace d'audit est réservée au SUPER_ADMIN
    if (currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    if (!id) {
      throw new HttpException('ID du log requis', HttpStatus.BAD_REQUEST);
    }
    const result = await this.sendAuditMessage<{ message: string }>(
      'delete_audit_log_by_id',
      { id },
      'Failed to delete audit log',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return result;
  }
  //=======================================================
  //Sesssion
  @Get('admin/sessions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listAllSessions(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const result = await this.sendAuthMessage<{
      message: string;
      data: any[];
      total: number;
      page: number;
      limit: number;
    }>(
      'list_all_sessions',
      { page: pageNum, limit: limitNum },
      'Échec récupération sessions',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return {
      message: result.message,
      data: {
        data: result.data,
        total: result.total,
        page: result.page,
        limit: result.limit,
      },
    };
  }

  @Get('users/me/sessions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMySessions(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const result = await this.sendAuthMessage<{
      message: string;
      data: any[];
      total: number;
      page: number;
      limit: number;
    }>(
      'list_user_sessions',
      { userId: currentUser.id, page: pageNum, limit: limitNum },
      'Échec de récupération des sessions',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return {
      message: result.message,
      data: {
        data: result.data,
        total: result.total,
        page: result.page,
        limit: result.limit,
      },
    };
  }
  @Get('bank/link/:accountNumber')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async linkBankAccount(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,
  ) {
    this.logger.log(
      `🔗 Link bank account: ${accountNumber} for user ${currentUser.id}`,
    );
    const response = await this.sendWalletMessage<any>(
      'link_account',
      { accountNumber },
      'Échec du lien bancaire',
      HttpStatus.BAD_REQUEST,
      12000,
    );
    return response;
  }

  // ✅ SÉCURITÉ : ces routes étaient publiques (aucune authentification). Réservées désormais au SUPER_ADMIN.
  @Post('topup/brute')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async topups(@CurrentUser() currentUser: any, @Body() data: { accountNumber: string; amount: number; requestId?: string }) {
    if (currentUser?.role !== 'SUPER_ADMIN') throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    return this.walletClient.send('topup', data);
  }

  @Post('cashout/brute')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async cashouts(@CurrentUser() currentUser: any, @Body() data: { accountNumber: string; amount: number; pin: string }) {
    if (currentUser?.role !== 'SUPER_ADMIN') throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    return this.walletClient.send('cashouts', data);
  }

  @Get('admin/sessions/:sessionId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getSessionById(
    @CurrentUser() currentUser: any,
    @Param('sessionId') sessionId: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    if (!sessionId) {
      throw new HttpException('ID de session requis', HttpStatus.BAD_REQUEST);
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    const response = await this.sendAuthMessage<{ message: string; data: any }>(
      'get_session_by_id',
      { sessionId, lang },
      'Échec de récupération de la session',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return response;
  }
  //===============================================================
  @Post('users/me/verify-pin')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async verifyMyPin(
    @CurrentUser() currentUser: any,
    @Body() body: { pin: string },
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const { pin } = body;
    if (!pin) {
      throw new HttpException(this.i18nService.translate('wallet.pin_required', lang), HttpStatus.BAD_REQUEST);
    }
    const response = await this.sendUserMessage<{
      valid: boolean;
      message: string;
    }>(
      'verify_pin',
      { userId: currentUser.id, pin, lang },
      this.i18nService.translate('wallet.pin_verification_failed', lang),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return { message: response.message };
  }

  @Post('users/me/device-token')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async registerDeviceToken(
    @CurrentUser() currentUser: any,
    @Body() body: { fcmToken: string },
  ) {
    const { fcmToken } = body;
    if (!fcmToken) {
      throw new HttpException(
        'Le token FCM est requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.sendAuthMessage<{ message: string }>(
      'register_device_token',
      { userId: currentUser.id, fcmToken },
      'Échec de l’enregistrement du token',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Post('auth/logout')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async logout(
    @CurrentUser() currentUser: any,
    @Body() body: { sessionId: string },
    @Headers('lang') langHeader?: string,
  ) {
    const { sessionId } = body;
    if (!sessionId) {
      throw new HttpException('sessionId requis', HttpStatus.BAD_REQUEST);
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    return this.sendAuthMessage<{ message: string }>(
      'revoke_session_by_id',
      { userId: currentUser.id, sessionId, lang },
      'Échec de la déconnexion',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
  //============================User_settings==================================
  @Get('users/me/settings')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMySettings(@CurrentUser() currentUser: any) {
    return this.sendUserMessage(
      'get_user_settings',
      { userId: currentUser.id },
      'Failed to retrieve settings',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Patch('users/me/settings')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMySettings(
    @CurrentUser() currentUser: any,
    @Body() dto: UpdateUserSettingsDto,
  ) {
    return this.sendUserMessage(
      'update_user_settings',
      { userId: currentUser.id, settings: dto },
      'Failed to update settings',
      HttpStatus.BAD_REQUEST,
    );
  }
  // ==================== NOTIFICATIONS ENDPOINTS ====================

  @Get('users/me/notifications')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyNotifications(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const result = await this.sendNotificationMessage<{
      message: string;
      data: any[];
      total: number;
      page: number;
      limit: number;
    }>(
      'list_user_notifications',
      { userId: currentUser.id, page: pageNum, limit: limitNum },
      'Échec de récupération des notifications',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return {
      message: result.message,
      data: {
        data: result.data,
        total: result.total,
        page: result.page,
        limit: result.limit,
      },
    };
  }

  @Get('wallet/phone/:phone')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getWalletByPhone(
    @CurrentUser() currentUser: any,
    @Param('phone') phone: string,
  ) {
    if (!phone) {
      throw new HttpException(
        'Le numéro de téléphone est requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    const response = await this.sendWalletMessage<{
      message: string;
      data: any;
    }>(
      'get_wallet_by_phone',
      { phone },
      'Échec de la récupération du wallet',
      HttpStatus.NOT_FOUND,
    );
    return response;
  }

  @Get('merchant/:merchantCode')
  async getMerchantByCode(@Param('merchantCode') merchantCode: string) {
    if (!merchantCode) {
      throw new HttpException('Code marchand requis', HttpStatus.BAD_REQUEST);
    }
    return this.sendWalletMessage(
      'get_merchant_by_code',
      { merchantCode },
      'Échec de récupération du commerçant',
      HttpStatus.NOT_FOUND,
    );
  }

  @Get('wallet/transactions/:transactionId')
  async getTransactionById(
    @Param('transactionId') transactionId: string,
    @Headers('authorization') authorization?: string,
  ) {
    if (!transactionId) {
      throw new HttpException(
        'ID de transaction requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    const caller = this.optionalLookupCaller(authorization);
    if (caller && !caller.isAdmin) {
      const own = await this.prisma.transaction.findFirst({ where: { id: transactionId, userId: caller.id }, select: { id: true } });
      if (!own) throw new HttpException('Transaction introuvable', HttpStatus.NOT_FOUND);
    }
    return this.sendWalletMessage(
      'get_transaction_by_id',
      { transactionId },
      'Échec de récupération de la transaction',
      HttpStatus.NOT_FOUND,
    );
  }

  // Dans le contrôleur de l'API Gateway
  @Post('admin/wallet/topup')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminTopUp(
    @CurrentUser() currentUser: any,  // ICI on a l'admin
    @Body() body: { walletId: string; amount: number; pin: string; paymentMethod: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';

    // ✅ DOUBLE VALIDATION : recharge sans contrepartie (ou au-dessus du seuil) → demande en attente d'un 2e administrateur
    const pending = await this.approvals.interceptAdminTopUp(currentUser, body, ipAddress, lang);
    if (pending) return pending;

    // On passe l'adminId dans le payload
    return this.sendWalletMessage(
      'admin_top_up',
      {
        adminId: currentUser.id,  // ← AJOUTER
        walletId: body.walletId,
        amount: body.amount,
        pin: body.pin,
        lang,
        ipAddress,
        paymentMethod: body.paymentMethod
      },
      this.i18nService.translate('wallet.top_up_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('admin/wallet/cashout')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminCashout(
    @CurrentUser() currentUser: any,
    @Body() body: { walletId: string; amount: number; otpCode?: string; paymentMethod?: string; pin?: string; },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    // Vérification des rôles
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';

    // Appel direct au service
    return this.sendWalletMessage(
      'admin_cashout',
      {
        adminId: currentUser.id,
        walletId: body.walletId,
        amount: body.amount,
        otpCode: body.otpCode, // ✅ OTP au lieu de pin (peut être undefined ou "123456")
        pin: body.pin, // ✅ Pin au lieu de otpCode (peut être undefined ou "123456")
        lang,
        ipAddress,
        paymentMethod: body.paymentMethod // "CASH"
      },
      this.i18nService.translate('wallet.cashout_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('admin/wallet/send')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminSend(
    @CurrentUser() currentUser: any,
    @Body() body: { fromWalletId: string; toPhone: string; amount: number; pin: string; description?: string; paymentMethod?: string; countryCode?: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';

    // ✅ Validations
    if (!body.fromWalletId) {
      throw new HttpException(
        this.i18nService.translate('wallet.admin_send_from_wallet_required', lang),
        HttpStatus.BAD_REQUEST
      );
    }
    if (!body.toPhone) {
      throw new HttpException(
        this.i18nService.translate('wallet.admin_send_to_phone_required', lang),
        HttpStatus.BAD_REQUEST
      );
    }
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(
        this.i18nService.translate('wallet.amount_positive', lang),
        HttpStatus.BAD_REQUEST
      );
    }
    if (!body.pin || body.pin.length < 4) {
      throw new HttpException(
        this.i18nService.translate('wallet.pin_min_length', lang),
        HttpStatus.BAD_REQUEST
      );
    }

    return this.sendWalletMessage(
      'admin_send',
      {
        adminId: currentUser.id,
        fromWalletId: body.fromWalletId,
        toPhone: body.toPhone,
        amount: body.amount,
        pin: body.pin,
        description: body.description,
        lang,
        ipAddress,
        paymentMethod: body.paymentMethod,
        countryCode: body.countryCode // ✅ AJOUTÉ
      },
      this.i18nService.translate('wallet.transfer_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  // adminPay dans l'API Gateway - CORRIGÉ avec adminId
  @Post('admin/wallet/pay')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminPay(
    @CurrentUser() currentUser: any,
    @Body() body: { fromWalletId: string; merchantCode: string; amount: number; pin: string; description?: string; paymentMethod: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';

    // ✅ Validations
    if (!body.fromWalletId) {
      throw new HttpException(
        this.i18nService.translate('wallet.admin_pay_from_wallet_required', lang),
        HttpStatus.BAD_REQUEST
      );
    }
    if (!body.merchantCode) {
      throw new HttpException(
        this.i18nService.translate('wallet.admin_pay_merchant_code_required', lang),
        HttpStatus.BAD_REQUEST
      );
    }
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(
        this.i18nService.translate('wallet.amount_positive', lang),
        HttpStatus.BAD_REQUEST
      );
    }
    if (!body.pin || body.pin.length < 4) {
      throw new HttpException(
        this.i18nService.translate('wallet.pin_min_length', lang),
        HttpStatus.BAD_REQUEST
      );
    }

    return this.sendWalletMessage(
      'admin_pay',
      {
        adminId: currentUser.id,
        fromWalletId: body.fromWalletId,
        merchantCode: body.merchantCode,
        amount: body.amount,
        pin: body.pin,
        description: body.description,
        lang,
        ipAddress,
        paymentMethod: body.paymentMethod
      },
      this.i18nService.translate('wallet.payment_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('admin/branches/transfer-cash')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async transferCashBetweenBranches(
    @CurrentUser() currentUser: any,
    @Body() body: {
      fromWalletId: string;
      toWalletId: string;
      amount: number;
      currency?: string;
      reason?: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {

    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException(
        'Accès interdit. Seul un administrateur peut effectuer des transferts de cash',
        HttpStatus.FORBIDDEN,
      );
    }

    const lang = langHeader || 'fr';

    // ✅ Validations
    if (!body.fromWalletId) {
      throw new HttpException(
        this.i18nService.translate('wallet.from_wallet_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.toWalletId) {
      throw new HttpException(
        this.i18nService.translate('wallet.to_wallet_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.amount || body.amount <= 0) {
      throw new HttpException(
        this.i18nService.translate('wallet.amount_positive', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (body.fromWalletId === body.toWalletId) {
      throw new HttpException(
        'Impossible de transférer vers le même wallet',
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] transferCashBetweenBranches:', {
      fromWalletId: body.fromWalletId,
      toWalletId: body.toWalletId,
      amount: body.amount,
      currency: body.currency,
      reason: body.reason,
      adminId: currentUser.id,
    });

    return this.sendWalletMessage(
      'transfer_cash_between_branches',
      {
        fromWalletId: body.fromWalletId,
        toWalletId: body.toWalletId,
        amount: body.amount,
        adminId: currentUser.id,
        currency: body.currency || 'CDF',
        reason: body.reason,
        lang,
        ipAddress,
      },
      'Échec du transfert de cash entre agences',
      HttpStatus.BAD_REQUEST,
      120000,
    );
  }


  @Post('wallet/convert')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async convertCurrency(
    @CurrentUser() currentUser: any,
    @Body() body: { fromWalletId: string; toWalletId: string; amount: number; pin: string; description?: string },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    if (!body.fromWalletId || !body.toWalletId) {
      throw new HttpException(this.i18nService.translate('wallet.missing_wallet_ids', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(this.i18nService.translate('wallet.amount_positive', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.pin || body.pin.length < 4 || !/^\d+$/.test(body.pin)) {
      throw new HttpException(this.i18nService.translate('wallet.pin_invalid', lang), HttpStatus.BAD_REQUEST);
    }
    const response = await this.sendWalletMessage(
      'convert_currency',
      { ...body, lang, ipAddress },
      this.i18nService.translate('wallet.conversion_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
    return response;
  }

  @Post('admin/exchange-rates')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async setExchangeRate(
    @CurrentUser() currentUser: any,
    @Body() dto: ExchangeRateDto,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';
    return this.sendWalletMessage(
      'set_exchange_rate',
      dto,
      this.i18nService.translate('wallet.exchange_rate_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/exchange-rates')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getExchangeRates(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';
    return this.sendWalletMessage(
      'get_exchange_rates',
      {},
      this.i18nService.translate('wallet.exchange_rates_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('wallet/list')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listMyWallets(@CurrentUser() currentUser: any) {
    const response = await this.sendWalletMessage<{
      message: string;
      data: any[];
    }>(
      'list_user_wallets',
      { userId: currentUser.id },
      'Failed to list wallets',
      HttpStatus.NOT_FOUND,
    );
    return response;
  }

  @Post('admin/wallet/reconcile/:transactionId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async reconcileTransaction(
    @CurrentUser() currentUser: any,
    @Param('transactionId') transactionId: string,
    @Body() body: { pin: string },
    @Headers('lang') langHeader?: string,
  ) {
    // ✅ Vérification des droits admin
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';

    if (!transactionId) {
      throw new HttpException(
        'ID de transaction requis',
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ Vérification du PIN
    if (!body.pin || body.pin.length < 4) {
      throw new HttpException(
        'Le PIN est requis (4 chiffres minimum)',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!/^\d+$/.test(body.pin)) {
      throw new HttpException(
        'Le PIN doit contenir uniquement des chiffres',
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] reconcile_transaction:', {
      transactionId,
      adminId: currentUser.id,
      lang,
    });

    return this.sendWalletMessage(
      'reconcile_transaction',
      {
        transactionId,
        adminId: currentUser.id,
        adminPin: body.pin,
        lang,
      },
      'Échec de la réconciliation de la transaction',
      HttpStatus.BAD_REQUEST,
      120000,
    );
  }
  // ==================== SETTINGS ENDPOINTS ====================

  @Get('admin/settings/general')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getGeneralSettings(@CurrentUser() currentUser: any) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendSettingsMessage(
      'get_general_settings',
      {},
      'Failed to get settings',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('ping-settings')
  async pingSettings() {
    return this.sendSettingsMessage('ping', {}, 'ping failed', 5000);
  }

  @Patch('admin/settings/general')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateGeneralSettings(
    @Body() dto: any,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendSettingsMessage(
      'update_general_settings',
      dto,
      'Failed to update settings',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/settings/security')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getSecurityPolicies(@CurrentUser() currentUser: any) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendSettingsMessage(
      'get_security_policies',
      {},
      'Failed to get policies',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Patch('admin/settings/security')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateSecurityPolicies(
    @Body() dto: any,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendSettingsMessage(
      'update_security_policies',
      dto,
      'Failed to update policies',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/settings/limits/:userId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserTransactionLimit(
    @Param('userId') userId: string,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendSettingsMessage(
      'get_user_transaction_limit',
      { userId },
      'Failed to get limits',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Patch('admin/settings/limits/:userId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateUserTransactionLimit(
    @Param('userId') userId: string,
    @Body() dto: any,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendSettingsMessage(
      'update_user_transaction_limit',
      { userId, dto },
      'Failed to update limits',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
  // ==================== NOTIFICATIONS ENDPOINTS (suite) ====================

  @Patch('users/me/notifications/:id/read')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async markNotificationAsRead(
    @CurrentUser() currentUser: any,
    @Param('id') notificationId: string,
  ) {
    if (!notificationId) {
      throw new HttpException(
        'ID de notification requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await this.sendNotificationMessage<{
      message: string;
      data: any;
    }>(
      'mark_notification_seen',
      { notificationId, userId: currentUser.id },
      'Échec du marquage de la notification',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return result;
  }

  @Patch('users/me/notifications/read-all')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async markAllNotificationsAsRead(@CurrentUser() currentUser: any) {
    const result = await this.sendNotificationMessage<{
      message: string;
      count: number;
    }>(
      'mark_all_notifications_seen',
      { userId: currentUser.id },
      'Échec du marquage de toutes les notifications',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return result;
  }
  // ==================== HEALTH ====================

  @Get('health')
  async healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      message: 'API Gateway is running',
      services: {
        auth: true,
        user: true,
        wallet: true,
        audit: true,
        notification: true
      }
    };
  }

  //=====================================DASHBOARD===========================
  @Get('admin/dashboard')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAdminDashboard(
    @CurrentUser() currentUser: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('countryCode') countryCode?: string,
    @Query('branchId') branchId?: string, // ✅ AJOUT DU FILTRE PAR BRANCHE
  ) {
    // 1️⃣ Vérification des droits
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    // 2️⃣ Logs pour le debugging
    console.log('[Gateway] Admin Dashboard Request:', {
      adminId: currentUser.id,
      role: currentUser.role,
      branchId: currentUser.branchId,
      filters: { startDate, endDate, countryCode, branchId }
    });

    // 3️⃣ Construction du payload
    const payload: any = {
      adminId: currentUser.id,
    };

    if (startDate) payload.startDate = startDate;
    if (endDate) payload.endDate = endDate;
    if (countryCode) payload.countryCode = countryCode;
    if (branchId) payload.branchId = branchId;

    // 4️⃣ Envoi du message
    return this.sendUserMessage(
      'get_admin_dashboard',
      payload,
      'Failed to get dashboard',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  private async checkServiceHealth(queue: string): Promise<boolean> {
    try {
      let client: ClientProxy;
      if (queue === 'auth_queue') client = this.authClient;
      else if (queue === 'user_queue') client = this.userClient;
      else if (queue === 'wallet_queue') client = this.walletClient;
      else if (queue === 'audit_queue') client = this.auditClient;
      else if (queue === 'notification_queue') client = this.notificationClient;
      else return false;
      await firstValueFrom(client.send('health_check', {}).pipe(timeout(5000)));
      return true;
    } catch (error) {
      return false;
    }
  }

  @Get('wallet/statement/download')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async downloadStatement(
    @CurrentUser() currentUser: any,
    @Res() res: Response,
    @Query('startDate') startDateStr?: string,
    @Query('endDate') endDateStr?: string,
    @Headers('lang') langHeader?: string,
  ) {
    let startDate: Date | undefined = undefined;
    let endDate: Date | undefined = undefined;
    if (startDateStr && startDateStr.trim() !== '') {
      startDate = new Date(startDateStr);
      if (isNaN(startDate.getTime())) startDate = undefined;
    }
    if (endDateStr && endDateStr.trim() !== '') {
      endDate = new Date(endDateStr);
      if (isNaN(endDate.getTime())) endDate = undefined;
    }
    const allowedLangs = ['fr', 'en', 'sw', 'ar', 'es'];
    const lang = allowedLangs.includes(langHeader || '') ? langHeader : 'fr';
    const result = await this.sendWalletMessage<{
      pdfBase64: string;
      message: string;
    }>(
      'generate_statement_pdf',
      {
        userId: currentUser.id,
        startDate: startDateStr,
        endDate: endDateStr,
        lang,
      },
      'Erreur génération relevé',
      HttpStatus.INTERNAL_SERVER_ERROR,
      300000,
    );
    const pdfBuffer = Buffer.from(result.pdfBase64, 'base64');
    let filename = 'releve_compte.pdf';
    if (startDateStr && endDateStr) {
      filename = `releve_${startDateStr}_${endDateStr}.pdf`;
    } else if (startDateStr) {
      filename = `releve_depuis_${startDateStr}.pdf`;
    } else if (endDateStr) {
      filename = `releve_jusqu_au_${endDateStr}.pdf`;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  }

  // ==================== RESOURCES MANAGEMENT ====================

  @Post('admin/resources')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createResource(
    @CurrentUser() currentUser: any,
    @Body() dto: CreateResourceDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'create_resource',
      dto,
      'Échec de la création de la ressource',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Patch('admin/resources/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateResource(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() dto: UpdateResourceDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'update_resource',
      { id, ...dto },
      'Échec de la mise à jour de la ressource',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/resources')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAllResources(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendUserMessage(
      'get_all_resources',
      { page: pageNum, limit: limitNum },
      'Échec de la récupération des ressources',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/resources/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getOneResource(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_one_resource',
      { id },
      'Ressource non trouvée',
      HttpStatus.NOT_FOUND,
    );
  }

  @Post('admin/users/assign-resource')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async assignMultipleResourcesToUser(
    @CurrentUser() currentUser: any,
    @Body() dto: AssignMultipleResourcesDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    if (!dto.grantedBy) dto.grantedBy = currentUser.id;

    return this.sendUserMessage(
      'assign_resource_to_user',
      dto,
      'Échec de l’attribution multiple',
      HttpStatus.BAD_REQUEST,
    );
  }


  @Get('admin/users/:userId/resources')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserResources(
    @CurrentUser() currentUser: any,
    @Param('userId') userId: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_user_resources',
      { userId },
      'Échec de la récupération des ressources utilisateur',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Delete('admin/users/:userId/resources/:resourceId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  @Permissions({ resource: 'resources', action: 'canDelete' })
  async revokeResource(
    @CurrentUser() currentUser: any,
    @Param('userId') userId: string,
    @Param('resourceId') resourceId: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'revoke_resource',
      { userId, resourceId },
      'Échec de la révocation de la ressource',
      HttpStatus.BAD_REQUEST,
    );
  }
  //========================SETTINGS==============================================
  @Post('admin/settings/app')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  @Permissions({ resource: 'settings', action: 'canCreate' })
  async upsertAppSettings(
    @CurrentUser() currentUser: any,
    @Body() dto: UpsertAppSettingsDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'upsert_app_settings',
      dto,
      'Échec de mise à jour',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/settings/app')
  async getAppSettings() {
    try {
      // ✅ Utiliser userClient au lieu de settingsClient
      const result = await firstValueFrom(
        this.userClient.send('get_app_settings', {}).pipe(
          timeout(30000)
        ),
      );
      return result;
    } catch (err) {
      this.logger.error(`RPC error: ${err.message}`);

      // Timeout
      if (err.name === 'TimeoutError' || err.message?.includes('Timeout')) {
        throw new HttpException(
          'Service temporarily unavailable, please try again',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      // Erreur du microservice
      if (err.response) {
        const errorResponse = err.response;
        if (typeof errorResponse === 'object') {
          throw new HttpException(
            errorResponse.message || 'Service error',
            errorResponse.statusCode || HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
        throw new HttpException(
          typeof errorResponse === 'string' ? errorResponse : 'Service error',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      throw new HttpException(
        'Service error: ' + (err.message || 'Unknown error'),
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('auth/login-attempts')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyLoginAttempts(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.sendAuthMessage(
      'get_login_attempts',
      { userId: currentUser.id, page: pageNum, limit: limitNum },
      'Failed to get login attempts',
      HttpStatus.BAD_REQUEST,
    );
  }

  // ==================== PAWAPAY COUNTRY & NETWORK ENDPOINTS ====================

  @Post('admin/pawapay/countries')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createCountry(
    @CurrentUser() currentUser: any,
    @Body() dto: CreateCountryDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendWalletMessage(
      'create_country',
      dto,
      'Failed to create country',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Patch('admin/pawapay/countries/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateCountry(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() dto: UpdateCountryDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendWalletMessage(
      'update_country',
      { id, dto },
      'Failed to update country',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('pawapay/countries/:id')
  async getCountry(@Param('id') id: string) {
    return this.sendWalletMessage(
      'get_country',
      { id },
      'Country not found',
      HttpStatus.NOT_FOUND,
    );
  }

  @Get('pawapay/countries')
  async getAllCountries(@Query('status') status?: string) {
    console.log('🔍 [API Gateway] Status from query:', status);

    // Si status est fourni, filtrer, sinon tout
    const payload: any = {};
    if (status) {
      const validStatuses = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
      if (!validStatuses.includes(status.toUpperCase())) {
        throw new HttpException(
          'Invalid status. Use: ACTIVE, INACTIVE, SUSPENDED',
          HttpStatus.BAD_REQUEST,
        );
      }
      payload.status = status.toUpperCase();
    }

    return this.sendWalletMessage(
      'get_all_countries',
      payload,
      'Failed to get countries',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Post('admin/pawapay/networks')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createNetwork(
    @CurrentUser() currentUser: any,
    @Body() dto: CreateNetworkDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendWalletMessage(
      'create_network',
      dto,
      'Failed to create network',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Patch('admin/pawapay/networks/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateNetwork(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() dto: UpdateNetworkDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendWalletMessage(
      'update_network',
      { id, dto },
      'Failed to update network',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('pawapay/networks/:id')
  async getNetwork(@Param('id') id: string) {
    return this.sendWalletMessage(
      'get_network',
      { id },
      'Network not found',
      HttpStatus.NOT_FOUND,
    );
  }

  @Get('pawapay/networks')
  async getAllNetworks() {
    return this.sendWalletMessage(
      'get_all_networks',
      {},
      'Failed to get networks',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('pawapay/networks/filter/by-country')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyNetworksByWallet(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    let finalCountryCode: string | null = null;

    // 1️⃣ Essayer depuis currentUser
    if (currentUser?.countryCode) {
      finalCountryCode = currentUser.countryCode.toUpperCase();
      console.log('[API Gateway] CountryCode from currentUser:', finalCountryCode);
    } else {
      // 2️⃣ Fallback: essayer depuis le wallet
      try {
        const wallet = await this.prisma.wallet.findFirst({
          where: {
            userId: currentUser.id,
            isActive: true,
          },
          select: { currency: true },
        });

        if (wallet) {
          const country = await this.prisma.country_provider.findFirst({
            where: {
              OR: [
                { default_currency: wallet.currency },
                {
                  country_currency: {
                    some: { currency_code: wallet.currency }
                  }
                }
              ]
            },
            select: { countryCode: true, code: true },
          });

          if (country) {
            finalCountryCode = country.countryCode || country.code;
            console.log('[API Gateway] Country from wallet currency:', finalCountryCode);
          }
        }
      } catch (error) {
        console.error('[API Gateway] Error fetching country from wallet:', error);
      }
    }

    // ✅ Vérifier si on a trouvé un countryCode
    if (!finalCountryCode) {
      throw new HttpException(
        'Country code not found for this user. Please update your profile or contact support.',
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] getMyNetworksByWallet - finalCountryCode:', finalCountryCode);

    return this.sendWalletMessage(
      'get_networks_by_country',
      { countryCode: finalCountryCode, lang },
      this.i18nService.translate('wallet.networks_retrieve_failed', lang),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
  // ==================== API KEY MANAGEMENT ENDPOINTS ====================

  @Post('admin/api-keys')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createApiKey(
    @CurrentUser() currentUser: any,
    @Body() body: { name: string; userId: string; permissions: string[]; expiresInDays?: number },
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'create_api_key',
      body,
      'Failed to create API key',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/api-keys')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listApiKeys(
    @CurrentUser() currentUser: any,
    @Query('userId') userId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // ✅ Vérifier que l'utilisateur est admin
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    // ✅ Si userId n'est pas fourni, utiliser l'ID de l'utilisateur connecté
    const targetUserId = userId;

    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    return this.sendUserMessage(
      'list_api_keys',
      { userId: targetUserId, page: pageNum, limit: limitNum },
      'Failed to list API keys',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('users/me/api-keys')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listMyApiKeys(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    return this.sendUserMessage(
      'list_api_keys',
      { userId: currentUser.id, page: pageNum, limit: limitNum },
      'Failed to list your API keys',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Patch('admin/api-keys/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateApiKey(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      permissions?: string[];
      isActive?: boolean;
      expiresInDays?: number;
    },
  ) {
    // ✅ Vérifier que l'utilisateur est admin
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    if (!id) {
      throw new HttpException('ID de la clé API requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'update_api_key',
      {
        id,
        userId: currentUser.id,
        ...body,
      },
      'Failed to update API key',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Patch('users/me/api-keys/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMyApiKey(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      permissions?: string[];
      isActive?: boolean;
      expiresInDays?: number;
    },
  ) {
    if (!id) {
      throw new HttpException('ID de la clé API requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'update_api_key',
      {
        id,
        userId: currentUser.id,
        ...body,
      },
      'Failed to update your API key',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Delete('admin/api-keys/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteApiKey(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    // ✅ Vérifier que l'utilisateur est admin
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    if (!id) {
      throw new HttpException('ID de la clé API requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'delete_api_key',
      { id },
      'Failed to delete API key',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Delete('users/me/api-keys/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteMyApiKey(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    if (!id) {
      throw new HttpException('ID de la clé API requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'delete_api_key',
      { id, userId: currentUser.id },
      'Failed to delete your API key',
      HttpStatus.BAD_REQUEST,
    );
  }


  @Post('admin/api-keys/:id/revoke')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async revokeApiKey(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    // ✅ Vérifier que l'utilisateur est admin
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    if (!id) {
      throw new HttpException('ID de la clé API requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'revoke_api_key',
      { id, userId: currentUser.id },
      'Failed to revoke API key',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('users/me/api-keys/:id/revoke')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async revokeMyApiKey(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    if (!id) {
      throw new HttpException('ID de la clé API requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'revoke_api_key',
      { id, userId: currentUser.id },
      'Failed to revoke your API key',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('admin/api-keys/:id/reactivate')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async reactivateApiKey(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    // ✅ Vérifier que l'utilisateur est admin
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    if (!id) {
      throw new HttpException('ID de la clé API requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'reactivate_api_key',
      { id, userId: currentUser.id },
      'Failed to reactivate API key',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('users/me/api-keys/:id/reactivate')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async reactivateMyApiKey(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    if (!id) {
      throw new HttpException('ID de la clé API requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'reactivate_api_key',
      { id, userId: currentUser.id },
      'Failed to reactivate your API key',
      HttpStatus.BAD_REQUEST,
    );
  }


  //===============================Externe============================

  @Post('api/external/pay')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('pay')
  async externalPay(
    @Request() req: any,
    @Body() body: {
      system_user_id?: string;     // ✅ Optionnel - ID de l'acheteur (dans Favor Help)
      amount: number;
      currency?: string;
      description?: string;
      access_token: string;        // ✅ OBLIGATOIRE - Token FPay de l'acheteur
    },
    @Res() res: Response,
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user;   // ✅ Le marchand (API Key owner)

    try {
      // ============================================================
      // 1. VALIDATIONS DE BASE
      // ============================================================

      if (!body.access_token) {
        throw new HttpException(
          'access_token est requis pour l\'acheteur',
          HttpStatus.BAD_REQUEST
        );
      }

      if (!body.amount || body.amount <= 0) {
        throw new HttpException('Le montant doit être supérieur à 0', HttpStatus.BAD_REQUEST);
      }

      // ============================================================
      // 2. VÉRIFIER LE TOKEN FPay DE L'ACHETEUR AVEC JWT
      // ============================================================

      let fpayUserId: string;
      let decodedToken: any;

      try {
        const jwtSecret = process.env.JWT_SECRET || 'fpay-super-secret-key-2024';

        // ✅ Vérifier et décoder le JWT
        decodedToken = jwt.verify(body.access_token, jwtSecret) as any;

        if (!decodedToken || !decodedToken.id) {
          throw new Error('Token invalide - id manquant');
        }

        // ✅ Vérifier l'expiration (jwt.verify le fait déjà)
        const now = Math.floor(Date.now() / 1000);
        if (decodedToken.exp && decodedToken.exp < now) {
          throw new Error('Token expiré');
        }

        fpayUserId = decodedToken.id;
        console.log('[ExternalPay] ✅ Token JWT valide pour acheteur:', fpayUserId);

      } catch (tokenError: any) {
        console.error('[ExternalPay] ❌ Token invalide:', tokenError.message);
        throw new HttpException(
          tokenError.message === 'jwt expired'
            ? 'Token FPay expiré'
            : 'Token FPay invalide',
          HttpStatus.UNAUTHORIZED
        );
      }

      // ============================================================
      // 3. RÉCUPÉRER L'ACHETEUR
      // ============================================================

      let payer: any = null;

      // 1️⃣ Essayer de trouver l'acheteur par system_user_id (si fourni)
      if (body.system_user_id) {
        payer = await this.prisma.user.findFirst({
          where: {
            id: body.system_user_id,
            status: 'ACTIVE',
            deleted: false,
          },
          include: {
            wallets: {
              where: { isActive: true },
            },
          },
        });

        if (payer) {
          console.log('[ExternalPay] ✅ Acheteur trouvé via system_user_id:', payer.id);
        }
      }

      // 2️⃣ Si non trouvé, utiliser l'id du token (le token JWT contient l'id FPay)
      if (!payer) {
        payer = await this.prisma.user.findFirst({
          where: {
            id: fpayUserId,
            status: 'ACTIVE',
            deleted: false,
          },
          include: {
            wallets: {
              where: { isActive: true },
            },
          },
        });

        if (payer) {
          console.log('[ExternalPay] ✅ Acheteur trouvé via id du token:', payer.id);
        }
      }

      // 3️⃣ Si toujours pas trouvé, essayer par phone depuis le token
      if (!payer && decodedToken.phone) {
        payer = await this.prisma.user.findFirst({
          where: {
            phone: decodedToken.phone,
            status: 'ACTIVE',
            deleted: false,
          },
          include: {
            wallets: {
              where: { isActive: true },
            },
          },
        });

        if (payer) {
          console.log('[ExternalPay] ✅ Acheteur trouvé via phone:', payer.id);
        }
      }

      // 4️⃣ Si toujours pas trouvé, essayer par email depuis le token
      if (!payer && decodedToken.email) {
        payer = await this.prisma.user.findFirst({
          where: {
            email: decodedToken.email,
            status: 'ACTIVE',
            deleted: false,
          },
          include: {
            wallets: {
              where: { isActive: true },
            },
          },
        });

        if (payer) {
          console.log('[ExternalPay] ✅ Acheteur trouvé via email:', payer.id);
        }
      }

      if (!payer) {
        throw new HttpException(
          `Acheteur non trouvé. Vérifiez que vous avez un compte actif.`,
          HttpStatus.NOT_FOUND
        );
      }

      // ============================================================
      // 4. VÉRIFIER LE WALLET DE L'ACHETEUR
      // ============================================================

      const targetCurrency = body.currency || 'USD';
      let clientWallet = payer.wallets.find((w: any) => w.currency === targetCurrency);

      if (!clientWallet) {
        clientWallet = payer.wallets[0];
        if (!clientWallet) {
          throw new HttpException(`Aucun wallet actif trouvé pour l'acheteur`, HttpStatus.BAD_REQUEST);
        }
      }

      console.log('[ExternalPay] Wallet acheteur:', {
        walletId: clientWallet.id,
        currency: clientWallet.currency,
        balance: clientWallet.balance,
      });

      if (clientWallet.balance < body.amount) {
        throw new HttpException(
          `Solde insuffisant: ${clientWallet.balance} ${clientWallet.currency}`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // ============================================================
      // 5. VÉRIFIER LE MARCHAND (DESTINATAIRE)
      // ============================================================

      const recipient = apiKeyUser;

      if (recipient.status !== 'ACTIVE') {
        throw new HttpException(`Le marchand n'est pas actif`, HttpStatus.BAD_REQUEST);
      }

      if (payer.id === recipient.id) {
        throw new HttpException('Impossible de payer à soi-même', HttpStatus.BAD_REQUEST);
      }

      console.log('[ExternalPay] Marchand:', {
        id: recipient.id,
        phone: recipient.phone,
        merchantCode: recipient.merchantCode,
      });

      // ============================================================
      // 6. PRÉPARER LE PAYLOAD POUR pay_without_pin
      // ============================================================

      const payPayload: any = {
        fromWalletId: clientWallet.id,
        amount: body.amount,
        description: body.description || `Paiement vers ${recipient.full_name || recipient.phone}`,
        lang,
        ipAddress,
      };

      // ✅ Ajouter le destinataire (marchand)
      if (recipient.role === 'MERCHANT' && recipient.merchantCode) {
        payPayload.merchantCode = recipient.merchantCode;
        console.log('[ExternalPay] ✅ Paiement vers un marchand, code:', recipient.merchantCode);
      } else if (recipient.phone) {
        payPayload.toPhone = recipient.phone;
        console.log('[ExternalPay] ✅ Paiement vers un utilisateur, téléphone:', recipient.phone);
      } else {
        throw new HttpException('Le marchand n\'a ni téléphone ni code marchand', HttpStatus.BAD_REQUEST);
      }

      console.log('[ExternalPay] 📤 Payload envoyé:', JSON.stringify(payPayload, null, 2));

      // ============================================================
      // 7. APPELER LE SERVICE WALLET
      // ============================================================

      const response = await this.sendWalletMessage<any>(
        'pay_without_pin',
        payPayload,
        this.i18nService.translate('wallet.payment_failed', lang),
        HttpStatus.BAD_REQUEST,
        120000  // ✅ Timeout de 2 minutes
      );

      console.log('[ExternalPay] ✅ Réponse reçue du wallet:', JSON.stringify(response, null, 2));

      // ============================================================
      // 8. RETOURNER LA RÉPONSE
      // ============================================================

      return res.status(200).json({
        status: 'success',
        message: response?.message || 'Paiement effectué avec succès',
        data: response?.data || response,
        transaction: response?.data?.transaction || null,
        wallet: response?.data?.wallet || null,
      });

    } catch (error: any) {
      console.error('[ExternalPay] ❌ Erreur:', error);

      // ✅ Si c'est déjà une HttpException, la relancer
      if (error instanceof HttpException) {
        throw error;
      }

      // ✅ Sinon, créer une nouvelle HttpException
      throw new HttpException(
        {
          status: 'error',
          message: error.message || 'Erreur lors du paiement',
          code: error.code || 'PAYMENT_ERROR',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('api/external/send')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('send')
  async externalSend(
    @Request() req: any,
    @Body() body: {
      userId: string; // 🔥 userId du DESTINATAIRE (client)
      amount: number;
      description?: string;
      currency?: string;
      countryCode?: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user; // 🔥 API Key owner = PAYEUR (company)

    console.log('[ExternalSend] 📋 Utilisateur de l\'API Key (PAYEUR):', {
      id: apiKeyUser.id,
      full_name: apiKeyUser.full_name,
      phone: apiKeyUser.phone,
      merchantCode: apiKeyUser.merchantCode,
      role: apiKeyUser.role,
      status: apiKeyUser.status,
    });

    // ✅ 1. Vérifier que le payeur (API Key owner) a un téléphone
    if (!apiKeyUser.phone) {
      throw new HttpException(
        'API Key user has no phone number',
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 2. Récupérer le DESTINATAIRE (client) par son userId
    const recipient = await this.prisma.user.findFirst({
      where: {
        id: body.userId,
        status: 'ACTIVE',
        deleted: false,
      },
      include: {
        wallets: {
          where: { isActive: true },
        },
      },
    });

    if (!recipient) {
      throw new HttpException(
        `Recipient with id ${body.userId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    // ✅ 3. Récupérer le wallet du DESTINATAIRE
    const targetCurrency = body.currency || 'USD';
    let recipientWallet = recipient.wallets.find(w => w.currency === targetCurrency);

    if (!recipientWallet) {
      recipientWallet = recipient.wallets[0];
      if (!recipientWallet) {
        throw new HttpException(
          `No active wallet found for recipient ${body.userId}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      console.warn(`[ExternalSend] Wallet ${targetCurrency} not found, using ${recipientWallet.currency}`);
    }

    console.log('[ExternalSend] Wallet du destinataire trouvé:', {
      walletId: recipientWallet.id,
      currency: recipientWallet.currency,
      balance: recipientWallet.balance,
    });

    // ✅ 4. Vérifier que le payeur n'est pas le destinataire
    if (apiKeyUser.id === recipient.id) {
      throw new HttpException(
        this.i18nService.translate('wallet.cannot_transfer_self', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 5. Récupérer les wallets du PAYEUR (company)
    const payerWallets = await this.prisma.wallet.findMany({
      where: {
        userId: apiKeyUser.id,
        isActive: true,
      },
    });

    if (!payerWallets || payerWallets.length === 0) {
      throw new HttpException(
        `No active wallet found for payer ${apiKeyUser.id}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 6. Chercher le wallet du payeur dans la devise demandée
    let payerWallet = payerWallets.find(w => w.currency === targetCurrency);

    // ✅ Compte FIDÉLITÉ : le paiement passe TOUJOURS, même avec un solde à 0 ou négatif
    //    (le wallet est débité et peut devenir négatif). Comptes concernés : FPAY_OVERDRAFT_PAYER_IDS (.env).
    const overdraftPayers = String(process.env.FPAY_OVERDRAFT_PAYER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allowOverdraft = overdraftPayers.includes(apiKeyUser.id);
    if (allowOverdraft) {
      payerWallet = payerWallet ?? payerWallets[0];
      console.log(`[ExternalSend] 🎁 Compte autorisé en négatif (${apiKeyUser.id}) : wallet ${payerWallet.currency}, solde ${payerWallet.balance}`);
    }

    // ✅ 7. Si pas assez de solde ou pas de wallet dans cette devise, chercher un autre wallet avec assez de solde
    if (allowOverdraft) {
      // pas de contrôle de solde : le wallet sera débité même s'il devient négatif
      payerWallet = payerWallet ?? payerWallets[0];
    } else if (payerWallet) {
      if (payerWallet.balance < body.amount) {
        console.log(`[ExternalSend] Solde insuffisant en ${targetCurrency} (${payerWallet.balance}), recherche d'un autre wallet...`);

        // Chercher un autre wallet avec assez de solde
        const otherWallet = payerWallets.find(w =>
          w.currency !== targetCurrency &&
          w.balance >= body.amount
        );

        if (otherWallet) {
          payerWallet = otherWallet;
          console.log(`[ExternalSend] Wallet trouvé en ${payerWallet.currency} avec ${payerWallet.balance} ${payerWallet.currency}`);
        } else {
          // Aucun wallet avec assez de solde
          throw new HttpException(
            `Insufficient balance: ${payerWallet.balance} ${payerWallet.currency}. You have ${payerWallets.map(w => `${w.balance} ${w.currency}`).join(', ')}`,
            HttpStatus.BAD_REQUEST,
          );
        }
      }
    } else {
      // ✅ 8. Si pas de wallet dans la devise demandée, prendre le premier avec assez de solde
      console.log(`[ExternalSend] Aucun wallet en ${targetCurrency}, recherche d'un autre wallet...`);

      const availableWallet = payerWallets.find(w => w.balance >= body.amount);

      if (availableWallet) {
        payerWallet = availableWallet;
        console.log(`[ExternalSend] Wallet trouvé en ${payerWallet.currency} avec ${payerWallet.balance} ${payerWallet.currency}`);
      } else {
        // Aucun wallet avec assez de solde
        const balances = payerWallets.map(w => `${w.balance} ${w.currency}`).join(', ');
        throw new HttpException(
          `Insufficient balance in any wallet. Available balances: ${balances}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    console.log('[ExternalSend] Wallet du payeur sélectionné:', {
      walletId: payerWallet.id,
      currency: payerWallet.currency,
      balance: payerWallet.balance,
    });

    // ✅ 9. Préparer les données pour le service wallet
    const sendPayload: any = {
      fromWalletId: payerWallet.id,
      toPhone: recipient.phone,
      amount: body.amount,
      description: body.description || `Envoi de fidélité vers ${recipient.full_name || recipient.phone}`,
      countryCode: body.countryCode,
      lang,
      ipAddress,
    };

    console.log('[ExternalSend] 📤 Payload envoyé au service wallet:', sendPayload);

    // ✅ 10. Appeler le service wallet
    const response = await this.sendWalletMessage(
      'send_fidelity',
      sendPayload,
      this.i18nService.translate('wallet.transfer_failed', lang),
      HttpStatus.BAD_REQUEST,
    );

    // ✅ 11. Log de l'opération
    await this.prisma.audit_log.create({
      data: {
        id: crypto.randomUUID(),
        userId: apiKeyUser.id,
        action: 'EXTERNAL_SEND_FIDELITY',
        details: JSON.stringify({
          payerId: apiKeyUser.id,
          payerPhone: apiKeyUser.phone,
          recipientId: recipient.id,
          recipientPhone: recipient.phone,
          amount: body.amount,
          currency: body.currency,
          apiKeyId: apiKeyUser.id,
          description: body.description,
          countryCode: body.countryCode,
          selectedWalletCurrency: payerWallet.currency,
        }),
        ipAddress: ipAddress || null,
        createdAt: new Date(),
      },
    });

    return response;
  }

  @Post('api/external/salary')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('send')
  async externalSendSalary(
    @Request() req: any,
    @Body() body: {
      phone: string;         // 🔥 TÉLÉPHONE du DESTINATAIRE (employé)
      amount: number;
      description?: string;
      currency?: string;
      countryCode?: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user; // 🔥 API Key owner = PAYEUR (company)

    console.log('[ExternalSendSalary] 📋 Utilisateur de l\'API Key (PAYEUR):', {
      id: apiKeyUser.id,
      full_name: apiKeyUser.full_name,
      phone: apiKeyUser.phone,
      merchantCode: apiKeyUser.merchantCode,
      role: apiKeyUser.role,
      status: apiKeyUser.status,
    });

    // ✅ 1. Vérifier que le payeur (API Key owner) a un téléphone
    if (!apiKeyUser.phone) {
      throw new HttpException(
        'API Key user has no phone number',
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 2. Vérifier que le phone du destinataire est fourni
    if (!body.phone || body.phone.trim() === '') {
      throw new HttpException(
        'Recipient phone is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 3. Nettoyer le phone
    const cleanToPhone = body.phone.replace(/[^0-9+]/g, '');

    // ✅ 4. Récupérer le DESTINATAIRE (employé) par son PHONE
    const recipient = await this.prisma.user.findFirst({
      where: {
        phone: {
          in: [
            cleanToPhone,
            body.phone,
            `+${cleanToPhone.replace(/^\+/, '')}`
          ]
        },
        status: 'ACTIVE',
        deleted: false,
      },
      include: {
        wallets: {
          where: { isActive: true },
        },
      },
    });

    if (!recipient) {
      throw new HttpException(
        `Recipient with phone ${body.phone} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    // ✅ 5. Récupérer le wallet du DESTINATAIRE
    const targetCurrency = body.currency || 'USD';
    let recipientWallet = recipient.wallets.find(w => w.currency === targetCurrency);

    if (!recipientWallet) {
      recipientWallet = recipient.wallets[0];
      if (!recipientWallet) {
        throw new HttpException(
          `No active wallet found for recipient ${body.phone}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      console.warn(`[ExternalSendSalary] Wallet ${targetCurrency} not found, using ${recipientWallet.currency}`);
    }

    console.log('[ExternalSendSalary] Wallet du destinataire trouvé:', {
      walletId: recipientWallet.id,
      currency: recipientWallet.currency,
      balance: recipientWallet.balance,
    });

    // ✅ 6. Vérifier que le payeur n'est pas le destinataire
    if (apiKeyUser.id === recipient.id) {
      throw new HttpException(
        this.i18nService.translate('wallet.cannot_transfer_self', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 7. Récupérer les wallets du PAYEUR (company)
    const payerWallets = await this.prisma.wallet.findMany({
      where: {
        userId: apiKeyUser.id,
        isActive: true,
      },
    });

    if (!payerWallets || payerWallets.length === 0) {
      throw new HttpException(
        `No active wallet found for payer ${apiKeyUser.id}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 8. Chercher le wallet du payeur dans la devise demandée
    let payerWallet = payerWallets.find(w => w.currency === targetCurrency);

    // ✅ 9. Si pas assez de solde ou pas de wallet dans cette devise, chercher un autre wallet avec assez de solde
    if (payerWallet) {
      if (payerWallet.balance < body.amount) {
        console.log(`[ExternalSendSalary] Solde insuffisant en ${targetCurrency} (${payerWallet.balance}), recherche d'un autre wallet...`);

        const otherWallet = payerWallets.find(w =>
          w.currency !== targetCurrency &&
          w.balance >= body.amount
        );

        if (otherWallet) {
          payerWallet = otherWallet;
          console.log(`[ExternalSendSalary] Wallet trouvé en ${payerWallet.currency} avec ${payerWallet.balance} ${payerWallet.currency}`);
        } else {
          throw new HttpException(
            `Insufficient balance: ${payerWallet.balance} ${payerWallet.currency}. You have ${payerWallets.map(w => `${w.balance} ${w.currency}`).join(', ')}`,
            HttpStatus.BAD_REQUEST,
          );
        }
      }
    } else {
      // ✅ 10. Si pas de wallet dans la devise demandée, prendre le premier avec assez de solde
      console.log(`[ExternalSendSalary] Aucun wallet en ${targetCurrency}, recherche d'un autre wallet...`);

      const availableWallet = payerWallets.find(w => w.balance >= body.amount);

      if (availableWallet) {
        payerWallet = availableWallet;
        console.log(`[ExternalSendSalary] Wallet trouvé en ${payerWallet.currency} avec ${payerWallet.balance} ${payerWallet.currency}`);
      } else {
        const balances = payerWallets.map(w => `${w.balance} ${w.currency}`).join(', ');
        throw new HttpException(
          `Insufficient balance in any wallet. Available balances: ${balances}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    console.log('[ExternalSendSalary] Wallet du payeur sélectionné:', {
      walletId: payerWallet.id,
      currency: payerWallet.currency,
      balance: payerWallet.balance,
    });

    // ✅ 11. Préparer les données pour le service wallet
    const sendPayload: any = {
      fromWalletId: payerWallet.id,
      toPhone: recipient.phone,   // ✅ phone du destinataire trouvé
      amount: body.amount,
      description: body.description || `Paiement de salaire vers ${recipient.full_name || recipient.phone}`,
      countryCode: body.countryCode,
      lang,
      ipAddress,
    };

    console.log('[ExternalSendSalary] 📤 Payload envoyé au service wallet:', sendPayload);

    // ✅ 12. Appeler le service wallet
    const response = await this.sendWalletMessage(
      'send_salary',
      sendPayload,
      this.i18nService.translate('wallet.transfer_failed', lang),
      HttpStatus.BAD_REQUEST,
    );

    // ✅ 13. Log de l'opération
    await this.prisma.audit_log.create({
      data: {
        id: crypto.randomUUID(),
        userId: apiKeyUser.id,
        action: 'EXTERNAL_SEND_SALARY',
        details: JSON.stringify({
          payerId: apiKeyUser.id,
          payerPhone: apiKeyUser.phone,
          recipientId: recipient.id,
          recipientPhone: recipient.phone,
          amount: body.amount,
          currency: body.currency,
          apiKeyId: apiKeyUser.id,
          description: body.description,
          countryCode: body.countryCode,
          selectedWalletCurrency: payerWallet.currency,
        }),
        ipAddress: ipAddress || null,
        createdAt: new Date(),
      },
    });

    return response;
  }

  @Post('api/external/send/parrainage')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('send_parrainage')
  async externalSendParrainage(
    @Request() req: any,
    @Body() body: {
      amount: number;
      description?: string;
      currency?: string;
      countryCode?: string;
      paymentMethod?: string;
      toApiKey?: string;  // ✅ API Key du destinataire
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user; // 🔥 API Key owner = PAYEUR (expéditeur)

    console.log('[ExternalSendParrainage] 📋 Utilisateur de l\'API Key (PAYEUR):', {
      id: apiKeyUser.id,
      full_name: apiKeyUser.full_name,
      phone: apiKeyUser.phone,
      merchantCode: apiKeyUser.merchantCode,
      role: apiKeyUser.role,
      status: apiKeyUser.status,
    });

    // ✅ 1. Vérifier que le payeur (API Key owner) existe et est valide
    if (!apiKeyUser) {
      throw new HttpException(
        'Utilisateur API Key non trouvé',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (!apiKeyUser.phone) {
      throw new HttpException(
        'API Key user has no phone number',
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 2. Vérifier que le payeur est un marchand
    if (apiKeyUser.role !== 'MERCHANT') {
      throw new HttpException(
        'Seuls les marchands peuvent envoyer des parrainages',
        HttpStatus.FORBIDDEN,
      );
    }

    if (apiKeyUser.status === 'BLOCKED') {
      throw new HttpException(
        'Le compte de l\'expéditeur est bloqué',
        HttpStatus.FORBIDDEN,
      );
    }

    // ✅ 3. VÉRIFIER le paymentMethod (optionnel)
    const validPaymentMethods = ['MOBILE_MONEY', 'CASH', 'BANK_TRANSFER', 'CARD'];
    const paymentMethod = body.paymentMethod || 'MOBILE_MONEY';

    if (!validPaymentMethods.includes(paymentMethod)) {
      throw new HttpException(
        `paymentMethod invalide. Valeurs acceptées: ${validPaymentMethods.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 4. Déterminer la devise
    const targetCurrency = body.currency || 'USD';

    // ✅ 5. Récupérer le wallet du PAYEUR (expéditeur) dans la devise demandée
    const payerWallets = await this.prisma.wallet.findMany({
      where: {
        userId: apiKeyUser.id,
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            phone: true,
            role: true,
            status: true,
            countryCode: true,
            kycStatus: true,
            merchantType: true,
          }
        }
      },
    });

    if (!payerWallets || payerWallets.length === 0) {
      throw new HttpException(
        `Aucun wallet actif trouvé pour l'expéditeur`,
        HttpStatus.NOT_FOUND,
      );
    }

    // ✅ Chercher le wallet du payeur dans la devise demandée
    let payerWallet = payerWallets.find(w => w.currency === targetCurrency);

    // ✅ Si pas de wallet dans cette devise, prendre le premier wallet actif
    if (!payerWallet) {
      payerWallet = payerWallets[0];
      console.warn(`[ExternalSendParrainage] Aucun wallet en ${targetCurrency}, utilisation du wallet en ${payerWallet.currency}`);
    }

    console.log('[ExternalSendParrainage] Wallet du payeur sélectionné:', {
      walletId: payerWallet.id,
      currency: payerWallet.currency,
      balance: payerWallet.balance,
      user: payerWallet.user?.full_name,
    });

    // ✅ Vérifier le solde du payeur
    if (payerWallet.balance < body.amount) {
      throw new HttpException(
        `Solde insuffisant. Solde actuel: ${payerWallet.balance} ${payerWallet.currency}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 6. Récupérer le DESTINATAIRE via son API Key
    if (!body.toApiKey) {
      throw new HttpException(
        'L\'API Key du destinataire est requise',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Récupérer l'utilisateur via l'API Key du destinataire
    const recipientApiKey = await this.prisma.api_key.findFirst({
      where: {
        key: body.toApiKey,
        isActive: true,
      },
      include: {
        user: {
          include: {
            wallets: {
              where: { isActive: true },
            },
          },
        },
      },
    });

    if (!recipientApiKey) {
      throw new HttpException(
        'API Key du destinataire invalide ou inactive',
        HttpStatus.NOT_FOUND,
      );
    }

    // ✅ Vérifier que l'API Key a un utilisateur associé
    if (!recipientApiKey.user) {
      throw new HttpException(
        'Aucun utilisateur associé à l\'API Key du destinataire',
        HttpStatus.NOT_FOUND,
      );
    }

    const recipientUser = recipientApiKey.user;

    // ✅ Vérifier que le destinataire est un marchand
    if (recipientUser.role !== 'MERCHANT') {
      throw new HttpException(
        'Seuls les marchands peuvent recevoir des parrainages',
        HttpStatus.FORBIDDEN,
      );
    }

    if (recipientUser.status === 'BLOCKED') {
      throw new HttpException(
        'Le compte du destinataire est bloqué',
        HttpStatus.FORBIDDEN,
      );
    }

    // ✅ Récupérer le wallet du destinataire dans la même devise
    let recipientWallet = recipientUser.wallets.find(w => w.currency === targetCurrency);

    // ✅ Si pas de wallet dans cette devise, prendre le premier wallet actif
    if (!recipientWallet) {
      recipientWallet = recipientUser.wallets[0];
      if (!recipientWallet) {
        throw new HttpException(
          `Aucun wallet actif trouvé pour le destinataire`,
          HttpStatus.NOT_FOUND,
        );
      }
      console.warn(`[ExternalSendParrainage] Aucun wallet en ${targetCurrency} pour le destinataire, utilisation du wallet en ${recipientWallet.currency}`);
    }

    console.log('[ExternalSendParrainage] Destinataire via API Key:', {
      id: recipientUser.id,
      full_name: recipientUser.full_name,
      phone: recipientUser.phone,
      walletId: recipientWallet.id,
      currency: recipientWallet.currency,
    });

    // ✅ 7. Vérifier que l'expéditeur et le destinataire sont différents
    if (apiKeyUser.id === recipientUser.id) {
      throw new HttpException(
        'Vous ne pouvez pas vous envoyer de parrainage à vous-même',
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ 8. Préparer les données pour le service wallet
    const sendPayload: any = {
      fromWalletId: payerWallet.id,
      toWalletId: recipientWallet.id,
      amount: body.amount,
      description: body.description || `Envoi de parrainage vers ${recipientUser.full_name || recipientUser.phone}`,
      countryCode: body.countryCode || recipientUser.countryCode || 'CD',
      paymentMethod: paymentMethod,
      lang,
      ipAddress,
    };

    console.log('[ExternalSendParrainage] 📤 Payload envoyé au service wallet:', {
      fromWalletId: sendPayload.fromWalletId,
      toWalletId: sendPayload.toWalletId,
      fromUser: apiKeyUser.full_name,
      toUser: recipientUser.full_name,
      amount: sendPayload.amount,
      currency: targetCurrency,
      paymentMethod: sendPayload.paymentMethod,
    });

    // ✅ 9. Appeler le service wallet avec 'send_parrainage'
    const response = await this.sendWalletMessage(
      'send_parrainage',
      sendPayload,
      this.i18nService.translate('wallet.parrainage_failed', lang),
      HttpStatus.BAD_REQUEST,
    );

    // ✅ 10. Log de l'opération
    await this.prisma.audit_log.create({
      data: {
        id: crypto.randomUUID(),
        userId: apiKeyUser.id,
        action: 'EXTERNAL_SEND_PARRAINAGE',
        details: JSON.stringify({
          payerId: apiKeyUser.id,
          payerPhone: apiKeyUser.phone,
          payerWalletId: payerWallet.id,
          payerWalletCurrency: payerWallet.currency,
          recipientId: recipientUser.id,
          recipientPhone: recipientUser.phone,
          recipientWalletId: recipientWallet.id,
          recipientWalletCurrency: recipientWallet.currency,
          amount: body.amount,
          currency: targetCurrency,
          description: body.description,
          countryCode: body.countryCode,
          paymentMethod: paymentMethod,
        }),
        ipAddress: ipAddress || null,
        createdAt: new Date(),
      },
    });

    return response;
  }

  @Post('api/external/send/taxi')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('send_taxi')
  async externalSendTaxi(
    @Request() req: any,
    @Body() body: {
      amount: number;
      description?: string;
      currency?: string;
      countryCode?: string;
      paymentMethod?: string;
      toApiKey?: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user;

    console.log('[ExternalSendTaxi] 📋 Utilisateur de l\'API Key (PAYEUR):', {
      id: apiKeyUser.id,
      full_name: apiKeyUser.full_name,
      phone: apiKeyUser.phone,
      merchantCode: apiKeyUser.merchantCode,
      role: apiKeyUser.role,
      status: apiKeyUser.status,
    });

    if (!apiKeyUser) {
      throw new HttpException('Utilisateur API Key non trouvé', HttpStatus.UNAUTHORIZED);
    }

    if (!apiKeyUser.phone) {
      throw new HttpException('API Key user has no phone number', HttpStatus.BAD_REQUEST);
    }

    if (apiKeyUser.role !== 'MERCHANT') {
      throw new HttpException('Seuls les marchands peuvent payer des courses taxi', HttpStatus.FORBIDDEN);
    }

    if (apiKeyUser.status === 'BLOCKED') {
      throw new HttpException('Le compte de l\'expéditeur est bloqué', HttpStatus.FORBIDDEN);
    }

    const validPaymentMethods = ['MOBILE_MONEY', 'CASH', 'BANK_TRANSFER', 'CARD'];
    const paymentMethod = body.paymentMethod || 'MOBILE_MONEY';

    if (!validPaymentMethods.includes(paymentMethod)) {
      throw new HttpException(
        `paymentMethod invalide. Valeurs acceptées: ${validPaymentMethods.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const targetCurrency = body.currency || 'USD';

    const payerWallets = await this.prisma.wallet.findMany({
      where: { userId: apiKeyUser.id, isActive: true },
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            phone: true,
            role: true,
            status: true,
            countryCode: true,
            kycStatus: true,
            merchantType: true,
          },
        },
      },
    });

    if (!payerWallets || payerWallets.length === 0) {
      throw new HttpException(
        `Aucun wallet actif trouvé pour l'expéditeur`,
        HttpStatus.NOT_FOUND,
      );
    }

    let payerWallet = payerWallets.find((w) => w.currency === targetCurrency);

    if (!payerWallet) {
      payerWallet = payerWallets[0];
      console.warn(`[ExternalSendTaxi] Aucun wallet en ${targetCurrency}, utilisation du wallet en ${payerWallet.currency}`);
    }

    console.log('[ExternalSendTaxi] Wallet du payeur sélectionné:', {
      walletId: payerWallet.id,
      currency: payerWallet.currency,
      balance: payerWallet.balance,
      user: payerWallet.user?.full_name,
    });

    if (payerWallet.balance < body.amount) {
      throw new HttpException(
        `Solde insuffisant. Solde actuel: ${payerWallet.balance} ${payerWallet.currency}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.toApiKey) {
      throw new HttpException('L\'API Key du chauffeur est requise', HttpStatus.BAD_REQUEST);
    }

    const recipientApiKey = await this.prisma.api_key.findFirst({
      where: { key: body.toApiKey, isActive: true },
      include: {
        user: {
          include: {
            wallets: { where: { isActive: true } },
          },
        },
      },
    });

    if (!recipientApiKey) {
      throw new HttpException('API Key du chauffeur invalide ou inactive', HttpStatus.NOT_FOUND);
    }

    if (!recipientApiKey.user) {
      throw new HttpException('Aucun utilisateur associé à l\'API Key du chauffeur', HttpStatus.NOT_FOUND);
    }

    const recipientUser = recipientApiKey.user;

    if (recipientUser.role !== 'MERCHANT') {
      throw new HttpException('Seuls les marchands peuvent recevoir des paiements taxi', HttpStatus.FORBIDDEN);
    }

    if (recipientUser.status === 'BLOCKED') {
      throw new HttpException('Le compte du chauffeur est bloqué', HttpStatus.FORBIDDEN);
    }

    let recipientWallet = recipientUser.wallets.find((w) => w.currency === targetCurrency);

    if (!recipientWallet) {
      recipientWallet = recipientUser.wallets[0];
      if (!recipientWallet) {
        throw new HttpException(`Aucun wallet actif trouvé pour le chauffeur`, HttpStatus.NOT_FOUND);
      }
      console.warn(`[ExternalSendTaxi] Aucun wallet en ${targetCurrency} pour le chauffeur, utilisation du wallet en ${recipientWallet.currency}`);
    }

    console.log('[ExternalSendTaxi] Chauffeur via API Key:', {
      id: recipientUser.id,
      full_name: recipientUser.full_name,
      phone: recipientUser.phone,
      walletId: recipientWallet.id,
      currency: recipientWallet.currency,
    });

    if (apiKeyUser.id === recipientUser.id) {
      throw new HttpException('Vous ne pouvez pas vous payer vous-même', HttpStatus.BAD_REQUEST);
    }

    const sendPayload: any = {
      fromWalletId: payerWallet.id,
      toWalletId: recipientWallet.id,
      amount: body.amount,
      description: body.description || `Paiement taxi vers ${recipientUser.full_name || recipientUser.phone}`,
      countryCode: body.countryCode || recipientUser.countryCode || 'CD',
      paymentMethod: paymentMethod,
      lang,
      ipAddress,
    };

    console.log('[ExternalSendTaxi] 📤 Payload envoyé au service wallet:', {
      fromWalletId: sendPayload.fromWalletId,
      toWalletId: sendPayload.toWalletId,
      fromUser: apiKeyUser.full_name,
      toUser: recipientUser.full_name,
      amount: sendPayload.amount,
      currency: targetCurrency,
      paymentMethod: sendPayload.paymentMethod,
    });

    const response = await this.sendWalletMessage(
      'send_taxi',
      sendPayload,
      this.i18nService.translate('wallet.taxi_payment_failed', lang),
      HttpStatus.BAD_REQUEST,
    );

    await this.prisma.audit_log.create({
      data: {
        id: crypto.randomUUID(),
        userId: apiKeyUser.id,
        action: 'EXTERNAL_SEND_TAXI',
        details: JSON.stringify({
          payerId: apiKeyUser.id,
          payerPhone: apiKeyUser.phone,
          payerWalletId: payerWallet.id,
          payerWalletCurrency: payerWallet.currency,
          recipientId: recipientUser.id,
          recipientPhone: recipientUser.phone,
          recipientWalletId: recipientWallet.id,
          recipientWalletCurrency: recipientWallet.currency,
          amount: body.amount,
          currency: targetCurrency,
          description: body.description,
          countryCode: body.countryCode,
          paymentMethod: paymentMethod,
        }),
        ipAddress: ipAddress || null,
        createdAt: new Date(),
      },
    });

    return response;
  }

  @Post('api/external/pay/mobile_money')
  @UseGuards(ApiKeyGuard)  //  Utiliser ApiKeyGuard au lieu de JwtAuthGuard
  @PermissionsApi_Key('pay')  //  Permission requise
  async payAccount(
    @Request() req: any,  // ✅ Récupérer l'utilisateur de l'API Key
    @Body() body: {
      amount: number;
      currency?: string;
      description?: string;
      paymentMethod?: string;
      /** ✅ Identifiant du dépôt Mobile Money chez l'intégrateur : un même dépôt ne crédite qu'une fois */
      externalReference?: string;
      depositId?: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user;  // ✅ Utilisateur lié à l'API Key

    // ✅ Vérifier que l'utilisateur existe via l'API Key
    if (!apiKeyUser) {
      throw new HttpException(
        'API Key invalide ou utilisateur non trouvé',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // ✅ Vérifier que l'utilisateur est actif
    if (apiKeyUser.status !== 'ACTIVE') {
      throw new HttpException(
        'L\'utilisateur n\'est pas actif',
        HttpStatus.FORBIDDEN,
      );
    }

    console.log('[PayAccount] API Key user:', {
      id: apiKeyUser.id,
      full_name: apiKeyUser.full_name,
      phone: apiKeyUser.phone,
      role: apiKeyUser.role,
    });

    // ✅ Vérifier le montant
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(
        'Le montant doit être supérieur à 0',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.sendWalletMessage(
      'pay_account',
      {
        userId: apiKeyUser.id,  // ✅ Le userId est celui de l'API Key
        amount: body.amount,
        currency: body.currency || 'CDF',
        description: body.description || `Paiement via API Key`,
        paymentMethod: body.paymentMethod || 'MOBILE_MONEY',
        ipAddress,
        lang,
        externalReference: body.externalReference || body.depositId || null,
      },
      this.i18nService.translate('wallet.payment_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  // ============================================================
  // 1. AUTH / OTP / LINK-USER FPAY (CORRIGÉ)
  // ============================================================

  @Post('auth/fpay/link-user')
  async linkFpayUser(
    @Body() body: {
      phone: string;
      password: string;
      otpCode?: string;
      clientId?: string;
      lang?: string;
      autoOpen?: boolean;
    },
    @Ip() ipAddress: string,
    @Res() res: Response,
  ) {
    // ✅ Si phone et password ne sont pas fournis → Retourner l'URL
    if (!body || !body.phone || !body.password) {
      const clientId = body?.clientId || 'web-client';
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      const authCode = crypto.randomBytes(32).toString('hex');

      const redirectUrl = new URL('/oauth/login', appUrl);
      redirectUrl.searchParams.set('client_id', clientId);
      redirectUrl.searchParams.set('code', authCode);
      redirectUrl.searchParams.set('redirect_uri', `${appUrl}/oauth/callback`);

      console.log('[FPay OAuth] URL de la page:', redirectUrl.toString());

      return res.json({
        status: 'success',
        message: 'Page OAuth FPay',
        url: redirectUrl.toString(),
        openInBrowser: redirectUrl.toString()
      });
    }

    // ✅ Traitement de la connexion avec OTP
    const lang = body.lang || 'fr';
    const clientId = body.clientId || 'web-client';
    const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/oauth/callback`;
    const hasOtp = body.otpCode && body.otpCode.trim() !== '';

    console.log('[FPay Link User] Traitement pour:', body.phone);
    console.log('[FPay Link User] OTP fourni:', hasOtp ? '✅' : '❌');

    try {
      // ✅ Construction du payload avec OTP si présent
      const payload: any = {
        phone: body.phone,
        password: body.password,
        clientId: clientId,
        redirectUri: redirectUri,
        lang,
        ipAddress,
      };

      if (hasOtp) {
        payload.otpCode = body.otpCode;
        console.log('[FPay Link User] 🔐 Vérification OTP:', body.otpCode);
      }

      // ✅ Utiliser le pattern 'link_user' qui existe déjà
      const result = await this.sendAuthMessage<FpayAuthResponse>(
        'link_user',  // ← Pattern EXISTANT
        payload,
        'Login failed',
        HttpStatus.BAD_REQUEST,
      ) as FpayAuthResponse;  // ← CAST EXPLICITE

      // ✅ Vérifier si un OTP est requis (première étape)
      if (result.requiresOtp === true) {
        console.log('[FPay Link User] 📱 OTP requis pour:', body.phone);
        return res.json({
          status: 'success',
          message: 'Code OTP envoyé avec succès',
          requiresOtp: true,
          phone: body.phone,
          data: null
        });
      }

      // ✅ Connexion réussie avec OTP vérifié
      console.log('[FPay Link User] ✅ Connexion réussie pour:', body.phone);

      return res.json({
        status: 'success',
        message: 'Connexion FPay réussie',
        data: result.data || null,
        accessToken: result.accessToken || null,
        refreshToken: result.refreshToken || null,
        sessionId: result.sessionId || null,
        oauthRedirectUrl: result.oauthRedirectUrl || null,
        requiresOtp: false,
        isLinked: true
      });

    } catch (error) {
      console.error('[FPay Link User] Erreur:', error);
      return res.status(400).json({
        status: 'error',
        message: error.message || 'Erreur de connexion FPay'
      });
    }
  }
  // ============================================================
  // 2. ENDPOINT SPÉCIFIQUE POUR L'ENVOI D'OTP
  // ============================================================

  @Post('auth/send-otp')
  async sendOtp(
    @Body() body: {
      phone: string;
      password?: string;
      clientId?: string;
      lang?: string;
    },
    @Ip() ipAddress: string,
    @Res() res: Response,
  ) {
    if (!body || !body.phone) {
      return res.status(400).json({
        status: 'error',
        message: 'Le numéro de téléphone est requis'
      });
    }

    const lang = body.lang || 'fr';
    const clientId = body.clientId || 'web-client';
    const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/oauth/callback`;

    console.log('[Send OTP] Demande d\'envoi OTP pour:', body.phone);

    try {
      // ✅ Appel au service FPay pour envoyer l'OTP
      const result = await this.sendAuthMessage(
        'send_otp',
        {
          phone: body.phone,
          password: body.password || '',
          clientId: clientId,
          redirectUri: redirectUri,
          lang,
          ipAddress,
        },
        'Erreur lors de l\'envoi de l\'OTP',
        HttpStatus.BAD_REQUEST,
      );

      console.log('[Send OTP] ✅ OTP envoyé avec succès à:', body.phone);

      return res.json({
        status: 'success',
        message: 'Code OTP envoyé avec succès',
        phone: body.phone,
        requiresOtp: true,
        data: null
      });

    } catch (error) {
      console.error('[Send OTP] Erreur:', error);
      return res.status(400).json({
        status: 'error',
        message: error.message || 'Erreur lors de l\'envoi de l\'OTP'
      });
    }
  }
  // ============================================================
  // ROUTE AUTH/LINK-USER (FONCTIONNE AVEC sendAuthMessage)
  // ============================================================
  @Post('auth/link-user')
  async linkUser(
    @Body() body: {
      access_token: string;
      refresh_token?: string;
      system_user_id: string;
      clientId?: string;
      redirectUri?: string;
      lang?: string;
    },
    @Res() res: Response,
  ) {
    try {
      const { access_token, refresh_token, system_user_id } = body;

      if (!access_token) {
        return res.status(400).json({
          success: false,
          message: 'access_token est requis pour la liaison'
        });
      }

      if (!system_user_id) {
        return res.status(400).json({
          success: false,
          message: 'system_user_id est requis pour la liaison'
        });
      }

      // ✅ VÉRIFIER LE TOKEN DIRECTEMENT AVEC JWT
      let fpayUserId: string;
      let decodedToken: any;

      try {
        const jwtSecret = process.env.JWT_SECRET || 'fpay-super-secret-key-2024';

        // ✅ Vérifier et décoder le JWT
        decodedToken = jwt.verify(access_token, jwtSecret) as any;

        if (!decodedToken || !decodedToken.id) {
          throw new Error('Token invalide - id manquant');
        }

        fpayUserId = decodedToken.id;
        console.log(`[LinkUser] ✅ Token JWT vérifié, fpayUserId: ${fpayUserId}`);

        // ✅ Vérifier l'expiration (jwt.verify le fait déjà)
        const now = Math.floor(Date.now() / 1000);
        if (decodedToken.exp && decodedToken.exp < now) {
          throw new Error('Token expiré');
        }

      } catch (jwtError) {
        console.error('[LinkUser] ❌ Erreur vérification JWT:', jwtError.message);
        return res.status(401).json({
          success: false,
          message: jwtError.message === 'jwt expired'
            ? 'Token FPay expiré'
            : 'Token FPay invalide'
        });
      }

      // ✅ ENREGISTRER LE TOKEN DANS oauthaccesstoken
      try {
        let expiresAt: Date;
        if (decodedToken && decodedToken.exp) {
          expiresAt = new Date(decodedToken.exp * 1000);
        } else {
          expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        }

        // Vérifier si le token existe déjà
        const existingToken = await this.prisma.oauthaccesstoken.findFirst({
          where: { token: access_token },
        });

        if (!existingToken) {
          await this.prisma.oauthaccesstoken.create({
            data: {
              id: crypto.randomUUID(),  // ← AJOUTER CECI
              token: access_token,
              clientId: body.clientId || 'oauth-link',
              userId: fpayUserId,
              scope: 'all',
              expiresAt: expiresAt,
              createdAt: new Date(),
            },
          });
          console.log(`[LinkUser] ✅ Token enregistré dans oauthaccesstoken pour l'utilisateur ${fpayUserId}`);
        } else {
          console.log(`[LinkUser] ⏳ Token déjà existant, mise à jour de l'expiration`);
          await this.prisma.oauthaccesstoken.update({
            where: { id: existingToken.id },
            data: { expiresAt: expiresAt },
          });
        }
      } catch (dbError) {
        console.error('[LinkUser] ❌ Erreur lors de l\'enregistrement du token:', dbError.message);
        // On continue même si l'enregistrement échoue
      }

      // ✅ Lier les comptes dans Favor Help
      const favorHelpUrl = process.env.FAVOR_HELP_API_URL || 'https://api.favorhelp.com/api/v1';

      const linkUserResponse = await fetch(`${favorHelpUrl}/fpay/link-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemUserId: system_user_id,
          fpayUserId: fpayUserId,
          accessToken: access_token,
          refreshToken: refresh_token || null,
        }),
      });

      if (!linkUserResponse.ok) {
        const errorData = await linkUserResponse.json();
        throw new Error(errorData.message || 'Erreur lors de la liaison');
      }

      const linkData = await linkUserResponse.json();

      return res.status(200).json({
        success: true,
        message: 'Compte lié avec succès',
        data: {
          systemUserId: system_user_id,
          fpayUserId: fpayUserId,
          isLinked: true,
          ...linkData,
        }
      });

    } catch (error) {
      console.error('[LinkUser] ❌ Erreur:', error.message);
      return res.status(500).json({
        success: false,
        message: error.message || 'Erreur lors de la liaison'
      });
    }
  }
  // ============================================================
  // 3. ENDPOINT SPÉCIFIQUE POUR LA VÉRIFICATION OTP FPAY
  // ============================================================

  @Post('auth/fpay/verify-otp')
  async verifyFpayOtp(
    @Body() body: {
      phone: string;
      password: string;
      otpCode: string;
      clientId?: string;
      lang?: string;
    },
    @Ip() ipAddress: string,
    @Res() res: Response,
  ) {
    // ✅ 1. Validation des champs
    if (!body || !body.phone || !body.password || !body.otpCode) {
      return res.status(400).json({
        status: 'error',
        message: 'Tous les champs sont requis (phone, password, otpCode)'
      });
    }

    const lang = body.lang || 'fr';
    const clientId = body.clientId || 'web-client';
    const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/oauth/callback`;

    console.log('[FPay Verify OTP] Vérification OTP pour:', body.phone);
    console.log('[FPay Verify OTP] Code:', body.otpCode);

    try {
      // ✅ 2. Utiliser le pattern 'link_user' avec OTP (existant)
      const result = await this.sendAuthMessage<FpayAuthResponse>(
        'link_user',  // ← Pattern EXISTANT
        {
          phone: body.phone,
          password: body.password,
          otpCode: body.otpCode,
          clientId: clientId,
          redirectUri: redirectUri,
          lang,
          ipAddress,
        },
        'Code OTP invalide',
        HttpStatus.BAD_REQUEST,
      ) as FpayAuthResponse;  // ← CAST EXPLICITE

      console.log('[FPay Verify OTP] ✅ OTP vérifié avec succès pour:', body.phone);

      // ✅ 3. Retourner la réponse
      return res.json({
        status: 'success',
        message: 'Connexion FPay réussie',
        data: result.data || null,
        accessToken: result.accessToken || null,
        refreshToken: result.refreshToken || null,
        sessionId: result.sessionId || null,
        requiresOtp: false,
        isLinked: true
      });

    } catch (error) {
      console.error('[FPay Verify OTP] Erreur:', error);
      return res.status(400).json({
        status: 'error',
        message: error.message || 'Code OTP invalide ou expiré'
      });
    }
  }

  // ============================================================
  // 2. ENDPOINT SPÉCIFIQUE POUR L'ENVOI D'OTP FPAY
  // ============================================================

  @Post('auth/fpay/send-otp')
  async sendFpayOtp(
    @Body() body: {
      phone: string;
      password: string;
      clientId?: string;
      lang?: string;
    },
    @Ip() ipAddress: string,
    @Res() res: Response,
  ) {
    // ✅ 1. Validation
    if (!body || !body.phone) {
      return res.status(400).json({
        status: 'error',
        message: 'Le numéro de téléphone est requis'
      });
    }

    if (!body.password) {
      return res.status(400).json({
        status: 'error',
        message: 'Le mot de passe est requis'
      });
    }

    const lang = body.lang || 'fr';
    const clientId = body.clientId || 'web-client';
    const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/oauth/callback`;

    console.log('[FPay Send OTP] Demande d\'envoi OTP pour:', body.phone);

    try {
      // ✅ 2. Utiliser le pattern 'send_otp' qui existe déjà
      const result = await this.sendAuthMessage(
        'send_otp',  // ← Pattern EXISTANT
        {
          phone: body.phone,
          password: body.password,
          clientId: clientId,
          redirectUri: redirectUri,
          lang,
          ipAddress,
        },
        'Erreur lors de l\'envoi de l\'OTP',
        HttpStatus.BAD_REQUEST,
      );

      console.log('[FPay Send OTP] ✅ OTP envoyé avec succès à:', body.phone);

      return res.json({
        status: 'success',
        message: 'Code OTP envoyé avec succès',
        phone: body.phone,
        requiresOtp: true,
        data: null
      });

    } catch (error) {
      console.error('[FPay Send OTP] Erreur:', error);
      return res.status(400).json({
        status: 'error',
        message: error.message || 'Erreur lors de l\'envoi de l\'OTP'
      });
    }
  }
  // ============================================================
  // 4. MÉTHODES UTILITAIRES POUR LES URLs
  // ============================================================

  private getAppUrl(): string {
    const env = process.env.NODE_ENV || 'development';

    switch (env) {
      case 'production':
        return process.env.APP_URL_CALLBACK_PROD || 'https://api-prod.favorhelp.com/api/v1/';
      case 'test':
        return process.env.APP_URL_CALLBACK_TEST || 'https://api.favorhelp.com/api/v1/';
      case 'development':
      default:
        return process.env.APP_URL || 'http://localhost:3000';
    }
  }

  private getFrontendUrl(): string {
    const env = process.env.NODE_ENV || 'development';

    switch (env) {
      case 'production':
        return process.env.FRONTEND_URL || 'https://f-pay.app';
      case 'test':
        return process.env.FRONTEND_URL || 'https://f-pay.favorhelp.com';
      case 'development':
      default:
        return process.env.FRONTEND_URL || 'http://localhost:4200';
    }
  }

  private getOAuthCallbackUrl(): string {
    const env = process.env.NODE_ENV || 'development';

    switch (env) {
      case 'production':
        return process.env.OAUTH_CALLBACK_URL || `${process.env.APP_URL_CALLBACK_PROD}/oauth/callback`;
      case 'test':
        return process.env.OAUTH_CALLBACK_URL || `${process.env.APP_URL_CALLBACK_TEST}/oauth/callback`;
      case 'development':
      default:
        return process.env.OAUTH_CALLBACK_URL || 'http://localhost:3000/oauth/callback';
    }
  }

  private getMobileCallbackUrl(): string {
    return process.env.MOBILE_CALLBACK_URL || 'fpay://callback';
  }

  private getWebCallbackUrl(): string {
    return process.env.WEB_CALLBACK_URL || 'https://fpay.com/callback';
  }

  // ✅ Nouvelle méthode pour déterminer le callback en fonction du clientId
  private getCallbackUrlByClientId(clientId: string): string {
    // Si c'est un client mobile, retourner l'URL mobile
    if (clientId === 'mobile-client' || clientId?.includes('mobile')) {
      return this.getMobileCallbackUrl();
    }
    // Sinon, retourner l'URL web
    return this.getWebCallbackUrl();
  }

  private getFpayUrl(): string {
    return process.env.FPAY_API_URL || 'https://f-pay.favorhelp.com';
  }
  // ============================================================
  // 5. FONCTION 1: GET /auth/open
  // ============================================================
  @Get('auth/open')
  async openOAuthPage(@Res() res: Response) {
    const appUrl = this.getAppUrl();
    const oauthCallbackUrl = this.getOAuthCallbackUrl();
    const authCode = crypto.randomBytes(32).toString('hex');

    const redirectUrl = new URL('/oauth/login', appUrl);
    redirectUrl.searchParams.set('client_id', 'web-client');
    redirectUrl.searchParams.set('code', authCode);
    redirectUrl.searchParams.set('redirect_uri', oauthCallbackUrl);

    console.log('[OAuth] Environnement:', process.env.NODE_ENV || 'development');
    console.log('[OAuth] APP_URL:', appUrl);
    console.log('[OAuth] OAUTH_CALLBACK_URL:', oauthCallbackUrl);
    console.log('[OAuth] Ouverture de la page:', redirectUrl.toString());

    return res.redirect(HttpStatus.FOUND, redirectUrl.toString());
  }

  // ============================================================
  // 6. FONCTION 2: GET /oauth/login (avec OTP dans la page HTML)

  @Get('oauth/login')
  async oauthLoginPage(
    @Query() query: {
      code?: string;
      client_token?: string;
      redirect_uri?: string;
      access_token?: string;
      refresh_token?: string;
      user_id?: string;
      system_user_id?: string;
      error?: string;
      lang?: string;
      amount?: string;
      currency?: string;
      description?: string;
      api_key?: string;
    },
    @Res() res: Response,
    @Request() req: any,
  ) {
    try {
      // ============================================================
      // 1️⃣ VÉRIFICATION STRICTE : client_token OBLIGATOIRE
      // ============================================================

      const clientToken = query.client_token;

      // ❌ Pas de token = REJETÉ
      if (!clientToken) {
        console.warn('[OAuth] ❌ client_token manquant');
        return res.status(400).json({
          success: false,
          error: 'MISSING_CLIENT_TOKEN',
          message: 'client_token est obligatoire pour accéder à cette page',
          code: 'CLIENT_TOKEN_REQUIRED'
        });
      }

      // ✅ Validation STRICTE du token
      const result = validateClientToken(clientToken);

      // ❌ Token invalide = REJETÉ
      if (!result.valid || !result.clientId) {
        console.warn('[OAuth] ❌ Token client invalide:', clientToken);
        return res.status(401).json({
          success: false,
          error: 'INVALID_CLIENT_TOKEN',
          message: 'Token client invalide. Utilisez un token valide.',
          code: 'INVALID_TOKEN'
        });
      }

      const clientId = result.clientId;
      console.log('[OAuth] ✅ Client authentifié par token:', clientId);

      // ============================================================
      // 2️⃣ CONFIGURATION DES URLS
      // ============================================================

      const appUrl = this.getAppUrl();
      const frontendUrl = this.getFrontendUrl();
      const oauthCallbackUrl = process.env.OAUTH_CALLBACK_URL || 'https://favorhelp.com';
      const mobileCallbackUrl = process.env.MOBILE_CALLBACK_URL || 'fpay://callback';
      const env = process.env.NODE_ENV || 'development';
      const envLabel = env === 'production' ? 'PRODUCTION' : env === 'test' ? 'TEST' : 'LOCAL';

      const systemUserId = query.system_user_id || '';
      const amount = query.amount || '';
      const currency = query.currency || '';
      const description = query.description || '';
      const apiKey = query.api_key || '';

      // ============================================================
      // 3️⃣ GESTION DU REDIRECT_URI
      // ============================================================

      let callbackUrl = query.redirect_uri || '';

      if (!callbackUrl) {
        if (clientId === 'mobile-client' || clientId?.includes('mobile')) {
          callbackUrl = mobileCallbackUrl;
          console.log('[OAuth] 📱 Client mobile, callback automatique:', callbackUrl);
        } else {
          callbackUrl = oauthCallbackUrl;
          console.log('[OAuth] 🌐 Client web, callback automatique:', callbackUrl);
        }
      } else {
        console.log('[OAuth] 📋 redirect_uri fourni par le client:', callbackUrl);
      }

      console.log('[OAuth] Client ID:', clientId);
      console.log('[OAuth] Callback URL final:', callbackUrl);

      // ============================================================
      // 4️⃣ NETTOYAGE DE L'URL
      // ============================================================

      const baseUrl = `${req.protocol}://${req.get('host')}${req.path}`;
      const cleanParams = new URLSearchParams();

      if (clientToken) cleanParams.set('client_token', clientToken);
      if (systemUserId) cleanParams.set('system_user_id', systemUserId);
      if (amount) cleanParams.set('amount', amount);
      if (currency) cleanParams.set('currency', currency);
      if (description) cleanParams.set('description', description);
      if (apiKey) cleanParams.set('api_key', apiKey);

      const cleanUrl = `${baseUrl}?${cleanParams.toString()}`;
      console.log('[OAuth] URL nettoyée (sans code):', cleanUrl);

      // ============================================================
      // 5️⃣ CHARGEMENT DE LA PAGE HTML
      // ============================================================

      const filePath = path.join(__dirname, '..', 'src', 'public', 'oauth', 'authorize.html');

      if (fs.existsSync(filePath)) {
        let html = fs.readFileSync(filePath, 'utf8');

        html = html.replace(/{{APP_URL}}/g, appUrl);
        html = html.replace(/{{FRONTEND_URL}}/g, frontendUrl);
        html = html.replace(/{{OAUTH_CALLBACK_URL}}/g, callbackUrl);
        html = html.replace(/{{MOBILE_CALLBACK_URL}}/g, mobileCallbackUrl);
        html = html.replace(/{{ENV}}/g, env);
        html = html.replace(/{{ENV_LABEL}}/g, envLabel);
        html = html.replace(/{{SYSTEM_USER_ID}}/g, systemUserId);
        html = html.replace(/{{AMOUNT}}/g, amount);
        html = html.replace(/{{CURRENCY}}/g, currency);
        html = html.replace(/{{DESCRIPTION}}/g, description);
        html = html.replace(/{{API_KEY}}/g, apiKey);
        html = html.replace(/{{CLIENT_TOKEN}}/g, clientToken);
        html = html.replace(/{{REDIRECT_URI}}/g, callbackUrl);

        return res.set('Content-Type', 'text/html').send(html);
      }

      return res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="theme-color" content="#FDB515">
    <title>F-Pay • Connexion</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        :root {
            --gold: #FDB515;
            --gold-light: #FFCB45;
            --gold-deep: #C88A06;
            --ink: #111111;
            --bg: #050505;
            --card: #1b1b1d;
            --field: #2a2a2d;
            --field-hover: #303034;
            --line: rgba(255, 255, 255, 0.07);
            --text: #ffffff;
            --muted: rgba(255, 255, 255, 0.62);
            --faint: rgba(255, 255, 255, 0.40);
            --ok: #34d17a;
            --err: #ff5b5b;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        html { font-size: 16px; -webkit-text-size-adjust: 100%; }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
            min-height: 100vh;
            min-height: 100dvh;
            color: var(--text);
            background-color: var(--bg);
            background-image:
                radial-gradient(120% 60% at 50% 115%, rgba(253, 181, 21, 0.38) 0%, rgba(160, 110, 8, 0.16) 40%, transparent 70%),
                linear-gradient(180deg, #000000 0%, #050505 55%, #120d02 100%);
            background-attachment: fixed;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: clamp(0px, 3vw, 40px);
            -webkit-font-smoothing: antialiased;
        }

        .page {
            width: 100%;
            max-width: 1120px;
            display: grid;
            grid-template-columns: 1fr;
            align-items: center;
            gap: 56px;
        }

        @media (min-width: 960px) {
            .page { grid-template-columns: 1fr 440px; }
        }

        /* ===================== Présentation (ordinateur) ===================== */
        .showcase { display: none; }

        @media (min-width: 960px) {
            .showcase { display: block; animation: fadeUp 0.6s ease both; }
        }

        .brand-row { display: flex; align-items: center; gap: 14px; }

        /* Logo F-Pay (image intégrée : s'affiche même sans accès externe) */
        .fpay-logo {
            display: block;
            aspect-ratio: 243 / 96;
            background: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPMAAABgCAYAAADIBETSAAAvaUlEQVR42u29eXwd13Em+n11Tl9cACS1S9ZKCQS0kJS80InjbAAncWIpEm3FAd7YLy+bk3Ams+S9Ge9LSMSJM8nL8pKZydiZiZ2fJ8+ZAOONpCQ7egkJZxzJlmk7WiiRBClRolZqI7Hci9vnVL0/ui8ISly6gQuKYG79fvcHLUDf7tOnTlV9VfUVUUqMAMGO731C5Nx/C1g3EAmQWLJiBjgD5DDw/C/H2rovAiMOGIrzvFq2FnfceK5K/a8h+DFNjSR4+p/MUpLPg/Y4yftNcI9zHOPb9u6f/Z0ROA4hoi1LXkpssGyD+877vt9w+TeBBoBQ7hJnrGgEzneGQ/+gtet/CDABqPNSoO39nuvHQtjW8zF3XvKJ8GKIJN1r8nIJiBBwABwBA7Shh0H+vQKf9Tfv/RIBsxE4DEJJWFsllq5I8V+9iACg1vEjYMWAmJ4ditw804LB7MiCL7VjTLN14gBmTF9Lp8UMCMEsNExDTWOoqQpwjnTwVl/lF/Srvfekd/b+BIcQSZhtKrMf2nKmiS9/2ru1+e7n2bMMNNCTiA/kGikAdB7KQxJqd/Z2hGg9SG1e12mxdT76rgiECMO0KgD4qrxFzL4W71r1p/L49Pu58enpttv9T8IyD0QAMLjrYAFnlzIDQIRZeHBBl9icrUk9lcsIXGbBzrh1IkFmTrdLa6phxlS6/a/p1d3b7UurruQQoo3AtVXjrFVmI0AD/vsKGlZl8bKdTS6Zg01DWNud/euh+cWOazLF9V57XVU6okJ5Bh96QggBCYdDKhX5fu2U7faVa6/hEKJZ2+U+Wy0zASDp7r0aTC7Mga+zxDKbAZ6w+uHg6vuy/zY4P9f4on7mTvtaJARguhRWgGQSJmKQhKs00btsy7UXAu0Y+ixV5h0CAKqVPqBbADubYioDKjDYY5hc/8JRL2Qhx4OtWXKogdCHqRikS66Lon/Z9DTsrAun2pYZuTLfCPpcAc4WoYIepO3On2v+1mhgLGZuDG9AzEzeUlPoOBFTt8L9ZNzW++scQsRI2zqfZco8kCE5lLU4K1ORnAN+7ZiXAuZItj1/Z+8KA1YhNWAJxp0Gep2KCofftK+uuhKD0La7fVYps8Tsd30fLMVZBn4RFkA201ILuA6A5bQrKbhIg6Fs1ZcZzACd18dac8qSoAZT1y3LQ4qPkDCsGWy72meHMltWOtT9lYsIXA2ksxv3LNFlB0yqhOnx3AuZF2i1Y3O2lhLlOlcVUZTP1fqE9AllXh9PmsHMLNiCc9t0OqVG4c/a1r7LOTQa29b5zJcCRSOjAiD6+LoeY3UFkNrZhWRXCJt+Lk2ffGzW05xPuDzQDwyPwdRuzEonzcosEwnEYM8aMEOAVuYuaALDcp/IClTFo2EIDYswyHxqwklQowW/3C1LJ+3dAH4fA/2C4TFtq8ySVuZmGWf1OkonYCFiHpVjZ6hVViBxxrgfGJpcEJJ9aCzHFbAaJWpFDDBHUNVmnOM/w2T9UVy0wqHhi93HswCqgeiodacN9EjEAIGf9d1utU4rYoSJzMOTIokAE9hPZ8o81q4KW/rK3Hy3chPOvsIgAz2oeDh3lh2yJHp5GYJu2gQh7br8CkXdUqMnLbUn8c3L93B4LMzzWSZz1b7H7uz9w1jTX6PjbycOnSE1JUu6yQaxGSWAN05vu2El+fAB2wThMNrWeenGzFkMaXCrs/SynXVgiDHcv0BnnQTsfTf1XAjj1ShXxmlICAP3cngs2AicGTifz8gInG3v97xlfMbfMv5HMeiPR9gLkpBl42gSjIboOqWaIKwDMFvh1palqczMXNFPJ6Trzco4z6oXKrA6qNiV+8rzc7FHs3XsqNjVzvOcEMwKx6pmBkfQLLuHi/pJwubzGRpC5PqxYABtZHWlcuu+f7DUfkbEAjMY00qeUgaHDAfI762tMktWmTdlL6/j+isAueLsQrINAAWoNSJeyss4H5qfMuebXMjVqBKlK+TUoORDLUMCAOPQroZ9e12S3LZvR6jZf3HdIrD5Ve5R0DMXF2jLkoyZ1xAAHJavAro6gJpmCtByxTKc1lZBAkAEqonZkccw88jBlpRxQtaWT+DQYcZQETzUcoVZtzPaJki9Ev6I0/wVEVZVUdxrIIkIGOyy7KxrkxcsYWXOkGyTyg1kB2B1BVqdbzRkHXldpxFdM4DiMhvW+DiwMQXOc8A8+3gHspQNgVJlnGYw78CQ6kRd9VEAwGDrDjUyq97qvPnAY2Hrqm9Jl+vXmkaUQTINELAbALAZhuG20ixRZc43hfGmxXGu844lpBOGyftyD3GxrXLWO2CuAXvpL7T+hpGcJmjenF8k9MGR1RVD49p5gF+k4rFlGx49hMUIYgb6xYbHLBDfhWd/2fx3Hjq3Y+Wlr8w5IQHlBlpAk9CvhYoVwW5v+tzfaH3Nz7xGsTPny/eVWysCsDVd05cGc1dm1a4o5sgSBk9gRneT0MVi+SBgAXgSZvP6YxIzc5+1rTZnpsgpNrkBI8to0pOBX4tR+SUw04cy6/hgJft52j5uoXHybLqGsspXpSMatBSSLYAZZpHsRTyzwgJ2yKFjnnUBwY0ZaJsgtglilv/M/rlt/RfRMmencLJyJeguyZHsVoNfeZNDeMhABbbrgqzkayEX9RMYQxqxNkkI1FXBgiBhDjCRfHCxb5O080ufxZapGMHH5z5rmRAEoxBc1E8cGjMOIeYqmx2gc+PvYWDTJsjmgX7BwJiSp8YObATupAdg8ztPdo1NEGwGsaPYQbp5x5gOL3LhjAHESL5uReTQmGEIeiplhvOVPmCZAFPlgJNi4oAJc67+SLY6A0u2uogia8qfZHBaU42pPjIXSGup5Oi4gn2i8yurN9ju0gqc+XERQGweACMjcINdV62A6zxnJmonxNgRRFGJU2D3i/zJ+6eG8/rvnLbITkT/awAzRR0rgmnYiRSZw9DsUClxSC1iJdzstQs8WwnLnPX1mvm1lASwVsdKs00Oz6dTTxw4+o6WlmzOqXVJu740kp2QIbXnKx2yWM9PDiHa9n4fJg++EamV9K7orG5QxQNzD4YTKjEGhRzNFRiwLddeGBy+T2hvNdU3GNAXgQsshBWOrFDBQDUE1oipl8IdvXtJ/r0IvkDu/cemUr/SSjc3fLq153Zx8laNoNBqBk4DOg3ltKtII1XbQ47fmx9hdhwl1+m/WnVl5/l8S0yt8+Qhl9FVWJ9+fuYbfM8TT53skFiARpCEjgzCvfOX+35IUrvq1K/IxAxP+J/aN3YSZW4SErgbFycFTAUqzjD1KDB0uBV53tMOneWL/+zI6mWmM325shTM4ULh6Zjqft6y78iibI4RCAah6R0HX+8S6YsNMxZU5qOHjT6T1DsyZT5B2sxG4DIrPBrtsyuruKxys6q9O6oN+A5ehESywSfBgAiYZo3bBkAIiqALIl1IeDk8B7QWPxK/1vc/aocb7yMPPDMXGGz+c9i66t+78/zvI2TaPmsfINmFDUhApFt7f5+3jb9/7qHQvN90a+/PSJV/DscVrlJsTasXdjxv21a9A9h3z8gI3FCLAEvblN2f3XHNterdX4rg+9Bd/NxNt676y5O52bm7I9cSAXn6prWhAT1ollc+LaDJ4TUzyxmucE5XeiXBSzQaiioLzAweMDSbPCBAa5HsHRf1cz3HLN1iPy9VkTARAsmCzTUW0SGOKb7BoV2TRxX2GIUXEprR8/acE5fzvWr8VfG8ToRA3RBqqqiZ5h4LYUc5vJuuiEaAamYh68gG6PwK+d87rfIDM1/oeSfftf/B5tQNADq5beXrQGzSiagaLRyX0YUwESZO8L7al677z+Tux2wTBMMwDObc5mq/K05WhKmYImMqPS7ez2Ycawj+HH9hbIRhT7zNNrXm8DUDsRmwO3s7ouILrtOtDYdDAEnmt3Si+1IDEkcRwTvl5Ej2lgsJXr2YNdmGxq4lCx/m6K6DXus6RdTKKyORV37taC2SbZsgAwNj0bb2Xc6EP6/T0TIihjK3BkL4xaPg1zEb0JFQAxju6tuoK+R7rtP/gXhel06rhqkY8xp1Ielzrm4hwZy7++gnQ/+FgCPpSTAcCal4rnLd7m9ta89aDiFidHVCwqrmf8ktc8s1mBKsZH9z7AegR0bDMl2tvjLYhk1HXgjjpaipAfQEXf7zVZ/m/yeZYErNgNW2ZV0Xh6EtQeFHs7Ahmv2yW+7WhsMhba4Zjn7/ie5L4EkY//EEyjwqAOA7L+0BO87N/KNWp6VMYA1Q9aG5bv3SQ7IBAmvhc2tbAjJDajBdhDJOALhsnSNhAfEPXNWt0Fg8ZZa52CJhMh5yXemdOTgXm1akaaUb21at06/2ft118lMCXh0mQggN04yPm24hw/JIJqEWg3O4OHp3x9TWvsuBXfHZkdXLAP4K6manyBqYJASAJ1F93cEcMZ9d4y5b8RKB5+BJFAxvDKBGI8lLGnypZ453tjCr/BDM7u45xwwfzbMhrsyJmx+Hf3yCxWgSEiTXgV1oPf+zGeAEmEojp/fkPuvSU+ZcAc2wpgysYIA5gcQZbXgn2fO3sO7Zvr0u4cadaWNLz0bf7f+3MKWRLJOJsIgqCcPnuf7Ay2aDrjmLioRxCDFs6/2/XCLfkER+OEzEEIJpbk1alr4k6UNNg6vyqg7aX3MI8YKu9Da3zF0dGqqn+K6sIMewj+vHglnmRpPZoDxu2DkN2E5UCFix/Z1XF0XXKc7Brc0Ouf6FPW9ulbXOf+eXu0vThhbHNYDoukViPX7d/dT4F07wRwP5Yvobs2xUy4EpAxIA8WnM7Dy4ZJV5KHOzSOaEBCxDSAAzPI1DjafyE37Bz2+bILYdnm/emaZbet/lqu4/xxmNZVhCzWDiKHFa697zPxpAbB41s2zTPfrZldV4Z+/n3HL5QwvWEaY1tlqJj/Vf6MOkBrfC/VDY1vtBmP5CoZLUZvsm8GAexsgrPSpQ7i1tV/PrEvr6VrwvDEKntvZdboL/U6dVWaKRiQQ0mDmPD5FQOQX4tTbDZFpem2tgAjMdB359JgfXlh6SDdjE1msvMEPPfAgJSOzlLx6oNy3efPd7psT9nsNQrkcI2/o2SpV/bcHEQlkeMIvSLWLRPsNbxvdhBILNWdPG4S9edsGVr0u+Jsvc/xGOxGBZB9aiN8iQ8HEiqgj+g5Fvi9NKnqLmgSSggEIfPJFHpRbuxYyhFJYw20nGN2SHxAJqA9ZkGYwq9GOu26+IJfrg1Sy6bnE6YyO8ed89NjLo/Im9iRFHulUZtW6rwS8a4MHZhd7xmk9LnM9DALDlEleak3NjLElIIIAZd9v2fg/A28A8kPy8wonDMAyPqX1p1ZVa5W9JB38u1tRMUYruVw3mEpE4pS95dnzCDNyxA1xPRPvi9RfEavgb1ylvygGa5PSenshqXlA47nc2Y6jQPfIqTCJPsSW19KEAedF7nh9C4dZQIjUYsdq2r6xy/YH68fLYBe5PQKht67shevulOBWVBSsHc++JsabTnvxIBsKN2nGUeROBYUP1vMsBXLV4hAQKs7gb2O4BeGB7C645MKccdMQ1Y//WyZzr7+gXYEwjeIOrEjZlypIVcl7s77l+LGABKTkzsHFH3+u94N1Ke69U5YIwqYqjKHGJ08midDofD6cf4YZdz9in1yUDT+2MtuXSrujDVtclb0qPxCBymhW5/JqY92BI7bB32D9XgXNLnznqPPhi2NZ7PyoygKiKYu+PGgwELkO9uhLAbmwC54JrBWNlEtCG6m8lHa6STmoUFo2VTX23d+Fw/GNu2LvfRgYdh0bjcZQ5JySw83rB7iowswiEBOZg0+b08P9SrF/QZj5eOJpZ/qFFYpM8trjFYDfmGcoSrYVZZVVU/kjY1ncJYA4s6JkooGZOhMvNrDfewdcLbK10CVEDwmSMJEu7vmoWk2XOxyPhbr9h/6dyj8G4ERq3dX3Odbu3hsMhiNDPV8FA6KsQ/zz/3OKY2+BJRnsMN48/bzhOQc6OfgeMBTO7Dx4DRd8fAaoh+k7xoaZrAOwu24DSLHxpbFv1gy6R28OUqhQMVwxQl4jEyfiU79TfzeLu0Wze9omQbJOO68kqYDMtJiQwy1KOjTT6i/rF7WsOb19AzCwGONF48GGk/A4AuI7dPw5ZcR4wbYAu0EKLAR2MceJ+NLgbMI4eYjNIvgHRSs2VyqdGwHfJv8peYbnbc7PohwHBEGcMYSIGZLlQN483km2QGTvkHH/JDMTOSfLNO9PGl3t+Q1b4d8XDIeU8LLIBEQb6hIIKHQRHs5zNMrCGIaSm+Um58Bh8trXU9jTRa7yyUqvpdhPfQMD7S80FMzN4QhDfAOCLZRtQMJjtdTF8UjypaYlskZlJVaQxoZv92/YfztOEJ1LmZlQri0RIkCMTkIQ4/08grfoSwvFKBXfeHhvrthjDr5Hn3Z7tFr/ggx4QOGfTrD7646HOe4aGTG07fZjEdZjnUPVQ01guN318vBcEi1d2vdpi0sEgoNXtZ7lh/KCNrK5waGejsa3vR10Fm+NEDJYh1qUOCADiu8VBgVjXpxntu6q6j4bnVGg0nktYD4g3+g65BkKEmsYFK3SGvUMtryk/nrLlqcAU8Xusse4E1RgLxs0kEQ0GZCBYiQaZ2VLSO3tvcx3SH0s8rwHRd4oLR+L3Ksuv+KzZPpnr0R1nA8wlJGgi2YvVajoRW5hdTcELq+qO/CiALUD8R2BiA6wWAGsFaX8KXtCl9uIPkrjHzBteXnUpPK+0YMUJCY512dxrORzEDEYiuk7xcUL/ZbJh/G/s2+sSrNsZnv7cJd2E/TeSjAqREk9nmRvqEAyxrl8x4M99h36db9t/+Li/v+XSLqSdAxHyft8tA2FKLa/Umt/i5MrGJknicQpyml1Pnfc99kR486o9TOQmRLOChzIRDAassZHVFXJXowgIZgAxCLNPr0uivvxbUDM1sKg9m62DdfwA12e0zMQJlXmWkKCTJj3gYlPrsoVpDRqQGlUfMQCk78s9UmvZ91gdFOwmgWiK1LEn6WBnaMyDZP4MAIkoiK7b+fRI+Fhlw75P2XZ4TCwzEpp+pfvDfoXrC4dDkIJWP9/J0S93Tuvxm0J+wN8y/vVjENwdryiyODRm3PD0NIA7AdwZtvW931X4e5qalkXj5x6SsabqTffMdWtPFLvGrbgPCW9CXYvhQwZaaiBwBbrSKwDsLwSCWdZVFrYe/gW3zN0UJmKUgmGRmUW/zLk4EbclG/bdfTxWGn8c5TdUelaCcunisYssyvZ0sBpFZh5QAGZyfd4g0gLPwgwQB0yHGLAn8zcNIliDCoGZEoQEZ4YiKwVwXeLTifDRyoZ9n7Tt8BiAAmNWu7N3FYl/Fydj4dJCMxgE6rvE6XT8E3ninPdx487URnIXchA54cCrXdJjeqBv3ft/h629L7gq/zxm87Jc2UMq7/Z6Dsuqjx17zrwSHsrcbyPvgeG9VjBwJsGg0KTLVcKUrgGw/1QgWNZMMWo2snpZlMZv6IxZ4XZZwChknNGG8/xg08K/Ctk5niV3jtcCy1zO/8wlsT2REFafDLXn9wKf6ybk6tYdRswr1uxpNJ59Ig3Ie71zcvglZZEt+AqFCZFO6L+s3Lbvk7a933M9AkYz1NdH+6jrlE6NxU9CMnOt43T8iLtl/NfxqztD03pwCPFkRTHNElEMQe3b6xJ/2/hnQl3/xHWLs7Jc31lrKQju5/pdkydtLc1j3Shyn9ZUpYR3RZjCA3R53HwqVpAd/Y7D0NjV+NdumazUU5ejzn1n6pY5sQb+jLeM78LIoByPieUVF2sSEiSrwQSALZWqrKayHQDe/iK6Vl0L+gtaR3VkBiQwcB/wg7XNA5tyQJmlCAle4wVSM0S/3HmFPak1e3tlw/inMkUeC7YJwiHE2ldW9dLjPXFKrXDoYAhumfgwHX/X/9S+38nTWihLTkjAsHVnNIMcdvx4nNKnXCIOZQqKmq2ltKxYZMdJLHuu5JXOmT0acdCVGOPTrDCj2etPFJfP3tImCAbGon2h52IQ79eaFU735qkoxsn4Qj3VT2SNGaPH/a5XXHCWkOCmfOLDEtFlKpjAYHsAQHTZDRnVs7Uo18xm7/UuAhge2xyf3HJpl5n1zhfJPp2xsZkFn1D8MnFa0y9Lg29J3jF+t22Hz4tWZhsGvOO/cF2uw9RiEatsWVmhj5N6V3Lrvg/Z9n6PgbE43/JUDkOxo18uvGX8iKl9hp2EWflGH5L5/LD+kx4eNgLH9QfqJL6DCk/skr9aybKuN3CtbYfnUJagPO4vrxkkCQsVfsgtk/M11VKkj9JJ0YjfXv6u/c81GzMKKHOzJttdC2sSEiwRwwyBWbore5F+bQYHtLLe22DEA8xLai5z51xB8nV6hiqzGVTNok9Iv8J7NXs0TsWfczeP387b9j6ZbeKsWMcM5PqxcOjL1y2H2XusZiiCAZjBJBHGGX3JGX/FDMzJ+Ba27ofGLBuGp1t02oylAEwKgsGYkz6cqrX0qHucNV0UTRUamGcxVmKiJ5v4senV+8AsK+qwu/t66Pkv4pRqUUDWDOqrIvFI3J0sT/9LszHjRL8vr0KyV3z1fILXLK25UiQsBRnvzxZBcqqjVjWINHuv3SPMD+9gsc9VxatCeQask2VMPLHJ1+GrIsly59TsqTgdf0Nq6Zv8rfv+e5Padq4LvGNz5oqeW9Ef993u0hgsFovnTKVKQWq/xdv2PokdRwsYFiQZWGZJvfNhDfqMS0grwEHXbC0NdW0E5TiAU7eWNpsuBPeiYShaH02CMUJdp1SR8IbMAh9nH4zmVrmmv5nhECVq+AmDI03wIa4/UG82Zpzo1/2rkOz0vB6wcj6Q2tJBsumASXMx3ZWx67WyQaTZe12bjqLjTSSbsBuRCFAi/mluuPkOcDth8GYQ70lU6OAI1BUadKcFfs7V/P/Ln37kBeBoKuZVONCafIOovgt0VqS00QB1FXFxUh93OPdTWVzYGtqjo7XTuybDtt4n4XkpghWpnTZ6EqkdrE4nryIkONHBAQBJ3T8YkvCy9zy3+BRPU3hIrPONAL72yuKUbL1HY2PbqnWSyD+Pk6rFU1GIvltcOqnbKxv2fbnIgIQ5ypx1Lokl12aEBBPa2jzwYiPZUy+k6TP7sWz7hQy4soU58oxFFLUnUOt7Os15r8xszXzwQScgu71v2aMrgIYhBnsBddtFckeE3Vm5ZfzeuZsqt3bxOJfISiy2rOsK9nI/ZoyF0mxmyqoIUvsMN+yctu39nhxrXY395qbTa1Ml3mLWWtrAPg7tahShxD16cDzyQtjaez8q/FFEK9p0kVeC4KQgmCh/WxK60LBY1DySoKYW4fQDRR9+zqYayN9RZQ3FLwK17iKCXxnL535gw7QPO99srC4DGq3yLLLea63tBRiHhkYcMIRZQoIS1LrOgzHaS3Ik/EcjlWbzZvw3syDCw0Y+ZY5PJCr7uWHP88f8zlEw6sQn+mhOJChHbnRergipFUGxjaSLUxpCwKghi5UXJ4AqgXvks66NORXTQL9guMB9NZsugG/B40cLN80wi88VuPGVlrP57+kdvW9zHfKTcbo424sZgl8uPhyJf1HZsP/bza6oEsqMnP9ZbsxJIpcKlJ0hzZoRtSuT1WQnYGnEwouycxBNQPJBAhgdfXd8+aurz0eY6UFqyKqaC8U/yoo41vS77rbxTYvkoxA7+l1zwsEsUn1KAGgMEfEtrpoAaYgZidzJDyZfpcS67ur47r5HckvSWmWenThpXcXNStZ8QuMDpb5r4OK86ULvQZDiqca8EgyGa6Y7+14H7H1y1ht4KKsQD1vtk02IlsXeoYmHaM2OeM+PN4tNSlpmKjDoANe3OIQEi6zRDA9lqufWtLZj05j1XuNB5p2OnfXGSlZ4QWlCAgeY4eEsD/uYB65euFvadO1y0Ago5+ru2DGW70t5U/HGNVMkIlbntzgMte39Hutb52I3Cz1s+8pqmOQliIUzBg4Ng2vmmIuSJObK4l3ynTgdZpywI9qpC2ZIMCrUd7DLp7wOwJNYkxMeDiGGdb3v8cvlzWGyhFWGqXQ5lx7WP3Abxg/aCByHi2ERuTJvEmBY0bnxdVxUQoJFUWOBzYCm/5gflmtbV8aZhTywaRNijzHbx67C66RKhGktTUhA4CGuHwu2vR9soQLMVwY2I2IYoKGvTNiQb+bFoUluTpucdFeSdpkGnHI/zhISNHTCM7yKkOCkzzEMM4CY2P0EulbtYYU3ZuyfBTaQmaIiEmfiGwH8HXrWCbbujNlBhGGkhZs3mqCixEk9kCyv/OGpUlGv3qgZpk4A8HZ+L9DVBURdGki25XHxVIyoPQJsEtL1tBbJ9oCFw8HP7J9tw1W7KWvhKI6AGZhZDZcrQKupdRdiAUeu6DTgisIWkLNO9cFFeZaBfjGAkXyj63KJWqEClqyHmTyA+w48lx82xV/P9n7HIUQzfBtJfmqXMinMQLDnDmcc2JPJRr/C9YYZLd6EY2ZSIWH4GNfvmmwWm5RU5pxal/56sDobPy+O8iG07sMG0E1YGMfMVx9Hx8BVgLsIaIR8ePpCv6MBdtOI+zGx+oW7P7bJ51H06ibCUBT88g4MDZtGLJj/PB3S5HyudJ8H2vmIeStnQTNiplOLcl+HLjZmU2xuzsbHFVirnJCAZns4nM26xjwILyhyT7m/yvjPoXajGQTfHE9t21XnQfBhrWmZZorou5yLE/Gb7r7xz4/kaa0yd+KPhXrcjYtnkA1AhWCXb931nIdNGbTxPmBYiZ/+BfCqTuAlLJywwgB4D5uqCeQDCnD98Ga1kWEXaX3ZXIDiyX96kg19At++/FlgL0pzRi2mVEMXUlS1bAWvSMsrBDPndlTt7p5z4gxvsXpB9sycJJFNat2y7B85Gu8U34o1tRJkD8xLeldN39V7Wffw+MH0K8kH/LlySTgSC48DIgGLBhX5gD96GGEeypyNUjW61YtDSGAGdBCo7Yc1/hYQwYJognImI5MG7OnR2HjrDuDTCVlpAIf+FFrThbvZArCjLjzy+XR69XdGBgfd0CjjdGff5RWzlTmKWRj+gid0Bnv88FgYKVAAcJosMzAMNFKrCsWXSptninPRvBTnpIhcvyPGQqjJu90KuThMFOQ0a1Lgzn/WtQHAUza595LYfdBVeGVI7ZSdTSQYAsxXZbmv4zK7+/paDOHf6HTxss2cf83FI/F/Vjbs+7rNc3/4XHEV+GyV4KpFAr8i2O0RX/p8nLnp463flZsE2JhqHZ9Ey288u/7g4DAwCiTGa3wHukOjPJLt8o022MrN3zrHqcTRlNHymOKGllvl0TF7csulXXD2fpTo+c1nXVtMuXeupS0B5mVPxaenw7be76LCK3PwqsidR3Q4H2fitTaT/rQ/x3eHl4sN6TM0aXOt5ir4cD67al6GzmOWkGDVVYC7dJGUmUCAkXuOUuu2gpFzAMDoHCbOEQcMEtjRKiQmdwOouKjfA2MQsdXoINDQU+ZjXwkYGXBmDcnbnP2oOKlFtSBkEq3Q4zDLsVt/rjit8TL+bJ3nxp1puqX7o65beopa5Tmzrg9V0vjoXEtb0isQYExhdi8EG8oUj1hNAeDfAuzTSbXipA45be6R8J94275xW4DX1lRmOCzvA7oSYHoRqHUpsCkIpx/OqHVtDr91K2Vo0V1Xwm4se9YREK0pHOzh+ViNRVTmrDAjjZMmUqMgQbEAxcW6mlT4ppk7r70J2POALTB0sE8j4cadafrlVeulyg/GaY2F2VuOzrp+lEP7D8971nVzdhiRTboo2nQBiDYMLuH3WTRoKHYGNGlzw0R81rPrd8qmoo4T+eSsGeJXgxW0XsnMAE9Y46VQe2n/vE/N11ryMSTR7IYyhARmMOdIDfYSfMejZ9TzN59gxVUvkHw2S+0Uuzc1U+kQLyF+mIShZ53MX5HXJdyItP7Fa66VqvwPKMQ0G/da2O332YQQ4GgXWGnJFcmreyDO2MveUaxoWTOBkJpFRfEhr2YmVdIihnnrAy+dqiuqgDLvaLpONy1aNIYKDPYY8PaXXkkivxTEDMwqnVZWCfaWnivlCQof5dt3vXhcQvbXTpezyY7rxwIM++CLN+cL6cKUqu+Uf55u7bmdb96Z2sjqSql1bQ6627gzrX+5d3XS5b4mDhdrajYfUnyj3Q8AAwP981uPZtPFhj3Pg3gQFQIlylSbs6cLKkV0VXFhIj6QPHPOfzODYGhhKWGZpdY1f/0izZVS0INZiZ0BS4vFMndHszWZ8VcAdnk5QoKMK8qaLvbIGfb8OcOIATvhYKV4vA3UaCoV9xeNrX0/0uxUsu393jZBXjmI3CwfcjcCl5cpKtcjpNtWvSOpYkwcrw51i+WZTikIAM0WXpCzo9/l6/Gt8jO3yzlFzCahfJAbd6b5uJoFfZfPqXXPOUpIYNJ6/EtglubF7zu45JS52XQe0Os7nQ81LUetK4RZDn6daUh2c+ObbEfDPkqWGinK2AB8BSsksa+FO3v/PW4e/9RsK+Rwk5USxOZsNvJcy293XHOt0n9IPH4RCoS6admpkgaYCCTWYxqJ1hXkGO4pW95a3NOz6LudSyf1q5UN+++yFqUqPQAkyWXXKJPFIiRosoA8jKUqs51Fsjabm1mCkIAkgoF25pRxHosZ5nFiR/XeUJ96ylfkspiNSyn0fCJgaJg5h07plD/Vr/b+fGObfSYK/7Y6WXmC3NUAMqDN7uztqDO9NIn++0neHokNrpNdYVJz7rl5eS0mngwNPNXxfHjiGGBvAdiIV9kZarHhyEqRposyhw+F1IamSYle5cLKrH5FH7CMwJHYekICOmAyxljfnft1ulR12mBrUapTHiaEizWNEflo0YfOLPCPgOUMnVPptt4vocp/ZQ3VMhZaBFSF6bSqr8pbpIq3cCrOhM7GE2Fb7zMwpEZUg9olCZJLXad0QgCb1nkPujtmmROCDds3Z9b1vPfYLJnBzJ7H2dW7lxWuwYy1jt3SLLrlzofD8dNuw/4HrIUFRAIAqm5NljJtOTClQAJYfBaNvY8f3eNLTPI8KmHXlXS9TBxhsGc6sPzxWatxhslokwcrxj/TmkZK+dQkCRJwoaYapjQ6ssN3sNd1yg+7Llnvq/JWn0iPCDpDTWOY0hg1IzlYqM8KmdPBNdC/YEwiIwNANORNF/NgBz0BkGrSnH8t4Tcz2tzW7QfJX8TaxemtsAzJZnwU+LmpJYtkE/bSl1aea4ZVCDkhQQmrAWA/N+ycnnf+c7E97SFEG4HreMej91vDvuS6RcxsXkU9JISAiwoLDdNQ0xhqGkNdY0hNY0as7wi4ec+SOr5O39+6sOo5Zoc372nxblLppGjQ3+GtB54BBk9Ja1RSmTcJ4HNCgpZT6xroQMuL37HDYekJAaDLV1aK8MKYFQSUKuMEJKOxyZHSM1IGs7SMS/zHYt1mxBdjxDyFpZZZxc0+cqq1K/+ddJgxKKQcIcHJPbGspiDYt+K0Ltx7QE6b2yESjuh4Um/8p8yfGG2pBRV0/bNLCF4JLMaQuOxyxvAglqrkg84c7VrpFBrKxzcG3XXGn1iEYhTCm3fv1hkdlm7nADut5AmqMO/Jor1YWUEOGBo6lXTIvhZiEtmkCzlntwV7qsyki5Ne05MAPsyhg7XmKKCWKrOLXdeB/jzkwWCL34/A6qDWH8mPPFuqOm3gjVlvbYm8IyloGKh2ZiLZr/K3oTYy6JIN+/5DPBzv8it8YpYVH5yGcEaTKhmiPh+jTRaK2rPWUpA4gJd3P3sMgLWwgy1rutiwc5rEd/NQyRZwMkTfJS5Oxq8nt43/T1ukrjkxqawBOgG0+uJmgAhsuh45kXWyYPPSU+Zmva5pzi5d1MPOCNljw2o+ck8LrcZixhPWnGPkQvqeOB2/55e7RVdoM4u+KqKpHjTlz5CoSZabt1PqSUIAHGce97faIwNxLxwXVDxCgBpMVeQDi7mOQvOvXyS6rxz8soOojz+1VJU5p5IRIfvyPq+ixf9GT5jhSTx37jMAzixCghPd9jAUm0HefuDlWiO+XWt6X2ahEXQR6JdNLfiqOFV7UdRuPqzuOwYug1qhUyA7geYSErT2EHe0e9BQzHdkr5lFt0xEZ/TzlVv3frOJlC+KMhvk9ZlRNrZcmekNFseBjWleWbbkkGwAwB0rLzaza5BqGVwhq8km9nDjzjTrAF4aaTkOQ80gy9/x6LMvPul+TKfiX/nl4pOEbI6/acFJr2YW/HLnVXFQpvUneNv+By/sqF+Agki6ZZG+EWw9JtPsXqI8EOt22DtI2efOaHPJOK2TXuLHTjbBsTWWGVgLzMRsfS227oMUSEhqE8leejXZ+QBw0K3yiXSGaAGEGhBP9YFZCgc15APMdvQvqecnobYJctEv755wt4y/J07reyPsKb/Ce+9JM8uetcQGnzMPK/qE4pc7rzP6/81MpD/M2/fttE0Q1DonmvxtJEJ2eLziA0SDpSIgGkYHfC9b49a1ls42Xdwyfgi0h5FIqaaLpt8hXSIW7I9462MHTjbBsRXiAQh4rssHk7fOw0biYEeCsP5XmU+xdCu/gnG5X+Gcny7Yy5PVC7nsp965JMCvE1toYjPIW8Y/M/GFnm1dwL8B8V6/zF0KA9AwhNQMND0p8R5J5+DYIQ4CxLo+ipr9nr95/FNAPkLnIRhuf+RF3NG7Bxf473eTerL1dhAgHI6/l2zY97DZwiq/ThA3O7OxqNuwAwl+ALWCZAW55yEVkTihTxz2/P2F9ioXU2bW32165BeB0ELLQZL2Iu35/5rWfuA7R6mJlpgMQg0gku6/Dy9O/bE4WR2j2sk6ViVPN7iKzMSZ+IXktv1/15zntBQPsmZzhI3A8V37nwPwcfvi9f9PRNgAxTtg+AGf8BJ0iMsCCZt7oM1eBMEQ6zrFGb1HBH/lZtwo37l7YvawGELMSzHNtsjP68vx1y3YBcc7HkgAHi9L0C8lG/bfla9v6/fXoYuNhM1sQWel7FFsZtIhElP8xoW37D1iI4OOHF1UHTgNHUxLr+qrxSgguRRLWE+EIYweOw7Wtq88N52qXCe01YRdrcbXwWxZ/tgmxGEzHDTiId9h3+Xb9j8++7ctSNEsVlWdbYJgMwx39fZE4gEqqpqxybPAO4++Ki5M605fH38LBrOxoYu9D3zOmwVgtOVmLbsm49mgkBiBlEot5W2TZwQLZ2utdJydaTUwpuSBlwF8M/8UUpIdA/0ycJKBdtl42H45aWhyUT9xaMwWzePJWD803Wq/6Ze7znQixqLjWJnNrwTE3t9MmRFYdM+UaEtbWmCtj0kLzVXC5n8/NGZ4CLaYAFDLnin3GBpbrvk+1+HvtdSAgilJM0S/TFx6RL9cecf47UUnOLYKAGtLWxZsrU9MuDC2hB9OfkcSSkgtFprgCBgdGGdsJqm4D2WpzdHTFmJJezu2pS2vtsr1rX23JJ3ux+K0xsLDAc2i63ZiM/qnvHn3bowOyqIAc203uy1tKYCNZHiAxMmD97lOeUOoWyFlNkB9QsRgz7uKX43/9chLQGtqxduWuS1tKa3NmSWNU0/9rFvu3hBqpayyoYMCtU/wbY+8gIF+Od34QNsyt6UtmEM8uGZ1V+xsPMgKrypK+WtA9B2UUNeHfa3jjRjcFU5HKqptmdvSluPJjn7HYWisNv61W+FWakO1KHc3gYx2QfhBDu1qtII2t22Z29KW+VjlZoHIlmsujt7touO5mlohQnszRN8tLk7Gu/2GfT9hr+GEz7Zlbktb1gyShAXIR9wyOT+magUrvYwCasNCXORe5bZlbktbTm1Zs1nhd/f0xujup1lFC865arZwhiP6X5MN479qr/Hc7bZlbss/bcm5uMIMPuE6Wc3ZQ4u41yYJJU7pYa9uc6tpc9vK3Ja2lLHKzbLNbX1vkYobjJOqUng8jql0OlG13+U7dz+1IwfQ2m52W9ryGrnYJDRs6f07t0zWh4LVXgaor5CxYY86nboRO5+uz5ml1bbMbWnLabfKhNodvbe6blkfp2O5ApGEhPGj3PD09ELnKrctc1vasjCrTIwOSuj8zn2+U95YuGzTctrcaf2Gu3X8R17Z3922zG1py+m3ypZ2fm8dvbwh1k0LKrKKy/1s2gfOtFFDbWVuyz9ZocULXLewiB6YAd5TpEtcnI4fq9y67x9e61RUW5nb0pbBjKjQdyz7ejgc/pweE3aK8ksKVAX74mTc6Dfs++0zTZEB4P8H7wzYo190CVYAAAAASUVORK5CYII=") center / contain no-repeat;
        }

        .brand-mark {
            flex: 0 0 auto;
            padding: 14px 20px;
            border-radius: 18px;
            background: #ffffff;
        }

        .brand-mark .fpay-logo { height: 40px; }

        .brand-name { font-size: 30px; font-weight: 900; letter-spacing: -0.8px; color: var(--gold); line-height: 1; }
        .brand-tag { font-size: 15px; font-weight: 600; color: rgba(255, 255, 255, 0.8); line-height: 1.4; max-width: 380px; }

        .showcase h3 {
            margin-top: 44px;
            font-size: clamp(36px, 3.8vw, 50px);
            line-height: 1.08;
            font-weight: 900;
            letter-spacing: -1.6px;
            max-width: 560px;
        }

        .showcase h3 span { color: var(--gold); }

        .showcase p.lead { margin-top: 18px; font-size: 17px; line-height: 1.6; color: var(--muted); max-width: 500px; }

        .actions { display: flex; gap: 22px; margin-top: 40px; }

        .action { width: 92px; text-align: center; }

        .action .circle {
            width: 60px;
            height: 60px;
            margin: 0 auto;
            border-radius: 50%;
            display: grid;
            place-items: center;
            color: #fff;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.10);
        }

        .action:first-child .circle { background: var(--gold); color: var(--ink); border-color: var(--gold); }
        .action .circle svg { width: 24px; height: 24px; }
        .action span { display: block; margin-top: 10px; font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.85); }

        .proof { display: flex; gap: 28px; margin-top: 46px; padding-top: 26px; border-top: 1px solid var(--line); max-width: 520px; }
        .proof div { flex: 1 1 0; }
        .proof div b { display: block; font-size: 18px; font-weight: 800; color: var(--text); white-space: nowrap; }
        .proof div span { display: block; margin-top: 4px; font-size: 13px; color: var(--muted); }

        /* ===================== Carte (style application) ===================== */
        .container {
            position: relative;
            width: 100%;
            max-width: 440px;
            margin: 0 auto;
            min-height: 100dvh;
            background: var(--card);
            overflow: hidden;
            animation: fadeUp 0.5s ease both;
        }

        @media (min-width: 520px) {
            .container { min-height: 0; border-radius: 34px; border: 1px solid rgba(255, 255, 255, 0.08); }
        }

        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(16px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Bandeau doré façon application */
        .hero {
            position: relative;
            padding: 22px 22px 54px;
            text-align: center;
            background: linear-gradient(180deg, var(--gold-light) 0%, var(--gold) 30%, var(--gold-deep) 62%, #4a3405 84%, var(--card) 100%);
            overflow: hidden;
        }

        .hero .waves { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

        .hero-top { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; }

        .logo { display: flex; align-items: center; gap: 10px; }

        .logo {
            padding: 9px 14px;
            border-radius: 14px;
            background: #ffffff;
        }

        .logo .fpay-logo { height: 24px; }

        .logo h1 { font-size: 19px; font-weight: 900; letter-spacing: -0.4px; color: var(--ink); }
        .logo h1 .f { color: var(--ink); }
        .logo h1 .pay { color: var(--ink); }

        .secure {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 7px 12px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 700;
            color: var(--ink);
            background: rgba(255, 255, 255, 0.28);
        }

        .secure svg { width: 13px; height: 13px; }

        .hero-center { position: relative; z-index: 1; margin-top: 30px; }

        .hero-center small { display: block; font-size: 14px; font-weight: 600; color: rgba(17, 17, 17, 0.75); }

        .hero-center .big { margin-top: 8px; font-size: clamp(30px, 8vw, 36px); font-weight: 900; letter-spacing: -1px; color: #fff; line-height: 1.1; }

        .hero-pill {
            display: inline-block;
            margin-top: 18px;
            padding: 10px 22px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            color: #fff;
            background: rgba(0, 0, 0, 0.28);
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .dots { position: relative; z-index: 1; display: flex; justify-content: center; gap: 6px; margin-top: 22px; }
        .dots i { width: 8px; height: 6px; border-radius: 6px; background: rgba(255, 255, 255, 0.35); }
        .dots i:first-child { width: 22px; background: var(--gold); }

        /* Montant demandé : remplace le texte d'accueil */
        .pay-summary { display: none; }
        .pay-summary.show { display: block; }
        .pay-summary.show + .hero-default { display: none; }

        /* ===================== Formulaire ===================== */
        .body { padding: 6px 22px 26px; }

        .header { margin-bottom: 20px; }
        .header h2 { font-size: 22px; font-weight: 800; letter-spacing: -0.4px; }
        .header p { margin-top: 6px; font-size: 14px; line-height: 1.55; color: var(--muted); }

        .api-message {
            display: none;
            padding: 13px 14px 13px 42px;
            border-radius: 16px;
            font-size: 13.5px;
            font-weight: 500;
            line-height: 1.5;
            margin-bottom: 16px;
            position: relative;
            overflow-wrap: break-word;
            animation: slideDown 0.25s ease;
        }

        .api-message::before {
            content: '';
            position: absolute;
            left: 15px;
            top: 50%;
            width: 17px;
            height: 17px;
            margin-top: -8.5px;
            background: currentColor;
            -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z'/%3E%3C/svg%3E") center / contain no-repeat;
            mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z'/%3E%3C/svg%3E") center / contain no-repeat;
        }

        .api-message.show { display: block; }
        .api-message.success { background: rgba(52, 209, 122, 0.12); color: #5ee39a; }
        .api-message.error { background: rgba(255, 91, 91, 0.12); color: #ff8080; }
        .api-message.info { background: rgba(253, 181, 21, 0.12); color: var(--gold-light); }

        @keyframes slideDown {
            from { opacity: 0; transform: translateY(-6px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .form-group { margin-bottom: 18px; position: relative; }

        .form-group label {
            display: block;
            margin-bottom: 9px;
            font-size: 14px;
            font-weight: 700;
            color: #fff;
        }

        .form-group label .req { color: var(--err); margin-left: 3px; }

        .form-group input {
            width: 100%;
            height: 56px;
            padding: 0 18px;
            font-family: inherit;
            font-size: 15px;
            color: var(--text);
            background: var(--field);
            border: 1.5px solid transparent;
            border-radius: 16px;
            outline: none;
            transition: border-color 0.2s ease, background 0.2s ease;
        }

        .form-group input::placeholder { color: var(--faint); }
        .form-group input:hover { background: var(--field-hover); }
        .form-group input:focus { border-color: var(--gold); background: var(--field); }
        .form-group input:disabled { opacity: 0.55; cursor: not-allowed; }

        .form-group.error input { border-color: var(--err); }
        .form-group.success input { border-color: rgba(52, 209, 122, 0.6); }

        .form-group .error-message { display: none; margin-top: 8px; font-size: 12.5px; line-height: 1.45; color: #ff8080; }
        .form-group.error .error-message { display: block; animation: slideDown 0.2s ease; }

        /* Indicatif + numéro : deux blocs comme dans l'application */
        .phone-wrapper { display: flex; gap: 10px; height: 56px; }

        .country-select {
            position: relative;
            flex: 0 0 auto;
            width: 118px;
            background: var(--field);
            border: 1.5px solid transparent;
            border-radius: 16px;
            transition: border-color 0.2s ease, background 0.2s ease;
        }

        .country-select:hover { background: var(--field-hover); }
        .country-select:focus-within { border-color: var(--gold); }

        .country-select::after {
            content: '';
            position: absolute;
            right: 14px;
            top: 50%;
            width: 7px;
            height: 7px;
            margin-top: -5px;
            border-right: 2px solid var(--muted);
            border-bottom: 2px solid var(--muted);
            transform: rotate(45deg);
            pointer-events: none;
        }

        .country-select select {
            width: 100%;
            height: 100%;
            padding: 0 32px 0 16px;
            font-family: inherit;
            font-size: 15px;
            font-weight: 700;
            color: var(--text);
            background: transparent;
            border: none;
            outline: none;
            appearance: none;
            -webkit-appearance: none;
            cursor: pointer;
            text-overflow: ellipsis;
        }

        .country-select select option { background: #2a2a2d; color: #fff; }

        .phone-wrapper input { flex: 1 1 auto; min-width: 0; height: 100%; }

        .form-group.error .country-select { border-color: var(--err); }

        /* Afficher / masquer le mot de passe */
        .form-group.password-with-toggle input { padding-right: 54px; }

        .toggle-password-btn {
            position: absolute;
            right: 8px;
            top: 36px;
            width: 42px;
            height: 42px;
            display: grid;
            place-items: center;
            border: none;
            border-radius: 12px;
            background: transparent;
            color: var(--muted);
            cursor: pointer;
        }

        .toggle-password-btn:hover { color: #fff; }
        .toggle-password-btn:focus { outline: none; }
        .toggle-password-btn:focus-visible { outline: 2px solid var(--gold); }
        .toggle-password-btn.active { color: var(--gold); }
        .toggle-password-btn .eye-icon { width: 20px; height: 20px; }

        /* Bouton principal : pilule dorée */
        .btn {
            width: 100%;
            height: 58px;
            margin-top: 10px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            font-family: inherit;
            font-size: 16px;
            font-weight: 800;
            color: var(--ink);
            background: var(--gold);
            border: none;
            border-radius: 999px;
            cursor: pointer;
            transition: background 0.2s ease, transform 0.15s ease, opacity 0.2s ease;
        }

        .btn:hover:not(:disabled) { background: var(--gold-light); }
        .btn:active:not(:disabled) { transform: scale(0.985); }
        .btn:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }

        .spinner {
            display: none;
            width: 19px;
            height: 19px;
            border: 2.5px solid rgba(17, 17, 17, 0.25);
            border-top-color: var(--ink);
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
        }

        .btn.loading .spinner { display: inline-block; }
        .btn.loading .btn-text { display: inline; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Code OTP */
        .otp-container { display: none; animation: slideDown 0.25s ease; }
        .otp-container.show { display: block; }
        .otp-container > label { display: block; margin-bottom: 12px; font-size: 14px; font-weight: 700; color: #fff; }

        .otp-inputs { display: grid; grid-template-columns: repeat(6, 1fr); gap: 9px; }

        .otp-inputs input {
            width: 100%;
            height: 58px;
            text-align: center;
            font-family: inherit;
            font-size: 24px;
            font-weight: 800;
            color: #fff;
            background: var(--field);
            border: 1.5px solid transparent;
            border-radius: 16px;
            outline: none;
            caret-color: var(--gold);
            transition: border-color 0.2s ease, background 0.2s ease;
        }

        .otp-inputs input:focus { border-color: var(--gold); }
        .otp-inputs input.filled { background: rgba(253, 181, 21, 0.14); color: var(--gold-light); }
        .otp-inputs input.error { border-color: var(--err); }
        .otp-inputs input:disabled { opacity: 0.5; cursor: not-allowed; }

        .otp-error-message { display: none; margin-top: 10px; font-size: 12.5px; color: #ff8080; text-align: center; }
        .otp-error-message.show { display: block; }

        .otp-timer { display: flex; justify-content: center; gap: 10px; margin: 16px 0 4px; font-size: 13.5px; color: var(--muted); }
        .otp-timer a { color: var(--gold); font-weight: 700; text-decoration: none; }
        .otp-timer a:hover { text-decoration: underline; }

        .hidden-fields.hide { display: none !important; }

        /* ===================== Mot de passe oublié ===================== */
        .forgot-row { margin-top: 10px; text-align: right; }
        .form-group.error .forgot-row + .error-message { margin-top: 4px; }
        .forgot-row a, .back-link { color: var(--gold); font-size: 13.5px; font-weight: 700; text-decoration: none; }
        .forgot-row a:hover { text-decoration: underline; }
        .hidden-fields.hide .forgot-row { display: none; }

        .forgot-state { display: none; animation: slideDown 0.25s ease; }
        .forgot-state.show { display: block; }
        .forgot-mode #loginState { display: none; }

        .back-link { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 16px; color: var(--muted); }
        .back-link:hover { color: #fff; }
        .back-link svg { width: 18px; height: 18px; }

        .sent-to {
            margin-bottom: 18px;
            padding: 12px 14px;
            border-radius: 14px;
            font-size: 13.5px;
            line-height: 1.5;
            color: var(--muted);
            background: rgba(255, 255, 255, 0.05);
        }

        .sent-to b { color: #fff; }

        #fpCodeBoxes input { height: 58px; padding: 0; text-align: center; font-size: 24px; font-weight: 800; border-radius: 16px; }
        #fpCodeGroup.error #fpCodeBoxes input { border-color: var(--err); }
        @media (max-width: 380px) { #fpCodeBoxes input { height: 50px; font-size: 20px; border-radius: 13px; } }
        @media (max-width: 339px) { #fpCodeBoxes input { height: 44px; font-size: 18px; border-radius: 11px; } }

        .pass-rules { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }

        .pass-rules li {
            padding: 5px 10px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            color: var(--faint);
            background: rgba(255, 255, 255, 0.05);
            transition: color 0.2s ease, background 0.2s ease;
        }

        .pass-rules li.ok { color: #5ee39a; background: rgba(52, 209, 122, 0.12); }

        .form-links { margin-top: 20px; text-align: center; font-size: 14px; }
        .form-links a { color: var(--gold); font-weight: 700; text-decoration: none; }
        .form-links a:hover { text-decoration: underline; }

        .legal { margin-top: 18px; text-align: center; font-size: 12.5px; line-height: 1.5; color: var(--faint); }

        /* ===================== Sélecteur de pays personnalisé ===================== */
        .country-select.cs-ready::after { display: none; }
        .country-select.cs-ready select {
            position: absolute; inset: 0; width: 100%; height: 100%;
            opacity: 0; pointer-events: none;
        }

        .cs-trigger {
            width: 100%; height: 100%;
            display: flex; align-items: center; gap: 8px;
            padding: 0 12px 0 12px;
            font-family: inherit; font-size: 15px; font-weight: 700; color: var(--text);
            background: transparent; border: none; border-radius: 16px;
            cursor: pointer; text-align: left;
        }

        .cs-trigger:focus { outline: none; }
        .country-select:has(.cs-trigger:focus-visible) { border-color: var(--gold); }
        .cs-trigger .cs-code { flex: 1 1 auto; white-space: nowrap; }
        .cs-trigger .cs-chev { width: 16px; height: 16px; color: var(--muted); transition: transform 0.2s ease; flex: 0 0 auto; }
        .country-select.cs-open { border-color: var(--gold); }
        .country-select.cs-open .cs-chev { transform: rotate(180deg); color: var(--gold); }

        .cs-flag {
            width: 26px; height: 18px; flex: 0 0 auto;
            border-radius: 4px; object-fit: cover;
            background: rgba(255, 255, 255, 0.1);
            display: inline-grid; place-items: center;
            font-size: 9px; font-weight: 800; color: var(--muted); letter-spacing: 0.3px;
            overflow: hidden;
        }

        /* Fond (téléphones / tablettes) */
        .cs-overlay {
            position: fixed; inset: 0; z-index: 9998;
            background: rgba(0, 0, 0, 0.62);
            opacity: 0; transition: opacity 0.2s ease;
        }
        .cs-overlay.show { opacity: 1; }

        .cs-panel {
            position: fixed; z-index: 9999;
            display: flex; flex-direction: column;
            background: #222225;
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: var(--text);
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
        }

        /* Ordinateur : liste sous le champ */
        .cs-panel.cs-drop {
            width: 320px; max-height: 360px;
            border-radius: 18px;
            opacity: 0; transform: translateY(-6px);
            transition: opacity 0.15s ease, transform 0.15s ease;
        }
        .cs-panel.cs-drop.show { opacity: 1; transform: translateY(0); }

        /* Téléphones et tablettes : feuille qui monte du bas de l'écran */
        .cs-panel.cs-sheet {
            left: 50%; bottom: 0;
            width: 100%; max-width: 560px;
            max-height: min(78vh, 640px);
            border-radius: 26px 26px 0 0;
            border-bottom: none;
            padding-bottom: env(safe-area-inset-bottom);
            transform: translate(-50%, 100%);
            transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .cs-panel.cs-sheet.show { transform: translate(-50%, 0); }

        .cs-handle { width: 42px; height: 5px; margin: 10px auto 2px; border-radius: 5px; background: rgba(255, 255, 255, 0.22); }
        .cs-drop .cs-handle { display: none; }

        .cs-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px 6px; }
        .cs-head b { font-size: 17px; font-weight: 800; }
        .cs-drop .cs-head { display: none; }

        .cs-close {
            width: 34px; height: 34px; display: grid; place-items: center;
            border: none; border-radius: 50%; cursor: pointer;
            color: var(--muted); background: rgba(255, 255, 255, 0.08);
        }
        .cs-close svg { width: 16px; height: 16px; }

        .cs-search { position: relative; padding: 10px 14px; }
        .cs-search svg { position: absolute; left: 28px; top: 50%; width: 17px; height: 17px; margin-top: -8.5px; color: var(--faint); pointer-events: none; }
        .cs-search input {
            width: 100%; height: 46px; padding: 0 14px 0 42px;
            font-family: inherit; font-size: 15px; color: var(--text);
            background: #2d2d31; border: 1.5px solid transparent; border-radius: 14px; outline: none;
        }
        .cs-search input:focus { border-color: var(--gold); }
        .cs-search input::placeholder { color: var(--faint); }

        .cs-list { list-style: none; overflow-y: auto; padding: 4px 8px 12px; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }

        .cs-item {
            display: flex; align-items: center; gap: 12px;
            padding: 12px 12px; border-radius: 13px;
            cursor: pointer; user-select: none;
        }
        .cs-item:hover, .cs-item.cs-active { background: rgba(255, 255, 255, 0.06); }
        .cs-item.cs-selected { background: rgba(253, 181, 21, 0.12); }
        .cs-item .cs-name { flex: 1 1 auto; font-size: 15px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cs-item .cs-pre { font-size: 14px; font-weight: 700; color: var(--muted); }
        .cs-item.cs-selected .cs-pre { color: var(--gold); }
        .cs-item .cs-check { width: 18px; height: 18px; color: var(--gold); visibility: hidden; flex: 0 0 auto; }
        .cs-item.cs-selected .cs-check { visibility: visible; }
        .cs-empty { padding: 26px 12px; text-align: center; font-size: 14px; color: var(--faint); }

        .cs-list::-webkit-scrollbar { width: 6px; }
        .cs-list::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 6px; }

        /* ===================== RESPONSIVE (tous les écrans) ===================== */

        /* Téléphones : carte plein écran, zones sûres (encoche, barre du bas) */
        @media (max-width: 519px) {
            body { padding: 0; align-items: stretch; }
            .page { gap: 0; }
            .container { min-height: 100vh; min-height: 100dvh; }
            .hero { padding-top: calc(18px + env(safe-area-inset-top)); }
            .body { padding-bottom: calc(26px + env(safe-area-inset-bottom)); }
        }

        /* Petits téléphones (320–380 px) */
        @media (max-width: 380px) {
            .hero, .body { padding-left: 16px; padding-right: 16px; }
            .hero { padding-bottom: 44px; }
            .hero-center { margin-top: 22px; }
            .hero-center .big { font-size: 28px; }
            .header h2 { font-size: 20px; }
            .country-select { width: 100px; }
            .country-select select { padding-left: 12px; padding-right: 26px; font-size: 14px; }
            .phone-wrapper { gap: 8px; }
            .form-group input, .phone-wrapper { height: 52px; }
            .toggle-password-btn { top: 34px; }
            .otp-inputs { gap: 6px; }
            .otp-inputs input { height: 50px; font-size: 20px; border-radius: 13px; }
            .btn { height: 54px; }
            .secure span { display: none; }
        }

        /* Très petits écrans (moins de 340 px) */
        @media (max-width: 339px) {
            .otp-inputs { gap: 4px; }
            .otp-inputs input { height: 44px; font-size: 18px; border-radius: 11px; }
            .hero-pill { padding: 9px 16px; font-size: 12px; }
        }

        /* Tablettes et petits portables : carte centrée */
        @media (min-width: 520px) and (max-width: 959px) {
            body { padding: 32px 24px; }
            .container { max-width: 460px; }
        }

        /* Téléphone à l'horizontale / écrans peu hauts : bandeau compact */
        @media (max-height: 560px) and (orientation: landscape) {
            body { align-items: flex-start; padding: 16px; }
            .container { min-height: 0; border-radius: 24px; border: 1px solid rgba(255, 255, 255, 0.08); }
            .hero { padding-bottom: 30px; }
            .hero-center { margin-top: 12px; }
            .hero-center .big { font-size: 26px; }
            .hero-pill, .dots { display: none; }
            .showcase h3 { font-size: 32px; }
        }

        /* Portables (960–1199 px) */
        @media (min-width: 960px) and (max-width: 1199px) {
            .page { grid-template-columns: 1fr 420px; gap: 40px; }
            .showcase h3 { font-size: 40px; }
            .container { max-width: 420px; }
        }

        /* Ordinateurs peu hauts (1280×720, 1366×768…) : tout tient sans défiler */
        @media (min-width: 960px) and (max-height: 820px) {
            body { padding-top: 20px; padding-bottom: 20px; }
            .hero { padding-bottom: 30px; }
            .hero-center { margin-top: 14px; }
            .hero-center .big { font-size: 30px; }
            .hero-pill { margin-top: 12px; }
            .dots { display: none; }
            .header { margin-bottom: 14px; }
            .form-group { margin-bottom: 14px; }
            .form-group input, .phone-wrapper { height: 50px; }
            .toggle-password-btn { top: 32px; }
            .btn { height: 52px; }
            .legal { margin-top: 12px; }
        }

        /* Grands écrans */
        @media (min-width: 1600px) {
            .brand-mark .fpay-logo { height: 46px; }
            .page { max-width: 1280px; grid-template-columns: 1fr 470px; gap: 96px; }
            .container { max-width: 470px; }
            .showcase h3 { font-size: 60px; max-width: 640px; }
            .showcase p.lead { font-size: 19px; max-width: 580px; }
        }

        /* Très grands écrans (2K / 4K) */
        @media (min-width: 2200px) {
            html { font-size: 18px; }
            .page { max-width: 1500px; grid-template-columns: 1fr 540px; }
            .container { max-width: 540px; }
            .showcase h3 { font-size: 72px; }
        }

        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { animation: none !important; transition: none !important; }
        }
    </style>
</head>
<body>
    <div class="page">
        <section class="showcase" aria-hidden="true">
            <div class="brand-row">
                <div class="brand-mark"><span class="fpay-logo" role="img" aria-label="F-Pay"></span></div>
                <div>
                    <div class="brand-tag">L'argent qui voyage à la vitesse de la vie</div>
                </div>
            </div>

            <h3>Envoyez, recevez et retirez <span>où que vous soyez.</span></h3>
            <p class="lead">Connectez votre compte Favor Pay pour payer en toute sécurité. Vos identifiants restent chez Favor Pay et chaque connexion est confirmée par un code SMS.</p>

        </section>

        <div class="container">
            <div class="hero">
                <svg class="waves" viewBox="0 0 440 300" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M-20 120 C 90 60, 180 170, 300 110 S 470 60, 470 60 L 470 -20 L -20 -20 Z" fill="rgba(255,255,255,0.10)"/>
                    <path d="M-20 175 C 110 120, 210 225, 330 160 S 470 120, 470 120 L 470 -20 L -20 -20 Z" fill="rgba(255,255,255,0.06)"/>
                    <path d="M-20 70 C 80 30, 160 110, 260 70 S 470 20, 470 20" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.2"/>
                </svg>

                <div class="hero-top">
                    <div class="logo">
                        <span class="fpay-logo" role="img" aria-label="F-Pay"></span>
                    </div>
                    <span class="secure"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><span>Sécurisé</span></span>
                </div>

                <div class="hero-center">
                    <!-- Montant transmis par l'application partenaire (sinon : texte d'accueil) -->
                    <div class="pay-summary" id="paySummary">
                        <small id="paySummaryCurrency">Paiement demandé</small>
                        <div class="big" id="paySummaryAmount"></div>
                        <div class="hero-pill" id="paySummaryDesc">Paiement Favor Pay</div>
                    </div>
                    <div class="hero-default">
                        <small>Bienvenue sur</small>
                        <div class="big">Favor Pay</div>
                        <div class="hero-pill">Connexion à votre portefeuille</div>
                    </div>
                </div>

                <div class="dots"><i></i><i></i></div>
            </div>

            <div class="body">
                <div id="loginState">
                    <div class="header">
                        <h2 id="formTitle">Se connecter</h2>
                        <p id="stepMessage">Veuillez saisir le numéro de téléphone et le mot de passe associé à votre compte</p>
                    </div>

                    <!-- BANDEAU MESSAGE API -->
                    <div class="api-message" id="apiMessage"></div>

                    <form id="loginForm" autocomplete="off" novalidate>
                        <div id="hiddenFields" class="hidden-fields">
                            <div class="form-group" id="fullNameGroup" style="display:none;">
                                <label for="fullName">Nom complet<span class="req">*</span></label>
                                <input type="text" id="fullName" placeholder="Votre nom complet" autocomplete="off">
                                <div class="error-message" id="fullNameError">Le nom complet est requis</div>
                            </div>

                            <div class="form-group" id="phoneGroup">
                                <label for="phone">Numéro Mobile Money<span class="req">*</span></label>
                                <div class="phone-wrapper">
                                    <div class="country-select">
                                        <select id="countryCode" autocomplete="off" aria-label="Indicatif du pays">
                                        </select>
                                    </div>
                                    <input type="tel" id="phone" placeholder="Numéro de téléphone" autocomplete="off" inputmode="tel">
                                </div>
                                <div class="error-message" id="phoneError">Le numéro de téléphone est requis</div>
                            </div>

                            <div class="form-group" id="passwordGroup">
                                <label for="password">Mot de passe<span class="req">*</span></label>
                                <input type="password" id="password" placeholder="Votre mot de passe" autocomplete="new-password">
                                <div class="forgot-row" id="forgotRow"><a href="#" id="forgotLink">Mot de passe oublié ?</a></div>
                                <div class="error-message" id="passwordError">Le mot de passe doit contenir au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial</div>
                            </div>

                            <div class="form-group" id="confirmPasswordGroup" style="display:none;">
                                <label for="confirmPassword">Confirmer le mot de passe<span class="req">*</span></label>
                                <input type="password" id="confirmPassword" placeholder="Confirmez votre mot de passe" autocomplete="new-password">
                                <div class="error-message" id="confirmPasswordError">Les mots de passe ne correspondent pas</div>
                            </div>
                        </div>

                        <div class="otp-container" id="otpContainer">
                            <label>Code de vérification<span class="req" style="color:#ff5b5b;margin-left:3px;">*</span></label>
                            <div class="otp-inputs" id="otpInputs">
                                <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" data-index="0" aria-label="Chiffre 1">
                                <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" data-index="1" aria-label="Chiffre 2">
                                <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" data-index="2" aria-label="Chiffre 3">
                                <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" data-index="3" aria-label="Chiffre 4">
                                <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" data-index="4" aria-label="Chiffre 5">
                                <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" data-index="5" aria-label="Chiffre 6">
                            </div>
                            <div class="otp-error-message" id="otpError">Le code OTP est requis</div>
                            <div class="otp-timer">
                                <span id="otpTimer"></span>
                                <a href="#" id="resendOtpLink">Renvoyer le code</a>
                            </div>
                        </div>

                        <button type="submit" class="btn" id="submitBtn">
                            <span class="spinner" id="submitSpinner"></span>
                            <span class="btn-text" id="btnText">Se connecter</span>
                        </button>
                    </form>

                    <div class="form-links">
                        <a href="#" id="toggleFormLink" class="register-link">Créer un compte</a>
                    </div>
                </div>

                <!-- ===================== MOT DE PASSE OUBLIÉ ===================== -->
                <div id="forgotState" class="forgot-state">
                    <a href="#" class="back-link" id="forgotBack">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                        Retour à la connexion
                    </a>

                    <div class="header">
                        <h2 id="forgotTitle">Mot de passe oublié</h2>
                        <p id="forgotMessage">Saisissez le numéro de votre compte. Nous vous enverrons un code par SMS pour choisir un nouveau mot de passe.</p>
                    </div>

                    <div class="api-message" id="forgotApiMessage"></div>

                    <form id="forgotForm" autocomplete="off" novalidate>
                        <!-- Étape 1 : numéro -->
                        <div id="forgotStep1">
                            <div class="form-group" id="fpPhoneGroup">
                                <label for="fpPhone">Numéro du compte<span class="req">*</span></label>
                                <div class="phone-wrapper">
                                    <div class="country-select">
                                        <select id="fpCountry" aria-label="Indicatif du pays"></select>
                                    </div>
                                    <input type="tel" id="fpPhone" placeholder="Numéro de téléphone" autocomplete="off" inputmode="tel">
                                </div>
                                <div class="error-message" id="fpPhoneError">Saisissez un numéro de téléphone valide</div>
                            </div>
                        </div>

                        <!-- Étape 2 : code + nouveau mot de passe -->
                        <div id="forgotStep2" style="display:none;">
                            <div class="sent-to" id="fpSentTo"></div>

                            <div class="form-group" id="fpCodeGroup">
                                <label>Code reçu par SMS<span class="req">*</span></label>
                                <div class="otp-inputs" id="fpCodeBoxes">
                                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="one-time-code" aria-label="Chiffre 1">
                                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" aria-label="Chiffre 2">
                                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" aria-label="Chiffre 3">
                                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" aria-label="Chiffre 4">
                                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" aria-label="Chiffre 5">
                                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off" aria-label="Chiffre 6">
                                </div>
                                <div class="error-message" id="fpCodeError">Saisissez les 6 chiffres du code</div>
                            </div>

                            <div class="otp-timer">
                                <span id="fpTimer"></span>
                                <a href="#" id="fpResend" style="display:none;">Renvoyer le code</a>
                            </div>
                        </div>

                        <!-- Étape 3 : nouveau mot de passe -->
                        <div id="forgotStep3" style="display:none;">

                            <div class="form-group password-with-toggle" id="fpPassGroup">
                                <label for="fpPass">Nouveau mot de passe<span class="req">*</span></label>
                                <input type="password" id="fpPass" placeholder="Nouveau mot de passe" autocomplete="new-password">
                                <button type="button" class="toggle-password-btn" data-target="fpPass" aria-label="Afficher le mot de passe">
                                    <svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                                </button>
                                <ul class="pass-rules" id="fpRules">
                                    <li data-rule="len">8 caractères minimum</li>
                                    <li data-rule="up">Une majuscule</li>
                                    <li data-rule="low">Une minuscule</li>
                                    <li data-rule="num">Un chiffre</li>
                                    <li data-rule="spe">Un caractère spécial</li>
                                </ul>
                                <div class="error-message" id="fpPassError">Le mot de passe ne respecte pas toutes les règles</div>
                            </div>

                            <div class="form-group" id="fpConfirmGroup">
                                <label for="fpConfirm">Confirmer le mot de passe<span class="req">*</span></label>
                                <input type="password" id="fpConfirm" placeholder="Confirmez le mot de passe" autocomplete="new-password">
                                <div class="error-message" id="fpConfirmError">Les mots de passe ne correspondent pas</div>
                            </div>
                        </div>

                        <button type="submit" class="btn" id="fpSubmit">
                            <span class="spinner"></span>
                            <span class="btn-text" id="fpBtnText">Recevoir le code</span>
                        </button>
                    </form>
                </div>

                <p class="legal">Connexion sécurisée par Favor Pay · Ne partagez jamais votre code</p>
            </div>
        </div>
    </div>
    <script>
        (function() {
            'use strict';

            var API_BASE_URL = window.location.origin;
            var APP_URL = '${appUrl}';
            var FRONTEND_URL = '${frontendUrl}';
            var OAUTH_CALLBACK_URL = '${callbackUrl}';
            var MOBILE_CALLBACK_URL = '${mobileCallbackUrl}';
            var ENV = '${env}';
            var SYSTEM_USER_ID = '${systemUserId}';
            var AMOUNT = '${amount}';
            var CURRENCY = '${currency}';
            var DESCRIPTION = '${description}';
            var API_KEY = '${apiKey}';
            var CLIENT_TOKEN = '${clientToken}';
            var REDIRECT_URI = '${callbackUrl}';

            var form = document.getElementById('loginForm');
            var hiddenFields = document.getElementById('hiddenFields');
            var phoneInput = document.getElementById('phone');
            var passwordInput = document.getElementById('password');
            var confirmPasswordInput = document.getElementById('confirmPassword');
            var fullNameInput = document.getElementById('fullName');
            var phoneGroup = document.getElementById('phoneGroup');
            var passwordGroup = document.getElementById('passwordGroup');
            var confirmPasswordGroup = document.getElementById('confirmPasswordGroup');
            var fullNameGroup = document.getElementById('fullNameGroup');
            var phoneError = document.getElementById('phoneError');
            var passwordError = document.getElementById('passwordError');
            var confirmPasswordError = document.getElementById('confirmPasswordError');
            var fullNameError = document.getElementById('fullNameError');
            var submitBtn = document.getElementById('submitBtn');
            var btnText = document.getElementById('btnText');
            var submitSpinner = document.getElementById('submitSpinner');
            var countrySelect = document.getElementById('countryCode');
            var toggleFormLink = document.getElementById('toggleFormLink');
            var formTitle = document.getElementById('formTitle');
            var stepMessage = document.getElementById('stepMessage');
            var otpContainer = document.getElementById('otpContainer');
            var otpInputs = document.querySelectorAll('#otpInputs input');
            var otpError = document.getElementById('otpError');
            var otpTimer = document.getElementById('otpTimer');
            var resendOtpLink = document.getElementById('resendOtpLink');
            var apiMessage = document.getElementById('apiMessage');

            var urlParams = new URLSearchParams(window.location.search);
            var REDIRECT_URI = urlParams.get('redirect_uri') || OAUTH_CALLBACK_URL;

            var userTokens = { accessToken: null, refreshToken: null, userId: null, code: null };
            var userData = null;
            var isSubmitting = false;
            var isRegisterMode = false;
            var registerStep = 'init';
            var tempRegisterData = null;
            var otpTimerInterval = null;
            var countriesData = [];
            var apiMessageTimeout = null;

            // ============================================================
            // AFFICHER LE MESSAGE DE L'API (remplace tous les popups)
            // ============================================================
            function showApiMessage(message, type) {
                if (apiMessageTimeout) {
                    clearTimeout(apiMessageTimeout);
                }

                apiMessage.className = 'api-message show ' + (type || 'info');
                apiMessage.textContent = message;

                // Ne pas masquer automatiquement les messages d'erreur
                if (type !== 'error') {
                    apiMessageTimeout = setTimeout(function() {
                        apiMessage.classList.remove('show');
                    }, 6000);
                }
            }

            function hideApiMessage() {
                if (apiMessageTimeout) {
                    clearTimeout(apiMessageTimeout);
                }
                apiMessage.classList.remove('show');
            }

            // ============================================================
            // VALIDATION MOT DE PASSE FORT
            // ============================================================
            var PASSWORD_SPECIAL_REGEX = /[!@#$%^&*()_+\\-=\\[\\]{};':"\\\\|,.<>\\/?~]/;

            function isPasswordStrong(password) {
                return password.length >= 8 &&
                       /[A-Z]/.test(password) &&
                       /[a-z]/.test(password) &&
                       /[0-9]/.test(password) &&
                       PASSWORD_SPECIAL_REGEX.test(password);
            }

            function getPasswordErrorMessage(password) {
                if (!password) return 'Le mot de passe est requis';
                if (password.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères';
                if (!/[A-Z]/.test(password)) return 'Le mot de passe doit contenir au moins une majuscule';
                if (!/[a-z]/.test(password)) return 'Le mot de passe doit contenir au moins une minuscule';
                if (!/[0-9]/.test(password)) return 'Le mot de passe doit contenir au moins un chiffre';
                if (!PASSWORD_SPECIAL_REGEX.test(password)) return 'Le mot de passe doit contenir au moins un caractère spécial';
                return '';
            }

            var EYE_OPEN_SVG = '<svg class="eye-icon eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';

            var EYE_CLOSED_SVG = '<svg class="eye-icon eye-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';

            function injectPasswordToggles() {
                [passwordGroup, confirmPasswordGroup].forEach(function(group) {
                    if (!group) return;
                    var input = group.querySelector('input[type="password"], input[type="text"]');
                    if (!input) return;
                    if (group.querySelector('.toggle-password-btn')) return;

                    group.classList.add('password-with-toggle');

                    var btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'toggle-password-btn';
                    btn.setAttribute('data-target', input.id);
                    btn.setAttribute('aria-label', 'Afficher le mot de passe');
                    btn.innerHTML = EYE_OPEN_SVG + EYE_CLOSED_SVG;

                    group.appendChild(btn);

                    btn.addEventListener('click', function(e) {
                        e.preventDefault();
                        e.stopPropagation();

                        var isPassword = input.type === 'password';
                        input.type = isPassword ? 'text' : 'password';

                        var eyeOpen = btn.querySelector('.eye-open');
                        var eyeClosed = btn.querySelector('.eye-closed');

                        if (isPassword) {
                            btn.classList.add('active');
                            if (eyeOpen) eyeOpen.style.display = 'none';
                            if (eyeClosed) eyeClosed.style.display = 'block';
                            btn.setAttribute('aria-label', 'Masquer le mot de passe');
                        } else {
                            btn.classList.remove('active');
                            if (eyeOpen) eyeOpen.style.display = 'block';
                            if (eyeClosed) eyeClosed.style.display = 'none';
                            btn.setAttribute('aria-label', 'Afficher le mot de passe');
                        }

                        input.focus();
                    });
                });
            }

            function getOtpCode() {
                var code = '';
                otpInputs.forEach(function(input) {
                    code += input.value.trim();
                });
                return code;
            }

            function clearOtpInputs() {
                otpInputs.forEach(function(input) {
                    input.value = '';
                    input.classList.remove('filled', 'error');
                });
                otpInputs[0].focus();
            }

            function setOtpError(show) {
                if (show) {
                    otpError.classList.add('show');
                    otpInputs.forEach(function(input) {
                        input.classList.add('error');
                    });
                } else {
                    otpError.classList.remove('show');
                    otpInputs.forEach(function(input) {
                        input.classList.remove('error');
                    });
                }
            }

            function hideFieldsForOtp() {
                hiddenFields.classList.add('hide');
                otpContainer.classList.add('show');
                btnText.textContent = 'Vérifier le code';
                stepMessage.textContent = 'Saisissez le code OTP reçu par SMS';
                document.querySelector('.form-links').style.display = 'none';
            }

            function showFieldsAfterOtp() {
                hiddenFields.classList.remove('hide');
                otpContainer.classList.remove('show');
                btnText.textContent = isRegisterMode ? 'Créer mon compte' : 'Se connecter';
                stepMessage.textContent = isRegisterMode ? 'Veuillez saisir vos informations pour créer votre compte' : 'Veuillez saisir le numéro de téléphone et le mot de passe associé à votre compte';
                document.querySelector('.form-links').style.display = 'block';
                setOtpError(false);
            }

            otpInputs.forEach(function(input, index) {
                input.addEventListener('input', function(e) {
                    this.value = this.value.replace(/\\D/g, '').slice(0, 1);
                    
                    if (this.value) {
                        this.classList.remove('error');
                        this.classList.add('filled');
                    } else {
                        this.classList.remove('filled');
                    }
                    
                    setOtpError(false);
                    
                    if (this.value && index < otpInputs.length - 1) {
                        otpInputs[index + 1].focus();
                    }
                    
                    var allFilled = true;
                    otpInputs.forEach(function(inp) {
                        if (!inp.value.trim()) allFilled = false;
                    });
                    if (allFilled && otpContainer.classList.contains('show')) {
                        form.dispatchEvent(new Event('submit'));
                    }
                });

                input.addEventListener('keydown', function(e) {
                    if (e.key === 'Backspace' && !this.value && index > 0) {
                        otpInputs[index - 1].focus();
                        otpInputs[index - 1].value = '';
                        otpInputs[index - 1].classList.remove('filled');
                    }
                    if (e.key === 'ArrowLeft' && index > 0) {
                        otpInputs[index - 1].focus();
                    }
                    if (e.key === 'ArrowRight' && index < otpInputs.length - 1) {
                        otpInputs[index + 1].focus();
                    }
                    if (e.key === 'Delete' && !this.value && index < otpInputs.length - 1) {
                        otpInputs[index + 1].focus();
                        otpInputs[index + 1].value = '';
                        otpInputs[index + 1].classList.remove('filled');
                    }
                });

                input.addEventListener('paste', function(e) {
                    e.preventDefault();
                    var pasteData = (e.clipboardData || window.clipboardData).getData('text');
                    pasteData = pasteData.replace(/\\D/g, '').slice(0, 6);
                    
                    for (var i = 0; i < pasteData.length && i < otpInputs.length; i++) {
                        otpInputs[i].value = pasteData[i] || '';
                        otpInputs[i].classList.add('filled');
                    }
                    
                    if (pasteData.length >= 6) {
                        form.dispatchEvent(new Event('submit'));
                    } else {
                        otpInputs[pasteData.length].focus();
                    }
                });
            });

            async function fetchCountries() {
                try {
                    var response = await fetch(API_BASE_URL + '/pawapay/countries', {
                        method: 'GET',
                        headers: {
                            'Accept': 'application/json',
                            'Authorization': 'Bearer ' + CLIENT_TOKEN
                        }
                    });

                    if (!response.ok) {
                        throw new Error('Erreur lors de la récupération des pays');
                    }

                    var result = await response.json();

                    if (result.data && result.data.length > 0) {
                        countriesData = result.data;
                        populateCountrySelect(countriesData);
                    } else {
                        setDefaultCountries();
                    }
                } catch (error) {
                    console.error('[Countries] Erreur:', error);
                    setDefaultCountries();
                }
            }

            function populateCountrySelect(countries) {
                if (!countrySelect) return;
                countrySelect.innerHTML = '';
                
                var codCountry = null;
                var otherCountries = [];
                
                countries.forEach(function(country) {
                    if (country.prefix) {
                        if (country.countryCode === 'COD' || country.code === 'COD') {
                            codCountry = country;
                        } else {
                            otherCountries.push(country);
                        }
                    }
                });

                if (codCountry) {
                    var option = document.createElement('option');
                    option.value = codCountry.prefix;
                    option.text = codCountry.prefix;
                    option.dataset.countryCode = codCountry.countryCode || codCountry.code;
                    option.dataset.name = codCountry.name;
                    option.dataset.currency = codCountry.default_currency;
                    option.selected = true;
                    countrySelect.appendChild(option);
                }

                otherCountries.forEach(function(country) {
                    var option = document.createElement('option');
                    option.value = country.prefix;
                    option.text = country.prefix;
                    option.dataset.countryCode = country.countryCode || country.code;
                    option.dataset.name = country.name;
                    option.dataset.currency = country.default_currency;
                    countrySelect.appendChild(option);
                });

                if (countrySelect.options.length === 0) {
                    setDefaultCountries();
                }
            }

            function setDefaultCountries() {
                if (!countrySelect) return;
                var defaultCountries = [
                    { prefix: '243', countryCode: 'COD', name: 'Congo-Kinshasa' },
                    { prefix: '229', countryCode: 'BEN', name: 'Bénin' }
                ];
                countrySelect.innerHTML = '';
                defaultCountries.forEach(function(country, index) {
                    var option = document.createElement('option');
                    option.value = country.prefix;
                    option.text = country.prefix;
                    option.dataset.countryCode = country.countryCode;
                    option.dataset.name = country.name;
                    if (index === 0) {
                        option.selected = true;
                    }
                    countrySelect.appendChild(option);
                });
            }

            function getSelectedCountryCode() {
                if (countrySelect && countrySelect.selectedIndex >= 0) {
                    var option = countrySelect.options[countrySelect.selectedIndex];
                    return option ? option.dataset.countryCode : 'COD';
                }
                return 'COD';
            }

            function getSelectedPrefix() {
                if (countrySelect && countrySelect.selectedIndex >= 0) {
                    return countrySelect.value;
                }
                return '243';
            }

            function startOtpTimer() {
                otpTimer.style.display = 'none';
                resendOtpLink.style.display = 'none';
                
                clearInterval(otpTimerInterval);
                otpTimerInterval = setInterval(function() {}, 1000);
                
                setTimeout(function() {
                    clearInterval(otpTimerInterval);
                    resendOtpLink.style.display = 'inline';
                }, 60000);
            }

            if (resendOtpLink) {
                resendOtpLink.addEventListener('click', function(e) {
                    e.preventDefault();
                    
                    if (isSubmitting) return;
                    
                    registerStep = 'init';
                    
                    if (!tempRegisterData) return;
                    
                    setLoading(true);
                    hideApiMessage();
                    
                    handleRegister(
                        phoneInput.value.trim(),
                        passwordInput.value.trim(),
                        fullNameInput.value.trim()
                    ).then(function(result) {
                        if (result.message) {
                            showApiMessage(result.message, 'success');
                        }
                        startOtpTimer();
                        clearOtpInputs();
                        setOtpError(false);
                        setLoading(false);
                    }).catch(function(error) {
                        showApiMessage(error.message || 'Erreur lors du renvoi du code', 'error');
                        setLoading(false);
                    });
                });
            }

            function validateOtp() {
                var code = getOtpCode();
                if (code.length < 6) {
                    setOtpError(true);
                    return false;
                }
                setOtpError(false);
                return true;
            }

            function setFieldSuccess(group) {
                group.classList.remove('error');
                group.classList.add('success');
            }

            function setFieldError(group, errorEl, message) {
                group.classList.remove('success');
                group.classList.add('error');
                if (message) errorEl.textContent = message;
            }

            function clearFieldState(group) {
                group.classList.remove('error', 'success');
            }

            function validateField(field) {
                if (field === 'phone') {
                    var phone = phoneInput.value.trim();
                    if (!phone) {
                        setFieldError(phoneGroup, phoneError, 'Le numéro de téléphone est requis');
                        return false;
                    }
                    setFieldSuccess(phoneGroup);
                    return true;
                }
                if (field === 'password') {
                    var password = passwordInput.value.trim();
                    if (!isPasswordStrong(password)) {
                        setFieldError(passwordGroup, passwordError, getPasswordErrorMessage(password));
                        return false;
                    }
                    setFieldSuccess(passwordGroup);
                    return true;
                }
                if (field === 'fullName') {
                    var fullName = fullNameInput.value.trim();
                    if (!fullName) {
                        setFieldError(fullNameGroup, fullNameError, 'Le nom complet est requis');
                        return false;
                    }
                    setFieldSuccess(fullNameGroup);
                    return true;
                }
                if (field === 'confirmPassword') {
                    var password = passwordInput.value.trim();
                    var confirm = confirmPasswordInput.value.trim();
                    if (!confirm || password !== confirm) {
                        setFieldError(confirmPasswordGroup, confirmPasswordError, 'Les mots de passe ne correspondent pas');
                        return false;
                    }
                    setFieldSuccess(confirmPasswordGroup);
                    return true;
                }
                return true;
            }

            phoneInput.addEventListener('blur', function() { validateField('phone'); });
            phoneInput.addEventListener('input', function() {
                var phone = this.value.trim();
                if (phone) setFieldSuccess(phoneGroup);
                else clearFieldState(phoneGroup);
            });

            passwordInput.addEventListener('blur', function() { validateField('password'); });
            passwordInput.addEventListener('input', function() {
                var password = this.value.trim();
                if (isPasswordStrong(password)) setFieldSuccess(passwordGroup);
                else clearFieldState(passwordGroup);
                if (isRegisterMode && confirmPasswordGroup.style.display !== 'none') {
                    validateField('confirmPassword');
                }
            });

            fullNameInput.addEventListener('blur', function() { validateField('fullName'); });
            fullNameInput.addEventListener('input', function() {
                var fullName = this.value.trim();
                if (fullName) setFieldSuccess(fullNameGroup);
                else clearFieldState(fullNameGroup);
            });

            confirmPasswordInput.addEventListener('blur', function() { validateField('confirmPassword'); });
            confirmPasswordInput.addEventListener('input', function() {
                var password = passwordInput.value.trim();
                var confirm = this.value.trim();
                if (confirm && password === confirm) setFieldSuccess(confirmPasswordGroup);
                else clearFieldState(confirmPasswordGroup);
            });

            function toggleMode(registerMode) {
                isRegisterMode = registerMode;
                registerStep = 'init';
                tempRegisterData = null;
                clearInterval(otpTimerInterval);
                hideApiMessage();
                showFieldsAfterOtp();
                
                if (registerMode) {
                    fullNameGroup.style.display = 'block';
                    confirmPasswordGroup.style.display = 'block';
                    btnText.textContent = 'Créer mon compte';
                    toggleFormLink.textContent = 'Se connecter';
                    formTitle.textContent = 'Créer un compte';
                    stepMessage.textContent = 'Veuillez saisir vos informations pour créer votre compte';
                    
                    fullNameInput.value = '';
                    if (countrySelect && countrySelect.options.length > 0) {
                        var codFound = false;
                        for (var i = 0; i < countrySelect.options.length; i++) {
                            if (countrySelect.options[i].dataset.countryCode === 'COD') {
                                countrySelect.selectedIndex = i;
                                codFound = true;
                                break;
                            }
                        }
                        if (!codFound) {
                            countrySelect.selectedIndex = 0;
                        }
                    }
                    phoneInput.value = '';
                    passwordInput.value = '';
                    confirmPasswordInput.value = '';
                    clearOtpInputs();
                    setOtpError(false);
                    
                    clearFieldState(fullNameGroup);
                    clearFieldState(confirmPasswordGroup);
                } else {
                    fullNameGroup.style.display = 'none';
                    confirmPasswordGroup.style.display = 'none';
                    btnText.textContent = 'Se connecter';
                    toggleFormLink.textContent = 'Créer un compte';
                    formTitle.textContent = 'Se connecter';
                    stepMessage.textContent = 'Veuillez saisir le numéro de téléphone et le mot de passe associé à votre compte';
                    
                    fullNameInput.value = '';
                    confirmPasswordInput.value = '';
                    clearOtpInputs();
                    setOtpError(false);
                    
                    clearFieldState(fullNameGroup);
                    clearFieldState(confirmPasswordGroup);
                }
                
                document.querySelectorAll('.form-group').forEach(function(g) {
                    g.classList.remove('error', 'success');
                });
            }

            toggleFormLink.addEventListener('click', function(e) {
                e.preventDefault();
                toggleMode(!isRegisterMode);
            });

            function setLoading(loading) {
                isSubmitting = loading;
                if (loading) {
                    submitBtn.classList.add('loading');
                    submitBtn.disabled = true;
                } else {
                    submitBtn.classList.remove('loading');
                    submitBtn.disabled = false;
                }
            }

            function cleanUrl() {
                if (window.history && window.history.replaceState) {
                    var cleanUrl = window.location.origin + window.location.pathname;
                    window.history.replaceState({}, document.title, cleanUrl);
                }
            }

            // ============================================================
            // SUCCÈS - Le spinner RESTE EN MARCHE jusqu'à la redirection
            // ============================================================
            function showSuccess(data) {
                userData = data.data;
                userTokens = {
                    accessToken: data.accessToken || (data.data && data.data.accessToken),
                    refreshToken: data.refreshToken || (data.data && data.data.refreshToken),
                    userId: data.data && data.data.id,
                    code: data.code || urlParams.get('code')
                };

                cleanUrl();

                // Afficher le message de succès de l'API
                var successMsg = data.message || 'Connexion réussie !';
                showApiMessage(successMsg, 'success');

                // ⚠️ NE PAS arrêter le spinner - il continue de tourner pendant la redirection
                // Le spinner ne s'arrêtera que si la redirection échoue

                setTimeout(function() {
                    handleRedirect();
                }, 600);
            }

            window.handleRedirect = function() {
                if (REDIRECT_URI.startsWith('fpay://')) {
                    var params = new URLSearchParams();
                    
                    if (userTokens.accessToken) params.set('access_token', userTokens.accessToken);
                    if (userTokens.refreshToken) params.set('refresh_token', userTokens.refreshToken);
                    if (userTokens.userId) params.set('user_id', userTokens.userId);
                    if (userTokens.code) params.set('code', userTokens.code);
                    if (SYSTEM_USER_ID) params.set('system_user_id', SYSTEM_USER_ID);
                    if (AMOUNT) params.set('amount', AMOUNT);
                    if (CURRENCY) params.set('currency', CURRENCY);
                    if (DESCRIPTION) params.set('description', DESCRIPTION);
                    if (API_KEY) params.set('api_key', API_KEY);
                    if (CLIENT_TOKEN) params.set('client_token', CLIENT_TOKEN);

                    if (userData) {
                        params.set('data_id', userData.id || '');
                        params.set('data_phone', userData.phone || '');
                        params.set('data_full_name', userData.full_name || '');
                        params.set('data_role', userData.role || '');
                        params.set('data_status', userData.status || '');
                        params.set('data_kycStatus', userData.kycStatus || '');
                        params.set('data_countryCode', userData.countryCode || 'COD');
                        if (userData.wallets) {
                            params.set('wallets', JSON.stringify(userData.wallets));
                        }
                    }

                    var finalUrl = REDIRECT_URI + '?' + params.toString();
                    window.location.href = finalUrl;
                    return;
                }

                try {
                    var redirectUrl = new URL(REDIRECT_URI);
                    
                    if (userTokens.accessToken) redirectUrl.searchParams.set('access_token', userTokens.accessToken);
                    if (userTokens.refreshToken) redirectUrl.searchParams.set('refresh_token', userTokens.refreshToken);
                    if (userTokens.userId) redirectUrl.searchParams.set('user_id', userTokens.userId);
                    if (userTokens.code) redirectUrl.searchParams.set('code', userTokens.code);
                    if (SYSTEM_USER_ID) redirectUrl.searchParams.set('system_user_id', SYSTEM_USER_ID);
                    if (AMOUNT) redirectUrl.searchParams.set('amount', AMOUNT);
                    if (CURRENCY) redirectUrl.searchParams.set('currency', CURRENCY);
                    if (DESCRIPTION) redirectUrl.searchParams.set('description', DESCRIPTION);
                    if (API_KEY) redirectUrl.searchParams.set('api_key', API_KEY);
                    if (CLIENT_TOKEN) redirectUrl.searchParams.set('client_token', CLIENT_TOKEN);

                    if (userData) {
                        redirectUrl.searchParams.set('data_id', userData.id || '');
                        redirectUrl.searchParams.set('data_phone', userData.phone || '');
                        redirectUrl.searchParams.set('data_full_name', userData.full_name || '');
                        redirectUrl.searchParams.set('data_role', userData.role || '');
                        redirectUrl.searchParams.set('data_status', userData.status || '');
                        redirectUrl.searchParams.set('data_kycStatus', userData.kycStatus || '');
                        redirectUrl.searchParams.set('data_countryCode', userData.countryCode || 'COD');
                        if (userData.wallets) {
                            redirectUrl.searchParams.set('wallets', JSON.stringify(userData.wallets));
                        }
                    }

                    window.location.href = redirectUrl.toString();
                } catch (error) {
                    console.error('[OAuth] Erreur redirection:', error);
                    // En cas d'erreur de redirection, on affiche un message et on arrête le spinner
                    showApiMessage('Erreur lors de la redirection', 'error');
                    setLoading(false);
                    
                    var fallbackUrl = REDIRECT_URI + '?access_token=' + encodeURIComponent(userTokens.accessToken || '') +
                        '&refresh_token=' + encodeURIComponent(userTokens.refreshToken || '') +
                        '&user_id=' + encodeURIComponent(userTokens.userId || '') +
                        '&client_token=' + encodeURIComponent(CLIENT_TOKEN || '');
                    window.location.href = fallbackUrl;
                }
            };

            function focusFirstError() {
                if (phoneGroup.classList.contains('error')) { phoneInput.focus(); return true; }
                if (passwordGroup.classList.contains('error')) { passwordInput.focus(); return true; }
                if (isRegisterMode) {
                    if (fullNameGroup.classList.contains('error')) { fullNameInput.focus(); return true; }
                    if (confirmPasswordGroup.classList.contains('error')) { confirmPasswordInput.focus(); return true; }
                }
                return false;
            }

            async function handleRegister(phone, password, fullName) {
                var prefix = getSelectedPrefix();
                var countryCode = getSelectedCountryCode();
                var fullPhone = '+' + prefix + phone;
                
                if (registerStep === 'init') {
                    var registerData = {
                        full_name: fullName,
                        phone: fullPhone,
                        password: password,
                        countryCode: countryCode,
                        account_number: 'FP' + Date.now().toString().slice(-8),
                        platform: 'web',
                        deviceInfo: 'OAuth Web'
                    };

                    var response = await fetch(API_BASE_URL + '/auth/register', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(registerData)
                    });

                    var result = await response.json();

                    if (!response.ok) {
                        throw new Error(result.message || 'Erreur lors de envoi');
                    }

                    tempRegisterData = registerData;
                    registerStep = 'verify';
                    
                    return { 
                        step: 'verify', 
                        message: result.message || 'Un code OTP a été envoyé par SMS',
                        data: result 
                    };
                }

                if (registerStep === 'verify') {
                    var otpCode = getOtpCode();
                    
                    if (otpCode.length < 6) {
                        setOtpError(true);
                        throw new Error('Veuillez saisir le code OTP complet (6 chiffres)');
                    }

                    var registerDataWithOtp = {
                        ...tempRegisterData,
                        otpCode: otpCode
                    };

                    var response = await fetch(API_BASE_URL + '/auth/register', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(registerDataWithOtp)
                    });

                    var result = await response.json();

                    if (!response.ok) {
                        throw new Error(result.message || 'Code OTP invalide ou expiré');
                    }

                    registerStep = 'init';
                    tempRegisterData = null;

                    return { 
                        step: 'done', 
                        message: result.message || 'Compte créé avec succès !',
                        data: result 
                    };
                }
            }

            // ============================================================
            // SOUMISSION DU FORMULAIRE
            // ============================================================
            form.addEventListener('submit', async function(e) {
                e.preventDefault();

                if (isSubmitting) return;
                
                hideApiMessage();

                // CAS 1 : Vérification OTP
                if (isRegisterMode && registerStep === 'verify') {
                    var otpValid = validateOtp();
                    if (!otpValid) {
                        showApiMessage('Veuillez saisir le code OTP complet (6 chiffres)', 'error');
                        return;
                    }
                    
                    setLoading(true);
                    
                    try {
                        var result = await handleRegister(
                            phoneInput.value.trim(),
                            passwordInput.value.trim(),
                            fullNameInput.value.trim()
                        );
                        
                        if (result.step === 'done') {
                            var prefix = getSelectedPrefix();
                            var loginResponse = await fetch(API_BASE_URL + '/auth/login', {
                                method: 'POST',
                                headers: { 
                                    'Content-Type': 'application/json',
                                    'Accept': 'application/json'
                                },
                                body: JSON.stringify({
                                    phone: '+' + prefix + phoneInput.value.trim(),
                                    password: passwordInput.value.trim(),
                                    deviceInfo: 'OAuth Web',
                                    platform: 'web'
                                })
                            });

                            var loginData = await loginResponse.json();

                            if (!loginResponse.ok) {
                                throw new Error(loginData.message || 'Erreur de connexion après inscription');
                            }

                            // ✅ showSuccess NE FERME PAS le spinner
                            // Le spinner continue de tourner pendant la redirection
                            showSuccess(loginData);
                        }
                    } catch (error) {
                        console.error('[Register] Erreur:', error);
                        showApiMessage(error.message || 'Code OTP invalide', 'error');
                        setLoading(false);
                    }
                    return;
                }

                // CAS 2 : Connexion / Inscription standard
                var isPhoneValid = validateField('phone');
                var isPasswordValid = validateField('password');
                
                if (isRegisterMode) {
                    validateField('fullName');
                    validateField('confirmPassword');
                }

                var allValid = isPhoneValid && isPasswordValid;
                if (isRegisterMode) {
                    allValid = allValid && validateField('fullName') && validateField('confirmPassword');
                }

                if (!allValid) {
                    focusFirstError();
                    return;
                }

                var phone = phoneInput.value.trim();
                var password = passwordInput.value.trim();

                setLoading(true);

                try {
                    // CAS 2A : Inscription (étape 1)
                    if (isRegisterMode) {
                        var fullName = fullNameInput.value.trim();
                        
                        var result = await handleRegister(phone, password, fullName);
                        
                        if (result.step === 'verify') {
                            hideFieldsForOtp();
                            clearOtpInputs();
                            setOtpError(false);
                            otpInputs[0].focus();
                            showApiMessage(result.message || 'Un code OTP a été envoyé par SMS', 'success');
                            startOtpTimer();
                            setLoading(false);
                            return;
                        }
                        
                        if (result.step === 'done') {
                            showSuccess(result.data);
                            return;
                        }
                    }

                    // CAS 2B : Connexion
                    var prefix = getSelectedPrefix();
                    var response = await fetch(API_BASE_URL + '/auth/login', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify({
                            phone: '+' + prefix + phone,
                            password: password,
                            deviceInfo: 'OAuth Web',
                            platform: 'web'
                        })
                    });

                    var data = await response.json();

                    if (!response.ok) {
                        throw new Error(data.message || 'Identifiants invalides');
                    }

                    // ✅ showSuccess NE FERME PAS le spinner
                    // Le spinner continue de tourner pendant la redirection
                    showSuccess(data);

                } catch (error) {
                    console.error('[OAuth] Erreur détaillée:', error);
                    showApiMessage(error.message || 'Une erreur est survenue', 'error');
                    setLoading(false);
                }
            });

            document.addEventListener('DOMContentLoaded', function() {
                injectPasswordToggles();
                fetchCountries();

                var code = urlParams.get('code');
                var accessToken = urlParams.get('access_token');
                var userId = urlParams.get('user_id');
                
                if (code && accessToken && userId) {
                    userTokens = {
                        accessToken: accessToken,
                        refreshToken: urlParams.get('refresh_token'),
                        userId: userId,
                        code: code
                    };
                    showSuccess({
                        data: {
                            id: userId,
                            phone: urlParams.get('phone') || 'N/A',
                            full_name: urlParams.get('full_name') || 'Utilisateur',
                            role: urlParams.get('role') || 'USER',
                            status: 'ACTIVE'
                        }
                    });
                }
            });

        })();
    </script>
    <script>
        (function () {
            var amount = ${JSON.stringify(amount).replace(/</g, '\\u003c')};
            var currency = ${JSON.stringify(currency).replace(/</g, '\\u003c')};
            var description = ${JSON.stringify(description).replace(/</g, '\\u003c')};
            var n = Number(amount);
            if (amount && isFinite(n) && n > 0) {
                var box = document.getElementById('paySummary');
                document.getElementById('paySummaryAmount').textContent =
                    n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (currency || '');
                if (description) document.getElementById('paySummaryDesc').textContent = description;
                box.classList.add('show');
            }
        })();
    </script>
    <script>
        (function () {
            'use strict';
            var API = window.location.origin;
            var card = document.querySelector('.body');
            var loginState = document.getElementById('loginState');
            var forgotState = document.getElementById('forgotState');
            var forgotLink = document.getElementById('forgotLink');
            var forgotRow = document.getElementById('forgotRow');
            var back = document.getElementById('forgotBack');
            var form = document.getElementById('forgotForm');
            var msg = document.getElementById('forgotApiMessage');
            var title = document.getElementById('forgotTitle');
            var lead = document.getElementById('forgotMessage');
            var step1 = document.getElementById('forgotStep1');
            var step2 = document.getElementById('forgotStep2');
            var step3 = document.getElementById('forgotStep3');
            var verifiedCode = '';
            var country = document.getElementById('fpCountry');
            var phone = document.getElementById('fpPhone');
            var boxes = Array.prototype.slice.call(document.querySelectorAll('#fpCodeBoxes input'));
            var pass = document.getElementById('fpPass');
            var confirmPass = document.getElementById('fpConfirm');
            var rules = document.getElementById('fpRules');
            var submit = document.getElementById('fpSubmit');
            var btnText = document.getElementById('fpBtnText');
            var sentTo = document.getElementById('fpSentTo');
            var timerEl = document.getElementById('fpTimer');
            var resend = document.getElementById('fpResend');
            var mainCountry = document.getElementById('countryCode');
            var mainPhone = document.getElementById('phone');
            var mainPass = document.getElementById('password');
            var confirmGroup = document.getElementById('confirmPasswordGroup');
            var toggleFormLink = document.getElementById('toggleFormLink');

            var step = 1;
            var identifier = '';
            var busy = false;
            var timer = null;
            var msgTimer = null;

            function lang() {
                var l = (navigator.language || 'fr').slice(0, 2).toLowerCase();
                return ['fr', 'en', 'sw', 'ar', 'es'].indexOf(l) >= 0 ? l : 'fr';
            }

            function show(text, type) {
                if (msgTimer) clearTimeout(msgTimer);
                msg.className = 'api-message show ' + (type || 'info');
                msg.textContent = text;
                if (type !== 'error') msgTimer = setTimeout(function () { msg.classList.remove('show'); }, 7000);
            }

            function hide() { msg.classList.remove('show'); }

            function fieldError(id, on) {
                var g = document.getElementById(id);
                if (!g) return;
                if (on) g.classList.add('error'); else g.classList.remove('error');
            }

            function loading(on) {
                busy = on;
                submit.disabled = on;
                if (on) submit.classList.add('loading'); else submit.classList.remove('loading');
            }

            function errorText(data, fallback) {
                if (!data) return fallback;
                var m = data.message;
                if (m && typeof m === 'object' && m.message) m = m.message;
                if (Array.isArray(m)) m = m.join(', ');
                return (typeof m === 'string' && m) ? m : fallback;
            }

            function post(path, body) {
                return fetch(API + path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'lang': lang() },
                    body: JSON.stringify(body)
                }).then(function (res) {
                    return res.json().catch(function () { return {}; }).then(function (data) {
                        if (!res.ok) throw new Error(errorText(data, 'Une erreur est survenue. Réessayez.'));
                        return data;
                    });
                });
            }

            function masked(num) {
                var d = String(num).replace(/[^0-9]/g, '');
                return d.length > 6 ? '+' + d.slice(0, 3) + ' ••• ••• ' + d.slice(-3) : '+' + d;
            }

            function startTimer(seconds) {
                if (timer) clearInterval(timer);
                var left = seconds;
                resend.style.display = 'none';
                timerEl.style.display = 'inline';
                timerEl.textContent = 'Renvoyer le code dans ' + left + ' s';
                timer = setInterval(function () {
                    left -= 1;
                    if (left <= 0) {
                        clearInterval(timer);
                        timerEl.style.display = 'none';
                        resend.style.display = 'inline';
                    } else {
                        timerEl.textContent = 'Renvoyer le code dans ' + left + ' s';
                    }
                }, 1000);
            }

            function syncCountries() {
                if (!mainCountry) return;
                country.innerHTML = mainCountry.innerHTML;
                country.value = mainCountry.value;
                if (window.csRefreshAll) window.csRefreshAll();
            }

            var STEPS = {
                1: { btn: 'Recevoir le code', title: 'Mot de passe oublié', lead: 'Saisissez le numéro de votre compte. Nous vous enverrons un code par SMS pour choisir un nouveau mot de passe.' },
                2: { btn: 'Vérifier le code', title: 'Code de vérification', lead: 'Saisissez le code à 6 chiffres reçu par SMS.' },
                3: { btn: 'Changer le mot de passe', title: 'Nouveau mot de passe', lead: 'Choisissez un nouveau mot de passe pour votre compte.' }
            };

            function goStep(n) {
                step = n;
                step1.style.display = n === 1 ? 'block' : 'none';
                step2.style.display = n === 2 ? 'block' : 'none';
                step3.style.display = n === 3 ? 'block' : 'none';
                btnText.textContent = STEPS[n].btn;
                title.textContent = STEPS[n].title;
                lead.textContent = STEPS[n].lead;
            }

            function open(e) {
                if (e) e.preventDefault();
                syncCountries();
                phone.value = mainPhone ? mainPhone.value.trim() : '';
                clearBoxes(); pass.value = ''; confirmPass.value = ''; verifiedCode = '';
                ['fpPhoneGroup', 'fpCodeGroup', 'fpPassGroup', 'fpConfirmGroup'].forEach(function (id) { fieldError(id, false); });
                checkRules();
                hide();
                goStep(1);
                card.classList.add('forgot-mode');
                forgotState.classList.add('show');
                setTimeout(function () { (phone.value ? submit : phone).focus(); }, 50);
            }

            function close(e, done) {
                if (e) e.preventDefault();
                if (timer) clearInterval(timer);
                card.classList.remove('forgot-mode');
                forgotState.classList.remove('show');
                if (done && mainPhone) {
                    mainPhone.value = phone.value.trim();
                    if (mainCountry) mainCountry.value = country.value;
                    if (window.csRefreshAll) window.csRefreshAll();
                    if (mainPass) { mainPass.value = ''; mainPass.focus(); }
                }
            }

            var checks = {
                len: function (v) { return v.length >= 8; },
                up: function (v) { return /[A-Z]/.test(v); },
                low: function (v) { return /[a-z]/.test(v); },
                num: function (v) { return /[0-9]/.test(v); },
                spe: function (v) { return /[^A-Za-z0-9]/.test(v); }
            };

            function checkRules() {
                var v = pass.value, all = true;
                Array.prototype.forEach.call(rules.querySelectorAll('li'), function (li) {
                    var ok = checks[li.getAttribute('data-rule')](v);
                    if (ok) li.classList.add('ok'); else li.classList.remove('ok');
                    if (!ok) all = false;
                });
                return all;
            }

            function sendCode(isResend) {
                var digits = phone.value.replace(/[^0-9]/g, '');
                var prefix = String(country.value || '243').replace(/[^0-9]/g, '');
                if (digits.indexOf('0') === 0) digits = digits.slice(1);
                if (digits.length < 6) { fieldError('fpPhoneGroup', true); phone.focus(); return; }
                fieldError('fpPhoneGroup', false);
                identifier = digits.indexOf(prefix) === 0 && digits.length > 9 ? digits : prefix + digits;
                loading(true); hide();
                post('/auth/send-reset-otp', { identifier: identifier })
                    .then(function (data) {
                        sentTo.innerHTML = 'Code envoyé par SMS au <b>' + masked(identifier) + '</b>. Il est valable 5 minutes.';
                        show(errorText(data, isResend ? 'Nouveau code envoyé.' : 'Code envoyé par SMS.'), 'success');
                        goStep(2);
                        startTimer(60);
                        clearBoxes();
                        setTimeout(function () { boxes[0].focus(); }, 50);
                    })
                    .catch(function (err) { show(err.message, 'error'); })
                    .then(function () { loading(false); });
            }

            // Étape 2 : vérifier le code (sans le consommer) avant de choisir le mot de passe
            function verifyCode() {
                var c = codeValue();
                if (c.length !== 6) {
                    fieldError('fpCodeGroup', true);
                    (boxes.filter(function (x) { return !x.value; })[0] || boxes[0]).focus();
                    return;
                }
                loading(true); hide();
                post('/auth/verify-otp', { identifier: identifier, code: c })
                    .then(function () {
                        verifiedCode = c;
                        if (timer) clearInterval(timer);
                        goStep(3);
                        setTimeout(function () { pass.focus(); }, 50);
                    })
                    .catch(function (err) {
                        show(err.message || 'Code incorrect ou expiré.', 'error');
                        boxes.forEach(function (x) { x.classList.add('error'); });
                        setTimeout(function () { clearBoxes(); boxes.forEach(function (x) { x.classList.remove('error'); }); boxes[0].focus(); }, 900);
                    })
                    .then(function () { loading(false); });
            }

            // Étape 3 : nouveau mot de passe
            function resetPassword() {
                var c = verifiedCode;
                var okPass = checkRules();
                var okConfirm = pass.value && pass.value === confirmPass.value;
                fieldError('fpPassGroup', !okPass);
                fieldError('fpConfirmGroup', !okConfirm);
                if (!c) { goStep(2); return; }
                if (!okPass) { pass.focus(); return; }
                if (!okConfirm) { confirmPass.focus(); return; }
                loading(true); hide();
                post('/auth/reset-password', { identifier: identifier, code: c, password: pass.value })
                    .then(function () {
                        close(null, true);
                        var main = document.getElementById('apiMessage');
                        if (main) {
                            main.className = 'api-message show success';
                            main.textContent = 'Mot de passe modifié. Connectez-vous avec votre nouveau mot de passe.';
                        }
                    })
                    .catch(function (err) {
                        show(err.message, 'error');
                        // Code expiré entre-temps : retour à la saisie du code
                        if (/code|otp/i.test(err.message || '')) { verifiedCode = ''; clearBoxes(); goStep(2); }
                    })
                    .then(function () { loading(false); });
            }

            form.addEventListener('submit', function (e) {
                e.preventDefault();
                if (busy) return;
                if (step === 1) sendCode(false);
                else if (step === 2) verifyCode();
                else resetPassword();
            });

            // mousedown sans perte du focus : la validation du champ mot de passe ne décale pas le lien avant le clic
            forgotLink.addEventListener('mousedown', function (e) { e.preventDefault(); });
            forgotLink.addEventListener('click', open);
            back.addEventListener('click', close);
            resend.addEventListener('click', function (e) { e.preventDefault(); if (!busy) sendCode(true); });
            // Cases du code : un chiffre par case, retour arrière, flèches, collage du code complet
            function codeValue() { return boxes.map(function (x) { return x.value; }).join(''); }
            function clearBoxes() { boxes.forEach(function (x) { x.value = ''; x.classList.remove('filled'); }); }
            function fillFrom(start, digits) {
                for (var k = 0; k < digits.length && start + k < boxes.length; k++) {
                    boxes[start + k].value = digits[k];
                    boxes[start + k].classList.add('filled');
                }
                var next = Math.min(start + digits.length, boxes.length - 1);
                boxes[next].focus();
                fieldError('fpCodeGroup', false);
                if (codeValue().length === 6 && !busy) verifyCode();
            }
            boxes.forEach(function (box, i) {
                box.addEventListener('input', function () {
                    var d = box.value.replace(/[^0-9]/g, '');
                    if (!d) { box.value = ''; box.classList.remove('filled'); return; }
                    box.value = '';
                    fillFrom(i, d.split(''));
                });
                box.addEventListener('keydown', function (e) {
                    if (e.key === 'Backspace' && !box.value && i > 0) {
                        boxes[i - 1].value = '';
                        boxes[i - 1].classList.remove('filled');
                        boxes[i - 1].focus();
                        e.preventDefault();
                    } else if (e.key === 'ArrowLeft' && i > 0) {
                        boxes[i - 1].focus();
                    } else if (e.key === 'ArrowRight' && i < boxes.length - 1) {
                        boxes[i + 1].focus();
                    }
                });
                box.addEventListener('paste', function (e) {
                    var text = (e.clipboardData || window.clipboardData).getData('text') || '';
                    var d = text.replace(/[^0-9]/g, '').slice(0, 6);
                    if (!d) return;
                    e.preventDefault();
                    fillFrom(i, d.split(''));
                });
                box.addEventListener('focus', function () { box.select(); });
            });
            pass.addEventListener('input', function () { checkRules(); fieldError('fpPassGroup', false); });
            confirmPass.addEventListener('input', function () { fieldError('fpConfirmGroup', false); });
            phone.addEventListener('input', function () { fieldError('fpPhoneGroup', false); });

            // Afficher / masquer le nouveau mot de passe
            Array.prototype.forEach.call(forgotState.querySelectorAll('.toggle-password-btn'), function (btn) {
                btn.addEventListener('click', function () {
                    var input = document.getElementById(btn.getAttribute('data-target'));
                    var visible = input.type === 'text';
                    input.type = visible ? 'password' : 'text';
                    confirmPass.type = input.type;
                    if (visible) btn.classList.remove('active'); else btn.classList.add('active');
                });
            });

            // Pas de lien « oublié » en mode création de compte
            function syncLink() {
                forgotRow.style.display = confirmGroup && confirmGroup.style.display !== 'none' ? 'none' : 'block';
            }
            if (toggleFormLink) toggleFormLink.addEventListener('click', function () { setTimeout(syncLink, 0); });
            syncLink();
        })();
    </script>
    <script>
        // ============================================================
        // Sélecteur de pays personnalisé (le <select> d'origine reste la source de la valeur)
        //  - ordinateur : liste sous le champ ; téléphones / tablettes : feuille qui monte du bas
        // ============================================================
        (function () {
            'use strict';
            var ISO2 = {
                COD: 'cd', COG: 'cg', BEN: 'bj', CMR: 'cm', CIV: 'ci', GAB: 'ga', GHA: 'gh', KEN: 'ke', MWI: 'mw',
                MOZ: 'mz', NGA: 'ng', RWA: 'rw', SEN: 'sn', SLE: 'sl', TZA: 'tz', UGA: 'ug', ZMB: 'zm', BFA: 'bf',
                ETH: 'et', LSO: 'ls', ZWE: 'zw', MLI: 'ml', NER: 'ne', TGO: 'tg', GIN: 'gn', BDI: 'bi', AGO: 'ao',
                ZAF: 'za', TCD: 'td', CAF: 'cf', MAR: 'ma', DZA: 'dz', TUN: 'tn', EGY: 'eg', FRA: 'fr', BEL: 'be',
                USA: 'us', CAN: 'ca', GBR: 'gb', CHN: 'cn', IND: 'in', ARE: 'ae', SSD: 'ss', SDN: 'sd', MDG: 'mg'
            };
            var CHECK = '<svg class="cs-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
            var CHEV = '<svg class="cs-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
            var SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
            var CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

            function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

            function iso2(code) {
                var c = String(code || '').toUpperCase();
                if (c.length === 2) return c.toLowerCase();
                return ISO2[c] || '';
            }

            function flagHtml(code) {
                var i2 = iso2(code);
                var label = esc(String(code || '').slice(0, 3).toUpperCase());
                if (!i2) return '<span class="cs-flag">' + label + '</span>';
                return '<img class="cs-flag" alt="" loading="lazy" src="https://flagcdn.com/w40/' + i2 + '.png" ' +
                    'onerror="if(this.parentNode)this.outerHTML=\\'<span class=&quot;cs-flag&quot;>' + label + '</span>\\'">';
            }

            function optionData(opt) {
                return {
                    value: opt.value,
                    prefix: String(opt.value || opt.text || '').replace(/[^0-9]/g, ''),
                    code: opt.getAttribute('data-country-code') || '',
                    name: opt.getAttribute('data-name') || opt.text || ''
                };
            }

            function useSheet() {
                return window.innerWidth < 960 || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
            }

            var openState = null;

            function closePanel() {
                if (!openState) return;
                var st = openState;
                openState = null;
                st.wrap.classList.remove('cs-open');
                st.trigger.setAttribute('aria-expanded', 'false');
                st.panel.classList.remove('show');
                if (st.overlay) st.overlay.classList.remove('show');
                document.body.style.overflow = '';
                setTimeout(function () {
                    if (st.panel.parentNode) st.panel.parentNode.removeChild(st.panel);
                    if (st.overlay && st.overlay.parentNode) st.overlay.parentNode.removeChild(st.overlay);
                }, 280);
                window.removeEventListener('resize', st.onResize);
                window.removeEventListener('scroll', st.onScroll, true);
                document.removeEventListener('keydown', st.onKey);
                document.removeEventListener('mousedown', st.onOutside);
                st.trigger.focus();
            }

            function enhance(select) {
                var wrap = select.closest('.country-select');
                if (!wrap || wrap.classList.contains('cs-ready')) return;
                wrap.classList.add('cs-ready');
                select.setAttribute('tabindex', '-1');
                select.setAttribute('aria-hidden', 'true');

                var trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'cs-trigger';
                trigger.setAttribute('aria-haspopup', 'listbox');
                trigger.setAttribute('aria-expanded', 'false');
                wrap.appendChild(trigger);

                function refresh() {
                    var opt = select.options[select.selectedIndex];
                    if (!opt) { trigger.innerHTML = '<span class="cs-code">+243</span>' + CHEV; return; }
                    var d = optionData(opt);
                    trigger.innerHTML = flagHtml(d.code) + '<span class="cs-code">+' + esc(d.prefix) + '</span>' + CHEV;
                    trigger.setAttribute('aria-label', 'Pays : ' + d.name + ' (+' + d.prefix + ')');
                }

                function choose(value) {
                    if (select.value !== value) {
                        select.value = value;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    refresh();
                    closePanel();
                    var phone = wrap.parentNode && wrap.parentNode.querySelector('input[type="tel"]');
                    if (phone) setTimeout(function () { phone.focus(); }, 60);
                }

                function open() {
                    if (openState) { closePanel(); return; }
                    var sheet = useSheet();
                    var items = Array.prototype.map.call(select.options, optionData);

                    var panel = document.createElement('div');
                    panel.className = 'cs-panel ' + (sheet ? 'cs-sheet' : 'cs-drop');
                    panel.setAttribute('role', 'dialog');
                    panel.setAttribute('aria-label', 'Choisir le pays');
                    panel.innerHTML =
                        '<div class="cs-handle"></div>' +
                        '<div class="cs-head"><b>Choisir le pays</b><button type="button" class="cs-close" aria-label="Fermer">' + CLOSE + '</button></div>' +
                        '<div class="cs-search">' + SEARCH + '<input type="text" placeholder="Rechercher un pays ou un indicatif" autocomplete="off"></div>' +
                        '<ul class="cs-list" role="listbox"></ul>';
                    var list = panel.querySelector('.cs-list');
                    var search = panel.querySelector('input');
                    var active = -1;
                    var shown = [];

                    function render(q) {
                        var t = String(q || '').trim().toLowerCase().replace(/^\\+/, '');
                        shown = items.filter(function (d) {
                            return !t || d.name.toLowerCase().indexOf(t) >= 0 || d.prefix.indexOf(t) === 0 || d.code.toLowerCase().indexOf(t) === 0;
                        });
                        if (!shown.length) { list.innerHTML = '<li class="cs-empty">Aucun pays trouvé</li>'; active = -1; return; }
                        list.innerHTML = shown.map(function (d, i) {
                            var sel = d.value === select.value;
                            return '<li class="cs-item' + (sel ? ' cs-selected' : '') + '" role="option" aria-selected="' + sel + '" data-i="' + i + '">' +
                                flagHtml(d.code) + '<span class="cs-name">' + esc(d.name) + '</span><span class="cs-pre">+' + esc(d.prefix) + '</span>' + CHECK + '</li>';
                        }).join('');
                        active = -1;
                    }

                    function setActive(i) {
                        var els = list.querySelectorAll('.cs-item');
                        if (!els.length) return;
                        active = (i + els.length) % els.length;
                        Array.prototype.forEach.call(els, function (el, k) { el.classList.toggle('cs-active', k === active); });
                        els[active].scrollIntoView({ block: 'nearest' });
                    }

                    render('');
                    list.addEventListener('click', function (e) {
                        var li = e.target.closest('.cs-item');
                        if (li) choose(shown[Number(li.getAttribute('data-i'))].value);
                    });
                    search.addEventListener('input', function () { render(search.value); });
                    search.addEventListener('keydown', function (e) {
                        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
                        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
                        else if (e.key === 'Enter') {
                            e.preventDefault();
                            if (active >= 0 && shown[active]) choose(shown[active].value);
                            else if (shown.length === 1) choose(shown[0].value);
                        }
                    });
                    panel.querySelector('.cs-close').addEventListener('click', closePanel);

                    var overlay = null;
                    if (sheet) {
                        overlay = document.createElement('div');
                        overlay.className = 'cs-overlay';
                        overlay.addEventListener('click', closePanel);
                        document.body.appendChild(overlay);
                        document.body.style.overflow = 'hidden';
                    }
                    document.body.appendChild(panel);

                    function place() {
                        if (sheet) return;
                        var r = wrap.getBoundingClientRect();
                        var h = Math.min(360, panel.scrollHeight);
                        var below = window.innerHeight - r.bottom - 12;
                        var top = below >= Math.min(h, 260) || below >= r.top ? r.bottom + 8 : Math.max(12, r.top - h - 8);
                        var left = Math.min(r.left, window.innerWidth - 332);
                        panel.style.top = top + 'px';
                        panel.style.left = Math.max(12, left) + 'px';
                        panel.style.maxHeight = Math.max(200, top > r.top ? window.innerHeight - top - 12 : r.top - 20) + 'px';
                    }
                    place();

                    var st = {
                        wrap: wrap, trigger: trigger, panel: panel, overlay: overlay,
                        onResize: function () { if (useSheet() !== sheet) closePanel(); else place(); },
                        onScroll: function (e) { if (!sheet && !panel.contains(e.target)) place(); },
                        onKey: function (e) { if (e.key === 'Escape') closePanel(); },
                        onOutside: function (e) { if (!sheet && !panel.contains(e.target) && !wrap.contains(e.target)) closePanel(); }
                    };
                    openState = st;
                    wrap.classList.add('cs-open');
                    trigger.setAttribute('aria-expanded', 'true');
                    window.addEventListener('resize', st.onResize);
                    window.addEventListener('scroll', st.onScroll, true);
                    document.addEventListener('keydown', st.onKey);
                    document.addEventListener('mousedown', st.onOutside);

                    requestAnimationFrame(function () {
                        panel.classList.add('show');
                        if (overlay) overlay.classList.add('show');
                        var sel = list.querySelector('.cs-selected');
                        if (sel) sel.scrollIntoView({ block: 'center' });
                        // Pas de clavier qui s'ouvre tout seul sur téléphone / tablette
                        if (!sheet) search.focus();
                    });
                }

                trigger.addEventListener('click', open);
                trigger.addEventListener('keydown', function (e) {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
                });
                select.addEventListener('change', refresh);
                // Les pays arrivent après le chargement (API) : on suit les changements du <select>
                new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true });
                select.csRefresh = refresh;
                refresh();
            }

            function init() {
                Array.prototype.forEach.call(document.querySelectorAll('.country-select select'), enhance);
            }

            // Valeur changée par le code (ex. mot de passe oublié) : rafraîchir l'affichage
            window.csRefreshAll = function () {
                Array.prototype.forEach.call(document.querySelectorAll('.country-select select'), function (s) { if (s.csRefresh) s.csRefresh(); });
            };

            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
        })();
    </script>
</body>
</html>`);

    } catch (error) {
      console.error('[OAuth] Error:', error);
      return res.status(500).send('Erreur lors du chargement de la page');
    }
  }

  @Post('auth/generate-token')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async generateToken(
    @CurrentUser() currentUser: any,
    @Res() res: Response,
  ) {
    try {
      if (!currentUser || !currentUser.id) {
        return res.status(401).json({
          success: false,
          message: 'Utilisateur non authentifié',
        });
      }

      // ✅ Générer le token via le microservice
      const result = await this.sendAuthMessage<any>(
        'generate_token',
        { userId: currentUser.id },
        'Erreur génération token',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

      console.log('[GenerateToken] Résultat brut:', JSON.stringify(result, null, 2));

      // ✅ Extraire le token et les données - avec plusieurs sources possibles
      let accessToken: string | null = null;
      let refreshToken: string | null = null;
      let userId: string | null = null;

      // Source 1: Directement dans result
      if (result.accessToken) {
        accessToken = result.accessToken;
      } else if (result.data?.accessToken) {
        accessToken = result.data.accessToken;
      }

      if (result.refreshToken) {
        refreshToken = result.refreshToken;
      } else if (result.data?.refreshToken) {
        refreshToken = result.data.refreshToken;
      }

      // Source 2: Dans result.data (si le résultat est un objet avec data)
      if (result.data?.id) {
        userId = result.data.id;
      } else if (result.userId) {
        userId = result.userId;
      } else if (currentUser.id) {
        userId = currentUser.id;
      }

      // ✅ Si le token est dans une propriété différente
      if (!accessToken && result.token) {
        accessToken = result.token;
      }
      if (!accessToken && result.access_token) {
        accessToken = result.access_token;
      }

      if (!accessToken) {
        console.error('[GenerateToken] ❌ Token non trouvé dans la réponse:', result);
        return res.status(500).json({
          success: false,
          message: 'Token non généré',
          debug: result,
        });
      }

      // ✅ Décoder le token pour obtenir l'expiration
      let expiresAt: Date;
      try {
        const decoded = jwt.decode(accessToken) as any;
        if (decoded && decoded.exp) {
          expiresAt = new Date(decoded.exp * 1000);
        } else {
          expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        }
      } catch (error) {
        expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      }

      // ✅ Vérifier si le token existe déjà
      const existingToken = await this.prisma.oauthaccesstoken.findFirst({
        where: { token: accessToken },
      });

      if (!existingToken) {
        // ✅ ENREGISTRER LE TOKEN DANS LA BASE DE DONNÉES
        await this.prisma.oauthaccesstoken.create({
          data: {
            id: crypto.randomUUID(),  // ← AJOUTER CECI
            token: accessToken,
            clientId: 'api-gateway',
            userId: userId || 'unknown',
            scope: 'all',
            expiresAt: expiresAt,
            createdAt: new Date(),
          },
        });
        console.log(`[GenerateToken] ✅ Token enregistré pour l'utilisateur ${userId}`);
      } else {
        console.log(`[GenerateToken] ⏳ Token déjà existant, mise à jour de l'expiration`);
        await this.prisma.oauthaccesstoken.update({
          where: { id: existingToken.id },
          data: { expiresAt: expiresAt },
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          accessToken: accessToken,
          refreshToken: refreshToken || null,
          userId: userId,
          expiresAt: expiresAt.toISOString(),
        },
        message: 'Token généré avec succès',
      });

    } catch (error) {
      console.error('[GenerateToken] ❌ Erreur:', error.message);
      return res.status(500).json({
        success: false,
        message: error.message || 'Erreur lors de la génération du token',
      });
    }
  }
  // ============================================================
  // 7. FONCTION 3: GET /oauth/callback
  // ============================================================
  @Get('oauth/callback')
  async oauthCallback(
    @Query() query: {
      access_token?: string;
      refresh_token?: string;
      user_id?: string;
      system_user_id?: string;
      code?: string;
      error?: string;
      amount?: string;
      currency?: string;
      description?: string;
      api_key?: string;
      callback?: string;
      redirect_uri?: string;
      state?: string;
      client_id?: string;
      data_id?: string;
      data_phone?: string;
      data_full_name?: string;
      data_role?: string;
      data_status?: string;
      data_kycStatus?: string;
      data_countryCode?: string;
      wallets?: string;
    },
    @Res() res: Response,
    @Request() req: any,
  ) {
    console.log('[FPay] ✅ Callback reçu');
    console.log('[FPay] Query:', query);

    const isPaymentContext = !!(query.amount && query.currency);
    const isLinkContext = !!query.system_user_id && !query.amount;
    const clientId = query.client_id || 'web-client';

    let redirectUri = query.redirect_uri || query.callback || null;

    if (!redirectUri) {
      if (clientId === 'mobile-client' || clientId?.includes('mobile')) {
        redirectUri = this.getMobileCallbackUrl();
        console.log('[FPay] 📱 Client mobile, callback automatique:', redirectUri);
      } else {
        redirectUri = this.getOAuthCallbackUrl();
        console.log('[FPay] 🌐 Client web, callback automatique:', redirectUri);
      }
    }

    const hasRedirect = !!redirectUri;

    console.log('[FPay] 📋 Contexte:', isPaymentContext ? 'PAIEMENT' : isLinkContext ? 'LINK' : 'AUTH');
    console.log('[FPay] 📋 Client ID:', clientId);
    console.log('[FPay] 📋 redirect_uri EXACT:', redirectUri);

    // ✅ Fonction: Rediriger avec erreur
    const redirectWithError = (error: string, errorDescription?: string) => {
      if (hasRedirect) {
        const params = new URLSearchParams();
        params.set('error', error);
        if (errorDescription) {
          params.set('error_description', errorDescription);
        }
        if (query.state) {
          params.set('state', query.state);
        }
        params.set('client_id', clientId);

        let redirectUrl = redirectUri + '?' + params.toString();
        console.log('[FPay] 🔄 Redirection erreur:', redirectUrl);
        return res.redirect(redirectUrl);
      }

      return res.status(400).json({
        success: false,
        error: error,
        message: errorDescription || error,
        close: true,
        client_id: clientId,
      });
    };

    // ✅ Fonction: Rediriger avec succès
    const redirectWithSuccess = async (data: any) => {
      // ✅ ENREGISTRER LE TOKEN DANS LA BASE DE DONNÉES
      try {
        if (data.accessToken) {
          const decoded = jwt.decode(data.accessToken) as any;
          let expiresAt: Date;

          if (decoded && decoded.exp) {
            expiresAt = new Date(decoded.exp * 1000);
          } else {
            expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          }

          // ✅ Vérifier si le token existe déjà
          const existingToken = await this.prisma.oauthaccesstoken.findFirst({
            where: { token: data.accessToken },
          });

          if (!existingToken) {
            await this.prisma.oauthaccesstoken.create({
              data: {
                id: crypto.randomUUID(),  // ← AJOUTER CECI
                token: data.accessToken,
                clientId: clientId || 'oauth-callback',
                userId: data.data?.id || query.user_id,
                scope: 'all',
                expiresAt: expiresAt,
                createdAt: new Date(),
              },
            });
            console.log(`[OAuth] ✅ Token enregistré pour l'utilisateur ${data.data?.id || query.user_id}`);
          } else {
            console.log(`[OAuth] ⏳ Token déjà existant, mise à jour de l'expiration`);
            await this.prisma.oauthaccesstoken.update({
              where: { id: existingToken.id },
              data: { expiresAt: expiresAt },
            });
          }
        }
      } catch (dbError) {
        console.error('[OAuth] ❌ Erreur lors de l\'enregistrement du token:', dbError.message);
        // On continue même si l'enregistrement échoue
      }

      if (hasRedirect) {
        const params = new URLSearchParams();

        params.set('access_token', data.accessToken);
        params.set('refresh_token', data.refreshToken);
        params.set('user_id', data.data?.id);

        if (query.system_user_id) {
          params.set('system_user_id', query.system_user_id);
        }
        params.set('client_id', clientId);

        // ✅ Contexte LINK
        if (isLinkContext && data.accessToken && query.system_user_id) {
          console.log('[FPay] 🔗 Contexte LINK - Liaison automatique');
          params.set('link_required', 'true');
          params.set('fpay_user_id', data.data?.id || '');
        }

        // ✅ Contexte PAIEMENT
        if (isPaymentContext) {
          if (data.data?.payment) {
            params.set('payment_status', data.data.payment.status || 'PENDING');
            if (data.data.payment.transaction?.id) {
              params.set('transaction_id', data.data.payment.transaction.id);
            }
            if (data.data.payment.error) {
              params.set('payment_error', data.data.payment.error);
            }
          }
          if (query.amount) params.set('amount', query.amount);
          if (query.currency) params.set('currency', query.currency);
        }

        if (data.data) {
          params.set('data_id', data.data.id || '');
          params.set('data_phone', data.data.phone || '');
          params.set('data_full_name', data.data.full_name || '');
          params.set('data_role', data.data.role || '');
          params.set('data_status', data.data.status || '');
          params.set('data_kycStatus', data.data.kycStatus || '');
          params.set('data_countryCode', data.data.countryCode || 'CD');

          if (data.data.wallets) {
            params.set('wallets', JSON.stringify(data.data.wallets));
          }
        }

        if (data.message) params.set('message', data.message);

        let redirectUrl = redirectUri + '?' + params.toString();
        console.log('[FPay] 🔄 Redirection succès:', redirectUrl);
        return res.redirect(redirectUrl);
      }

      return res.status(200).json({
        ...data,
        close: true,
        client_id: clientId,
        message: data.message + ' - Cette page va se fermer automatiquement',
      });
    };

    // ✅ Erreurs
    if (query.error) {
      console.error('[FPay] ❌ Erreur dans la query:', query.error);
      return redirectWithError(query.error, 'Erreur d\'authentification FPay');
    }

    // ✅ CAS 1: Déjà connecté avec tokens - VÉRIFICATION JWT DIRECTE
    if (query.access_token && query.user_id) {
      console.log('[FPay] ✅ Utilisateur déjà connecté avec tokens');

      // ✅ VÉRIFIER LE TOKEN AVEC JWT (sans base de données)
      let isValidToken = true;
      let decodedToken: any = null;

      try {
        // Décoder le JWT (sans vérifier la signature)
        decodedToken = jwt.decode(query.access_token) as any;

        if (!decodedToken || !decodedToken.id) {
          isValidToken = false;
          console.error('[FPay] ❌ Token invalide - pas de id');
        }

        // Vérifier l'expiration
        if (decodedToken && decodedToken.exp) {
          const now = Math.floor(Date.now() / 1000);
          if (decodedToken.exp < now) {
            isValidToken = false;
            console.error('[FPay] ❌ Token expiré');
          }
        }

        // Vérifier que l'user_id du query correspond à l'id du token
        if (decodedToken && decodedToken.id !== query.user_id) {
          isValidToken = false;
          console.error('[FPay] ❌ Mismatch user_id');
        }

      } catch (error) {
        console.error('[FPay] ❌ Erreur décodage JWT:', error.message);
        isValidToken = false;
      }

      if (!isValidToken) {
        return redirectWithError('invalid_token', 'Token FPay invalide ou expiré');
      }

      // ✅ Token valide - Construire les données utilisateur
      let userData: any = null;
      let wallets = null;

      if (query.data_id) {
        userData = {
          id: query.data_id,
          phone: query.data_phone || decodedToken?.phone || '',
          full_name: query.data_full_name || decodedToken?.full_name || '',
          role: query.data_role || decodedToken?.role || 'USER',
          status: query.data_status || decodedToken?.status || 'ACTIVE',
          kycStatus: query.data_kycStatus || decodedToken?.kycStatus || 'NOT_SUBMITTED',
          countryCode: query.data_countryCode || decodedToken?.countryCode || 'CD',
          wallets: []
        };

        if (query.wallets) {
          try {
            wallets = JSON.parse(query.wallets);
            userData.wallets = wallets;
          } catch (e) {
            console.warn('[FPay] ⚠️ Erreur parsing wallets');
          }
        }
      } else if (decodedToken) {
        // Utiliser les données du token si data_id n'est pas présent
        userData = {
          id: decodedToken.id,
          phone: decodedToken.phone || '',
          full_name: decodedToken.full_name || '',
          role: decodedToken.role || 'USER',
          status: decodedToken.status || 'ACTIVE',
          kycStatus: decodedToken.kycStatus || 'NOT_SUBMITTED',
          countryCode: decodedToken.countryCode || 'CD',
          wallets: []
        };
      }

      // ✅ Si on est en contexte LINK
      if (isLinkContext && query.system_user_id) {
        console.log('[FPay] 🔗 Contexte LINK - Liaison des comptes');

        try {
          const favorHelpUrl = process.env.FAVOR_HELP_API_URL || 'https://api.favorhelp.com/api/v1';

          const linkResponse = await fetch(`${favorHelpUrl}/fpay/link-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemUserId: query.system_user_id,
              fpayUserId: query.user_id,
              accessToken: query.access_token,
              refreshToken: query.refresh_token || null,
            }),
          });

          if (!linkResponse.ok) {
            const errorData = await linkResponse.json();
            throw new Error(errorData.message || 'Erreur lors de la liaison');
          }

          console.log('[FPay] ✅ Comptes liés avec succès');

          const finalData = userData || {
            id: query.user_id,
            phone: '',
            full_name: '',
            role: 'USER',
            status: 'ACTIVE',
            kycStatus: 'NOT_SUBMITTED',
            countryCode: 'CD',
            wallets: []
          };

          return await redirectWithSuccess({
            success: true,
            accessToken: query.access_token,
            refreshToken: query.refresh_token,
            message: 'Authentification et liaison réussies',
            data: {
              ...finalData,
              id: query.user_id,
              isLinked: true,
            }
          });

        } catch (linkError) {
          console.error('[FPay] ❌ Erreur liaison:', linkError.message);
          return redirectWithError('link_failed', linkError.message || 'Échec de la liaison des comptes');
        }
      }

      // ✅ Cas simple: Authentification seulement
      const finalData = userData || {
        id: query.user_id,
        phone: '',
        full_name: '',
        role: 'USER',
        status: 'ACTIVE',
        kycStatus: 'NOT_SUBMITTED',
        countryCode: 'CD',
        wallets: []
      };

      return await redirectWithSuccess({
        success: true,
        accessToken: query.access_token,
        refreshToken: query.refresh_token,
        message: 'Authentification FPay réussie',
        data: finalData
      });
    }

    // ✅ CAS 2: Callback avec code
    if (query.code) {
      console.log('[FPay] 🔑 Échange du code contre des tokens');

      try {
        const tokenResponse = await this.sendUserMessage<any>(
          'exchange_code',
          {
            code: query.code,
            clientId: clientId,
            redirectUri: redirectUri,
          },
          'Échange de code échoué',
          HttpStatus.BAD_REQUEST,
        );

        if (!tokenResponse || !tokenResponse.accessToken) {
          throw new Error('Échange de code échoué');
        }

        console.log('[FPay] ✅ Tokens obtenus');

        const userResponse = await this.sendUserMessage<any>(
          'get_user',
          { id: tokenResponse.userId },
          'User not found',
          HttpStatus.NOT_FOUND,
        );

        const userData = userResponse?.data || {
          id: tokenResponse.userId,
          phone: '',
          full_name: '',
          role: 'USER',
          status: 'ACTIVE',
          kycStatus: 'NOT_SUBMITTED',
          countryCode: 'CD',
          wallets: []
        };

        return await redirectWithSuccess({
          success: true,
          accessToken: tokenResponse.accessToken,
          refreshToken: tokenResponse.refreshToken,
          message: 'Authentification FPay réussie',
          data: userData
        });

      } catch (error) {
        console.error('[FPay] ❌ Erreur échange code:', error.message);
        return redirectWithError('code_exchange_failed', error.message || 'Échec de l\'échange du code');
      }
    }

    console.error('[FPay] ❌ Aucune information valide dans le callback');
    return redirectWithError('invalid_request', 'Paramètres manquants ou invalides');
  }

  // ✅ Route pour récupérer les données complètes via session_id
  @Get('api/fpay-data/:sessionId')
  async getFpayData(@Param('sessionId') sessionId: string) {
    const data = this.fpayCache.get(sessionId);
    if (!data) {
      throw new Error('Session data not found or expired');
    }

    // Supprimer après récupération (usage unique)
    this.fpayCache.delete(sessionId);

    return {
      success: true,
      data: data.data,
    };
  }


  @Post('users/kyc/submit')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async submitKyc(
    @CurrentUser() currentUser: any,
    @Body() body: {
      documentType: string;
      documentNumber: string;
      documentFront: string;  // ✅ Sans "Url"
      documentBack?: string;  // ✅ Sans "Url"
      profileImage?: string;
    },
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    console.log('[submitKyc] Body reçu:', body);

    if (!body.documentType) {
      throw new HttpException(
        this.i18nService.translate('kyc_document_type_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.documentNumber) {
      throw new HttpException(
        this.i18nService.translate('kyc_document_number_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.documentFront) {
      throw new HttpException(
        this.i18nService.translate('kyc_document_front_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.sendUserMessage(
      'submit_kyc',
      {
        userId: currentUser.id,
        documentType: body.documentType,
        documentNumber: body.documentNumber,
        documentFrontUrl: body.documentFront,  // ✅ Renommer pour le service
        documentBackUrl: body.documentBack || null,  // ✅ Renommer pour le service
        profileImage: body.profileImage || null,
        lang,
      },
      this.i18nService.translate('kyc_submit_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }


  @Get('admin/kyc/submissions/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getKycSubmissionById(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';

    if (!id) {
      throw new HttpException(
        this.i18nService.translate('kyc_submission_id_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.sendUserMessage(
      'get_kyc_submission_by_id',
      { id, lang },
      this.i18nService.translate('kyc_submission_not_found', lang),
      HttpStatus.NOT_FOUND,
    );
  }


  /**
   * Récupérer le statut KYC de l'utilisateur connecté
   */
  @Get('users/me/kyc/status')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyKycStatus(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    return this.sendUserMessage(
      'get_kyc_status',
      { userId: currentUser.id, lang },
      this.i18nService.translate('kyc_status_error', lang),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Récupérer le statut KYC d'un utilisateur (Admin)
   */
  @Get('admin/users/:userId/kyc/status')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserKycStatus(
    @CurrentUser() currentUser: any,
    @Param('userId') userId: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';
    return this.sendUserMessage(
      'get_kyc_status',
      { userId, lang },
      this.i18nService.translate('kyc_status_error', lang),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Lister toutes les soumissions KYC (Admin)
   */
  @Get('admin/kyc/submissions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAllKycSubmissions(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('documentType') documentType?: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    return this.sendUserMessage(
      'get_all_kyc_submissions',
      {
        page: pageNum,
        limit: limitNum,
        status,
        documentType,
        lang,
      },
      this.i18nService.translate('kyc_submissions_error', lang),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Vérifier une soumission KYC (Admin)
   */
  @Patch('admin/kyc/verify/:kycId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async verifyKyc(
    @CurrentUser() currentUser: any,
    @Param('kycId') kycId: string,
    @Body() body: {
      status: 'VERIFIED' | 'REJECTED';
      adminNotes?: string;
      rejectionReason?: string;
    },
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';

    if (!kycId) {
      throw new HttpException(
        this.i18nService.translate('kyc_id_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.status || !['VERIFIED', 'REJECTED'].includes(body.status)) {
      throw new HttpException(
        this.i18nService.translate('kyc_invalid_status', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.sendUserMessage(
      'verify_kyc',
      {
        kycId,
        status: body.status,
        adminNotes: body.adminNotes,
        rejectionReason: body.rejectionReason,
        adminId: currentUser.id,
        lang,
      },
      this.i18nService.translate('kyc_verify_error', lang),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Statistiques KYC (Admin)
   */
  @Get('admin/kyc/stats')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getKycStats(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';
    return this.sendUserMessage(
      'get_kyc_stats',
      { lang },
      this.i18nService.translate('kyc_stats_error', lang),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @CurrentUser() currentUser: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('folder') folder: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    if (!file) {
      throw new HttpException(
        'Aucun fichier fourni',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!folder || folder.trim() === '') {
      throw new HttpException(
        'Le nom du dossier est requis',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.sendUserMessage(
      'upload_file',
      {
        userId: currentUser.id,
        file: file,
        folder: folder.trim(),
        lang,
      },
      'Erreur lors de l\'upload',
      HttpStatus.BAD_REQUEST,
    );
  }
  // ==================== EXCHANGE RATES ENDPOINTS ====================

  /**
   * Récupère les taux de change pour les wallets de l'utilisateur connecté
   */
  @Get('wallet/rates/user')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getExchangeRatesForUser(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    return this.sendWalletMessage(
      'get_exchange_rates_for_user',
      { userId: currentUser.id, lang },
      this.i18nService.translate('wallet.exchange_rates_failed', lang),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // ==================== BRANCH MANAGEMENT ENDPOINTS ====================

  @Post('admin/branches')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createBranch(
    @CurrentUser() currentUser: any,
    @Body() body: {
      name: string;
      address?: string;
      phone?: string;
      email?: string;
      countryId: string;
      status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
    },
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';

    // ✅ Validations
    if (!body.name) {
      throw new HttpException('Le nom de la branche est requis', HttpStatus.BAD_REQUEST);
    }

    if (!body.countryId) {
      throw new HttpException('L\'ID du pays est requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'create_branch',
      body,
      'Échec de la création de la branche',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Patch('admin/branches/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateBranch(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      code?: string;
      address?: string;
      phone?: string;
      email?: string;
      countryId?: string;
      status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
    },
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';

    if (!id) {
      throw new HttpException('ID de la branche requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'update_branch',
      { id, ...body },
      'Échec de la mise à jour de la branche',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Delete('admin/branches/:id')
  async deleteBranch(
    @CurrentUser() currentUser: any,
    @Body() body: { permanent?: boolean },
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';

    // ✅ Vérifier que l'ID est présent
    if (!currentUser?.id) {
      throw new HttpException('ID de la branche requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'delete_branch',
      {
        id: currentUser.id,
        permanent: body?.permanent || false,
      },
      'Échec de la suppression de la branche',
      HttpStatus.BAD_REQUEST,
    );
  }
  @Get('admin/branches')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAllBranches(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('countryId') countryId?: string,
    @Query('status') status?: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const lang = langHeader || 'fr';
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    return this.sendUserMessage(
      'get_all_branches',
      { page: pageNum, limit: limitNum, countryId, status },
      'Échec de la récupération des branches',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('branches/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getBranch(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    if (!id) {
      throw new HttpException('ID de la branche requis', HttpStatus.BAD_REQUEST);
    }

    // Vérifier que l'utilisateur a accès à cette branche (optionnel)
    // Si l'utilisateur n'est pas admin, vérifier s'il a des ressources sur cette branche

    return this.sendUserMessage(
      'get_branch',
      { id },
      'Branche non trouvée',
      HttpStatus.NOT_FOUND,
    );
  }

  @Get('branches/by-country/:countryCode')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getBranchesByCountry(
    @CurrentUser() currentUser: any,
    @Param('countryCode') countryCode: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    if (!countryCode) {
      throw new HttpException('Code pays requis', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'get_branches_by_country',
      { countryCode },
      'Échec de la récupération des branches par pays',
      HttpStatus.BAD_REQUEST,
    );
  }

  // Dans api-gateway.controller.ts
  @Get('wallet/international-fees/pourcentage')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async calculateInternationalFees(
    @CurrentUser() currentUser: any,
    @Query('amount') amount: string,
    @Query('walletId') walletId: string,
    @Query('countryCode') countryCode: string,
    @Query('paymentMethod') paymentMethod?: 'CASH' | 'MOBILE_MONEY',
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const parsedAmount = parseFloat(amount);

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new HttpException(
        this.i18nService.translate('wallet.amount_positive', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!walletId) {
      throw new HttpException('walletId est requis', HttpStatus.BAD_REQUEST);
    }

    if (!countryCode) {
      throw new HttpException('countryCode est requis', HttpStatus.BAD_REQUEST);
    }

    // ✅ Valider le paymentMethod
    const validMethods = ['CASH', 'MOBILE_MONEY'];
    const method = paymentMethod || 'CASH';
    if (!validMethods.includes(method)) {
      throw new HttpException(
        'paymentMethod doit être CASH ou MOBILE_MONEY',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.sendWalletMessage(
      'calculate_international_fees',
      {
        amount: parsedAmount,
        walletId,
        countryCode,
        paymentMethod: method,
        lang
      },
      'Erreur lors du calcul des frais',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // ==================== VALIDATION TRANSFERT INTERNATIONAL ====================

  @Post('admin/wallet/validate-transfer')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async validateInternationalTransfer(
    @CurrentUser() currentUser: any,
    @Body() body: {
      transactionId: string;
      pin: string;
      status: 'SUCCESS' | 'FAILED' | 'CANCELLED'; // ✅ AJOUT
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    // ✅ Vérification des droits admin
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';

    // ✅ Validations
    if (!body.transactionId) {
      throw new HttpException(
        this.i18nService.translate('wallet.transaction_id_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.pin || body.pin.length < 4) {
      throw new HttpException(
        this.i18nService.translate('admin.pin_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!/^\d+$/.test(body.pin)) {
      throw new HttpException(
        this.i18nService.translate('wallet.pin_digits_only', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    // ✅ Vérifier que le status est valide
    if (!body.status || !['SUCCESS', 'FAILED', 'CANCELLED'].includes(body.status)) {
      throw new HttpException(
        'Le statut doit être SUCCESS, FAILED ou CANCELLED',
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] validate_international_transfer:', {
      transactionId: body.transactionId,
      adminId: currentUser.id,
      status: body.status,
      lang,
    });

    return this.sendWalletMessage(
      'validate_international_transfer',
      {
        transactionId: body.transactionId,
        adminId: currentUser.id,
        adminPin: body.pin,
        status: body.status, // ✅ PASSER LE STATUS
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.transfer_validation_failed', lang),
      HttpStatus.BAD_REQUEST,
      120000,
    );
  }

  @Post('wallet/deposit/request')
  async requestDeposit(
    @Body() body: {
      userId: string;
      amount: number;
      currency: string;
      apiKey: string;          // ✅ API Key envoyée par le client dans le body
    },
    @Headers('lang') langHeader?: string,
    @Ip() ipAddress?: string,
  ) {
    const lang = langHeader || 'fr';

    // ✅ 1. Récupérer l'API Key du body
    const apiKey = body.apiKey;

    if (!apiKey) {
      throw new HttpException(
        'API Key requise pour identifier le payeur',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // ✅ 2. Extraire l'ID du payeur depuis l'API Key
    let payerId: string;
    try {
      const cleanToken = apiKey.startsWith('Bearer ')
        ? apiKey.substring(7)
        : apiKey;

      const decoded = jwt.decode(cleanToken) as any;
      payerId = decoded?.userId || decoded?.id || decoded?.sub;

      if (!payerId) {
        throw new Error('API Key invalide: ID manquant');
      }

      console.log('[API Gateway] ✅ Payeur extrait de l\'API Key:', {
        payerId,
        email: decoded?.email,
        role: decoded?.role,
        permissions: decoded?.permissions,
      });
    } catch (error: any) {
      console.error('[API Gateway] ❌ API Key validation error:', error.message);
      throw new HttpException(
        'API Key invalide',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // ✅ 3. Validations
    if (!body.userId) {
      throw new HttpException(
        'L\'ID du bénéficiaire est requis',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (body.userId === payerId) {
      throw new HttpException(
        'Le payeur et le bénéficiaire ne peuvent pas être le même utilisateur',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.amount || body.amount <= 0) {
      throw new HttpException(
        this.i18nService.translate('wallet.amount_positive', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.currency) {
      throw new HttpException(
        'La devise est obligatoire',
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] requestDeposit:', {
      beneficiaryId: body.userId,
      payerId: payerId,
      amount: body.amount,
      currency: body.currency,
      ipAddress,
    });

    // ✅ Envoyer sans apiKey
    return this.sendWalletMessage(
      'request_deposit',
      {
        userId: body.userId,
        payerId: payerId,
        amount: body.amount,
        currency: body.currency.toUpperCase(),
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.deposit_request_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('wallet/deposit/confirm')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async confirmDeposit(
    @CurrentUser() currentUser: any,
    @Body() body: {
      transactionId: string;
      userId: string;
      pin: string;
      amount: number;
      currency: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    // ✅ Vérifier que l'utilisateur connecté est un admin
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException(
        'Accès interdit. Seul un administrateur peut confirmer un dépôt.',
        HttpStatus.FORBIDDEN,
      );
    }

    // ✅ Validations
    if (!body.transactionId) {
      throw new HttpException('L\'ID de la transaction est requis', HttpStatus.BAD_REQUEST);
    }
    if (!body.userId) {
      throw new HttpException('L\'ID de l\'utilisateur à débiter est requis', HttpStatus.BAD_REQUEST);
    }
    if (!body.pin || body.pin.length < 4) {
      throw new HttpException(this.i18nService.translate('wallet.pin_min_length', lang), HttpStatus.BAD_REQUEST);
    }
    if (!/^\d+$/.test(body.pin)) {
      throw new HttpException(this.i18nService.translate('wallet.pin_digits_only', lang), HttpStatus.BAD_REQUEST);
    }
    if (!body.amount || body.amount <= 0) {
      throw new HttpException('Le montant est requis pour la diminution des points', HttpStatus.BAD_REQUEST);
    }
    if (!body.currency) {
      throw new HttpException('La devise est requise pour la diminution des points', HttpStatus.BAD_REQUEST);
    }

    console.log('[API Gateway] confirmDeposit - Admin:', {
      adminId: currentUser.id,
      adminRole: currentUser.role,
      transactionId: body.transactionId,
      payerId: body.userId,
      amount: body.amount,
      currency: body.currency,
    });

    // ✅ 1. Confirmer le dépôt
    const depositResult = await this.sendWalletMessage(
      'confirm_deposit',
      {
        transactionId: body.transactionId,
        userId: body.userId,
        pin: body.pin,
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.deposit_confirm_failed', lang),
      HttpStatus.BAD_REQUEST,
    );

    // ✅ 2. Appeler Favor Help pour diminuer les points avec fetch
    try {
      const favorHelpUrl = process.env.FAVOR_HELP_API_URL || 'https://api.favorhelp.com/api/v1';
      const decreasePointsUrl = `${favorHelpUrl}/deposit/decrease-points`;

      console.log('[API Gateway] 📤 Appel Favor Help - decrease-points:', {
        url: decreasePointsUrl,
        userId: body.userId,
        amount: body.amount,
        currency: body.currency.toUpperCase(),
      });

      const response = await fetch(decreasePointsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: body.userId,
          amount: body.amount,
          currency: body.currency.toUpperCase(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Erreur lors de la diminution des points');
      }

      console.log('[API Gateway] ✅ Réponse Favor Help:', data);

      // ✅ Fusionner les résultats
      return {
        success: true,
        deposit: depositResult,
        referralPoints: data,
      };

    } catch (error: any) {
      console.error('[API Gateway] ❌ Erreur appel Favor Help:', error.message);

      return {
        success: true,
        deposit: depositResult,
        referralPoints: {
          success: false,
          message: `Dépôt confirmé mais erreur lors de la diminution des points: ${error.message}`,
          error: error.message,
        },
      };
    }
  }

  @Post('wallet/deposit/cancel')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async cancelDepositRequest(
    @CurrentUser() currentUser: any,
    @Body() body: {
      transactionId: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    // ✅ Validations
    if (!body.transactionId) {
      throw new HttpException(
        'L\'ID de la transaction est requis',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!currentUser?.id) {
      throw new HttpException(
        'Utilisateur non authentifié',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return this.sendWalletMessage(
      'cancel_deposit_request',
      {
        transactionId: body.transactionId,
        userId: currentUser.id,
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.deposit_cancel_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }
  // ================================================================
  // BACKUP MANAGEMENT (ADMIN ONLY)
  // ================================================================

  // Modifier les endpoints backup pour utiliser sendUserMessage
  @Post('backup/create')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createBackup(
    @CurrentUser() currentUser: any,
    @Body() body: { compressed?: boolean },
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';
    console.log('[API Gateway] createBackup:', { adminId: currentUser.id, compressed: body?.compressed || false });

    // ✅ Utiliser sendUserMessage au lieu de sendWalletMessage
    return this.sendUserMessage(
      'backup_create',
      { compressed: body?.compressed || false },
      this.i18nService.translate('user.backup_create_failed', lang),
      HttpStatus.BAD_REQUEST,
      300000,
    );
  }

  @Get('backup/list')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getBackupsList(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';
    console.log('[API Gateway] getBackupsList:', { adminId: currentUser.id });

    // ✅ Utiliser sendUserMessage
    return this.sendUserMessage(
      'backup_list',
      {},
      this.i18nService.translate('user.backup_list_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('backup/restore/:fileName')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async restoreBackup(
    @CurrentUser() currentUser: any,
    @Param('fileName') fileName: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';

    if (!fileName) {
      throw new HttpException(
        this.i18nService.translate('user.backup_file_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] restoreBackup:', { adminId: currentUser.id, fileName });

    // ✅ Utiliser sendUserMessage
    return this.sendUserMessage(
      'backup_restore',
      { fileName },
      this.i18nService.translate('user.backup_restore_failed', lang),
      HttpStatus.BAD_REQUEST,
      300000,
    );
  }

  @Delete('backup/:fileName')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteBackup(
    @CurrentUser() currentUser: any,
    @Param('fileName') fileName: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';

    if (!fileName) {
      throw new HttpException(
        this.i18nService.translate('user.backup_file_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] deleteBackup:', { adminId: currentUser.id, fileName });

    // ✅ Utiliser sendUserMessage
    return this.sendUserMessage(
      'backup_delete',
      { fileName },
      this.i18nService.translate('user.backup_delete_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('backup/download/:fileName')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async downloadBackup(
    @CurrentUser() currentUser: any,
    @Param('fileName') fileName: string,
    @Res() res: Response,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';

    if (!fileName) {
      throw new HttpException(
        this.i18nService.translate('user.backup_file_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] downloadBackup:', { adminId: currentUser.id, fileName });

    try {
      // ✅ Utiliser sendUserMessage
      const result = await this.sendUserMessage<{ filePath: string; fileName: string }>(
        'backup_download',
        { fileName },
        this.i18nService.translate('user.backup_download_failed', lang),
        HttpStatus.BAD_REQUEST,
        300000,
      );

      const filePath = result.filePath;
      const fileName2 = result.fileName;

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName2}"`);

      const fs = require('fs');
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

    } catch (error) {
      console.error('[API Gateway] downloadBackup error:', error);
      throw new HttpException(
        error.message || this.i18nService.translate('user.backup_download_failed', lang),
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('backup/restore-upload')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  @UseInterceptors(FileInterceptor('file'))
  async restoreFromUpload(
    @CurrentUser() currentUser: any,
    @UploadedFile() file: Express.Multer.File,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';

    if (!file) {
      throw new HttpException(
        this.i18nService.translate('user.backup_file_required', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('[API Gateway] restoreFromUpload:', {
      adminId: currentUser.id,
      fileName: file.originalname,
      fileSize: file.size
    });

    // ✅ Utiliser sendUserMessage
    return this.sendUserMessage(
      'backup_restore_upload',
      { file },
      this.i18nService.translate('user.backup_restore_upload_failed', lang),
      HttpStatus.BAD_REQUEST,
      300000,
    );
  }

  @Post('backup/auto')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async triggerAutoBackup(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }

    const lang = langHeader || 'fr';
    console.log('[API Gateway] triggerAutoBackup:', { adminId: currentUser.id });

    // ✅ Utiliser sendUserMessage
    return this.sendUserMessage(
      'backup_auto',
      {},
      this.i18nService.translate('user.backup_auto_failed', lang),
      HttpStatus.BAD_REQUEST,
      300000,
    );
  }
  //===========================================AFFICHER LES BALANCES DE PAWAPAY==========================================
  @Get('pawapay/balances')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getPawaPayBalances(
    @CurrentUser() currentUser: any,  //  Récupérer l'utilisateur connecté
    @Query('country') country?: string,
    @Query('provider') provider?: string,
  ) {
    //  Vérifier que l'utilisateur est ADMIN ou SUPER_ADMIN
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException(
        'Accès interdit. Seul un administrateur peut consulter les balances PawaPay.',
        HttpStatus.FORBIDDEN,
      );
    }

    return this.sendWalletMessage(
      'get_pawapay_balances',
      { country, provider },
      'Erreur récupération balances',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('wallet/deposit/pawapay')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async depositWithPawaPay(
    @CurrentUser() currentUser: any,
    @Body() body: {
      amount: number;
      pin: string;
      provider: string;
      phone: string;
      currency: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    // ✅ Validations
    if (!body.amount || body.amount <= 0) {
      throw new HttpException(
        this.i18nService.translate('wallet.amount_positive', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.pin || body.pin.length < 4) {
      throw new HttpException(
        this.i18nService.translate('wallet.pin_min_length', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!/^\d+$/.test(body.pin)) {
      throw new HttpException(
        this.i18nService.translate('wallet.pin_digits_only', lang),
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.provider) {
      throw new HttpException(
        'Le provider est requis (ex: MTN_MOMO_BEN, ORANGE_COD, etc.)',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.phone) {
      throw new HttpException(
        'Le numéro de téléphone est requis',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.currency) {
      throw new HttpException(
        'La devise est requise (ex: CDF, USD, XOF, XAF, etc.)',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!currentUser?.id) {
      throw new HttpException(
        'Utilisateur non authentifié',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return this.sendWalletMessage(
      'deposit_pawapay',
      {
        userId: currentUser.id,
        amount: body.amount,
        pin: body.pin,
        provider: body.provider,
        phone: body.phone,
        currency: body.currency.toUpperCase(),
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.top_up_failed', lang),
      HttpStatus.BAD_REQUEST,
    );
  }

  //=====================================================================================================================
  private handleRpcError(
    error: any,
    defaultMessage: string,
    defaultStatus: number,
  ): never {
    this.logger.error('Raw RPC Error:', error);

    // 1️⃣ Timeout
    if (error?.name === 'TimeoutError') {
      throw new HttpException(
        {
          status: 'error',
          message: 'Le service est trop lent (timeout)',
          statusCode: HttpStatus.GATEWAY_TIMEOUT,
        },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }

    // 2️⃣ Extraire le message et le statut
    let message = defaultMessage;
    let status = defaultStatus;

    if (error?.response) {
      if (typeof error.response === 'object') {
        // ✅ Extraire le message
        message = error.response.message || error.response.error || defaultMessage;

        // ✅ Récupérer le statusCode et s'assurer que c'est un nombre
        const rawStatus = error.response.statusCode || error.response.status || defaultStatus;
        status = typeof rawStatus === 'number' ? rawStatus : defaultStatus;
      } else if (typeof error.response === 'string') {
        message = error.response;
      }
    } else if (error?.message) {
      message = error.message;
      const rawStatus = error.statusCode || error.status || defaultStatus;
      status = typeof rawStatus === 'number' ? rawStatus : defaultStatus;
    }

    // 3️⃣ ✅ FORCER le statut à être un nombre valide
    if (typeof status !== 'number' || isNaN(status) || status < 100 || status > 599) {
      this.logger.warn(`⚠️ StatusCode invalide: "${status}", utilisation de ${defaultStatus}`);
      status = defaultStatus;
    }

    // 4️⃣ ✅ S'assurer que le statusCode dans le body est aussi un nombre
    const statusCode = typeof status === 'number' ? status : defaultStatus;

    this.logger.error(`❌ RPC Error: ${message} (${statusCode})`);

    throw new HttpException(
      {
        status: 'error',
        message,
        statusCode: statusCode,
      },
      statusCode,
    );
  }
}