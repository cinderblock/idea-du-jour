CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`id_hash` text NOT NULL,
	`name` text NOT NULL,
	`model` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`first_seen_ts` integer NOT NULL,
	`last_seen_ts` integer NOT NULL,
	`decided_ts` integer,
	`first_ip` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_id_hash_unique` ON `devices` (`id_hash`);--> statement-breakpoint
CREATE TABLE `pending_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`ts` integer NOT NULL,
	`text` text,
	`audio` text
);
