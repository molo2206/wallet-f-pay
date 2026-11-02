-- =====================================================================================
-- ✅ Base F-PAY (pas favor_db) : la clé « FAVOR-HELP: Plateforme principale Favor Help »
--    (celle de FPAY_API_KEY_HELP dans le .env de Favor Help) reçoit la permission « cashout »
--    nécessaire aux routes api/external/cashout/* (retrait protégé par OTP). La clé n'est pas régénérée.
-- =====================================================================================
UPDATE api_key
   SET permissions = JSON_ARRAY_APPEND(permissions, '$', 'cashout'),
       updatedAt   = NOW()
 WHERE id = '5d2bff0a-ad72-43e8-aa1c-ca3c10c7f080'
   AND JSON_VALID(permissions)
   AND JSON_SEARCH(permissions, 'one', 'cashout') IS NULL;

-- Vérification : 1 ligne, permissions = ["pay","send","send_parrainage","refund","cashout"]
SELECT id, name, isActive, permissions
  FROM api_key
 WHERE id = '5d2bff0a-ad72-43e8-aa1c-ca3c10c7f080';
