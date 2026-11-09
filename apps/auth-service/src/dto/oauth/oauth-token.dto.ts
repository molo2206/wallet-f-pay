// apps/auth-service/src/dto/oauth/oauth-token.dto.ts
import { IsString, IsNotEmpty, IsOptional, IsIn, IsUrl } from 'class-validator';

export class OAuthTokenDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  clientSecret: string;

  @IsString()
  @IsIn(['authorization_code', 'refresh_token'])
  @IsNotEmpty()
  grantType: 'authorization_code' | 'refresh_token';

  @IsString()
  @IsOptional()
  code?: string;

  @IsString()
  @IsOptional()
  refreshToken?: string;

  @IsUrl({ require_tld: false })
  @IsOptional()
  redirectUri?: string;

  @IsString()
  @IsOptional()
  lang?: string;
}

export class OAuthTokenResponseDto {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export class OAuthRevokeTokenDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @IsIn(['access_token', 'refresh_token'])
  @IsOptional()
  tokenType?: 'access_token' | 'refresh_token';

  @IsString()
  @IsOptional()
  lang?: string;
}

export class OAuthValidateTokenDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class OAuthValidateTokenResponseDto {
  valid: boolean;
  userId?: string;
  clientId?: string;
  expiresAt?: Date;
  scope?: string;
}