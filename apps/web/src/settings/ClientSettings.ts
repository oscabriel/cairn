// Ported from github.com/pingdotgg/t3code, packages/contracts/src/settings.ts (ClientSettingsSchema,
// its defaults and the font size bounds) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the field
// names, literal sets, bounds and defaults of the settings Cairn offers. Changed: only the fields
// Cairn's settings page shows, plus the theme t3code keeps elsewhere; saved in localStorage under
// `cairn:client-settings:v1`, and a saved value that does not decode yields the defaults instead of
// an error; applying a setting writes the attributes `index.html` starts with.
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
import { Effect, Match, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

/** The localStorage key the client settings are saved under. */
export const CLIENT_SETTINGS_STORAGE_KEY = "cairn:client-settings:v1";

/** Light, dark, or whatever the device prefers. */
export const Theme = Schema.Literals(["system", "light", "dark"]);

export type Theme = typeof Theme.Type;

/** How Enter behaves in the composer. */
export const SendShortcut = Schema.Literals([
  "enter",
  "mod-enter-multiline",
  "mod-enter",
]);

/** What a message sent while a run is going does. */
export const FollowUpBehavior = Schema.Literals(["queue", "steer"]);

/** How times are printed. */
export const TimestampFormat = Schema.Literals([
  "locale",
  "12-hour",
  "24-hour",
]);

/** How wide the transcript and composer may grow. */
export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);

/** How a diff is laid out. */
export const DiffLayout = Schema.Literals(["stacked", "split"]);

const sizeBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/** The interface font size in pixels, 12 to 20, default 16. */
export const InterfaceFontSize = sizeBetween(12, 20);

/** The composer's font size in pixels, 12 to 20, default 14. */
export const PromptFontSize = sizeBetween(12, 20);

/** The code font size in pixels, 10 to 18, default 13. */
export const CodeFontSize = sizeBetween(10, 18);

/** The settings that belong to this device, each with its default when missing. */
export const ClientSettings = Schema.Struct({
  sendShortcut: SendShortcut.pipe(
    Schema.withDecodingDefault(Effect.succeed("enter" as const))
  ),
  followUpBehavior: FollowUpBehavior.pipe(
    Schema.withDecodingDefault(Effect.succeed("queue" as const))
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed("locale" as const))
  ),
  confirmThreadDelete: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true))
  ),
  composerCollapseOnScroll: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true))
  ),
  theme: Theme.pipe(
    Schema.withDecodingDefault(Effect.succeed("system" as const))
  ),
  fontSizeInterface: InterfaceFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(16))
  ),
  fontSizePrompt: PromptFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(14))
  ),
  fontSizeCode: CodeFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(13))
  ),
  chatWidth: ChatWidth.pipe(
    Schema.withDecodingDefault(Effect.succeed("comfortable" as const))
  ),
  diffLayout: DiffLayout.pipe(
    Schema.withDecodingDefault(Effect.succeed("stacked" as const))
  ),
});

export type ClientSettings = typeof ClientSettings.Type;

const ClientSettingsJson = Schema.fromJsonString(ClientSettings);

const decodeClientSettingsJson = Schema.decodeOption(ClientSettingsJson);

const encodeClientSettingsJson = Schema.encodeEffect(ClientSettingsJson);

const decodeEmpty = Schema.decodeSync(ClientSettings);

/** Every setting at its default. */
export const DEFAULT_CLIENT_SETTINGS: ClientSettings = decodeEmpty({});

/**
 * The settings saved as `json`. A missing key takes its default; text that is not JSON, or a value
 * outside its set, yields the defaults, so a corrupt entry never stops the page.
 */
export const parseClientSettings = (json: string): ClientSettings =>
  Option.getOrElse(
    decodeClientSettingsJson(json),
    () => DEFAULT_CLIENT_SETTINGS
  );

/** Reads this device's settings; nothing saved, or nothing readable, gives the defaults. */
export const loadClientSettings: Effect.Effect<
  ClientSettings,
  never,
  KeyValueStore.KeyValueStore
> = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const saved = yield* store.get(CLIENT_SETTINGS_STORAGE_KEY);

  return Option.match(Option.fromUndefinedOr(saved), {
    onNone: () => DEFAULT_CLIENT_SETTINGS,
    onSome: parseClientSettings,
  });
}).pipe(Effect.orElseSucceed(() => DEFAULT_CLIENT_SETTINGS));

