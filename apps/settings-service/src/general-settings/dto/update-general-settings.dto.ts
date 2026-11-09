export class UpdateGeneralSettingsDto {
  platform_name?: string;
  platform_logo?: string;
  platform_favicon?: string;
  contact_email?: string;
  contact_phone?: string;
  support_email?: string;
  address?: string;
  timezone?: string;
  date_format?: string;
  time_format?: string;
  maintenance_mode?: boolean;
  maintenance_message?: string;
}
