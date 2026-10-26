// The draft hero's measuring Mount, ported from github.com/pingdotgg/t3code,
// apps/web/src/components/chat/DraftHeroProjectHeading.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (MIT License, Copyright (c) 2026 T3 Tools Inc.; the full
// notice is in hero/Headline.ts). Kept: the fit check against a hidden full-width copy of the
// heading. Changed: a Foldkit Mount reporting `MeasuredHeadline` instead of React state.

import { Effect, Option, Queue, Stream } from "effect";
import { Mount } from "foldkit";

import { Message } from "./Message.ts";

/**
 * Reports whether the full inline heading fits its container, measured on a hidden copy so moving
 * the project name below cannot make the check oscillate.
 */
export const MeasureHeadline = Mount.defineStream("MeasureHeadline", {
  messages: [Message.MeasuredHeadline],
  execute: ({ element }) =>
    Stream.callback<typeof Message.MeasuredHeadline.Type>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let last = Option.none<boolean>();
          const inline = element.querySelector("[data-headline-measure]");

          const report = () => {
            const fits =
              inline !== null &&
              inline.getBoundingClientRect().width <=
                element.getBoundingClientRect().width;

            if (!Option.contains(last, fits)) {
              last = Option.some(fits);
              Queue.offerUnsafe(
                queue,
                Message.MeasuredHeadline({ inline: fits })
              );
            }
          };

          const resize = new ResizeObserver(report);

          resize.observe(element);

          if (inline !== null) {
            resize.observe(inline);
          }

          report();

          return resize;
        }),
        (resize) =>
          Effect.sync(() => {
            resize.disconnect();
          })
      ).pipe(Effect.flatMap(() => Effect.never))
    ),
});
