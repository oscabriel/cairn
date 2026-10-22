// The order of the turn-content stages (a seam: the integrator adds each package's stage here).
// Skill expansion runs before attachments, so an expanded skill block precedes the files it may
// mention. Planned order: text, skill expansion, attachments.
import { attachmentStage } from "../attachments/AttachmentStage.ts";
import { skillExpansionStage } from "../skills/SkillExpansionStage.ts";
import { TurnContent, textStage } from "./TurnContent.ts";

/** Every turn-content stage, in the order they run. */
export const turnContentStages = [
  textStage,
  skillExpansionStage,
  attachmentStage,
];

/** `TurnContent` running the stages above. */
export const TurnContentLive = TurnContent.layerFrom(turnContentStages);
