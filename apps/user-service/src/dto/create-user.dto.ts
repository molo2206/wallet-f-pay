// api-gateway/src/dto/user.dto.ts
export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
  MERCHANT = 'MERCHANT',
}

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

// Pour créer un utilisateur
export class CreateUserDto {
  email?: string;
  phone?: string;
  full_name: string;
  account_number?: string;
  branch?: string;
  role?: UserRole;
  merchantCode?: string;
  lang?: string;
  businessName?: string;
  deviceId?: string;
  countryCode?: string;
  merchantType?: UserMerchantType;
  businessCategory?: string;
  businessAddress?: string;
}

// Pour mettre à jour un utilisateur
export class UpdateUserDto {
  email?: string;
  phone?: string;
  password?: string;
  full_name?: string;
  account_number?: string;
  branch?: string;
  role?: UserRole;
  status?: UserStatus;
  lang?: string;
  businessName?: string;
  countryCode?: string;
  merchantType?: UserMerchantType;
  businessCategory?: string;
  businessAddress?: string;
}

// Pour la réponse
export class UserResponseDto {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  account_number: string | null;
  branch: string | null;
  role: string;
  status: string;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  merchantCode?: string | null;
  lang?: string;
  businessName?: string | null;
  countryCode?: string | null;
  merchantType?: string | null;
  businessCategory?: string | null;
  businessAddress?: string | null;
}