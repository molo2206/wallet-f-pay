// dto/auth-response.dto.ts
import { user_role, user_status } from '@prisma/client';

export interface UserInfoDto {
  id: string;
  email: string | null;
  phone: string | null;
  password?: string | null;
  full_name: string | null;
  account_number: string | null;
  branch: string | null;
  role: user_role;
  status: user_status;
  deleted: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  fcmToken: string | null;
  pin?: string | null;
  passwordStatus: string | null;
  pinstatus: boolean | null;
  merchantCode?: string | null;
  businessName?: string | null;
  countryCode?: string | null;
}


export interface SessionDto {
  id: string;
  device_info: string | null;
  ip_address: string | null;
  last_activity: Date | null;
  created_at: Date | null;
  expires_at: Date;
}

export interface ResourcePermissionDto {
  id: string;
  name: string;
  label: string;
  permissions: {
    canCreate: boolean;
    canRead: boolean;
    canUpdate: boolean;
    canDelete: boolean;
    canManage: boolean;
  };
  grantedAt: Date;
  expiresAt: Date | null;
}

export interface AuthResponseDto {
  accessToken: string;
  refreshToken: string;
  data: UserInfoDto;
  message?: string;
  sessions?: SessionDto[];
  sessionId?: string;
  resources?: ResourcePermissionDto[];
  wallets?: any[];
}