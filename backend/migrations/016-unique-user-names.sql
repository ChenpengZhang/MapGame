-- Nicknames become globally unique among accounts with a verified email (case-insensitive, ignoring
-- surrounding spaces), so leaderboards and map authors cannot be confused or impersonated. Unverified
-- accounts (e.g. a mistyped email) never block a nickname; whoever verifies first keeps it.
-- Existing duplicates among verified accounts keep the earliest account's name; later ones get a
-- "#2", "#3"… suffix (and can rename themselves afterwards).
DO $$
DECLARE
  r record;
  candidate text;
  n integer;
BEGIN
  FOR r IN
    SELECT id, btrim(name) AS name FROM (
      SELECT id, name, row_number() OVER (PARTITION BY lower(btrim(name)) ORDER BY "createdAt", id) AS rn
      FROM "user" WHERE "emailVerified"
    ) ranked
    WHERE rn > 1
    ORDER BY lower(btrim(name)), rn
  LOOP
    n := 2;
    LOOP
      candidate := r.name || '#' || n;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "user" WHERE "emailVerified" AND lower(btrim(name)) = lower(candidate));
      n := n + 1;
    END LOOP;
    UPDATE "user" SET name = candidate, "updatedAt" = CURRENT_TIMESTAMP WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX user_name_unique ON "user" (lower(btrim(name))) WHERE "emailVerified";
