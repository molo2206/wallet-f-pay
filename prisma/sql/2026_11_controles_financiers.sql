-- =====================================================================
-- F-PAY : contrôles financiers (double validation, plafonds KYC, grand livre,
-- trésorerie / couverture, arrêtés de caisse)
-- Script NON destructif : CREATE TABLE / INSERT IGNORE / UPDATE d'un indicateur.
-- À exécuter UNE fois après une sauvegarde. Erreurs ignorables si relancé : #1050, #1061.
-- Ne PAS utiliser prisma migrate dev / db push.
-- =====================================================================

-- 1) Double validation des recharges admin
CREATE TABLE IF NOT EXISTS `admin_operation_requests` (
  `id` varchar(36) NOT NULL,
  `operation` varchar(30) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | APPROVED | EXECUTED | FAILED | UNCERTAIN | REJECTED | CANCELLED | EXPIRED',
  `reason` varchar(40) NOT NULL,
  `amount` double NOT NULL,
  `currency` varchar(10) NOT NULL,
  `wallet_id` varchar(36) NOT NULL,
  `target_user_id` varchar(36) NULL,
  `payload` text NOT NULL,
  `note` varchar(500) NULL,
  `requested_by` varchar(36) NOT NULL,
  `requested_at` datetime NOT NULL,
  `expires_at` datetime NOT NULL,
  `decided_by` varchar(36) NULL,
  `decided_at` datetime NULL,
  `decision_note` varchar(500) NULL,
  `result` text NULL,
  `error` varchar(1000) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_aor_status` (`status`, `requested_at`),
  KEY `idx_aor_requested_by` (`requested_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Plafonds par niveau KYC (montants en devise de référence, USD par défaut ; NULL = pas de plafond)
CREATE TABLE IF NOT EXISTS `kyc_limit_tiers` (
  `kyc_status` varchar(20) NOT NULL COMMENT 'NOT_SUBMITTED | PENDING | VERIFIED | REJECTED',
  `per_transaction_limit` double NULL,
  `daily_limit` double NULL,
  `monthly_limit` double NULL,
  `yearly_limit` double NULL,
  `monthly_count_limit` int NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `updated_at` datetime NULL,
  PRIMARY KEY (`kyc_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Valeurs de départ PRUDENTES (à adapter avant de passer LIMITS_MODE=enforce)
INSERT IGNORE INTO `kyc_limit_tiers` (`kyc_status`, `per_transaction_limit`, `daily_limit`, `monthly_limit`, `yearly_limit`, `monthly_count_limit`, `is_active`, `updated_at`) VALUES ('NOT_SUBMITTED', 100, 300, 1500, 10000, 60, 1, NOW());
INSERT IGNORE INTO `kyc_limit_tiers` (`kyc_status`, `per_transaction_limit`, `daily_limit`, `monthly_limit`, `yearly_limit`, `monthly_count_limit`, `is_active`, `updated_at`) VALUES ('PENDING', 100, 300, 1500, 10000, 60, 1, NOW());
INSERT IGNORE INTO `kyc_limit_tiers` (`kyc_status`, `per_transaction_limit`, `daily_limit`, `monthly_limit`, `yearly_limit`, `monthly_count_limit`, `is_active`, `updated_at`) VALUES ('REJECTED', 50, 100, 500, 3000, 30, 1, NOW());
INSERT IGNORE INTO `kyc_limit_tiers` (`kyc_status`, `per_transaction_limit`, `daily_limit`, `monthly_limit`, `yearly_limit`, `monthly_count_limit`, `is_active`, `updated_at`) VALUES ('VERIFIED', 3000, 5000, 30000, 200000, NULL, 1, NOW());

-- 3) Grand livre en partie double (tenu en parallèle, alimenté automatiquement)
CREATE TABLE IF NOT EXISTS `ledger_entries` (
  `id` varchar(36) NOT NULL,
  `transaction_id` varchar(36) NOT NULL,
  `version` int NOT NULL,
  `line` tinyint NOT NULL,
  `account` varchar(120) NOT NULL,
  `account_kind` varchar(20) NOT NULL COMMENT 'WALLET_LIABILITY | WALLET_ASSET | CLEARING',
  `wallet_id` varchar(36) NULL,
  `currency` varchar(10) NOT NULL,
  `debit` double NOT NULL DEFAULT 0,
  `credit` double NOT NULL DEFAULT 0,
  `tx_type` varchar(20) NULL,
  `payment_method` varchar(20) NULL,
  `tx_reference` varchar(255) NULL,
  `occurred_at` datetime NOT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ledger_tx_version_line` (`transaction_id`, `version`, `line`),
  KEY `idx_ledger_account` (`account`, `currency`),
  KEY `idx_ledger_wallet` (`wallet_id`),
  KEY `idx_ledger_occurred` (`occurred_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ledger_tx_state` (
  `transaction_id` varchar(36) NOT NULL,
  `projected_amount` double NOT NULL,
  `projected_status` varchar(20) NOT NULL,
  `version` int NOT NULL DEFAULT 0,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`transaction_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ledger_meta` (
  `k` varchar(60) NOT NULL,
  `v` varchar(255) NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Index utile au grand livre et aux plafonds (curseur de mise à jour)
ALTER TABLE `transaction` ADD INDEX `idx_transaction_updated` (`updatedAt`, `id`);
ALTER TABLE `transaction` ADD INDEX `idx_transaction_user_created` (`userId`, `createdAt`);

-- 4) Trésorerie : comptes déclarés (banque, autres opérateurs) et historique des soldes
CREATE TABLE IF NOT EXISTS `treasury_accounts` (
  `id` varchar(36) NOT NULL,
  `name` varchar(120) NOT NULL,
  `kind` varchar(20) NOT NULL COMMENT 'BANK | PROVIDER | CASH_OTHER | OTHER',
  `currency` varchar(10) NOT NULL,
  `balance` double NOT NULL DEFAULT 0,
  `reference` varchar(120) NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `updated_by` varchar(36) NULL,
  `updated_at` datetime NOT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_treasury_currency` (`currency`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `treasury_balance_history` (
  `id` varchar(36) NOT NULL,
  `account_id` varchar(36) NOT NULL,
  `previous_balance` double NOT NULL,
  `balance` double NOT NULL,
  `note` varchar(500) NOT NULL,
  `updated_by` varchar(36) NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_tbh_account` (`account_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5) Photos quotidiennes de couverture de la monnaie électronique
CREATE TABLE IF NOT EXISTS `coverage_snapshots` (
  `id` varchar(36) NOT NULL,
  `business_date` date NOT NULL,
  `currency` varchar(10) NOT NULL,
  `customer_liabilities` double NOT NULL,
  `fee_wallets` double NOT NULL,
  `branch_cash` double NOT NULL,
  `provider_float` double NOT NULL,
  `provider_float_source` varchar(20) NULL,
  `bank_and_other` double NOT NULL,
  `assets_total` double NOT NULL,
  `gap` double NOT NULL,
  `coverage_ratio` double NULL,
  `status` varchar(20) NOT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coverage_date_currency` (`business_date`, `currency`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6) Arrêtés de caisse des agences
CREATE TABLE IF NOT EXISTS `branch_cash_closings` (
  `id` varchar(36) NOT NULL,
  `branch_id` varchar(36) NOT NULL,
  `currency` varchar(10) NOT NULL,
  `business_date` date NOT NULL,
  `expected_balance` double NOT NULL,
  `counted_amount` double NOT NULL,
  `difference` double NOT NULL,
  `difference_status` varchar(20) NOT NULL COMMENT 'BALANCED | SURPLUS | SHORTAGE',
  `cash_in` double NOT NULL DEFAULT 0,
  `cash_out` double NOT NULL DEFAULT 0,
  `movements_count` int NOT NULL DEFAULT 0,
  `note` varchar(1000) NULL,
  `status` varchar(20) NOT NULL DEFAULT 'SUBMITTED' COMMENT 'SUBMITTED | APPROVED | REJECTED',
  `submitted_by` varchar(36) NOT NULL,
  `submitted_at` datetime NOT NULL,
  `reviewed_by` varchar(36) NULL,
  `reviewed_at` datetime NULL,
  `review_note` varchar(1000) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_closing_branch_currency_date` (`branch_id`, `currency`, `business_date`),
  KEY `idx_closing_status` (`status`, `business_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7) Caisses d'agence : marquer les wallets de caisse déjà créés (ils n'avaient pas l'indicateur)
-- Contrôle d'abord (lecture seule) :
SELECT w.`id`, w.`currency`, w.`balance`, u.`email` FROM `wallet` w INNER JOIN `user` u ON u.`id` = w.`userId` WHERE u.`email` LIKE 'caisse.%' AND u.`branchId` = w.`branchId` AND (w.`isBranchWallet` = 0 OR w.`isBranchWallet` IS NULL);
UPDATE `wallet` w INNER JOIN `user` u ON u.`id` = w.`userId` SET w.`isBranchWallet` = 1 WHERE u.`email` LIKE 'caisse.%' AND u.`branchId` = w.`branchId` AND (w.`isBranchWallet` = 0 OR w.`isBranchWallet` IS NULL);

-- 8) Droits délégables aux ADMIN (le SUPER_ADMIN a toujours accès)
INSERT IGNORE INTO `resources` (`id`, `name`, `label`, `description`, `createdAt`, `updatedAt`)
VALUES (UUID(), 'APPROVALS', 'Validation des opérations', 'Valider ou rejeter les recharges admin soumises à double validation', NOW(), NOW());
INSERT IGNORE INTO `resources` (`id`, `name`, `label`, `description`, `createdAt`, `updatedAt`)
VALUES (UUID(), 'TREASURY', 'Trésorerie', 'Grand livre, couverture, floats, réconciliation opérateur, validation des arrêtés de caisse', NOW(), NOW());
