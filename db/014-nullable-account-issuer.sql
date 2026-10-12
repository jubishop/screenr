-- Better Auth 1.7.0 through 1.7.2 created account.issuer as NOT NULL with the
-- unique index account_issuer_accountId_uidx. Better Auth 1.7.3 and later no
-- longer write issuer and reject every request while it is required. 1.7.2
-- writes issuer on every insert, so a nullable column suits either release.
-- Keep the column and index while rollback to 1.7.2 remains possible: 1.7.2
-- finds accounts by issuer, and PostgreSQL treats null issuers as distinct.
-- Databases first created by 1.7.3 or later have no issuer column.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'account'
        AND column_name = 'issuer') THEN
    ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL;
  END IF;
END $$;
