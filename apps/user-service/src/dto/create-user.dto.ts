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

// Pour créer un utilisateur
export class CreateUserDto {
  email?: string;
  phone?: string;
  full_name: string; // requis selon HEAD
  account_number?: string;
  branch?: string;
  role?: UserRole; // typé avec l'enum
  merchantCode?: string;
  lang?: string;
  businessName?: string;
  deviceId?: string;
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
}

// Pour la réponse
export class UserResponseDto {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  account_number: string | null;
  branch: string | null;
  role: string; // ou UserRole selon votre usage
  status: string; // ou UserStatus
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  merchantCode?: string | null;
  lang?: string;
  businessName?: string;
}
