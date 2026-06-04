// apps/user-service/src/dto/update-user.dto.ts
import {
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  Matches,
  IsEnum,
} from 'class-validator';
import { UserRole } from './create-user.dto';

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  BLOCKED = 'BLOCKED',
  SUSPENDED = 'SUSPENDED',
}

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(8) // au moins 8 caractères pour le mot de passe
  password?: string;

  @IsOptional()
  @IsString()
  @MinLength(4) // au moins 4 chiffres pour le PIN
  @Matches(/^\d+$/, { message: 'PIN must contain only digits' })
  pin?: string;

  @IsOptional()
  @IsString()
  full_name?: string;

  @IsOptional()
  @IsString()
  account_number?: string;

  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  businessName?: string;

  lang?: string;
}
