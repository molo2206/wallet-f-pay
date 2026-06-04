/* eslint-disable prettier/prettier */
import { user_passwordStatus, user_role, user_status } from '@prisma/client';

export class UserResponseDto {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  account_number: string | null;
  branch: string | null;
  role: user_role;
  status: user_status;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  merchantCode: string | null;
  businessName: string | null;

  // Champs optionnels (ou obligatoires selon votre besoin)
  fcmToken?: string | null;
  passwordStatus?: user_passwordStatus | null;
  pinstatus?: boolean | null;
  failed_login_attempts?: number;
  locked_until?: Date | null;
}
