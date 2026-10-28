import { attachments } from "./attachments.data";
import { conversations } from "./conversations.data";
import { images } from "./images.data";
import { jobs } from "./jobs.data";
import { messages } from "./messages.data";
import { transcripts } from "./transcripts.data";

/** Every database operation, grouped by table: `data.<table>.<operation>()`. */
export const data = {
  attachments,
  conversations,
  images,
  jobs,
  messages,
  transcripts,
};

export type * from "./attachments.data";
export type * from "./conversations.data";
export type * from "./images.data";
export type * from "./jobs.data";
export type * from "./messages.data";
export type * from "./transcripts.data";
