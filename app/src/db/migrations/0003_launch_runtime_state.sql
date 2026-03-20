ALTER TABLE `agenter_records` ADD COLUMN `launch_state` text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE `agenter_records` ADD COLUMN `launch_error` text;--> statement-breakpoint
ALTER TABLE `agenter_records` ADD COLUMN `launch_updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE `agenter_records` ADD COLUMN `launch_session` text;--> statement-breakpoint
ALTER TABLE `agenter_records` ADD COLUMN `runtime_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `agenter_records` ADD COLUMN `runtime_error` text;--> statement-breakpoint
ALTER TABLE `agenter_records` ADD COLUMN `runtime_updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE `agenter_records` ADD COLUMN `chain_state` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `agenter_records` ADD COLUMN `chain_state_updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;
