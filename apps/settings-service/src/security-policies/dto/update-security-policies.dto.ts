export class UpdateSecurityPoliciesDto {
  password_min_length?: number;
  password_require_uppercase?: boolean;
  password_require_lowercase?: boolean;
  password_require_numbers?: boolean;
  password_require_special?: boolean;
  password_expiry_days?: number;
  password_history_count?: number;
  session_timeout_minutes?: number;
  max_concurrent_sessions?: number;
  remember_me_duration_days?: number;
  max_login_attempts?: number;
  lockout_duration_minutes?: number;
  require_captcha_after_attempts?: number;
  enforce_2fa?: boolean;
  enforce_2fa_for_admins?: boolean;
  allowed_2fa_methods?: string[];
  enable_ip_whitelist?: boolean;
  enable_ip_blacklist?: boolean;
}
