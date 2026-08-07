-- Run this in the Supabase SQL Editor. Adds the Personal Training booking
-- feature: a coach's public profile (individual + small-group hourly
-- rates), the availability slots they open up, and bookings against those
-- slots. See routes/personalTraining.js for how these are used.

-- 1. A coach's Personal Training profile - one per coach User, created the
-- first time they turn PT on for themselves.
CREATE TABLE "PersonalTrainingProfile" (
  "id"             TEXT PRIMARY KEY,
  "userId"         TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE CASCADE,
  "displayName"    TEXT NOT NULL,
  "photoUrl"       TEXT,
  "bio"            TEXT,
  "phone"          TEXT,
  "individualRate" DECIMAL(6,2) NOT NULL,
  "groupRate"      DECIMAL(6,2),
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- 2. Bookable windows on a coach's calendar. sessionType/capacity unify
-- individual (capacity 1) and small-group (coach-set capacity) slots.
-- bookedCount is only ever moved by the atomic UPDATE in POST
-- /api/personal-training/bookings, so two people can never both land the
-- last open seat.
CREATE TABLE "PTAvailabilitySlot" (
  "id"          TEXT PRIMARY KEY,
  "profileId"   TEXT NOT NULL REFERENCES "PersonalTrainingProfile"("id") ON DELETE CASCADE,
  "startTime"   TIMESTAMP(3) NOT NULL,
  "endTime"     TIMESTAMP(3) NOT NULL,
  "sessionType" TEXT NOT NULL DEFAULT 'individual',
  "capacity"    INTEGER NOT NULL DEFAULT 1,
  "bookedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "PTAvailabilitySlot_profileId_startTime_idx" ON "PTAvailabilitySlot"("profileId", "startTime");

-- 3. One family's booking of a seat in a slot. Multiple bookings can point
-- at the same group slot (up to its capacity); an individual slot only
-- ever has one. requesterUserId is set for a logged-in TeamSync app
-- booker, left null for a public website visitor.
CREATE TABLE "PTBooking" (
  "id"              TEXT PRIMARY KEY,
  "slotId"          TEXT NOT NULL REFERENCES "PTAvailabilitySlot"("id") ON DELETE CASCADE,
  "profileId"       TEXT NOT NULL REFERENCES "PersonalTrainingProfile"("id") ON DELETE CASCADE,
  "requesterName"   TEXT NOT NULL,
  "requesterEmail"  TEXT NOT NULL,
  "requesterPhone"  TEXT,
  "playerName"      TEXT,
  "requesterUserId" TEXT,
  "notes"           TEXT,
  "status"          TEXT NOT NULL DEFAULT 'confirmed',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "PTBooking_profileId_idx" ON "PTBooking"("profileId");
CREATE INDEX "PTBooking_slotId_idx" ON "PTBooking"("slotId");
