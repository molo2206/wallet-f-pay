import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class LoginUserDto {
  @IsString()
  @IsNotEmpty()
  identifier: string; // Peut être téléphone ou numéro de compte

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsOptional()
  fcmToken?: string;

  @IsOptional()
  platform?: string;

  @IsOptional()
  deviceInfo?: string;

  @IsOptional()
  lang?: string;

  @IsOptional()
  deviceId?: string;
}
