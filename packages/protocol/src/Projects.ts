// Project and folder queries: the folder picker, the scratch project, `@` file search and the base
// branches the new-thread context strip offers.

import { Schema } from "effect";

import {
  DisplayText,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./Ids.ts";

/** `projects.browse` input: a folder to list; none lists the user's home. */
export const BrowseInput = Schema.Struct({
  path: Schema.OptionFromNullOr(TrimmedNonEmptyString),
});

export type BrowseInput = typeof BrowseInput.Type;

/** One folder in a listing. Files are not listed: a project is a folder. */
export const BrowseEntry = Schema.Struct({
  name: DisplayText,
  path: TrimmedNonEmptyString,
  isGitRepo: Schema.Boolean,
});

export type BrowseEntry = typeof BrowseEntry.Type;

/** `projects.browse` result. */
export const BrowseResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  parent: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  entries: Schema.Array(BrowseEntry),
});

export type BrowseResult = typeof BrowseResult.Type;

/** `projects.searchEntries` input: files and folders under a project matching `query`. */
export const SearchEntriesInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.String.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(200)),
});

export type SearchEntriesInput = typeof SearchEntriesInput.Type;

/** One match, relative to the project root. */
export const SearchEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory"]),
});

export type SearchEntry = typeof SearchEntry.Type;

/** `projects.searchEntries` result. */
export const SearchEntriesResult = Schema.Struct({
  entries: Schema.Array(SearchEntry),
  /** True when more matched than `limit`. */
  truncated: Schema.Boolean,
});

export type SearchEntriesResult = typeof SearchEntriesResult.Type;

/** `git.branches` input. */
export const BranchesInput = Schema.Struct({
  projectId: ProjectId,
});

export type BranchesInput = typeof BranchesInput.Type;

/** One branch a new worktree can start from. */
export const Branch = Schema.Struct({
  name: TrimmedNonEmptyString,
  isRemote: Schema.Boolean,
  isDefault: Schema.Boolean,
  /** Commits ahead of its upstream, when it has one. */
  ahead: Schema.OptionFromNullOr(NonNegativeInt),
});

export type Branch = typeof Branch.Type;

/** `git.branches` result. */
export const BranchesResult = Schema.Struct({
  current: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  branches: Schema.Array(Branch),
});

export type BranchesResult = typeof BranchesResult.Type;
