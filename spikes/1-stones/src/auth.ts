// Copied unchanged from cairn-v1 apps/cloud-sandbox/src/auth.ts, commit 1a5cd4a56e84bfb187940428d144b584d2e084b0.
// The relay's shared-secret check. Both sides hash before comparing, so the comparison is constant-time over equal
// lengths whatever the caller sent. Plain Web Crypto, so the tests run it in Node.

/** The secret is 64 hex (32 random bytes); a Worker bound with anything else refuses every request. */
export const SECRET = /^[0-9a-f]{64}$/;

const digest = async (text: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** True when `header` is exactly `Bearer <secret>` and the bound secret is well formed. */
export const bearerMatches = async (header: string | null, secret: string | undefined): Promise<boolean> => {
	if (!secret || !SECRET.test(secret) || header === null || !header.startsWith("Bearer ")) return false;
	const [given, expected] = await Promise.all([digest(header.slice("Bearer ".length)), digest(secret)]);
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= (given[i] ?? 0) ^ (expected[i] ?? 0);
	return diff === 0;
};
