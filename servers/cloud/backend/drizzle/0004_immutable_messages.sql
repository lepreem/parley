-- Messages, the attachments they link and transcripts are written once: an edit
-- deletes the old rows and inserts new ones under new ids. Each API process
-- caches their text by id (src/chat/historyText.ts), so an UPDATE would leave
-- it serving the old text. These refuse one. Deletes, cascades included, are
-- untouched.
CREATE FUNCTION "refuse_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are immutable: delete and insert instead', TG_TABLE_NAME
		USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "chat_messages_immutable" BEFORE UPDATE ON "chat_messages"
	FOR EACH ROW EXECUTE FUNCTION "refuse_update"();--> statement-breakpoint
CREATE TRIGGER "chat_message_attachments_immutable" BEFORE UPDATE ON "chat_message_attachments"
	FOR EACH ROW EXECUTE FUNCTION "refuse_update"();--> statement-breakpoint
CREATE TRIGGER "transcript_contents_immutable" BEFORE UPDATE ON "transcript_contents"
	FOR EACH ROW EXECUTE FUNCTION "refuse_update"();
