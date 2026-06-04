import { Request } from 'express';
import { user_role, user, user_status } from '@prisma/client';

export type CurrentUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
  full_name?: string | null;
  role: user_role;
  status: user_status;
  deleted?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface AuthenticatedRequest extends Request {
  currentUser?: user | null;
}
