-- Add per-project idle timeout (in minutes). Default 5 matches the previous
-- hardcoded threshold in the desktop tracker.
ALTER TABLE "projects"
  ADD COLUMN "idle_timeout_minutes" INTEGER NOT NULL DEFAULT 5;
