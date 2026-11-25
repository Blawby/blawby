ALTER TABLE `listing_message_members` ADD `cleaning_order` integer;--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD `turnover_checklist` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD `offer_cleans_to_all` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `accepted_member_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `accepted_at` text;