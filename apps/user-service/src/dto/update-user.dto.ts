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

export enum UserMerchantType {
  RETAIL = 'RETAIL',
  WHOLESALE = 'WHOLESALE',
  RESTAURANT = 'RESTAURANT',
  HOTEL = 'HOTEL',
  TRANSPORT = 'TRANSPORT',
  HEALTHCARE = 'HEALTHCARE',
  EDUCATION = 'EDUCATION',
  TECHNOLOGY = 'TECHNOLOGY',
  FINANCIAL = 'FINANCIAL',
  REAL_ESTATE = 'REAL_ESTATE',
  CONSTRUCTION = 'CONSTRUCTION',
  AGRICULTURE = 'AGRICULTURE',
  MANUFACTURING = 'MANUFACTURING',
  ENTERTAINMENT = 'ENTERTAINMENT',
  BEAUTY = 'BEAUTY',
  FASHION = 'FASHION',
  SPORTS = 'SPORTS',
  PHARMACY = 'PHARMACY',
  SUPERMARKET = 'SUPERMARKET',
  ELECTRONICS = 'ELECTRONICS',
  AUTOMOTIVE = 'AUTOMOTIVE',
  OTHER = 'OTHER',
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
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
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

  // ✅ Nouveaux champs marchands
  @IsOptional()
  @IsEnum(UserMerchantType)
  merchantType?: UserMerchantType;

  @IsOptional()
  @IsString()
  businessCategory?: string;

  @IsOptional()
  @IsString()
  businessAddress?: string;

  @IsOptional()
  @IsString()
  countryCode?: string;

  lang?: string;
}