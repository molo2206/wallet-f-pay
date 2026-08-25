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
import { FileFieldsInterceptor, FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { UploadedFile, UploadedFiles } from '@nestjs/common';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';

const gatewayLoginLocks = new Map<string, boolean>();

interface RpcError {
  status?: string;
  message?: string;
  statusCode?: number;
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

  constructor(private readonly i18nService: I18nService, private readonly prisma: PrismaService) { // ✅ injection
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

  private async sendWalletMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000,
  ): Promise<T> {
    this.logger.debug(`Wallet RPC → ${pattern}`, data);

    try {
      const result = await firstValueFrom(
        this.walletClient.send(pattern, data).pipe(
          timeout(timeoutMs),
          catchError((error) => {
            this.handleRpcError(error, defaultMessage, defaultStatus);
          }),
        ),
      );

      return result as T;
    } catch (error) {
      this.logger.error(`Wallet error ${pattern}`, error);
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
  ): Promise<{ message: string; data: UserResponseDto }> {
    this.logger.log(`👤 Get user request: ${id}`);
    const response = await this.sendUserMessage<{
      message: string;
      data: UserResponseDto;
    }>('get_user', { id }, 'User not found', HttpStatus.NOT_FOUND);
    return response;
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
    @Query('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (!userId) {
      throw new HttpException('userId is required', HttpStatus.BAD_REQUEST);
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

  // apps/api-gateway/src/api-gateway.controller.ts

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
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
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

  @Post('topup/brute')
  async topups(@Body() data: { accountNumber: string; amount: number; requestId?: string }) {
    return this.walletClient.send('topup', data);
  }

  @Post('cashout/brute')
  async cashouts(@Body() data: { accountNumber: string; amount: number; pin: string }) {
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
  async getTransactionById(@Param('transactionId') transactionId: string) {
    if (!transactionId) {
      throw new HttpException(
        'ID de transaction requis',
        HttpStatus.BAD_REQUEST,
      );
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
      system_user_id: string;
      amount: number;
      currency?: string;
      description?: string;
      access_token?: string;
    },
    @Res() res: Response,
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string
  ) {
    const lang = langHeader || 'fr';
    const apiKeyUser = req.user;

    try {
      // ✅ Validation
      if (!body.system_user_id) {
        throw new HttpException('system_user_id est requis', HttpStatus.BAD_REQUEST);
      }

      if (!body.amount || body.amount <= 0) {
        throw new HttpException('Le montant doit être supérieur à 0', HttpStatus.BAD_REQUEST);
      }

      console.log('[ExternalPay] 📋 system_user_id du payeur:', body.system_user_id);

      // ✅ Correction du type
      let fpayUserId: string | null = null;

      // ✅ 1. Vérifier le token si fourni
      if (body.access_token) {
        try {
          const verifyResponse = await this.sendUserMessage<{
            message: string;
            data: any;
          }>(
            'verify_token',
            { accessToken: body.access_token },
            'Token invalide',
            HttpStatus.UNAUTHORIZED,
          );

          if (verifyResponse && verifyResponse.data) {
            fpayUserId = verifyResponse.data.id;
            console.log('[ExternalPay] ✅ Token FPay valide:', fpayUserId);

            // ✅ Lier automatiquement si token valide
            try {
              const favorHelpUrl = process.env.FAVOR_HELP_API_URL || 'https://api.favorhelp.com/api/v1';
              await fetch(`${favorHelpUrl}/fpay/link-user`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  systemUserId: body.system_user_id,
                  fpayUserId: fpayUserId,
                  accessToken: body.access_token,
                }),
              });
              console.log('[ExternalPay] ✅ Compte lié automatiquement');
            } catch (linkError) {
              console.warn('[ExternalPay] ⚠️ Erreur liaison automatique:', linkError.message);
            }
          }
        } catch (tokenError) {
          console.error('[ExternalPay] ❌ Token invalide:', tokenError.message);
          throw new HttpException(
            'Token FPay invalide ou expiré',
            HttpStatus.UNAUTHORIZED
          );
        }
      }

      // ✅ 2. Vérifier si l'utilisateur est lié (si pas de token)
      if (!fpayUserId) {
        try {
          const userStatus = await this.sendFpayMessage<{ isLinked: boolean; userIdFpay?: string }>(
            'check_user_link',
            { systemUserId: body.system_user_id },
            'Erreur lors de la vérification du lien',
            HttpStatus.BAD_REQUEST,
          );

          if (userStatus.isLinked && userStatus.userIdFpay) {
            fpayUserId = userStatus.userIdFpay;
            console.log('[ExternalPay] ✅ Utilisateur déjà lié:', fpayUserId);
          }
        } catch (error) {
          // Utilisateur non lié
        }
      }

      // ✅ 3. Si pas de token et pas lié → Redirection OAuth
      if (!fpayUserId) {
        console.log('[ExternalPay] 🔐 Utilisateur non lié, redirection vers OAuth FPay');

        const fpayUrl = process.env.FPAY_API_URL || 'https://f-pay.favorhelp.com';
        const appUrl = process.env.APP_URL || 'http://localhost:3000';
        const clientId = 'web-client';
        const callbackUrl = `${appUrl}/oauth/callback`;

        const redirectUrl = new URL(`${fpayUrl}/oauth/login`);
        redirectUrl.searchParams.set('client_id', clientId);
        redirectUrl.searchParams.set('system_user_id', body.system_user_id);
        redirectUrl.searchParams.set('redirect_uri', callbackUrl);
        redirectUrl.searchParams.set('amount', body.amount.toString());
        redirectUrl.searchParams.set('currency', body.currency || 'USD');
        if (body.description) {
          redirectUrl.searchParams.set('description', body.description);
        }

        const authHeader = req.headers.authorization || '';
        redirectUrl.searchParams.set('api_key', authHeader);

        return res.status(200).json({
          status: 'redirect',
          message: 'Authentification FPay requise. Veuillez vous connecter.',
          redirectUrl: redirectUrl.toString(),
          openInBrowser: redirectUrl.toString(),
          system_user_id: body.system_user_id,
          data: {
            amount: body.amount,
            currency: body.currency,
          }
        });
      }

      // ✅ 4. Récupérer le wallet du payeur (dans user-service)
      const payer = await this.prisma.user.findFirst({
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

      if (!payer) {
        throw new HttpException(`Utilisateur avec ID ${body.system_user_id} non trouvé`, HttpStatus.NOT_FOUND);
      }

      // ✅ 5. Trouver le wallet
      const targetCurrency = body.currency || 'USD';
      let clientWallet = payer.wallets.find(w => w.currency === targetCurrency);

      if (!clientWallet) {
        clientWallet = payer.wallets[0];
        if (!clientWallet) {
          throw new HttpException(`Aucun wallet actif trouvé`, HttpStatus.BAD_REQUEST);
        }
      }

      console.log('[ExternalPay] Client wallet found:', {
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

      // ✅ 6. Le destinataire
      const recipient = apiKeyUser;

      if (recipient.status !== 'ACTIVE') {
        throw new HttpException(`Le destinataire n'est pas actif`, HttpStatus.BAD_REQUEST);
      }

      if (payer.id === recipient.id) {
        throw new HttpException('Impossible de payer à soi-même', HttpStatus.BAD_REQUEST);
      }

      // ✅ 7. Préparer le payload (sans PIN)
      const payPayload: any = {
        fromWalletId: clientWallet.id,
        amount: body.amount,
        description: body.description || `Paiement externe vers ${recipient.full_name || recipient.phone}`,
        lang,
        ipAddress,
      };

      // ✅ 8. Ajouter le destinataire
      if (recipient.role === 'MERCHANT' && recipient.merchantCode) {
        payPayload.merchantCode = recipient.merchantCode;
        console.log('[ExternalPay] ✅ Paiement vers un marchand, code:', recipient.merchantCode);
      } else if (recipient.phone) {
        payPayload.toPhone = recipient.phone;
        console.log('[ExternalPay] ✅ Paiement vers un utilisateur, téléphone:', recipient.phone);
      } else {
        throw new HttpException('Le destinataire n\'a ni téléphone ni code marchand', HttpStatus.BAD_REQUEST);
      }

      console.log('[ExternalPay] 📤 Payload envoyé (sans PIN):', payPayload);

      // ✅ 9. Appeler le service wallet avec 'pay_without_pin'
      const response = await this.sendWalletMessage(
        'pay_without_pin',
        payPayload,
        this.i18nService.translate('wallet.payment_failed', lang),
        HttpStatus.BAD_REQUEST,
      );

      return response;

    } catch (error) {
      console.error('[ExternalPay] Erreur:', error);

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          status: 'error',
          message: error.message || 'Erreur lors du paiement',
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

    // ✅ 7. Si pas assez de solde ou pas de wallet dans cette devise, chercher un autre wallet avec assez de solde
    if (payerWallet) {
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

      // ✅ ICI - Appel via microservice auth
      const verifyResponse = await this.sendAuthMessage<{
        valid: boolean;
        data?: {
          id: string;
          email: string | null;
          phone: string | null;
          full_name: string | null;
          role: string;
          status: string;
          kycStatus: string;
          countryCode: string | null;
        };
        message: string;
      }>(
        'verify_token',
        { accessToken: access_token },
        'Token invalide',
        HttpStatus.UNAUTHORIZED,
      );

      if (!verifyResponse.valid || !verifyResponse.data) {
        return res.status(401).json({
          success: false,
          message: verifyResponse.message || 'Token FPay invalide ou expiré'
        });
      }

      const fpayUser = verifyResponse.data;

      // Lier les comptes
      const favorHelpUrl = process.env.FAVOR_HELP_API_URL || 'https://api.favorhelp.com/api/v1';

      const linkUserResponse = await fetch(`${favorHelpUrl}/fpay/link-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemUserId: system_user_id,
          fpayUserId: fpayUser.id,
          accessToken: access_token,
          refreshToken: refresh_token || null,
        }),
      });

      if (!linkUserResponse.ok) {
        const errorData = await linkUserResponse.json();
        throw new Error(errorData.message || 'Erreur lors de la liaison');
      }

      return res.status(200).json({
        success: true,
        message: 'Compte lié avec succès',
        data: {
          systemUserId: system_user_id,
          fpayUserId: fpayUser.id,
          isLinked: true
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

  @Post('auth/verify-token')
  async verifyToken(
    @Body() body: { access_token: string },
    @Res() res: Response,
  ) {
    try {
      const { access_token } = body;

      if (!access_token) {
        return res.status(400).json({
          success: false,
          message: 'access_token est requis'
        });
      }

      const verifyResponse = await this.sendAuthMessage<{
        valid: boolean;
        data?: {
          id: string;
          email: string | null;
          phone: string | null;
          full_name: string | null;
          role: string;
          status: string;
          kycStatus: string;
          countryCode: string | null;
        };
        message: string;
      }>(
        'verify_token',
        { accessToken: access_token },
        'Token invalide',
        HttpStatus.UNAUTHORIZED,
      );

      return res.status(200).json(verifyResponse);

    } catch (error) {
      console.error('[verifyToken] ❌ Erreur:', error.message);
      return res.status(500).json({
        success: false,
        message: error.message || 'Erreur lors de la vérification'
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
  // ============================================================

  @Get('oauth/login')
  async oauthLoginPage(
    @Query() query: {
      code?: string;
      client_id?: string;
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

      const clientId = query.client_id || 'web-client';

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

      const baseUrl = `${req.protocol}://${req.get('host')}${req.path}`;
      const cleanParams = new URLSearchParams();

      if (clientId) cleanParams.set('client_id', clientId);
      if (systemUserId) cleanParams.set('system_user_id', systemUserId);
      if (amount) cleanParams.set('amount', amount);
      if (currency) cleanParams.set('currency', currency);
      if (description) cleanParams.set('description', description);
      if (apiKey) cleanParams.set('api_key', apiKey);

      const cleanUrl = `${baseUrl}?${cleanParams.toString()}`;
      console.log('[OAuth] URL nettoyée (sans code):', cleanUrl);

      const filePath = path.join(__dirname, '..', 'src', 'public', 'oauth', 'authorize.html');

      // ✅ Modification du JavaScript dans la page HTML
      // Pour que le login appelle /auth/login (et non /auth/link-user)
      // et retourne directement le token sans liaison

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
        html = html.replace(/{{CLIENT_ID}}/g, clientId);
        html = html.replace(/{{REDIRECT_URI}}/g, callbackUrl);

        return res.set('Content-Type', 'text/html').send(html);
      }

      return res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connexion F-Pay</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            width: 100%;
            max-width: 480px;
            background: white;
            border-radius: 24px;
            padding: 48px 40px;
            box-shadow: 0 20px 60px rgba(10, 28, 242, 0.15);
            border: 1px solid rgba(10, 28, 242, 0.08);
        }
        .logo { text-align: center; margin-bottom: 32px; }
        .logo .icon {
            width: 72px;
            height: 72px;
            background: #0A1CF2;
            border-radius: 18px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            color: white;
            font-weight: bold;
            margin-bottom: 12px;
        }
        .logo h1 { font-size: 28px; color: #1a1a2e; letter-spacing: -0.5px; }
        .logo h1 .f { color: #0A1CF2; }
        .logo h1 .pay { color: #FFB81C; }
        .logo p { color: #6b7280; font-size: 14px; margin-top: 4px; }
        .env-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-top: 8px;
        }
        .env-badge.local { background: #10b981; color: white; }
        .env-badge.test { background: #f59e0b; color: white; }
        .env-badge.production { background: #ef4444; color: white; }
        .header { margin-bottom: 28px; }
        .header h2 { font-size: 20px; color: #1a1a2e; margin-bottom: 6px; }
        .header p { color: #6b7280; font-size: 14px; }
        .payment-info {
            background: #f8f9ff;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 20px;
            border: 1px solid #e5e7eb;
        }
        .payment-info .info-row {
            display: flex;
            justify-content: space-between;
            padding: 4px 0;
        }
        .payment-info .label {
            color: #6b7280;
            font-size: 13px;
        }
        .payment-info .value {
            color: #1a1a2e;
            font-weight: 600;
            font-size: 13px;
        }
        .form-group { margin-bottom: 18px; }
        .form-group label { display: block; font-size: 14px; font-weight: 500; color: #1a1a2e; margin-bottom: 6px; }
        .form-group input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            font-size: 15px;
            transition: all 0.2s;
            background: #fafafa;
            color: #1a1a2e;
        }
        .form-group input:focus {
            outline: none;
            border-color: #0A1CF2;
            background: white;
            box-shadow: 0 0 0 4px rgba(10, 28, 242, 0.1);
        }
        .form-group input::placeholder { color: #9ca3af; }
        .form-group input:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn {
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            background: #0A1CF2;
            color: white;
            transition: all 0.2s;
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(10, 28, 242, 0.35); }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
        .btn .spinner { display: none; }
        .btn.loading .spinner { display: inline-block; }
        .btn.loading .btn-text { display: none; }
        .btn .spinner {
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255, 255, 255, 0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .message {
            padding: 12px 16px;
            border-radius: 12px;
            margin-bottom: 16px;
            font-size: 14px;
            display: none;
        }
        .message.show { display: block; }
        .message.error { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
        .message.success { background: #f0fdf4; color: #059669; border: 1px solid #bbf7d0; }
        .message.info { background: #eff6ff; color: #0A1CF2; border: 1px solid rgba(10, 28, 242, 0.2); }
        .otp-section {
            display: none;
            animation: fadeIn 0.3s ease-in;
        }
        .otp-section.show {
            display: block;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .links { text-align: center; margin-top: 20px; font-size: 14px; color: #6b7280; }
        .links a { color: #0A1CF2; text-decoration: none; font-weight: 500; cursor: pointer; }
        .links a:hover { text-decoration: underline; }
        .links .divider { color: #e5e7eb; margin: 0 8px; }
        .footer { text-align: center; margin-top: 24px; color: #9ca3af; font-size: 13px; }
        .footer a { color: #6b7280; text-decoration: none; }
        .footer a:hover { color: #0A1CF2; }
        .timer {
            text-align: center;
            font-size: 13px;
            color: #6b7280;
            margin-top: 8px;
        }
        #successState {
            display: none;
            text-align: center;
            padding: 20px 0;
        }
        #successState .success-icon { font-size: 64px; margin-bottom: 16px; }
        #successState h2 { color: #1a1a2e; margin-bottom: 8px; }
        #successState p { color: #6b7280; margin-bottom: 8px; }
        #successState .user-info {
            background: #f8f9ff;
            border-radius: 12px;
            padding: 16px;
            margin: 16px 0;
            text-align: left;
            border: 1px solid #e5e7eb;
        }
        #successState .user-info .info-row {
            display: flex;
            justify-content: space-between;
            padding: 6px 0;
            border-bottom: 1px solid #f0f0f0;
        }
        #successState .user-info .info-row:last-child { border-bottom: none; }
        #successState .user-info .label { color: #6b7280; font-size: 13px; }
        #successState .user-info .value { color: #1a1a2e; font-weight: 500; font-size: 13px; }

        @media (prefers-color-scheme: dark) {
            body { background: #1a1a2e; }
            .container { background: #1e293b; border-color: rgba(255, 255, 255, 0.05); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4); }
            .logo h1 { color: #f1f5f9; }
            .logo p { color: #94a3b8; }
            .header h2 { color: #f1f5f9; }
            .header p { color: #94a3b8; }
            .payment-info { background: #1e293b; border-color: #334155; }
            .payment-info .value { color: #f1f5f9; }
            .form-group label { color: #f1f5f9; }
            .form-group input { background: #0f172a; border-color: #334155; color: #f1f5f9; }
            .form-group input:focus { background: #1e293b; border-color: #0A1CF2; box-shadow: 0 0 0 4px rgba(10, 28, 242, 0.2); }
            .form-group input::placeholder { color: #64748b; }
            .links { color: #94a3b8; }
            .links a { color: #93c5fd; }
            .footer { color: #64748b; }
            .footer a { color: #94a3b8; }
            .footer a:hover { color: #93c5fd; }
            .message.error { background: #451a1a; color: #fca5a5; border-color: #7f1d1d; }
            .message.success { background: #064e3b; color: #6ee7b7; border-color: #065f46; }
            .message.info { background: #1e3a5f; color: #93c5fd; border-color: #1e40af; }
            .timer { color: #94a3b8; }
            #successState h2 { color: #f1f5f9; }
            #successState p { color: #94a3b8; }
            #successState .user-info { background: #1e293b; border-color: #334155; }
            #successState .user-info .info-row { border-color: #334155; }
            #successState .user-info .value { color: #f1f5f9; }
        }

        @media (max-width: 520px) {
            .container { padding: 32px 20px; }
            .logo h1 { font-size: 24px; }
            .btn { font-size: 15px; padding: 12px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <div class="icon">F</div>
            <h1><span class="f">F</span><span class="pay">Pay</span></h1>
            <p>Solutions de paiement securisees</p>
            <div><span class="env-badge ${env}">${envLabel}</span></div>
        </div>

        <div id="loginState">
            <div class="header">
                <h2>Connexion a F-Pay</h2>
                <p id="stepMessage">Etape 1 : Saisissez vos identifiants</p>
            </div>
            
            <div class="payment-info" id="paymentInfo" style="display: none;">
                <div class="info-row">
                    <span class="label">Montant</span>
                    <span class="value" id="displayAmount">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Devise</span>
                    <span class="value" id="displayCurrency">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Description</span>
                    <span class="value" id="displayDescription">-</span>
                </div>
            </div>

            <div class="message" id="message">
                <span id="messageText">Message</span>
            </div>
            <form id="loginForm" autocomplete="off">
                <div class="form-group">
                    <label>Numero de telephone</label>
                    <input type="tel" id="phone" placeholder="+243 999 999 999" required>
                </div>
                <div class="form-group" id="passwordGroup">
                    <label>Mot de passe</label>
                    <input type="password" id="password" placeholder="Votre mot de passe" required>
                </div>
                <div class="otp-section" id="otpSection">
                    <div class="form-group">
                        <label>Code OTP</label>
                        <input type="text" id="otpCode" placeholder="Entrez le code recu par SMS" maxlength="6" inputmode="numeric" autocomplete="off">
                        <div class="timer" id="timer">⏱️ 60s</div>
                    </div>
                </div>
                <button type="submit" class="btn" id="submitBtn">
                    <span class="spinner"></span>
                    <span class="btn-text" id="btnText">Se connecter</span>
                </button>
            </form>
            <div class="links">
                <a href="#" id="resendLink" style="display:none;">Renvoyer le code OTP</a>
                <span class="divider" id="dividerResend" style="display:none;">|</span>
                <a href="#">Creer un compte</a>
            </div>
        </div>

        <div id="successState" style="display:none;">
            <div class="success-icon">✅</div>
            <h2>Connexion reussie !</h2>
            <p>Vous etes maintenant connecte a F-Pay.</p>
            <div class="user-info" id="userInfo">
                <div class="info-row">
                    <span class="label">ID utilisateur</span>
                    <span class="value" id="userId">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Telephone</span>
                    <span class="value" id="userPhone">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Nom complet</span>
                    <span class="value" id="userFullName">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Role</span>
                    <span class="value" id="userRole">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Statut</span>
                    <span class="value" id="userStatus">-</span>
                </div>
            </div>
            <button class="btn" onclick="handleRedirect()" style="margin-top: 16px;">
                Continuer →
            </button>
        </div>

        <div class="footer">
            <span>Connexion securisee • </span>
            <a href="#">Conditions d utilisation</a>
            <span> • </span>
            <a href="#">Politique de confidentialite</a>
        </div>
    </div>

    <script>
        (function() {
            'use strict';

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
            var CLIENT_ID = '${clientId}';
            var REDIRECT_URI = '${callbackUrl}';

            console.log('[OAuth] Environnement:', ENV);
            console.log('[OAuth] APP_URL:', APP_URL);
            console.log('[OAuth] OAUTH_CALLBACK_URL:', OAUTH_CALLBACK_URL);
            console.log('[OAuth] SYSTEM_USER_ID:', SYSTEM_USER_ID);
            console.log('[OAuth] CLIENT_ID:', CLIENT_ID);
            console.log('[OAuth] REDIRECT_URI:', REDIRECT_URI);
            console.log('[OAuth] Paiement:', { AMOUNT, CURRENCY, DESCRIPTION });
            console.log('[OAuth] API_KEY:', API_KEY ? '✅ Présente' : '❌ Absente');

            var urlParams = new URLSearchParams(window.location.search);
            var CLIENT_ID = urlParams.get('client_id') || 'web-client';
            var REDIRECT_URI = urlParams.get('redirect_uri') || OAUTH_CALLBACK_URL;

            var userTokens = { accessToken: null, refreshToken: null, userId: null, code: null };
            var userData = null;
            var otpRequired = false;
            var timerInterval = null;
            var secondsLeft = 60;
            var phoneSaved = '';
            var passwordSaved = '';

            function displayPaymentInfo() {
                var paymentInfo = document.getElementById('paymentInfo');
                if (AMOUNT || CURRENCY || DESCRIPTION) {
                    paymentInfo.style.display = 'block';
                    document.getElementById('displayAmount').textContent = AMOUNT || '-';
                    document.getElementById('displayCurrency').textContent = CURRENCY || '-';
                    document.getElementById('displayDescription').textContent = DESCRIPTION || '-';
                }
            }

            function cleanUrl() {
                if (window.history && window.history.replaceState) {
                    var cleanUrl = window.location.origin + window.location.pathname;
                    window.history.replaceState({}, document.title, cleanUrl);
                }
            }

            function stopLoading() {
                var btn = document.getElementById('submitBtn');
                btn.classList.remove('loading');
                btn.disabled = false;
            }

            function startLoading() {
                var btn = document.getElementById('submitBtn');
                btn.classList.add('loading');
                btn.disabled = true;
            }

            function showMessage(type, text) {
                var messageEl = document.getElementById('message');
                var messageText = document.getElementById('messageText');
                messageEl.className = 'message show ' + type;
                messageText.textContent = text;
            }

            function showSuccess(data) {
                userData = data.data;
                userTokens = {
                    accessToken: data.accessToken || (data.data && data.data.accessToken),
                    refreshToken: data.refreshToken || (data.data && data.data.refreshToken),
                    userId: data.data && data.data.id,
                    code: data.code || urlParams.get('code')
                };

                cleanUrl();
                console.log('[OAuth] Tokens stockes:', userTokens);
                console.log('[OAuth] User data:', userData);
                
                console.log('[OAuth] Redirection automatique vers le callback...');
                handleRedirect();
            }

            // ✅ handleRedirect modifié - redirection directe avec tokens
            window.handleRedirect = function() {
                console.log('[OAuth] Redirection vers:', REDIRECT_URI);
                console.log('[OAuth] Tokens:', userTokens);
                console.log('[OAuth] User data:', userData);

                // ✅ Si c'est une URL mobile (fpay://)
                if (REDIRECT_URI.startsWith('fpay://')) {
                    var params = new URLSearchParams();
                    
                    if (userTokens.accessToken) {
                        params.set('access_token', userTokens.accessToken);
                    }
                    if (userTokens.refreshToken) {
                        params.set('refresh_token', userTokens.refreshToken);
                    }
                    if (userTokens.userId) {
                        params.set('user_id', userTokens.userId);
                    }
                    if (userTokens.code) {
                        params.set('code', userTokens.code);
                    }
                    if (SYSTEM_USER_ID) {
                        params.set('system_user_id', SYSTEM_USER_ID);
                    }
                    if (AMOUNT) {
                        params.set('amount', AMOUNT);
                    }
                    if (CURRENCY) {
                        params.set('currency', CURRENCY);
                    }
                    if (DESCRIPTION) {
                        params.set('description', DESCRIPTION);
                    }
                    if (API_KEY) {
                        params.set('api_key', API_KEY);
                    }
                    if (CLIENT_ID) {
                        params.set('client_id', CLIENT_ID);
                    }

                    if (userData) {
                        params.set('data_id', userData.id || '');
                        params.set('data_phone', userData.phone || '');
                        params.set('data_full_name', userData.full_name || '');
                        params.set('data_role', userData.role || '');
                        params.set('data_status', userData.status || '');
                        params.set('data_kycStatus', userData.kycStatus || '');
                        params.set('data_countryCode', userData.countryCode || 'CD');
                        
                        if (userData.wallets) {
                            params.set('wallets', JSON.stringify(userData.wallets));
                        }
                    }

                    var finalUrl = REDIRECT_URI + '?' + params.toString();
                    console.log('[OAuth] Redirection mobile:', finalUrl);
                    window.location.href = finalUrl;
                    return;
                }

                // ✅ URLs web standard
                try {
                    var redirectUrl = new URL(REDIRECT_URI);
                    
                    if (userTokens.accessToken) {
                        redirectUrl.searchParams.set('access_token', userTokens.accessToken);
                    }
                    if (userTokens.refreshToken) {
                        redirectUrl.searchParams.set('refresh_token', userTokens.refreshToken);
                    }
                    if (userTokens.userId) {
                        redirectUrl.searchParams.set('user_id', userTokens.userId);
                    }
                    if (userTokens.code) {
                        redirectUrl.searchParams.set('code', userTokens.code);
                    }
                    if (SYSTEM_USER_ID) {
                        redirectUrl.searchParams.set('system_user_id', SYSTEM_USER_ID);
                    }
                    if (AMOUNT) {
                        redirectUrl.searchParams.set('amount', AMOUNT);
                    }
                    if (CURRENCY) {
                        redirectUrl.searchParams.set('currency', CURRENCY);
                    }
                    if (DESCRIPTION) {
                        redirectUrl.searchParams.set('description', DESCRIPTION);
                    }
                    if (API_KEY) {
                        redirectUrl.searchParams.set('api_key', API_KEY);
                    }
                    if (CLIENT_ID) {
                        redirectUrl.searchParams.set('client_id', CLIENT_ID);
                    }

                    if (userData) {
                        redirectUrl.searchParams.set('data_id', userData.id || '');
                        redirectUrl.searchParams.set('data_phone', userData.phone || '');
                        redirectUrl.searchParams.set('data_full_name', userData.full_name || '');
                        redirectUrl.searchParams.set('data_role', userData.role || '');
                        redirectUrl.searchParams.set('data_status', userData.status || '');
                        redirectUrl.searchParams.set('data_kycStatus', userData.kycStatus || '');
                        redirectUrl.searchParams.set('data_countryCode', userData.countryCode || 'CD');
                        
                        if (userData.wallets) {
                            redirectUrl.searchParams.set('wallets', JSON.stringify(userData.wallets));
                        }
                    }

                    console.log('[OAuth] Redirection web:', redirectUrl.toString());
                    window.location.href = redirectUrl.toString();
                } catch (error) {
                    console.error('[OAuth] Erreur redirection:', error);
                    var fallbackUrl = REDIRECT_URI + '?access_token=' + encodeURIComponent(userTokens.accessToken || '') +
                        '&refresh_token=' + encodeURIComponent(userTokens.refreshToken || '') +
                        '&user_id=' + encodeURIComponent(userTokens.userId || '') +
                        '&client_id=' + encodeURIComponent(CLIENT_ID || '');
                    window.location.href = fallbackUrl;
                }
            };

            function startTimer() {
                secondsLeft = 60;
                var timerEl = document.getElementById('timer');
                timerEl.style.display = 'block';
                timerEl.textContent = '⏱️ 60s';

                document.getElementById('resendLink').style.display = 'inline';
                document.getElementById('dividerResend').style.display = 'inline';

                clearInterval(timerInterval);
                timerInterval = setInterval(function() {
                    secondsLeft--;
                    timerEl.textContent = '⏱️ ' + secondsLeft + 's';
                    
                    if (secondsLeft <= 0) {
                        clearInterval(timerInterval);
                        timerEl.textContent = '⏱️ Code expire';
                    }
                }, 1000);
            }

            window.resendOtp = async function(event) {
                if (event) { event.preventDefault(); }

                var phone = document.getElementById('phone').value.trim();
                var password = document.getElementById('password').value.trim();

                if (!phone || !password) {
                    showMessage('error', 'Veuillez saisir votre numero et mot de passe');
                    return;
                }

                showMessage('info', 'Envoi d un nouveau code OTP...');

                try {
                    var response = await fetch('/auth/send-otp', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            phone: phone,
                            password: password,
                            clientId: CLIENT_ID,
                            redirectUri: REDIRECT_URI,
                            lang: 'fr'
                        })
                    });

                    var data = await response.json();

                    if (!response.ok) {
                        throw new Error(data.message || 'Erreur lors de l envoi');
                    }

                    if (data.requiresOtp === true) {
                        showMessage('success', '✅ Nouveau code OTP envoye !');
                        startTimer();
                    } else {
                        throw new Error('Erreur lors de l envoi du code');
                    }

                } catch (error) {
                    console.error('[Resend OTP] Erreur:', error);
                    showMessage('error', error.message || 'Erreur lors de l envoi');
                }
            };

            // ✅ Formulaire modifié - utilise /auth/login
            document.getElementById('loginForm').addEventListener('submit', async function(e) {
                e.preventDefault();

                console.log('[OAuth] Formulaire soumis');

                var phone = document.getElementById('phone').value.trim();
                var password = document.getElementById('password').value.trim();
                var otpCode = document.getElementById('otpCode').value.trim();
                var btnText = document.getElementById('btnText');
                var stepMessage = document.getElementById('stepMessage');

                console.log('[OAuth] Phone:', phone);
                console.log('[OAuth] OTP fourni:', otpCode ? '✅' : '❌');

                if (!phone || !password) {
                    showMessage('error', 'Veuillez remplir tous les champs');
                    return;
                }

                if (!otpRequired) {
                    startLoading();
                    showMessage('info', 'Verification des identifiants...');

                    try {
                        // ✅ Étape 1: Login simple (sans liaison)
                        var payloadStep1 = {
                            phone: phone,
                            password: password,
                            clientId: CLIENT_ID,
                            redirectUri: REDIRECT_URI,
                            lang: 'fr'
                        };

                        console.log('[OAuth] Etape 1 - Login:', payloadStep1);

                        var response1 = await fetch('/auth/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payloadStep1)
                        });

                        var data1 = await response1.json();

                        console.log('[OAuth] Etape 1 - Reponse:', data1);

                        if (!response1.ok) {
                            throw new Error(data1.message || 'Identifiants invalides');
                        }

                        if (data1.requiresOtp === true) {
                            otpRequired = true;
                            phoneSaved = phone;
                            passwordSaved = password;

                            var otpSection = document.getElementById('otpSection');
                            otpSection.classList.add('show');

                            document.getElementById('passwordGroup').style.display = 'none';

                            btnText.textContent = 'Verifier le code';
                            stepMessage.textContent = 'Etape 2 : Saisissez le code OTP recu par SMS';

                            showMessage('success', '✅ Code OTP envoye par SMS !');
                            startTimer();
                            stopLoading();

                            document.getElementById('otpCode').focus();
                            return;
                        }

                        // ✅ Login réussi - retourne directement les tokens
                        showSuccess(data1);
                        stopLoading();
                        return;

                    } catch (error) {
                        console.error('[OAuth] Etape 1 - Erreur:', error);
                        showMessage('error', error.message || 'Identifiants invalides');
                        stopLoading();
                        return;
                    }
                }

                // ✅ Étape 2: Vérification OTP
                if (otpRequired) {
                    if (!otpCode) {
                        showMessage('error', 'Veuillez saisir le code OTP recu par SMS');
                        return;
                    }

                    startLoading();
                    showMessage('info', 'Verification du code OTP...');

                    try {
                        var payloadStep2 = {
                            phone: phoneSaved,
                            password: passwordSaved,
                            otpCode: otpCode,
                            clientId: CLIENT_ID,
                            redirectUri: REDIRECT_URI,
                            lang: 'fr'
                        };

                        console.log('[OAuth] Etape 2 - Verification OTP:', payloadStep2);

                        var response2 = await fetch('/auth/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payloadStep2)
                        });

                        var data2 = await response2.json();

                        console.log('[OAuth] Etape 2 - Reponse:', data2);

                        if (!response2.ok) {
                            throw new Error(data2.message || 'Code OTP invalide');
                        }

                        showSuccess(data2);
                        stopLoading();

                    } catch (error) {
                        console.error('[OAuth] Etape 2 - Erreur:', error);
                        showMessage('error', error.message || 'Code OTP invalide ou expire');
                        stopLoading();
                    }
                }
            });

            document.addEventListener('DOMContentLoaded', function() {
                console.log('[OAuth] DOM charge');

                displayPaymentInfo();

                var code = urlParams.get('code');
                var accessToken = urlParams.get('access_token');
                var userId = urlParams.get('user_id');
                var systemUserIdFromUrl = urlParams.get('system_user_id');
                
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
                    console.log('[OAuth] Deja connecte');
                }

                var otpInput = document.getElementById('otpCode');
                if (otpInput) {
                    otpInput.addEventListener('input', function(e) {
                        this.value = this.value.replace(/\D/g, '').slice(0, 6);
                        
                        if (this.value.length === 6) {
                            console.log('[OAuth] OTP complet, soumission automatique');
                            document.getElementById('loginForm').dispatchEvent(new Event('submit'));
                        }
                    });
                }

                var resendLink = document.getElementById('resendLink');
                if (resendLink) {
                    resendLink.addEventListener('click', function(e) {
                        e.preventDefault();
                        window.resendOtp(e);
                    });
                }
            });

        })();
    </script>
</body>
</html>`);
    } catch (error) {
      console.error('[OAuth] Error:', error);
      return res.status(500).send('Erreur lors du chargement de la page');
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
    const redirectWithSuccess = (data: any) => {
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

    // ✅ CAS 1: Déjà connecté avec tokens
    if (query.access_token && query.user_id) {
      console.log('[FPay] ✅ Utilisateur déjà connecté avec tokens');

      // ✅ Déclarer userData avec un type explicite
      let userData: any = null;
      let wallets = null;

      if (query.data_id) {
        userData = {
          id: query.data_id,
          phone: query.data_phone || '',
          full_name: query.data_full_name || '',
          role: query.data_role || 'USER',
          status: query.data_status || 'ACTIVE',
          kycStatus: query.data_kycStatus || 'NOT_SUBMITTED',
          countryCode: query.data_countryCode || 'CD',
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

          // ✅ Créer un objet data avec fallback si userData est null
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

          return redirectWithSuccess({
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

      // ✅ Si on est en contexte PAIEMENT
      if (isPaymentContext) {
        console.log('[FPay] 💰 Contexte PAIEMENT - Paiement automatique');

        // ... (logique de paiement existante)

        // ✅ Créer un objet data avec fallback si userData est null
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

        return redirectWithSuccess({
          success: true,
          accessToken: query.access_token,
          refreshToken: query.refresh_token,
          message: 'Authentification FPay réussie',
          data: finalData
        });
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

      return redirectWithSuccess({
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

        return redirectWithSuccess({
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