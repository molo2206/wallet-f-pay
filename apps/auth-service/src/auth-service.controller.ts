/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Controller, UnauthorizedException, UseGuards } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
  RpcException,
} from '@nestjs/microservices';
import { AuthServiceService } from './auth-service.service';
import { LoginUserDto } from './dto/login-user.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { AccountInfo } from './dto/account.dto';
import { RmqAuthGuard } from './utility/guards/rmq-auth.guard';

@Controller()
export class AuthServiceController {
  constructor(private readonly authService: AuthServiceService) { }

  @MessagePattern('login_user')
  async login(@Payload() data: LoginUserDto & { ipAddress?: string }) {
    console.log('[AuthService] Login request received:', {
      identifier: data.identifier,
      hasPassword: !!data.password,
      hasFcmToken: !!data.fcmToken,
      deviceInfo: data.deviceInfo,
    });

    try {
      const result = await this.authService.login(data, data.ipAddress);
      console.log('[AuthService] Login successful for:', data.identifier);
      return result;
    } catch (error) {
      console.error('[AuthService] Login failed for:', data.identifier, error);

      if (error instanceof RpcException) {
        throw error;
      }

      throw new RpcException({
        status: 'error',
        message: error.message || 'Login failed',
        statusCode: error.statusCode || error.status || 401,
      });
    }
  }

  @MessagePattern('register_user')
  async register(
    @Payload() data: RegisterUserDto & { ipAddress?: string; lang?: string },
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const message = context.getMessage();
    try {
      const result = await this.authService.register(data, data.ipAddress);
      channel.ack(message);
      return result;
    } catch (error) {
      channel.ack(message);
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 400,
      });
    }
  }

  @MessagePattern('verify_otp')
  async verifyOtp(
    @Payload() data: { identifier: string; code: string },
  ): Promise<{ message: string }> {
    console.log('[AuthService] Verify OTP request:', data.identifier);
    try {
      const result = await this.authService.verifyOtp(
        data.identifier,
        data.code,
      );
      return result;
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('send_reset_otp')
  async sendResetPasswordOtp(
    @Payload() data: { identifier: string; lang?: string },
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const message = context.getMessage();
    try {
      const identifier = data.identifier;
      const lang = data.lang || 'fr';
      if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
        throw new RpcException('Identifier manquant ou invalide');
      }
      const result = await this.authService.sendResetPasswordOtp(
        identifier.trim(),
        undefined,
        lang,
      );
      channel.ack(message);
      return result;
    } catch (error) {
      channel.ack(message);
      throw new RpcException(error instanceof Error ? error.message : error);
    }
  }

  @MessagePattern('reset_password')
  async resetPassword(
    @Payload()
    data: {
      identifier: string;
      code: string;
      password: string;
      lang?: string;
    },
  ): Promise<{ message: string }> {
    console.log(
      '📝 [AuthService] Reset password request received:',
      JSON.stringify(data),
    );
    try {
      const result = await this.authService.resetPassword({
        identifier: data.identifier,
        code: data.code,
        password: data.password,
        lang: data.lang,
      });
      return result;
    } catch (error) {
      console.error('❌ [AuthService] Reset password error:', error);
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @UseGuards(RmqAuthGuard)
  @MessagePattern('change_password')
  async changePassword(
    @Payload()
    data: {
      userId: string;
      currentPassword: string;
      newPassword: string;
      token: string;
    },
    @Ctx() context: RmqContext,
  ): Promise<{ message: string }> {
    const channel = context.getChannelRef();
    const message = context.getMessage();

    try {
      const result = await this.authService.changePassword(data.userId, {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });

      channel.ack(message);
      return result;
    } catch (error) {
      channel.ack(message);
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_account_by_number')
  async getAccountByNumber(
    @Payload() data: { accountNumber: string; lang?: string },
  ): Promise<AccountInfo> {
    console.log(
      '📞 [AuthService] Get account request received:',
      data.accountNumber,
    );
    try {
      const lang = data.lang || 'fr';
      const account = await this.authService.getAccountByNumber(
        data.accountNumber,
        lang,
      );
      console.log('✅ [AuthService] Account found:', data.accountNumber);
      return account;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('❌ [AuthService] Get account failed:', errorMessage);

      let statusCode = 404;
      if (error instanceof UnauthorizedException) {
        statusCode = 401;
      }

      throw new RpcException({
        status: 'error',
        message: errorMessage,
        statusCode,
      });
    }
  }

  @MessagePattern('validate_session')
  async validateSession(
    @Payload() data: { userId: string; sessionToken: string },
  ) {
    const valid = await this.authService.validateSession(
      data.userId,
      data.sessionToken,
    );
    return { valid };
  }

  @MessagePattern('list_all_sessions')
  async listAllSessions(@Payload() data: { page?: number; limit?: number }) {
    console.log('[AuthService] list_all_sessions handler called');
    return this.authService.listAllSessions(data.page, data.limit);
  }

  @MessagePattern('list_user_sessions')
  async listUserSessions(
    @Payload() data: { userId: string; page?: number; limit?: number },
  ) {
    console.log('[AuthService] list_user_sessions handler called');
    return this.authService.listUserSessions(
      data.userId,
      data.page,
      data.limit,
    );
  }

  @MessagePattern('register_device_token')
  async registerDeviceToken(
    @Payload() data: { userId: string; fcmToken: string },
  ) {
    return this.authService.registerDeviceToken(data.userId, data.fcmToken);
  }

  @MessagePattern('revoke_session_by_id')
  async revokeSessionById(
    @Payload() data: { userId: string; sessionId: string; lang?: string },
  ) {
    try {
      return await this.authService.revokeSessionById(
        data.userId,
        data.sessionId,
        data.lang || 'fr',
      );
    } catch (error) {
      console.error('[AuthService] revoke_session_by_id error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Échec de la déconnexion',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('get_UserStatus')
  async getUserStatus(@Payload() data: { userId: string }) {
    return this.authService.getUserStatus(data.userId);
  }

  @MessagePattern('get_session_by_id')
  async getSessionById(@Payload() data: { sessionId: string; lang?: string }) {
    return this.authService.getSessionById(data.sessionId, data.lang || 'fr');
  }

  @MessagePattern('check_phone_exists')
  async checkPhoneExists(@Payload() data: { phone: string; lang?: string }) {
    const lang = data.lang || 'fr';
    try {
      return await this.authService.checkPhoneExists(data.phone, lang);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to check phone',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_login_attempts')
  async getLoginAttempts(
    @Payload() data: { userId: string; page?: number; limit?: number },
  ) {
    try {
      return await this.authService.getLoginAttempts(
        data.userId,
        data.page,
        data.limit,
      );
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 500,
      });
    }
  }

  @MessagePattern('health_check')
  async healthCheck() {
    return { status: 'ok', service: 'auth-service' };
  }
}
