-- Keep original hashes so previously shared links and pending signups still work.
ALTER TABLE invitation ADD COLUMN share_token_hash text UNIQUE;
