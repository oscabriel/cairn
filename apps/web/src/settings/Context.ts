// What the root tells the settings page, built from what the root already holds: the epoch and its
// client, whether the route is the settings page, and the projects the Skills section can show.

import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { Equal, Option } from "effect";

import type { SettingsContext } from "./Model.ts";

/** The root's state the settings page reads. */
export interface SettingsInputs {
  readonly epoch: number;
  readonly hasClient: boolean;
  readonly isOpen: boolean;
  readonly shell: Option.Option<ShellSnapshot>;
}

/** The page's context from the root's state. */
export const settingsContextOf = (inputs: SettingsInputs): SettingsContext => ({
  epoch: inputs.epoch,
  hasClient: inputs.hasClient,
  isOpen: inputs.isOpen,
  projects: Option.match(inputs.shell, {
    onNone: () => [],
    onSome: (shell) =>
      shell.projects.map((project) => ({
        id: project.id,
        title: project.title,
      })),
  }),
});

/** True when two contexts say the same thing, so the root can skip informing the page. */
export const sameSettingsContext = (
  left: SettingsContext,
  right: SettingsContext
): boolean =>
  left.epoch === right.epoch &&
  left.hasClient === right.hasClient &&
  left.isOpen === right.isOpen &&
  Equal.equals(left.projects, right.projects);
