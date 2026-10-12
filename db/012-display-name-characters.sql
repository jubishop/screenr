-- Reject control characters (\p{Cc}; PostgreSQL text cannot store NUL), the
-- Unicode line and paragraph separators, and bidirectional embedding,
-- override, and isolate controls. Zero-width joiners stay allowed for emoji
-- sequences. The server rejects the same set first with a clear message.
-- Production had no matching names when this was added; a violating row would
-- stop the migration before the new release activated.
ALTER TABLE profile ADD CONSTRAINT profile_display_name_characters
  CHECK (display_name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]');
