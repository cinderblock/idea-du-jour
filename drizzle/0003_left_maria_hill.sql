CREATE TABLE `glossary_versions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor` text NOT NULL,
	`token_id` text,
	`terms` text NOT NULL,
	`note` text
);
