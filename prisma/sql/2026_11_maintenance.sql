-- =====================================================================
-- F-PAY : mode maintenance avancé
-- Script NON destructif (CREATE TABLE + INSERT IGNORE). À exécuter une fois.
-- Erreur ignorable si relancé : #1050.
-- =====================================================================

CREATE TABLE IF NOT EXISTS `maintenance_windows` (
  `id` varchar(36) NOT NULL,
  `title` varchar(150) NOT NULL,
  `messages` text NULL COMMENT 'JSON { fr, en, sw }',
  `scope` varchar(20) NOT NULL DEFAULT 'FULL' COMMENT 'FULL | READ_ONLY | MODULES',
  `modules` text NULL COMMENT 'JSON : DEPOSITS, WITHDRAWALS, TRANSFERS, PAYMENTS, CONVERSION, LOGIN, REGISTRATION, EXTERNAL_API, KYC, CASH_DESK',
  `starts_at` datetime NOT NULL COMMENT 'UTC',
  `ends_at` datetime NULL COMMENT 'UTC ; NULL = jusqu''à nouvel ordre',
  `status` varchar(20) NOT NULL DEFAULT 'SCHEDULED' COMMENT 'SCHEDULED | ACTIVE | ENDED | CANCELLED',
  `allow_roles` text NULL COMMENT 'JSON : rôles exemptés',
  `allow_user_ids` text NULL COMMENT 'JSON : comptes exemptés',
  `allow_ips` text NULL COMMENT 'JSON : adresses IP exemptées',
  `notify_users` tinyint(1) NOT NULL DEFAULT 0,
  `notify_before_minutes` int NOT NULL DEFAULT 30,
  `notified_before_at` datetime NULL,
  `notified_start_at` datetime NULL,
  `notified_end_at` datetime NULL,
  `synced_legacy` tinyint(1) NOT NULL DEFAULT 0,
  `created_by` varchar(36) NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `started_at` datetime NULL,
  `ended_at` datetime NULL,
  `ended_by` varchar(36) NULL,
  `end_reason` varchar(500) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_maintenance_status_dates` (`status`, `starts_at`, `ends_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Droit délégable aux ADMIN (le SUPER_ADMIN a toujours accès)
INSERT IGNORE INTO `resources` (`id`, `name`, `label`, `description`, `createdAt`, `updatedAt`)
VALUES (UUID(), 'MAINTENANCE', 'Mode maintenance', 'Planifier, démarrer, prolonger et terminer les maintenances', NOW(), NOW());
