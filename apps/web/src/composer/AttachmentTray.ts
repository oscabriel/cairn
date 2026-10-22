// The composer's attachment tray. This file is a placeholder that renders nothing; the attachment
// work package (3B) owns it and replaces it with the chips, thumbnails and upload progress. The
// card calls it between the editor and the footer, where t3code draws its attachment row.
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

/** The attachments of the active draft. Empty until attachments land. */
export const attachmentTrayView = (
  _model: Model,
  h: HtmlBuilder<Message>
): Html => h.empty;
