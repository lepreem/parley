-- refuse_update still refuses every update, unless the trigger names columns
-- it tolerates: an update that changes only those goes through, and one that
-- changes any other column is refused as before. The list is what may change,
-- never what may not, so a column added later is guarded without anyone
-- remembering to.
--
-- chat_messages tolerates user_id, so a guest's messages can move to the
-- account they sign in to (users.adoptGuest). The history text cache keeps
-- messages' text by id, and an owner change leaves both as they were.
CREATE OR REPLACE FUNCTION "refuse_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_NARGS > 0 AND (to_jsonb(NEW) - TG_ARGV) = (to_jsonb(OLD) - TG_ARGV) THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION '% rows are immutable: delete and insert instead', TG_TABLE_NAME
		USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
DROP TRIGGER "chat_messages_immutable" ON "chat_messages";--> statement-breakpoint
CREATE TRIGGER "chat_messages_immutable" BEFORE UPDATE ON "chat_messages"
	FOR EACH ROW EXECUTE FUNCTION "refuse_update"('user_id');
