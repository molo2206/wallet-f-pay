// dto/register-request.dto.ts
import { IsString, IsOptional, IsNotEmpty, MinLength } from 'class-validator';

export class RegisterUserDto {
  @IsOptional()
  @IsString()
  account_number?: string;

  @IsString()
  @IsNotEmpty()
  full_name: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsString()
  otpCode?: string;

  // ✅ Mot de passe OBLIGATOIRE
  @IsNotEmpty({ message: 'Le mot de passe est requis' })
  @IsString()
  @MinLength(8, { message: 'Le mot de passe doit contenir au moins 8 caractères' })
  password: string;

  @IsOptional()
  fcmToken?: string;

  @IsOptional()
  platform?: string;

  @IsOptional()
  deviceInfo?: string;

  @IsOptional()
  email?: string;

  @IsOptional()
  countryCode?: string;

  @IsOptional()
  lang?: string;
}