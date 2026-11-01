-- A person's friends (docs/data-and-access.md#shared-feeds-and-access-checks):
-- each accepted friendship where neither person has blocked the other, which
-- also keeps the demo circle and real members apart. Every query that lists
-- someone's friends reads them here, so a new rule about friendship itself
-- needs one edit. Callers add their own checks between the viewer and each
-- friend.
--
-- It stays a single STABLE, non-STRICT SQL SELECT so that PostgreSQL inlines
-- it into each calling query, which then plans as if the SELECT were written
-- there. screenr_blocked is not inlined either way. The previous release
-- ignores this function.
CREATE OR REPLACE FUNCTION screenr_friends(person text) RETURNS TABLE (user_id text)
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN low_id = person THEN high_id ELSE low_id END
  FROM friendship
  WHERE person IN (low_id, high_id) AND accepted_at IS NOT NULL
    AND NOT screenr_blocked(low_id, high_id)
$$;
