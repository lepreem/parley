ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "user_id";