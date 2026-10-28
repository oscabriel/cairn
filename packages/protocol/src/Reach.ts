// Reach (ADR 0038): artifacts an agent publishes under `https://plans.<domain>/<project>/<name>`
// and portals that serve a dev server at `https://<name>.<domain>`, both through porch and behind
// the owner check. These are the rows `reach.list` answers with and the `details` the tools attach
// to their transcript entries. The brain's porch receipts stay inside `reach/PorchClient.ts`; no
// shape here assumes a particular porch command. Shapes from docs/phase-2/notes/reach.md,
// sections 3 to 5.

import { Schema } from "effect";

import {
  DisplayText,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";

/** The largest file or folder an artifact may publish (t3code's `MAX_PAGE_BYTES`). */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

/** How many portals one brain keeps open at once (ADR 0038). */
export const MAX_OPEN_PORTALS = 6;

/** How long a portal lives unless asked otherwise (ADR 0038). */
export const DEFAULT_PORTAL_TTL_HOURS = 12;

/** A server-minted opaque token, as other server ids are. */
const OpaqueToken = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)
);

/** One published artifact. */
export const ArtifactId = OpaqueToken.pipe(Schema.brand("ArtifactId"));

export type ArtifactId = typeof ArtifactId.Type;

/** One portal. Its systemd unit is `cairn-portal-<id>`. */
export const PortalId = OpaqueToken.pipe(Schema.brand("PortalId"));

export type PortalId = typeof PortalId.Type;

/** A URL Cairn hands out: https only. */
const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\//u));

/** What an artifact published: one file, or a folder with an `index.html`. */
export const ArtifactKind = Schema.Literals(["file", "folder"]);

export type ArtifactKind = typeof ArtifactKind.Type;

/** An artifact as `reach.list` shows it. The porch registry is what is served; this is the index. */
export const ArtifactRow = Schema.Struct({
  id: ArtifactId,
  threadId: ThreadId,
  projectSlug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  kind: ArtifactKind,
  url: HttpsUrl,
  /** The content hash porch compared, so a republish of the same bytes is `changed: false`. */
  hash: TrimmedNonEmptyString,
  bytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_ARTIFACT_BYTES)),
  publishedAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  revokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
});

export type ArtifactRow = typeof ArtifactRow.Type;

/**
 * Where a portal stands. `opening` until its port answers; `stopped` keeps the name and command so
 * Start can run it again; `removed` is gone for good.
 */
export const PortalState = Schema.Literals([
  "opening",
  "open",
  "stopped",
  "removed",
]);

export type PortalState = typeof PortalState.Type;

/** Where a portal's process runs: a user unit on the host, or (phase 3) a stone. */
export const PortalArms = Schema.Literals(["host", "stone"]);

export type PortalArms = typeof PortalArms.Type;

/** Why a portal stopped: closed, expired, its process exited, or a boot found its unit gone. */
export const PortalStopReason = Schema.Literals([
  "closed",
  "expired",
  "exited",
  "lost",
]);

export type PortalStopReason = typeof PortalStopReason.Type;

/** A portal as `reach.list` shows it. */
export const PortalRow = Schema.Struct({
  id: PortalId,
  threadId: ThreadId,
  /** One DNS label, `<branch-slug>--<project-slug>`, at most 63 characters. */
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,63}$/u)),
  url: HttpsUrl,
  port: Schema.OptionFromNullOr(PositiveInt.check(Schema.isLessThan(65_536))),
  command: DisplayText,
  cwd: TrimmedNonEmptyString,
  state: PortalState,
  arms: PortalArms,
  ttlHours: PositiveInt.check(Schema.isLessThanOrEqualTo(72)),
  openedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  stoppedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  stopReason: Schema.OptionFromNullOr(PortalStopReason),
});

export type PortalRow = typeof PortalRow.Type;

/** `reach.list` input: one thread's artifacts and portals, or every thread's. */
export const ReachListInput = Schema.Struct({
  threadId: Schema.OptionFromNullOr(ThreadId),
});

export type ReachListInput = typeof ReachListInput.Type;

/** `reach.list` result. */
export const ReachList = Schema.Struct({
  artifacts: Schema.Array(ArtifactRow),
  portals: Schema.Array(PortalRow),
});

export type ReachList = typeof ReachList.Type;

/** `artifact.revoke` input: stop serving one artifact. */
export const ArtifactRevokeInput = Schema.Struct({
  artifactId: ArtifactId,
});

export type ArtifactRevokeInput = typeof ArtifactRevokeInput.Type;

/** `portal.close` and `portal.start` input. */
export const PortalInput = Schema.Struct({
  portalId: PortalId,
});

export type PortalInput = typeof PortalInput.Type;

/**
 * The `details` of an `artifact_publish` tool result, plain JSON in the transcript: the row reads
 * "Published report.html" or "Updated report.html" with the URL as a link.
 */
export const ArtifactDetails = Schema.Struct({
  kind: Schema.Literal("artifact"),
  artifactId: ArtifactId,
  url: HttpsUrl,
  name: TrimmedNonEmptyString,
  changed: Schema.Boolean,
  bytes: NonNegativeInt,
});

export type ArtifactDetails = typeof ArtifactDetails.Type;

/** The `details` of a `portal_open` or `portal_close` tool result, plain JSON in the transcript. */
export const PortalDetails = Schema.Struct({
  kind: Schema.Literal("portal"),
  portalId: PortalId,
  url: HttpsUrl,
  name: TrimmedNonEmptyString,
  state: PortalState,
});

export type PortalDetails = typeof PortalDetails.Type;
