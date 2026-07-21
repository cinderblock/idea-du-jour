CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`created_ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`item_id` text NOT NULL,
	`actor` text NOT NULL,
	`token_id` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`created_ts` integer NOT NULL,
	`updated_ts` integer NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`first_capture` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`scope` text NOT NULL,
	`label` text NOT NULL,
	`created_ts` integer NOT NULL,
	`last_used_ts` integer,
	`revoked_ts` integer
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_ts` integer NOT NULL
);
