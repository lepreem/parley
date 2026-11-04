import { useNavigate } from "react-router-dom";
import { openDesktopApp } from "../../lib/openDesktopApp";

/**
 * Chats on this computer happen in the desktop app: this opens it, or leads to
 * the download page if it isn't installed.
 */
export function UseThisComputer({ className }: { className: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => openDesktopApp(() => void navigate("/download"))}
      className={className}
    >
      Use this computer
    </button>
  );
}
