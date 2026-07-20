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
import type { Response } from 'express';
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

const gatewayLoginLocks = new Map<string, boolean>();

interface RpcError {
  status?: string;
  message?: string;
  statusCode?: number;
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
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    let start: Date | undefined;
    let end: Date | undefined;
    if (startDate) start = new Date(startDate);
    if (endDate) end = new Date(endDate);
    const response = await this.sendWalletMessage<any>(
      'list_transactions',
      {
        userId: currentUser.id,
        page: pageNum,
        limit: limitNum,
        startDate: start,
        endDate: end,
      },
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
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const response = await this.sendWalletMessage<any>(
      'list_all_transactions',
      {
        page: pageNum,
        limit: limitNum,
        userId,
        type,
        status,
        startDate,
        endDate,
        search,
      },
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
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_admin_dashboard',
      { startDate, endDate },
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
  //============================== Endpoint admin pour générer des clés API ================================================
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
  //===============================Externe====================================================
  // Cache simple : clé → { walletId, expiresAt }
  @Post('api/external/pay')
  @UseGuards(ApiKeyGuard)
  @PermissionsApi_Key('pay')
  async externalPay(
    @Request() req: any,
    @Body() body: {
      toPhoneOrCode: string;
      amount: number;
      currency?: string;
      description?: string;
      walletId?: string;
    },
    @Ip() ipAddress: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    const user = req.user;
    let fromWalletId = body.walletId;

    // ✅ Si walletId n'est pas fourni, récupérer par devise
    if (!fromWalletId) {
      // Devise par défaut: USD si non spécifiée
      const targetCurrency = body.currency || 'USD';
      const cacheKey = `${user.id}:${targetCurrency}`;

      // Vérifier le cache
      const cached = walletCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        fromWalletId = cached.walletId;
        console.log(`[ExternalPay] ✅ Wallet trouvé en cache pour ${targetCurrency}: ${fromWalletId}`);
      } else {
        // ✅ Récupérer le wallet par devise
        const wallet = await this.prisma.wallet.findFirst({
          select: { id: true },
          where: {
            userId: user.id,
            isActive: true,
            currency: targetCurrency as any,
          },
        });

        if (!wallet) {
          console.error(`[ExternalPay] ❌ Aucun wallet trouvé pour l'utilisateur ${user.id} en ${targetCurrency}`);

          // ✅ Lister les wallets disponibles pour l'utilisateur
          const availableWallets = await this.prisma.wallet.findMany({
            where: { userId: user.id, isActive: true },
            select: { id: true, currency: true },
          });

          const availableCurrencies = availableWallets.map(w => w.currency).join(', ');

          throw new HttpException(
            `No active ${targetCurrency} wallet found for this user. Available currencies: ${availableCurrencies || 'None'}`,
            HttpStatus.BAD_REQUEST,
          );
        }

        fromWalletId = wallet.id;

        // Mettre en cache
        walletCache.set(cacheKey, {
          walletId: fromWalletId,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });

        console.log(`[ExternalPay] ✅ Wallet trouvé pour ${targetCurrency}: ${fromWalletId}`);
      }
    } else {
      // ✅ Vérifier que le walletId appartient bien à l'utilisateur
      const wallet = await this.prisma.wallet.findFirst({
        select: { id: true, currency: true },
        where: {
          id: fromWalletId,
          userId: user.id,
          isActive: true,
        },
      });

      if (!wallet) {
        throw new HttpException(
          `Wallet ${fromWalletId} not found or does not belong to this user`,
          HttpStatus.BAD_REQUEST,
        );
      }

      console.log(`[ExternalPay] ✅ Wallet ${fromWalletId} (${wallet.currency}) appartient à l'utilisateur`);
    }

    // ✅ Appel à sendWalletMessage
    const response = await this.sendWalletMessage(
      'pay',
      {
        fromWalletId: fromWalletId,
        toPhone: body.toPhoneOrCode,
        merchantCode: null,
        amount: body.amount,
        description: body.description,
        lang,
        ipAddress,
        skipPinCheck: true,
      },
      this.i18nService.translate('wallet.payment_failed', lang),
      HttpStatus.BAD_REQUEST,
    );

    return response;
  }
  // ==================== KYC ENDPOINTS ====================

  /**
   * Soumettre une demande KYC avec upload de fichiers
   */
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
      code: string;
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
    if (!body.code) {
      throw new HttpException('Le code de la branche est requis', HttpStatus.BAD_REQUEST);
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

  // apps/api-gateway/src/api-gateway.controller.ts

  // ==================== VALIDATION TRANSFERT INTERNATIONAL ====================

  /**
   * Valide un transfert international en attente (Admin uniquement)
   */
  @Post('admin/wallet/validate-transfer')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async validateInternationalTransfer(
    @CurrentUser() currentUser: any,
    @Body() body: {
      transactionId: string;
      pin: string;
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

    console.log('[API Gateway] validate_international_transfer:', {
      transactionId: body.transactionId,
      adminId: currentUser.id,
      lang,
    });

    return this.sendWalletMessage(
      'validate_international_transfer',
      {
        transactionId: body.transactionId,
        adminId: currentUser.id,
        adminPin: body.pin,
        lang,
        ipAddress,
      },
      this.i18nService.translate('wallet.transfer_validation_failed', lang),
      HttpStatus.BAD_REQUEST,
      120000,
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