export enum UserSettingsTheme {
  LIGHT = 'light',
  DARK = 'dark',
  SYSTEM = 'system',
}

export class UpdateUserSettingsDto {
  language?: string; // ex: 'fr', 'en', 'sw'
  theme?: UserSettingsTheme;
  email_notifications?: boolean;
  sms_notifications?: boolean;
  push_notifications?: boolean;
  two_factor_enabled?: boolean;
  last_device?: string;
}
