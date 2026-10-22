// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/composerTypingGuard.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a request (an approval, a question) that
// arrives while the user is typing in the focused composer is held back until they pause for 1.5 s,
// send, or leave the composer, so a card never steals keystrokes; a request seen once is never held
// again. Changed: the state is a Schema value (arrays and `Option`) so a Foldkit Model can hold it,
// and events are a tagged union.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { Array, Option, Schema } from "effect";

/** How long after the last keystroke typing counts as paused. */
export const COMPOSER_TYPING_IDLE_MS = 1500;

/** Which requests the guard has seen and which it holds back. */
export const TypingGuardState = Schema.Struct({
  seen: Schema.Array(Schema.String),
  held: Schema.Array(Schema.String),
  focused: Schema.Boolean,
  /** When the user last typed, in milliseconds on the caller's clock. */
  lastTypedAt: Schema.Option(Schema.Finite),
});

export type TypingGuardState = typeof TypingGuardState.Type;

/** A guard that has seen nothing, with the composer unfocused. */
export const initialTypingGuard: TypingGuardState = {
  seen: [],
  held: [],
  focused: false,
  lastTypedAt: Option.none(),
};

/** What the guard reacts to. Times are milliseconds on the caller's clock. */
export const TypingGuardEvent = Schema.TaggedUnion({
  /** The requests now pending. */
  Requests: { requestIds: Schema.Array(Schema.String), now: Schema.Finite },
  Typed: { now: Schema.Finite },
  Focused: {},
  Blurred: {},
  Sent: {},
  /** Typing paused for {@link COMPOSER_TYPING_IDLE_MS}. */
  Idled: {},
});

export type TypingGuardEvent = typeof TypingGuardEvent.Type;

const isTyping = (state: TypingGuardState, now: number): boolean =>
  state.focused &&
  Option.exists(
    state.lastTypedAt,
    (typedAt) => now - typedAt < COMPOSER_TYPING_IDLE_MS
  );

const release = (
  state: TypingGuardState,
  focused: boolean
): TypingGuardState => ({
  ...state,
  held: [],
  lastTypedAt: Option.none(),
  focused,
});

/** The guard after `event`. */
export const updateTypingGuard = (
  state: TypingGuardState,
  event: TypingGuardEvent
): TypingGuardState =>
  TypingGuardEvent.match(event, {
    Requests: ({ now, requestIds }) => {
      const fresh = Array.filter(requestIds, (id) => !state.seen.includes(id));

      const stillHeld = Array.filter(state.held, (id) =>
        requestIds.includes(id)
      );

      return {
        ...state,
        seen: Array.dedupe([...state.seen, ...requestIds]),
        held: isTyping(state, now)
          ? Array.dedupe([...stillHeld, ...fresh])
          : stillHeld,
      };
    },
    Typed: ({ now }) => ({ ...state, lastTypedAt: Option.some(now) }),
    Focused: () => ({ ...state, focused: true }),
    Blurred: () => release(state, false),
    Sent: () => release(state, state.focused),
    Idled: () => release(state, state.focused),
  });
