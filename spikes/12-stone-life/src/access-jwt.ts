// By way of cairn-v1 apps/cloud-sandbox/src/access-jwt.ts (commit 1a5cd4a5). Copied from acoyfellow/coil, src/auth/access-jwt.ts, commit e142d668ccd43e4b3648a579c0318ad04d266e26, by way of
// apps/stones/src/access-jwt.ts and unchanged from that copy, whose changes are these: `verifyAccess` also returns the
// `common_name` claim, which a service token's JWT carries in place of an email, and `verifyServiceToken` requires it
// to be the expected client id. Formatting follows this repo.
//
// MIT License
//
// Copyright (c) 2026 Jordan Coeyman
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
const CLOCK_SKEW_SECONDS = 60;

const KEYS_TTL_MS = 10 * 60_000;

const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;

const AUDIENCE = /^[a-f0-9]{64}$/;

export class AccessDenied extends Error {
	override readonly name = "AccessDenied";
}

export type AccessConfig = { readonly teamDomain: string; readonly audience: string };

export const accessConfig = (
	teamDomain: string | undefined,
	audience: string | undefined,
): AccessConfig | null => {
	const domain = teamDomain?.replace(/\/+$/, "");

	return domain !== undefined &&
		audience !== undefined &&
		TEAM_DOMAIN.test(domain) &&
		AUDIENCE.test(audience)
		? { teamDomain: domain, audience }
		: null;
};

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
	const padded = value
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");

	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

const json = (segment: string): Record<string, unknown> => {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(segment)));

		if (typeof value !== "object" || value === null) throw new AccessDenied("malformed token");

		return value as Record<string, unknown>;
	} catch (cause) {
		if (cause instanceof AccessDenied) throw cause;

		throw new AccessDenied("malformed token");
	}
};

const cache = new Map<string, { keys: Map<string, CryptoKey>; until: number }>();

const keysFor = async (teamDomain: string, refresh: boolean): Promise<Map<string, CryptoKey>> => {
	const hit = cache.get(teamDomain);

	if (!refresh && hit !== undefined && hit.until > Date.now()) return hit.keys;

	const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`);

	if (!response.ok) throw new AccessDenied("could not load signing keys");

	const body = (await response.json()) as {
		keys?: Array<{ kid?: string; kty?: string; n?: string; e?: string }>;
	};
	const keys = new Map<string, CryptoKey>();

	for (const jwk of body.keys ?? []) {
		if (jwk.kty !== "RSA" || jwk.kid === undefined || jwk.n === undefined || jwk.e === undefined)
			continue;

		keys.set(
			jwk.kid,
			await crypto.subtle.importKey(
				"jwk",
				{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			),
		);
	}

	cache.set(teamDomain, { keys, until: Date.now() + KEYS_TTL_MS });

	return keys;
};

export const verifyAccess = async (
	token: string | null,
	config: AccessConfig,
): Promise<{ email: string | null; commonName: string | null }> => {
	if (token === null) throw new AccessDenied("missing token");

	const parts = token.split(".");
	const [head, body, signature] = parts;

	if (parts.length !== 3 || head === undefined || body === undefined || signature === undefined)
		throw new AccessDenied("malformed token");

	const header = json(head);

	if (header.alg !== "RS256" || typeof header.kid !== "string")
		throw new AccessDenied("unsupported token");

	let key = (await keysFor(config.teamDomain, false)).get(header.kid);

	key ??= (await keysFor(config.teamDomain, true)).get(header.kid);

	if (key === undefined) throw new AccessDenied("unknown signing key");

	const signed = new TextEncoder().encode(`${head}.${body}`);

	if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(signature), signed)))
		throw new AccessDenied("bad signature");

	const claims = json(body);
	const now = Math.floor(Date.now() / 1000);
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

	if (claims.iss !== config.teamDomain) throw new AccessDenied("wrong issuer");

	if (!audiences.includes(config.audience)) throw new AccessDenied("wrong audience");

	if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now)
		throw new AccessDenied("expired");

	if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now)
		throw new AccessDenied("not yet valid");

	return {
		email: typeof claims.email === "string" ? claims.email : null,
		commonName: typeof claims.common_name === "string" ? claims.common_name : null,
	};
};

/** The link's check: a valid Access JWT for the link application, minted for the link's own service token. */
export const verifyServiceToken = async (token: string | null, config: AccessConfig, clientId: string): Promise<void> => {
	const { commonName } = await verifyAccess(token, config);
	if (commonName !== clientId) throw new AccessDenied("wrong service token");
};
