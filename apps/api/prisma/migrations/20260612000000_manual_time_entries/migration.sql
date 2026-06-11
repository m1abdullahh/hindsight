-- Manual time entries: an admin can add hours on a member's behalf. Such an
-- entry has no originating device, so device_id becomes nullable. Existing
-- device-tracked rows keep their device_id; only new manual rows are null.
ALTER TABLE "time_entries" ALTER COLUMN "device_id" DROP NOT NULL;
