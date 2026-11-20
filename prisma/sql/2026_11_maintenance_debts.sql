-- =====================================================================
-- Dettes de frais de maintenance (gestion intelligente)
-- Script NON destructif (CREATE TABLE IF NOT EXISTS). À exécuter une fois.
-- Objectif : ne jamais rendre un solde négatif ; enregistrer les frais
-- impayés comme des dettes distinctes, recouvrées à la prochaine entrée de fonds.
-- =====================================================================

CREATE TABLE IF NOT EXISTS `maintenance_debts` (
  `id`               CHAR(36)       NOT NULL,
  `user_id`          CHAR(36)       NOT NULL,
  `wallet_id`        CHAR(36)       NOT NULL,          -- portefeuille à l'origine de la dette
  `currency`         VARCHAR(10)    NOT NULL,
  `amount_due`       DECIMAL(18,3)  NOT NULL DEFAULT 0, -- montant initialement dû
  `amount_recovered` DECIMAL(18,3)  NOT NULL DEFAULT 0, -- déjà recouvré
  `status`           ENUM('PENDING','PARTIAL','RECOVERED') NOT NULL DEFAULT 'PENDING',
  `reference`        VARCHAR(100)   NULL,
  `created_at`       DATETIME(0)    NOT NULL,
  `recovered_at`     DATETIME(0)    NULL,
  `updated_at`       DATETIME(0)    NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_maintenance_debts_user_status` (`user_id`, `status`),
  INDEX `idx_maintenance_debts_wallet` (`wallet_id`),
  INDEX `idx_maintenance_debts_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reste dû = amount_due - amount_recovered (calculé à la volée côté code).
