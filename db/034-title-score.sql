-- TMDB's user score, stored with the title details it arrives with
-- (docs/title-catalog.md#tmdb-user-score-implementation): the average rating
-- TMDB members give the title out of 10, and how many rated it. NULL means
-- Screenr has no usable value. Titles stored before this migration pick up
-- theirs at their next details refresh. The previous release ignores these
-- columns.
ALTER TABLE title
  ADD COLUMN vote_average double precision,
  ADD COLUMN vote_count integer;
