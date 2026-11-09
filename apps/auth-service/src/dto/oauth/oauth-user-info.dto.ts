// apps/auth-service/src/dto/oauth/oauth-user-info.dto.ts
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class OAuthUserInfoDto {
    @IsString()
    @IsNotEmpty()
    accessToken: string;

    @IsString()
    @IsOptional()
    lang?: string;
}

export class OAuthUserInfoResponseDto {
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    role: string;
    account_number: string | null;
    profileImage: string | null;
    kycStatus: string;
    countryCode: string | null;
}