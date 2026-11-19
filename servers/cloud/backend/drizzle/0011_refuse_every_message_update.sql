-- chat_messages lost user_id (0010): a message's owner is its conversation's,
-- so a guest signing in moves only conversations. Its trigger tolerated
-- user_id for that move, and now tolerates nothing, like the others.
DROP TRIGGER "chat_messages_immutable" ON "chat_messages";--> statement-breakpoint
CREATE TRIGGER "chat_messages_immutable" BEFORE UPDATE ON "chat_messages"
	FOR EACH ROW EXECUTE FUNCTION "refuse_update"();
