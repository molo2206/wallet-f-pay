-- =====================================================================
-- F-PAY : idempotence des opérations financières + programmes de travail
-- Script NON destructif (uniquement CREATE TABLE / ADD COLUMN / ADD INDEX).
-- À exécuter UNE fois sur la base de production (phpMyAdmin ou mysql),
-- de préférence après une sauvegarde. Ne PAS utiliser prisma migrate dev / db push.
-- Erreurs ignorables si le script est relancé : #1050 (table existe),
-- #1060 (colonne existe), #1061 (index existe).
-- =====================================================================

-- 1) Idempotence (api-gateway) : une même opération n'est jamais exécutée deux fois
CREATE TABLE IF NOT EXISTS `idempotency_requests` (
  `id` varchar(36) NOT NULL,
  `owner` varchar(120) NOT NULL,
  `idem_key` varchar(200) NOT NULL,
  `method` varchar(10) NOT NULL,
  `path` varchar(255) NOT NULL,
  `request_hash` char(64) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'PROCESSING',
  `response_status` int NULL,
  `response_body` mediumtext NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_idempotency_owner_key` (`owner`, `idem_key`),
  KEY `idx_idempotency_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Programmes de travail
CREATE TABLE IF NOT EXISTS `work_schedules` (
  `id` varchar(36) NOT NULL,
  `name` varchar(120) NOT NULL,
  `description` varchar(500) NULL,
  `timezone` varchar(64) NOT NULL DEFAULT 'Africa/Lubumbashi',
  `grace_minutes` int NOT NULL DEFAULT 0,
  `warn_minutes` int NOT NULL DEFAULT 10,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by` varchar(36) NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_work_schedules_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `work_schedule_slots` (
  `id` varchar(36) NOT NULL,
  `schedule_id` varchar(36) NOT NULL,
  `day_of_week` tinyint NOT NULL COMMENT '1 = lundi ... 7 = dimanche',
  `start_time` char(5) NOT NULL COMMENT 'HH:mm',
  `end_time` char(5) NOT NULL COMMENT 'HH:mm (inférieure au début = plage de nuit)',
  PRIMARY KEY (`id`),
  KEY `idx_wss_schedule` (`schedule_id`),
  CONSTRAINT `fk_wss_schedule` FOREIGN KEY (`schedule_id`) REFERENCES `work_schedules` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `work_schedule_assignments` (
  `id` varchar(36) NOT NULL,
  `schedule_id` varchar(36) NOT NULL,
  `target_type` varchar(10) NOT NULL COMMENT 'USER | BRANCH | ROLE',
  `target_id` varchar(36) NOT NULL,
  `created_by` varchar(36) NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wsa_target` (`target_type`, `target_id`),
  KEY `idx_wsa_schedule` (`schedule_id`),
  CONSTRAINT `fk_wsa_schedule` FOREIGN KEY (`schedule_id`) REFERENCES `work_schedules` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `work_schedule_exceptions` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `type` varchar(10) NOT NULL COMMENT 'ALLOW (accès hors horaires) | DENY (accès suspendu)',
  `starts_at` datetime NOT NULL COMMENT 'UTC',
  `ends_at` datetime NOT NULL COMMENT 'UTC',
  `reason` varchar(500) NOT NULL,
  `created_by` varchar(36) NULL,
  `created_at` datetime NOT NULL,
  `revoked_at` datetime NULL,
  PRIMARY KEY (`id`),
  KEY `idx_wse_user_period` (`user_id`, `starts_at`, `ends_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Sessions : motif de fermeture (traçabilité de la déconnexion automatique)
ALTER TABLE `sessions` ADD COLUMN `revoked_reason` varchar(50) NULL;
ALTER TABLE `sessions` ADD COLUMN `revoked_at` datetime NULL;
ALTER TABLE `sessions` ADD INDEX `idx_sessions_valid_expires` (`is_valid`, `expires_at`);

-- 4) Performances : recherches de transactions par statut / référence (supervision, réconciliation)
ALTER TABLE `transaction` ADD INDEX `idx_transaction_status_created` (`status`, `createdAt`);
ALTER TABLE `transaction` ADD INDEX `idx_transaction_reference` (`reference`);

-- 5) Ressource d'administration (droit délégable aux ADMIN ; le SUPER_ADMIN a toujours accès)
INSERT IGNORE INTO `resources` (`id`, `name`, `label`, `description`, `createdAt`, `updatedAt`)
VALUES (UUID(), 'WORK_SCHEDULES', 'Programmes de travail', 'Gestion des horaires d''accès et des dérogations', NOW(), NOW());
INSERT IGNORE INTO `resources` (`id`, `name`, `label`, `description`, `createdAt`, `updatedAt`)
VALUES (UUID(), 'SUPERVISION', 'Supervision', 'Tableau de bord des opérations en attente et indicateurs', NOW(), NOW());
