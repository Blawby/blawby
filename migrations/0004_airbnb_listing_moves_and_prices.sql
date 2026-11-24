ALTER TABLE `airbnb_sync_jobs` ADD `own_home` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `channel_listing_id` text;--> statement-breakpoint
ALTER TABLE `product_airbnb_listings` ADD `price_adjustment_type` text;--> statement-breakpoint
ALTER TABLE `product_airbnb_listings` ADD `price_adjustment` integer;--> statement-breakpoint
ALTER TABLE `product_nights` ADD `closed_for_reservation` integer DEFAULT 0 NOT NULL;