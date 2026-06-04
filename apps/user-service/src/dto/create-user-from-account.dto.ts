import { UserRole } from './create-user.dto';

export class CreateUserFromAccountDto {
  email?: string; // Optionnel selon votre schéma
  phone?: string; // Optionnel
  full_name?: string; // Optionnel
  account_number?: string; // Optionnel
  branch?: string; // Optionnel
  role?: UserRole; // Optionnel, défaut 'USER'
  merchantCode?: string;
  lang?: string;
  businessName?: string;
  deviceId?: string;
}
