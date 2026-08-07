-- Run this in the Supabase SQL Editor to add the new Membership.viewPlayerId
-- column (guardian/parent multi-child login support - see the comment on
-- viewPlayerId in schema.prisma). This project's schema is applied by hand
-- rather than via `prisma migrate` / `db push`, so nothing here can diff
-- against the other apps' tables sharing this Supabase project (see the
-- note at the top of schema.prisma).

ALTER TABLE "Membership" ADD COLUMN "viewPlayerId" TEXT;
