-- =====================================================================
-- F-PAY : précision des montants (3 décimales)
-- Les colonnes ci-dessous étaient en FLOAT (simple précision : ~7 chiffres significatifs,
-- 12345.67 devient 12345.669921875 et 1 250 000.789 perd ses décimales).
-- Passage en DOUBLE (15-16 chiffres significatifs, comme wallet.balance et transaction.amount) :
--  * élargissement SANS perte (chaque valeur FLOAT existe exactement en DOUBLE) ;
--  * le type Prisma reste « Float » : aucun changement de code ni d'API ;
--  * pas de passage en DECIMAL : Prisma renverrait des objets Decimal → modification
--    de tout le code de calcul (risque de régression en production).
-- À exécuter UNE fois, hors heures de pointe (ALTER = copie de table ; tables petites ici).
-- Sauvegarde préalable recommandée. Ne PAS utiliser prisma migrate dev / db push.
-- =====================================================================

-- ÉTAPE 1 : élargissement FLOAT → DOUBLE
ALTER TABLE `user` MODIFY COLUMN `maintenance_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `account` MODIFY COLUMN `balance` DOUBLE NOT NULL DEFAULT 0;
ALTER TABLE `user_transaction_limit` MODIFY COLUMN `daily_limit` DOUBLE NULL DEFAULT 500;
ALTER TABLE `user_transaction_limit` MODIFY COLUMN `monthly_limit` DOUBLE NULL DEFAULT 5000;
ALTER TABLE `user_transaction_limit` MODIFY COLUMN `yearly_limit` DOUBLE NULL DEFAULT 50000;
ALTER TABLE `user_transaction_limit` MODIFY COLUMN `per_transaction_limit` DOUBLE NULL DEFAULT 200;
ALTER TABLE `app_settings` MODIFY COLUMN `transfer_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `app_settings` MODIFY COLUMN `withdraw_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `transfer_percentage` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `international_transfer_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `international_deposit_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `international_withdrawal_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `maintenance_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `deposit_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `withdrawal_fee` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `merchant_maintenance_multiplier` DOUBLE NULL DEFAULT 2;
ALTER TABLE `country_provider` MODIFY COLUMN `cash_percentage` DOUBLE NULL DEFAULT 0;
ALTER TABLE `country_provider` MODIFY COLUMN `momo_percentage` DOUBLE NULL DEFAULT 0;
ALTER TABLE `network_provider` MODIFY COLUMN `pourcentage_deposit` DOUBLE NULL DEFAULT 0;
ALTER TABLE `network_provider` MODIFY COLUMN `pourcentage_payout` DOUBLE NULL DEFAULT 0;
ALTER TABLE `network_provider` MODIFY COLUMN `pourcentage_deposit_intern` DOUBLE NULL DEFAULT 0;
ALTER TABLE `network_provider` MODIFY COLUMN `pourcentage_payout_intern` DOUBLE NOT NULL DEFAULT 0;
ALTER TABLE `exchange_rate` MODIFY COLUMN `rate` DOUBLE NOT NULL;