/** Saves this device's settings; a full or refused storage answers false. */
export const saveClientSettings = (
  settings: ClientSettings
): Effect.Effect<boolean, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const json = yield* encodeClientSettingsJson(settings);

    yield* store.set(CLIENT_SETTINGS_STORAGE_KEY, json);

    return true;
  }).pipe(Effect.orElseSucceed(() => false));

/** The settings a switch turns on and off. */
export const BooleanSettingKey = Schema.Literals([
  "confirmThreadDelete",
  "composerCollapseOnScroll",
]);

export type BooleanSettingKey = typeof BooleanSettingKey.Type;

/** The settings a select chooses; each value arrives as the option's text. */
export const ChoiceSettingKey = Schema.Literals([
  "sendShortcut",
  "followUpBehavior",
  "timestampFormat",
  "theme",
  "fontSizeInterface",
  "fontSizePrompt",
  "fontSizeCode",
  "chatWidth",
  "diffLayout",
]);

export type ChoiceSettingKey = typeof ChoiceSettingKey.Type;

const decodeSendShortcut = Schema.decodeUnknownOption(SendShortcut);

const decodeFollowUp = Schema.decodeUnknownOption(FollowUpBehavior);

const decodeTimestampFormat = Schema.decodeUnknownOption(TimestampFormat);

const decodeTheme = Schema.decodeUnknownOption(Theme);

const decodeChatWidth = Schema.decodeUnknownOption(ChatWidth);

const decodeDiffLayout = Schema.decodeUnknownOption(DiffLayout);

const sizeFromText = <S extends Schema.Codec<number, number>>(size: S) =>
  Schema.decodeUnknownOption(
    Schema.FiniteFromString.pipe(Schema.decodeTo(size))
  );

const decodeInterfaceSize = sizeFromText(InterfaceFontSize);

const decodePromptSize = sizeFromText(PromptFontSize);

const decodeCodeSize = sizeFromText(CodeFontSize);

/** The settings with `key` set to the chosen `value`, or none when the value is not one of its options. */
export const chooseSetting = (
  settings: ClientSettings,
  key: ChoiceSettingKey,
  value: string
): Option.Option<ClientSettings> => {
  const set = <K extends ChoiceSettingKey>(
    field: K,
    decoded: Option.Option<ClientSettings[K]>
  ): Option.Option<ClientSettings> =>
    Option.map(decoded, (next): ClientSettings => ({
      ...settings,
      [field]: next,
    }));

  return Match.value(key).pipe(
    Match.when("sendShortcut", (field) =>
      set(field, decodeSendShortcut(value))
    ),
    Match.when("followUpBehavior", (field) =>
      set(field, decodeFollowUp(value))
    ),
    Match.when("timestampFormat", (field) =>
      set(field, decodeTimestampFormat(value))
    ),
    Match.when("theme", (field) => set(field, decodeTheme(value))),
    Match.when("fontSizeInterface", (field) =>
      set(field, decodeInterfaceSize(value))
    ),
    Match.when("fontSizePrompt", (field) =>
      set(field, decodePromptSize(value))
    ),
    Match.when("fontSizeCode", (field) => set(field, decodeCodeSize(value))),
    Match.when("chatWidth", (field) => set(field, decodeChatWidth(value))),
    Match.when("diffLayout", (field) => set(field, decodeDiffLayout(value))),
    Match.exhaustive
  );
};

/** The settings with the switch `key` set. */
export const toggleSetting = (
  settings: ClientSettings,
  key: BooleanSettingKey,
  isChecked: boolean
): ClientSettings => ({ ...settings, [key]: isChecked });

/** Whether the page should be dark, given the device's preference. */
export const isDark = (theme: Theme, prefersDark: boolean): boolean =>
  theme === "dark" || (theme === "system" && prefersDark);

/** Writes the appearance settings onto the document, as `index.html` starts them. */
export const applyClientSettings = (
  settings: ClientSettings
): Effect.Effect<void> =>
  Effect.sync(() => {
    const root = document.documentElement;

    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;

    root.classList.toggle("dark", isDark(settings.theme, prefersDark));
    root.style.fontSize = `${settings.fontSizeInterface}px`;
    root.style.setProperty(
      "--font-size-prompt",
      `${settings.fontSizePrompt}px`
    );
    root.style.setProperty("--font-size-code", `${settings.fontSizeCode}px`);
    root.style.setProperty("--diffs-font-size", `${settings.fontSizeCode}px`);
    root.dataset.chatWidth = settings.chatWidth;
  });
