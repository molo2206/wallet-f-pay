// apps/api-gateway/src/types/current-user.types.ts

import { Request } from 'express';
import { 
  user_role, 
  user, 
  user_status, 
  user_kycStatus,
  user_merchantType,
  user_passwordStatus 
} from '@prisma/client';

export type CurrentUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
  full_name?: string | null;
  account_number?: string | null;
  merchantCode?: string | null;
  branch?: string | null;
  role: user_role;
  status: user_status;
  deleted?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  pin?: string | null;
  passwordStatus?: user_passwordStatus | null;
  fcmToken?: string | null;
  pinstatus?: boolean | null;
  businessName?: string | null;
  failed_login_attempts?: number | null;
  locked_until?: Date | null;
  failed_pin_attempts?: number | null;
  pin_locked_until?: Date | null;
  kycStatus?: user_kycStatus | null;
  countryCode?: string | null;
  profileImage?: string | null;
  merchantType?: user_merchantType | null;
  businessCategory?: string | null;
  businessAddress?: string | null;
  maintenance_fee?: number | null;
  last_maintenance_date?: Date | null;
  is_maintenance_exempt?: boolean | null;
};

export interface AuthenticatedRequest extends Request {
  currentUser?: user | null;
}