-- Reserved migration number: 0010 was already applied in production.
-- Preserve the existing production migration identity and fill the sequence gap.
SELECT 1;
