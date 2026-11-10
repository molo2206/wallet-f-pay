-- =====================================================================
-- F-PAY : comptabilité SYSCOHADA (OHADA)
-- Script NON destructif (CREATE TABLE + INSERT IGNORE). À exécuter une fois, après une sauvegarde.
-- Erreurs ignorables si relancé : #1050, #1061.
-- Après exécution et redémarrage du wallet-service : POST /admin/accounting/run { "mode": "full" }
-- pour passer en comptabilité tout l'historique des transactions.
-- =====================================================================

-- 1) Plan comptable
CREATE TABLE IF NOT EXISTS `accounting_accounts` (
  `code` varchar(10) NOT NULL,
  `label` varchar(150) NOT NULL,
  `type` varchar(20) NOT NULL COMMENT 'ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE',
  `is_system` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('101', 'Capital social', 'EQUITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('121', 'Report à nouveau créditeur', 'EQUITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('129', 'Report à nouveau débiteur', 'EQUITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('131', 'Résultat net : bénéfice', 'EQUITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('139', 'Résultat net : perte', 'EQUITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('4011', 'Fournisseurs – opérateurs Mobile Money', 'LIABILITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('4191', 'Clients – fonds de monnaie électronique', 'LIABILITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('4192', 'Marchands – fonds de monnaie électronique', 'LIABILITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('421', 'Personnel, rémunérations dues', 'LIABILITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('441', 'État, impôt sur les bénéfices', 'LIABILITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('443', 'État, TVA facturée', 'LIABILITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('4711', 'Compte d''attente – opérations à analyser', 'LIABILITY', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('5211', 'Banques locales', 'ASSET', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('5311', 'Opérateurs Mobile Money (PawaPay)', 'ASSET', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('5312', 'Partenaires API – encaissements', 'ASSET', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('5711', 'Caisses des agences', 'ASSET', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('5712', 'Caisse siège', 'ASSET', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('5851', 'Virements internes de fonds (compensation)', 'ASSET', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('5852', 'Compensation des conversions de devises', 'ASSET', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('6318', 'Commissions des opérateurs Mobile Money', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('631', 'Frais bancaires', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('622', 'Locations et charges locatives', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('624', 'Entretien, réparations et maintenance', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('628', 'Frais de télécommunications', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('632', 'Rémunérations d''intermédiaires et de conseils', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('6371', 'Frais de SMS et notifications', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('641', 'Impôts et taxes directs', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('661', 'Rémunérations directes du personnel', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('6588', 'Autres charges diverses', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('676', 'Pertes de change', 'EXPENSE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('7061', 'Commissions sur dépôts Mobile Money', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('7062', 'Commissions sur retraits', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('7063', 'Frais de transfert national', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('7064', 'Frais de transfert et paiement international', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('7065', 'Frais de tenue de compte (maintenance)', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('7066', 'Commissions de parrainage', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('7067', 'Commissions sur paiements taxi', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('7068', 'Autres commissions et frais de service', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('758', 'Produits divers', 'REVENUE', 1, 1, NOW());
INSERT IGNORE INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES ('776', 'Gains de change', 'REVENUE', 1, 1, NOW());

-- 2) Écritures et lignes (montants en devise d'origine + en devise comptable)
CREATE TABLE IF NOT EXISTS `accounting_entries` (
  `id` varchar(36) NOT NULL,
  `journal` varchar(4) NOT NULL COMMENT 'MM | CA | VI | PR | CH | BQ | OD',
  `entry_date` date NOT NULL,
  `reference` varchar(255) NULL,
  `label` varchar(255) NOT NULL,
  `source` varchar(20) NOT NULL COMMENT 'AUTO | AUTO_CORRECTION | MANUAL | REVERSAL',
  `transaction_id` varchar(36) NULL,
  `version` int NOT NULL DEFAULT 1,
  `currency` varchar(10) NOT NULL,
  `rate_to_ref` double NOT NULL DEFAULT 1,
  `branch_id` varchar(36) NULL,
  `reversed_by` varchar(36) NULL,
  `created_by` varchar(36) NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_accounting_tx_version` (`transaction_id`, `version`),
  KEY `idx_accounting_entries_date` (`entry_date`, `journal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `accounting_lines` (
  `id` varchar(36) NOT NULL,
  `entry_id` varchar(36) NOT NULL,
  `line` int NOT NULL,
  `account_code` varchar(10) NOT NULL,
  `debit` double NOT NULL DEFAULT 0,
  `credit` double NOT NULL DEFAULT 0,
  `debit_ref` double NOT NULL DEFAULT 0,
  `credit_ref` double NOT NULL DEFAULT 0,
  `currency` varchar(10) NOT NULL,
  `entry_date` date NOT NULL,
  `branch_id` varchar(36) NULL,
  `label` varchar(255) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_accounting_lines_entry` (`entry_id`),
  KEY `idx_accounting_lines_account_date` (`account_code`, `entry_date`),
  KEY `idx_accounting_lines_date` (`entry_date`),
  KEY `idx_accounting_lines_branch` (`branch_id`, `entry_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Suivi de la passation automatique
CREATE TABLE IF NOT EXISTS `accounting_tx_state` (
  `transaction_id` varchar(36) NOT NULL,
  `amount` double NOT NULL,
  `status` varchar(20) NOT NULL,
  `version` int NOT NULL DEFAULT 0,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`transaction_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `accounting_meta` (
  `k` varchar(60) NOT NULL,
  `v` varchar(255) NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) Commissions facturées par les opérateurs (estimation des charges) — à renseigner selon votre contrat PawaPay
CREATE TABLE IF NOT EXISTS `accounting_provider_costs` (
  `id` varchar(36) NOT NULL,
  `operation` varchar(10) NOT NULL COMMENT 'DEPOSIT | PAYOUT',
  `currency` varchar(10) NOT NULL DEFAULT '*',
  `percentage` double NOT NULL DEFAULT 0,
  `fixed_fee` double NOT NULL DEFAULT 0,
  `updated_by` varchar(36) NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_provider_cost` (`operation`, `currency`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5) Périodes clôturées
CREATE TABLE IF NOT EXISTS `accounting_periods` (
  `period` char(7) NOT NULL COMMENT 'AAAA-MM',
  `status` varchar(10) NOT NULL DEFAULT 'CLOSED',
  `closed_by` varchar(36) NULL,
  `closed_at` datetime NULL,
  PRIMARY KEY (`period`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6) Droit délégable aux ADMIN (le SUPER_ADMIN a toujours accès)
INSERT IGNORE INTO `resources` (`id`, `name`, `label`, `description`, `createdAt`, `updatedAt`)
VALUES (UUID(), 'ACCOUNTING', 'Comptabilité', 'Revenus, compte de résultat, balance, grand livre, journal, écritures manuelles', NOW(), NOW());
