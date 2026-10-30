// The hold banner in the new look, over the classic banner's Model and Messages (`shell/Parked.ts`):
// what holds the open thread up beyond the user, from the one thread-state function's `threadHold`
// and `HOLD_LABELS`. A parked task offers Retry; a spent plan window says when it resets; a turn
// waiting for a Claude slot says so. Drawn with L3's banner, so its tone is a mark, a rule and
// words, never colour alone. It keeps the `thread-hold` test id and the `data-hold` kind.

import {
  HOLD_LABELS,
  ThreadHold,
  threadHold,
} from "@cairn/client-logic/ThreadState";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { formatDayTime } from "../../settings/Time.ts";
import { retryMessage } from "../../shell/Parked.ts";
import type { Message, Model } from "../../shell/Parked.ts";
import { banner } from "../ui/Banner.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import type { Tone } from "../ui/Tone.ts";
import { toneOfThreadTone } from "../ui/Tone.ts";

type H = HtmlBuilder<Message>;

const toneOf = (tag: ThreadHold["_tag"]): Tone =>
  toneOfThreadTone(HOLD_LABELS[tag].tone);

const wrap = (h: H, kind: string, body: Html): Html =>
  h.div(
    [
      h.DataAttribute("testid", "thread-hold"),
      h.DataAttribute("hold", kind),
      h.Class(
        "mx-auto w-full max-w-(--lane-width) px-(--space-3) pt-(--space-2)"
      ),
    ],
    [body]
  );

const content = (model: Model, h: H): Html =>
  Option.match(
    Option.flatMap(model.thread, (thread) =>
      Option.map(threadHold(thread), (hold) => ({ thread, hold }))
    ),
    {
      onNone: () => h.empty,
      onSome: ({ hold, thread }) =>
        ThreadHold.$match(hold, {
          Parked: ({ taskId }) =>
            wrap(
              h,
              "parked",
              banner(h, {
                tone: toneOf("Parked"),
                mark: Option.some("warning"),
                title: HOLD_LABELS.Parked.word,
                detail: Option.some(
                  Option.getOrElse(
                    model.failure,
                    () =>
                      "Work on this thread stopped after it was cut off several times in a row."
                  )
                ),
                actions: [
                  button(
                    h,
                    {
                      ...buttonDefaults<Message>(),
                      size: "small",
                      onClick: Option.some(retryMessage(thread.id, taskId)),
                      isDisabled: !model.hasClient,
                      isBusy: Option.isSome(model.retrying),
                    },
                    [Option.isSome(model.retrying) ? "Retrying" : "Retry"]
                  ),
                ],
              })
            ),
          Limited: ({ resetsAt }) =>
            wrap(
              h,
              "limited",
              banner(h, {
                tone: toneOf("Limited"),
                mark: Option.some("warning"),
                title: HOLD_LABELS.Limited.word,
                detail: Option.some(
                  Option.match(resetsAt, {
                    onNone: () =>
                      "The model plan's usage limit was reached. Send again once it resets.",
                    onSome: (at) =>
                      `The model plan's usage limit was reached. It resets ${formatDayTime(at)}.`,
                  })
                ),
                actions: [],
              })
            ),
          WaitingForSlot: () =>
            wrap(
              h,
              "claude-slot",
              banner(h, {
                tone: toneOf("WaitingForSlot"),
                mark: Option.none(),
                title: HOLD_LABELS.WaitingForSlot.word,
                detail: Option.some(
                  "This thread is waiting for a Claude slot."
                ),
                actions: [],
              })
            ),
        }),
    }
  );

/** The banner, embedded by the shell with `h.submodel` above the transcript. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [h.DataAttribute("slot", "thread-hold-slot"), h.Class("contents")],
    [content(model, h)]
  )
);
