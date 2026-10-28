import { useState, type FormEvent } from "react";
import { MAX_TITLE_LENGTH } from "@parley/contract/limits";
import { Link } from "react-router-dom";
import type { Conversation } from "../../api/conversations";
import { useServer } from "../../hooks/server/useServer";
import { Icon } from "../ui/Icon";
import { useDismissable } from "../ui/useDismissable";
import { sectionPath } from "./sections";

type ConversationRowProps = {
  conversation: Conversation;
  active: boolean;
  /** Lets the mobile drawer close itself once a chat has been chosen. */
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
};

export function ConversationRow({
  conversation,
  active,
  onOpen,
  onRename,
  onDelete,
}: ConversationRowProps) {
  const server = useServer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation.title);
  const menuRef = useDismissable<HTMLDivElement>(menuOpen, () =>
    setMenuOpen(false),
  );

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    const title = draftTitle.trim();
    if (title && title !== conversation.title) onRename(title);
    setRenaming(false);
  };

  if (renaming) {
    return (
      <form onSubmit={submitRename} className="px-1 py-0.5">
        <input
          autoFocus
          value={draftTitle}
          maxLength={MAX_TITLE_LENGTH}
          onChange={(event) => setDraftTitle(event.target.value)}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraftTitle(conversation.title);
              setRenaming(false);
            }
          }}
          aria-label="Chat name"
          className="w-full rounded-lg border border-signal bg-surface px-2.5 py-2 text-sm outline-none"
        />
      </form>
    );
  }

  return (
    <div className="group/row relative">
      <Link
        to={sectionPath(server, conversation.id)}
        onClick={onOpen}
        title={conversation.title}
        className={`block truncate rounded-lg py-2 pl-3 pr-9 text-sm transition-colors ${
          active
            ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--line)]"
            : "text-muted hover:bg-surface/70 hover:text-ink"
        }`}
      >
        {conversation.title}
      </Link>

      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label={`Actions for ${conversation.title}`}
        aria-expanded={menuOpen}
        className={`absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint transition-opacity hover:bg-sunk hover:text-ink focus-visible:opacity-100 ${
          menuOpen
            ? "opacity-100"
            : "opacity-0 pointer-coarse:opacity-100 group-hover/row:opacity-100"
        }`}
      >
        <Icon name="more" className="h-4 w-4" />
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-1 top-9 z-30 w-40 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg"
        >
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setDraftTitle(conversation.title);
              setRenaming(true);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-sunk"
          >
            <Icon name="pencil" className="h-4 w-4" />
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-live transition-colors hover:bg-live-tint"
          >
            <Icon name="trash" className="h-4 w-4" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
