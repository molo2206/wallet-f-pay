-- =====================================================================================
-- ✅ À exécuter sur la base F-PAY (pas favor_db) : la clé FAVOR HELP (FPAY_API_KEY_HELP) reçoit la permission « cashout »
--    nécessaire aux routes api/external/cashout/* (retrait protégé par OTP).
--    Aucune clé n'est régénérée (ne PAS passer par PATCH admin/api-keys, qui changerait la clé).
-- =====================================================================================
UPDATE api_key
   SET permissions = JSON_ARRAY_APPEND(permissions, '$', 'cashout'),
       updatedAt   = NOW()
 WHERE `key` LIKE '%eWBMw-MRIVbbcVy-8M5YYahxCLyDVKMcdwZqcB-0w1I'
   AND JSON_VALID(permissions)
   AND JSON_SEARCH(permissions, 'one', 'cashout') IS NULL;

-- Vérification : 1 ligne, « cashout » présent dans permissions
SELECT id, name, isActive, permissions
  FROM api_key
 WHERE `key` LIKE '%eWBMw-MRIVbbcVy-8M5YYahxCLyDVKMcdwZqcB-0w1I';
