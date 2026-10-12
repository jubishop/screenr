-- Better Auth 1.7.3 and later identify accounts by provider and account ID and
-- never read or write the account.issuer column that 1.7.0 through 1.7.2
-- required. Migration 014 kept the column and its unique index while rollback
-- to 1.7.2 remained possible. No retained release ships 1.7.2 any longer, so
-- drop the index and then the column, as Better Auth's 1.7 upgrade guide
-- directs. Databases first created by 1.7.3 or later have neither.
DROP INDEX IF EXISTS "account_issuer_accountId_uidx";
ALTER TABLE account DROP COLUMN IF EXISTS issuer;
