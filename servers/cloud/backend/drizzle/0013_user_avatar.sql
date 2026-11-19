CREATE TYPE "public"."avatar_color" AS ENUM('sage', 'pine', 'clay', 'coral', 'honey', 'blush', 'plum', 'lilac', 'sky', 'slate', 'mist', 'moss');--> statement-breakpoint
CREATE TYPE "public"."avatar_glyph" AS ENUM('sun', 'moon', 'clover', 'bolt', 'peaks', 'dots', 'arch', 'wave', 'spark', 'leaf', 'target', 'plus');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_glyph" "avatar_glyph";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_color" "avatar_color";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_whole" CHECK (("users"."avatar_glyph" is null) = ("users"."avatar_color" is null));