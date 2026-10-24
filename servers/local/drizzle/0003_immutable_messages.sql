-- Messages, the attachments they link and transcripts are written once: an edit
-- deletes the old rows and inserts new ones under new ids. These refuse an
-- UPDATE. Deletes, cascades included, are untouched.
CREATE TRIGGER `chat_messages_immutable` BEFORE UPDATE ON `chat_messages`
BEGIN
	SELECT RAISE(ABORT, 'chat_messages rows are immutable: delete and insert instead');
END;--> statement-breakpoint
CREATE TRIGGER `chat_message_attachments_immutable` BEFORE UPDATE ON `chat_message_attachments`
BEGIN
	SELECT RAISE(ABORT, 'chat_message_attachments rows are immutable: delete and insert instead');
END;--> statement-breakpoint
CREATE TRIGGER `transcript_contents_immutable` BEFORE UPDATE ON `transcript_contents`
BEGIN
	SELECT RAISE(ABORT, 'transcript_contents rows are immutable: delete and insert instead');
END;
