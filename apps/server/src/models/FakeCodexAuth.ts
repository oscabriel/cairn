// A fake of OpenAI's Codex sign-in for tests and judges: the device-code endpoints and a token
// endpoint that rotates the refresh token on every refresh and treats a reused one as theft, as
// OpenAI does. pi-ai's Codex flow calls `https://auth.openai.com` with the global `fetch`, so the
// fake hands out a `fetch` that sends those calls to it instead; nothing else is redirected.
//
//   const fake = await startFakeCodexAuth();
//   globalThis.fetch = fake.fetch;   // in a test's scope or a judge's process only
//   fake.approve();                  // the user entered the code
//
// Tokens are counters (`at_1`, `rt_1`, ...), never real values. The access token is a JWT with
// Codex's account claim and an email profile claim, unsigned.

import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The fake's address book for OpenAI's sign-in host. */
const AUTH_ORIGIN = "https://auth.openai.com";

/** The account the fake signs in. */
export const FAKE_ACCOUNT = {
  accountId: "acct_fake_codex",
  email: "owner@example.test",
} as const;

/** What the fake saw: counts and the refresh-token lineage, never a secret of the real service. */
export interface FakeCodexAuthLog {
  codeRequests: number;
  polls: number;
  exchanges: number;
  refreshes: number;
  /** Refresh calls that presented a token the fake had already rotated away. */
  reuses: number;
  /** The one refresh token that still works, if any. */
  current: string | undefined;
}

/** A running fake. */
export interface FakeCodexAuth {
  /** `http://127.0.0.1:<port>`. */
  readonly base: string;
  /** The global `fetch` with OpenAI's sign-in host sent to the fake. */
  readonly fetch: typeof fetch;
  readonly log: FakeCodexAuthLog;
  /** Marks the device code as entered: the next poll completes. */
  approve(): void;
  /** Refuses every later token call (the provider is down). */
  refuseAll(): void;
  close(): Promise<void>;
}

const base64 = (text: string) => Buffer.from(text, "utf-8").toString("base64");

/** The claims of the fake's access tokens: Codex's account claim and the profile's email. */
interface AccessClaims {
  readonly "https://api.openai.com/auth": {
    readonly chatgpt_account_id: string;
  };
  readonly "https://api.openai.com/profile": { readonly email: string };
  readonly serial: number;
}

/** One JSON answer of the fake: flat strings and numbers. */
type Answer = Readonly<Record<string, string | number>>;

const jwt = (claims: AccessClaims) =>
  `${base64(JSON.stringify({ alg: "none" }))}.${base64(JSON.stringify(claims))}.fake`;

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf-8");
};

const send = (response: ServerResponse, status: number, body: Answer) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/**
 * `realFetch` with OpenAI's sign-in host sent to the fake at `base`, for a process (a judge's
 * brain) other than the one the fake runs in.
 */
export const redirectFetch =
  (base: string, realFetch: typeof fetch): typeof fetch =>
  async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    return url.startsWith(AUTH_ORIGIN)
      ? await realFetch(`${base}${url.slice(AUTH_ORIGIN.length)}`, init)
      : await realFetch(input, init);
  };

/** How long the fake's access tokens live. pi-ai refreshes one with less than five minutes left. */
export interface FakeCodexAuthOptions {
  /** Seconds an access token from a sign-in lives; one hour by default. */
  readonly accessSeconds?: number;
  /** Seconds an access token from a refresh lives; `accessSeconds` by default. */
  readonly refreshedSeconds?: number;
}

/** Starts the fake on a free loopback port. */
export const startFakeCodexAuth = async (
  options: FakeCodexAuthOptions = {}
): Promise<FakeCodexAuth> => {
  const accessSeconds = options.accessSeconds ?? 3600;
  const refreshedSeconds = options.refreshedSeconds ?? accessSeconds;

  const log: FakeCodexAuthLog = {
    codeRequests: 0,
    polls: 0,
    exchanges: 0,
    refreshes: 0,
    reuses: 0,
    current: undefined,
  };

  let approved = false;
  let refusing = false;
  let serial = 0;
  const rotated = new Set<string>();

  const issue = (lifetime: number) => {
    serial += 1;
    log.current = `rt_${serial}`;

    return {
      access_token: jwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: FAKE_ACCOUNT.accountId,
        },
        "https://api.openai.com/profile": { email: FAKE_ACCOUNT.email },
        serial,
      }),
      refresh_token: log.current,
      expires_in: lifetime,
    };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    const url = request.url ?? "/";

    if (url === "/api/accounts/deviceauth/usercode") {
      log.codeRequests += 1;
      send(response, 200, {
        device_auth_id: "dev_fake",
        user_code: "FAKE-CODE",
        interval: "1",
      });

      return;
    }

    if (url === "/api/accounts/deviceauth/token") {
      log.polls += 1;

      if (!approved) {
        send(response, 403, { error: "deviceauth_authorization_pending" });

        return;
      }

      send(response, 200, {
        authorization_code: "code_fake",
        code_verifier: "verifier_fake",
      });

      return;
    }

    if (url === "/oauth/token") {
      const form = new URLSearchParams(body);

      if (refusing) {
        send(response, 503, { error: "temporarily_unavailable" });

        return;
      }

      if (form.get("grant_type") === "authorization_code") {
        log.exchanges += 1;

        if (log.current !== undefined) {
          rotated.add(log.current);
        }

        send(response, 200, issue(accessSeconds));

        return;
      }

      if (form.get("grant_type") === "refresh_token") {
        const presented = form.get("refresh_token") ?? "";

        if (presented !== log.current) {
          // Reuse of a rotated token: the whole grant is revoked, as OpenAI does.
          if (rotated.has(presented)) {
            log.reuses += 1;
          }

          log.current = undefined;
          send(response, 401, { error: "invalid_grant" });

          return;
        }

        log.refreshes += 1;
        rotated.add(presented);
        send(response, 200, issue(refreshedSeconds));

        return;
      }
    }

    send(response, 404, { error: "not_found" });
  };

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  // SAFETY: a server listening on a TCP host and port reports an `AddressInfo`.
  // Verified by: CodexLogin.test.ts (every case reaches the fake through this address)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    fetch: redirectFetch(base, globalThis.fetch),
    log,
    approve: () => {
      approved = true;
    },
    refuseAll: () => {
      refusing = true;
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
