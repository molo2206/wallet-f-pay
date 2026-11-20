// apps/auth-service/src/dto/oauth/oauth-authorize.dto.ts
import { IsString, IsNotEmpty, IsOptional, IsIn, IsUrl } from 'class-validator';

export class OAuthAuthorizeDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  redirectUri: string;

  @IsString()
  @IsIn(['code'])
  @IsNotEmpty()
  responseType: 'code';

  @IsString()
  @IsOptional()
  scope?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsOptional()
  lang?: string;
}

export class OAuthAuthorizeResponseDto {
  redirectUrl: string;
  authorizationCode?: string;
  requiresLogin: boolean;
}