-- ÉTAPE 2 (FACULTATIVE, recommandée) : supprimer le bruit hérité du FLOAT
-- (ex. 12345.669921875 → 12345.670). Montants et frais à 3 décimales,
-- pourcentages à 4 décimales.
-- Exécutez d'abord la requête de contrôle, puis les UPDATE.
SELECT `id`, `balance`, ROUND(`balance`, 3) AS `balance_arrondi` FROM `account` WHERE `balance` <> ROUND(`balance`, 3) LIMIT 50;
UPDATE `user` SET `maintenance_fee` = ROUND(`maintenance_fee`, 3) WHERE `maintenance_fee` IS NOT NULL;
UPDATE `account` SET `balance` = ROUND(`balance`, 3) WHERE `balance` IS NOT NULL;
UPDATE `user_transaction_limit` SET `daily_limit` = ROUND(`daily_limit`, 3) WHERE `daily_limit` IS NOT NULL;
UPDATE `user_transaction_limit` SET `monthly_limit` = ROUND(`monthly_limit`, 3) WHERE `monthly_limit` IS NOT NULL;
UPDATE `user_transaction_limit` SET `yearly_limit` = ROUND(`yearly_limit`, 3) WHERE `yearly_limit` IS NOT NULL;
UPDATE `user_transaction_limit` SET `per_transaction_limit` = ROUND(`per_transaction_limit`, 3) WHERE `per_transaction_limit` IS NOT NULL;
UPDATE `app_settings` SET `transfer_fee` = ROUND(`transfer_fee`, 3) WHERE `transfer_fee` IS NOT NULL;
UPDATE `app_settings` SET `withdraw_fee` = ROUND(`withdraw_fee`, 3) WHERE `withdraw_fee` IS NOT NULL;
UPDATE `country_provider` SET `transfer_percentage` = ROUND(`transfer_percentage`, 4) WHERE `transfer_percentage` IS NOT NULL;
UPDATE `country_provider` SET `international_transfer_fee` = ROUND(`international_transfer_fee`, 3) WHERE `international_transfer_fee` IS NOT NULL;
UPDATE `country_provider` SET `international_deposit_fee` = ROUND(`international_deposit_fee`, 3) WHERE `international_deposit_fee` IS NOT NULL;
UPDATE `country_provider` SET `international_withdrawal_fee` = ROUND(`international_withdrawal_fee`, 3) WHERE `international_withdrawal_fee` IS NOT NULL;
UPDATE `country_provider` SET `maintenance_fee` = ROUND(`maintenance_fee`, 3) WHERE `maintenance_fee` IS NOT NULL;
UPDATE `country_provider` SET `deposit_fee` = ROUND(`deposit_fee`, 3) WHERE `deposit_fee` IS NOT NULL;
UPDATE `country_provider` SET `withdrawal_fee` = ROUND(`withdrawal_fee`, 3) WHERE `withdrawal_fee` IS NOT NULL;
UPDATE `country_provider` SET `merchant_maintenance_multiplier` = ROUND(`merchant_maintenance_multiplier`, 4) WHERE `merchant_maintenance_multiplier` IS NOT NULL;
UPDATE `country_provider` SET `cash_percentage` = ROUND(`cash_percentage`, 4) WHERE `cash_percentage` IS NOT NULL;
UPDATE `country_provider` SET `momo_percentage` = ROUND(`momo_percentage`, 4) WHERE `momo_percentage` IS NOT NULL;
UPDATE `network_provider` SET `pourcentage_deposit` = ROUND(`pourcentage_deposit`, 4) WHERE `pourcentage_deposit` IS NOT NULL;
UPDATE `network_provider` SET `pourcentage_payout` = ROUND(`pourcentage_payout`, 4) WHERE `pourcentage_payout` IS NOT NULL;
UPDATE `network_provider` SET `pourcentage_deposit_intern` = ROUND(`pourcentage_deposit_intern`, 4) WHERE `pourcentage_deposit_intern` IS NOT NULL;
UPDATE `network_provider` SET `pourcentage_payout_intern` = ROUND(`pourcentage_payout_intern`, 4) WHERE `pourcentage_payout_intern` IS NOT NULL;
-- Taux de change : pas d'arrondi (les petits taux comme 0.000357 doivent garder leurs chiffres significatifs).

-- ÉTAPE 3 (FACULTATIVE) : soldes des wallets et montants déjà en DOUBLE
-- Contrôle (lecture seule) : écarts de bruit flottant.
SELECT `id`, `balance`, ROUND(`balance`, 3) AS `balance_arrondi` FROM `wallet` WHERE ABS(`balance` - ROUND(`balance`, 3)) > 0 LIMIT 50;
-- Correction (n'écrit que les lignes concernées) :
UPDATE `wallet` SET `balance` = ROUND(`balance`, 3) WHERE ABS(`balance` - ROUND(`balance`, 3)) > 0;
UPDATE `transaction` SET `amount` = ROUND(`amount`, 3) WHERE ABS(`amount` - ROUND(`amount`, 3)) > 0;

-- ÉTAPE 4 : contrôle de cohérence soldes / transactions (lecture seule, à garder pour la supervision)
-- Écart entre le solde d'un wallet et la somme de ses transactions réussies (CREDIT - DEBIT).
-- Un écart n'est pas forcément une erreur (soldes initiaux importés, opérations hors transaction) :
-- à analyser au cas par cas.
SELECT w.`id`, w.`userId`, w.`currency`, ROUND(w.`balance`, 3) AS `solde`,
       ROUND(COALESCE(SUM(CASE WHEN t.`movement` = 'CREDIT' THEN t.`amount` WHEN t.`movement` = 'DEBIT' THEN -t.`amount` ELSE 0 END), 0), 3) AS `somme_transactions`,
       ROUND(w.`balance` - COALESCE(SUM(CASE WHEN t.`movement` = 'CREDIT' THEN t.`amount` WHEN t.`movement` = 'DEBIT' THEN -t.`amount` ELSE 0 END), 0), 3) AS `ecart`
FROM `wallet` w
LEFT JOIN `transaction` t ON t.`walletId` = w.`id` AND t.`status` = 'SUCCESS'
GROUP BY w.`id`, w.`userId`, w.`currency`, w.`balance`
HAVING ABS(`ecart`) >= 0.001
ORDER BY ABS(`ecart`) DESC
LIMIT 200;
