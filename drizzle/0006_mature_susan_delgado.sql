CREATE TABLE `device_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`ts` integer NOT NULL,
	`field` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`ip` text
);
