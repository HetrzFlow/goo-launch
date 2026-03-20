CREATE TABLE `agent_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agenter_id` text NOT NULL,
	`event_type` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_events_agenter_id_created_at_idx` ON `agent_events` (`agenter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_events_severity_created_at_idx` ON `agent_events` (`severity`,`created_at`);--> statement-breakpoint
CREATE TABLE `agenter_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`agenter_id` text NOT NULL,
	`contract_address` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`last_triggered_at` text,
	`trigger_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`agent_name` text,
	`agent_intro` text,
	`agent_framework` text,
	`genesis_prompt` text,
	`agent_instructions` text,
	`skills_content` text,
	`memory_content` text,
	`buyback_policy` text,
	`token_symbol` text,
	`nominated_pct` integer,
	`token_address` text,
	`agent_wallet` text,
	`genome_hash` text,
	`owner_address` text,
	`launch_mode` text DEFAULT 'cloud' NOT NULL,
	`sandbox_provider` text,
	`llm_provider` text,
	`provider_bundle` text,
	`encrypted_private_key` text,
	`sandbox_id` text,
	`sandbox_url` text,
	`gateway_url` text,
	`gateway_token` text,
	`goo_core_status` text,
	`framework` text,
	`last_pulse_at` text,
	`llm_calls_count` integer DEFAULT 0 NOT NULL,
	`agos_agent_id` text,
	`agos_api_key` text,
	`agos_access_token` text,
	`agos_deployment_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agenter_records_agenter_id_unique` ON `agenter_records` (`agenter_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agenter_records_agos_agent_id_unique` ON `agenter_records` (`agos_agent_id`);--> statement-breakpoint
CREATE INDEX `agenter_records_user_id_idx` ON `agenter_records` (`user_id`);--> statement-breakpoint
CREATE INDEX `agenter_records_contract_address_idx` ON `agenter_records` (`contract_address`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agenter_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`via` text,
	`tier` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_messages_agenter_id_created_at_idx` ON `chat_messages` (`agenter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_user_id_idx` ON `chat_messages` (`user_id`);--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`deployer_address` text NOT NULL,
	`tx_hash` text NOT NULL,
	`network` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contracts_address_unique` ON `contracts` (`address`);--> statement-breakpoint
CREATE INDEX `contracts_user_id_idx` ON `contracts` (`user_id`);--> statement-breakpoint
CREATE TABLE `transaction_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agenter_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`tx_hash` text NOT NULL,
	`method` text NOT NULL,
	`memo` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transaction_logs_agenter_id_idx` ON `transaction_logs` (`agenter_id`);--> statement-breakpoint
CREATE INDEX `transaction_logs_user_id_idx` ON `transaction_logs` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_address` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_wallet_address_unique` ON `users` (`wallet_address`);