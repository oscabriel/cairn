// Spike 2: t3code's new-thread page (sidebar, draft hero, composer) in Foldkit. The markup is generated from t3code's
// rendered DOM (src/t3/); this file owns the state that changes: the draft, the rows, the phone sidebar and, for the
// typing test, a transcript that streams while the composer is typed into.
//
// URL: `?stream=1` streams the transcript; `?sidebar=1` opens the phone sidebar; `#fixture=<base64 JSON>` sets the rows.
import { Option, Schedule, Schema, Stream } from "effect"
import { Runtime, Subscription, Update } from "foldkit"
import { streamFromEventFilterMap, streamFromMediaQuery } from "foldkit/dom"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"

import { defaultFixture, Fixture, Model } from "./model"
import { desktopPage, mobilePage, mobileSidebarPage, mobileSidebarSheet } from "./t3/pages"
import { rowIdle, rowWorking, settledHeader } from "./t3/rows"

export const Message = defineMessageUnion({
	ChangedDraft: { value: Schema.String },
	ChangedViewport: { isMobile: Schema.Boolean },
	ToggledSidebar: {},
	ClosedSidebar: {},
	StreamedChunk: { text: Schema.String },
})
export type Message = typeof Message.Type

// `?busy=<ms>` adds that much work to every update, the load that exposes Foldkit's keystroke loss (#1697).
const busyMs = Number(new URLSearchParams(location.search).get("busy") ?? 0)
const busy = () => {
	const until = performance.now() + busyMs
	while (performance.now() < until) {}
}

const update = (model: Model, message: Message) => (busyMs > 0 && busy(), updateModel(model, message))

const updateModel = (model: Model, message: Message) =>
	Message.match<Update.Return<Model, Message>>(message, {
		ChangedDraft: ({ value }) => ({ model: { ...model, draft: value } }),
		ChangedViewport: ({ isMobile }) => ({ model: { ...model, isMobile } }),
		ToggledSidebar: () => ({ model: { ...model, sidebarOpen: !model.sidebarOpen } }),
		ClosedSidebar: () => ({ model: { ...model, sidebarOpen: false } }),
		StreamedChunk: ({ text }) => {
			const last = model.transcript.at(-1) ?? ""
			// A paragraph every ~400 characters, as a model's answer arrives in blocks.
			const transcript = last.length > 400 ? [...model.transcript, text] : [...model.transcript.slice(0, -1), last + text]
			return { model: { ...model, transcript } }
		},
	})

const readFixture = (): Fixture => {
	const encoded = /#fixture=([^&]+)/.exec(location.hash)?.[1]
	if (encoded === undefined) return defaultFixture
	const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Fixture))(atob(decodeURIComponent(encoded)))
	return Option.getOrElse(decoded, () => defaultFixture)
}

const params = new URLSearchParams(location.search)

const init: Runtime.ApplicationInit<Model, Message> = () => ({
	model: {
		fixture: readFixture(),
		draft: "",
		isMobile: matchMedia("(max-width: 767px)").matches,
		sidebarOpen: params.get("sidebar") === "1",
		streaming: params.get("stream") === "1",
		transcript: [""],
	},
})

const words = "The workflow resumed from its journal after the restart, and the scan's result came back without the scan running again. ".split(" ")

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	viewport: Subscription.persistentEntry(
		streamFromMediaQuery({ query: "(max-width: 767px)", mapMatches: (isMobile) => Message.ChangedViewport({ isMobile }) }),
	),
	// The static markup has no handlers, so the sidebar toggle and the sheet's backdrop are read from the document.
	sidebarClicks: Subscription.persistentEntry(
		streamFromEventFilterMap({
			target: document,
			type: "click",
			filterMapEvent: (event) => {
				const target = event.target instanceof Element ? event.target : null
				if (target?.closest('[aria-label="Toggle main sidebar"]')) return Option.some(Message.ToggledSidebar())
				if (target?.closest('[data-slot="sheet-viewport"]') && !target.closest('[data-slot="sidebar"]')) return Option.some(Message.ClosedSidebar())
				return Option.none()
			},
		}),
	),
	stream: entry(
		{ streaming: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ streaming: model.streaming }),
			// About 40 tokens a second, in 25 ms chunks, the rate of a fast model.
			dependenciesToStream: ({ streaming }) =>
				streaming
					? Stream.fromSchedule(Schedule.spaced("25 millis")).pipe(
							Stream.map((n) => Message.StreamedChunk({ text: `${words[n % words.length]} ` })),
						)
					: Stream.empty,
		},
	),
}))

const editor = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.Class(
				"relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
			),
		],
		[
			h.div(
				[],
				[
					h.textarea(
						[
							h.AriaLabel("Message"),
							h.DataAttribute("testid", "composer-editor"),
							h.Class(
								"-m-1 block max-h-52 min-h-19.5 w-[calc(100%+--spacing(2))] resize-none overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none [field-sizing:content]",
							),
							h.Value(model.draft),
							h.OnInput((value) => Message.ChangedDraft({ value })),
						],
					),
				],
			),
			model.draft === ""
				? h.div([h.Class("pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75")], [
						"Ask for changes, send follow-ups, or attach images",
					])
				: null,
		],
	)

const threadList = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.ul([h.Role("presentation"), h.Class("relative flex flex-col gap-px flex-1")], [
		...model.fixture.rows.map((row) =>
			h.li([h.Class("list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]")], [
				row.status === "working" ? rowWorking(h, row) : rowIdle(h, row),
			]),
		),
		settledHeader(h, model.fixture.settled),
	])

const transcript = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.streaming
		? h.div(
				[h.DataAttribute("testid", "stream"), h.DataAttribute("paragraphs", String(model.transcript.length)), h.Class("pointer-events-none fixed inset-x-0 top-12 z-0 mx-auto max-h-[45vh] max-w-3xl overflow-hidden px-6 text-sm leading-relaxed text-muted-foreground")],
				model.transcript.slice(-40).map((paragraph, index) => h.p([h.Key(String(model.transcript.length - 40 + index)), h.Class("mb-3")], [paragraph])),
			)
		: null

const view = (model: Model, h: HtmlBuilder<Message>): Document => {
	const slots = { threadList: threadList(model, h), editor: editor(model, h), ...model.fixture.draft }
	const page = !model.isMobile
		? desktopPage(h, slots)
		: model.sidebarOpen
			? h.div([h.Class("contents")], [mobileSidebarPage(h, slots), mobileSidebarSheet(h, slots)])
			: mobilePage(h, slots)
	return { title: "Cairn", body: h.div([h.Class("contents")], [page, transcript(model, h)]) }
}

Runtime.run(
	Runtime.makeApplication({
		Model,
		init,
		update,
		view,
		subscriptions,
		container: document.getElementById("root")!,
	}),
)
