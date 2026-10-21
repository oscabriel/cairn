// Spike 2's state: the inbox rows, the draft, and the phone layout. Rows come from a fixture the parity harness copies
// out of t3code at screenshot time (URL hash `#fixture=<base64 JSON>`), so both apps show the same threads.
import { Schema } from "effect"

export const Row = Schema.Struct({
	project: Schema.String,
	monogram: Schema.String,
	// The monogram's colour classes, one of t3code's project tones.
	tone: Schema.String,
	title: Schema.String,
	status: Schema.Literals(["working", "idle"]),
	age: Schema.String,
	branch: Schema.optional(Schema.String),
})
export type Row = typeof Row.Type

export const DraftProject = Schema.Struct({ project: Schema.String, monogram: Schema.String, tone: Schema.String })

export const Fixture = Schema.Struct({ rows: Schema.Array(Row), settled: Schema.Number, draft: DraftProject })
export type Fixture = typeof Fixture.Type

export const Model = Schema.Struct({
	fixture: Fixture,
	draft: Schema.String,
	isMobile: Schema.Boolean,
	sidebarOpen: Schema.Boolean,
	// The typing test's load: a transcript that grows while the composer is typed into.
	streaming: Schema.Boolean,
	transcript: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const defaultFixture: Fixture = {
	rows: [
		{ project: "cairn", monogram: "CN", tone: "text-amber-600 dark:text-amber-400", title: "Executor MCP Stdio Bridges", status: "working", age: "3m", branch: "main" },
		{ project: "supervillain", monogram: "SN", tone: "text-orange-600 dark:text-orange-400", title: "Codebase status overview", status: "idle", age: "2m" },
	],
	settled: 145,
	draft: { project: "cairn", monogram: "CN", tone: "text-amber-600 dark:text-amber-400" },
}
