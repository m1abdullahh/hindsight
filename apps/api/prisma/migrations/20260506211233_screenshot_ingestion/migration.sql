-- CreateEnum
CREATE TYPE "ScreenshotStatus" AS ENUM ('pending', 'uploaded', 'processed', 'failed');

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "total_active_seconds" INTEGER NOT NULL DEFAULT 0,
    "total_idle_seconds" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screenshots" (
    "id" TEXT NOT NULL,
    "time_entry_id" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "s3_key" TEXT NOT NULL,
    "thumbnail_s3_key" TEXT,
    "blurred_s3_key" TEXT,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "monitor_index" INTEGER NOT NULL DEFAULT 0,
    "active_window_title" TEXT,
    "active_app" TEXT,
    "keyboard_events_count" INTEGER NOT NULL DEFAULT 0,
    "mouse_events_count" INTEGER NOT NULL DEFAULT 0,
    "size_bytes" INTEGER,
    "blurred" BOOLEAN NOT NULL DEFAULT false,
    "status" "ScreenshotStatus" NOT NULL DEFAULT 'pending',
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screenshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_entries_user_id_started_at_idx" ON "time_entries"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "time_entries_project_id_started_at_idx" ON "time_entries"("project_id", "started_at");

-- CreateIndex
CREATE INDEX "time_entries_user_id_ended_at_idx" ON "time_entries"("user_id", "ended_at");

-- CreateIndex
CREATE INDEX "screenshots_time_entry_id_captured_at_idx" ON "screenshots"("time_entry_id", "captured_at");

-- CreateIndex
CREATE INDEX "screenshots_status_created_at_idx" ON "screenshots"("status", "created_at");

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_time_entry_id_fkey" FOREIGN KEY ("time_entry_id") REFERENCES "time_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
