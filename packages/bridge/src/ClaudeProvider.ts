// The thin pi-ai adapter for the `claude-bridge` provider. Ported from cairn-v1
// apps/server/src/Claude.ts `claudeProvider` (lines 60-90) at 1a5cd4a56e84bfb187940428d144b584d2e084b0,
// with the auth split of w-winter/dot314 extensions/pi-claude-bridge/src/native-provider.ts at
// c157f4e6f9fda15b2d6698a12820e7118d19fbd7 (ideas only). Changed: `auth.apiKey.check` is the
// side-effect-free availability probe pi-ai 1.4.0 calls, and both it and `resolve` read the cached
// login (`ClaudeAccount`), never spawning a child. There is no key: the login is the `claude` binary's.
//
// MIT License
//
// Copyright (c) 2026 Eli Dickinson
// Copyright (c) 2026 Warren Winter
// Copyright (c) 2026 Nico Bailon
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type {
  Api,
  AssistantMessageEventStream,
  Message,
  Model,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  createProvider,
  normalizeContext,
} from "@earendil-works/pi-ai";

import type { ClaudeLogin } from "./ClaudeAccount.ts";
import { loginAllowsTurns } from "./ClaudeAccount.ts";
import { PROVIDER_ID } from "./ClaudeModels.ts";

/** Where the adapter hands a request: the bridge runs it into `sink`, which it always ends. */
export type ClaudeCall = (
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  sink: AssistantMessageEventStream
) => void;

/** The label pi shows as the source of the bridge's auth. */
export const AUTH_SOURCE = "claude CLI";

/** The pi-ai provider `claude-bridge` over `call`, offering `models`, available unless `login` says logged out. */
export const claudeProvider = (
  models: ReadonlyArray<Model<Api>>,
  call: ClaudeCall,
  login: () => Promise<ClaudeLogin>
): Provider => {
  const stream = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions
  ) => {
    const sink = createAssistantMessageEventStream();

    call(model, context, options, sink);

    return sink;
  };

  return createProvider({
    id: PROVIDER_ID,
    name: "Claude",
    auth: {
      apiKey: {
        name: "Claude Code login",
        check: async () =>
          loginAllowsTurns(await login())
            ? { type: "api_key", source: AUTH_SOURCE }
            : undefined,
        resolve: async () =>
          loginAllowsTurns(await login())
            ? { auth: { apiKey: "not-used" }, source: AUTH_SOURCE }
            : undefined,
      },
    },
    models,
    api: { stream, streamSimple: stream },
  });
};

/** pi's messages as the transcript a provider receives, for judges that call the provider directly. */
export const providerContext = (
  messages: ReadonlyArray<Message>
): TranscriptContext => normalizeContext({ messages: [...messages] });
