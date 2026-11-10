// The browser judges' page side: how a locator finds its elements, what makes an element visible,
// enabled, stable and hit at a point, what a screenshot hides, and the socket a WebSocket route puts
// in the page. Page code, kept as text (as the judges' plants are): it runs in Chromium, where no
// module type describes it and no build step should touch it.
//
// The semantics are ported from github.com/microsoft/playwright,
// packages/injected/src/injectedScript.ts, domUtils.ts, selectorUtils.ts, roleUtils.ts and
// webSocketMock.ts, and packages/playwright-core/src/server/screenshotter.ts, at v1.64.1: text
// matching, visibility, the stability and hit-target checks, a routed socket, and a screenshot's
// animation handling. Reduced to what a judge calls, and rewritten for Cairn.
//
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0; you may not
// use this file except in compliance with the License. A copy is at
// http://www.apache.org/licenses/LICENSE-2.0. Software distributed under the License is distributed
// on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

/**
 * An expression for the page-side driver: the first use on a document builds it, and later uses
 * find it under a symbol the page's own code does not look at.
 */
export const PAGE_DRIVER = String.raw`(function () {
  const KEY = Symbol.for("cairn.browser.page");

  if (globalThis[KEY] !== undefined) {
    return globalThis[KEY];
  }

  const normalize = (text) =>
    text.replace(/[​­]/g, "").trim().replace(/\s+/g, " ");

  const skippedForText = (element) =>
    element.nodeName === "SCRIPT" ||
    element.nodeName === "NOSCRIPT" ||
    element.nodeName === "STYLE" ||
    (document.head !== null && document.head.contains(element));

  const textOf = (cache, root) => {
    const known = cache.get(root);

    if (known !== undefined) {
      return known;
    }

    const value = { full: "", normalized: "" };

    if (!skippedForText(root)) {
      if (root instanceof HTMLInputElement && ["submit", "button", "reset"].includes(root.type)) {
        value.full = root.value;
      } else {
        for (let child = root.firstChild; child !== null; child = child.nextSibling) {
          if (child.nodeType === Node.TEXT_NODE) {
            value.full += child.nodeValue ?? "";
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            value.full += textOf(cache, child).full;
          }
        }
      }

      value.normalized = normalize(value.full);
    }

    cache.set(root, value);

    return value;
  };

  const textMatcher = (matcher) => {
    if (matcher.regex !== undefined) {
      const regex = new RegExp(matcher.regex.source, matcher.regex.flags);

      return (text) => {
        regex.lastIndex = 0;

        return regex.test(text.full);
      };
    }

    const wanted = normalize(matcher.text);

    if (matcher.exact === true) {
      return (text) => text.normalized === wanted;
    }

    const lowered = wanted.toLowerCase();

    return (text) => text.normalized.toLowerCase().includes(lowered);
  };

  const visibleTextNode = (node) => {
    const range = document.createRange();

    range.selectNode(node);

    const rect = range.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0;
  };

  const isVisible = (element) => {
    const style = getComputedStyle(element);

    if (style.display === "contents") {
      for (let child = element.firstChild; child !== null; child = child.nextSibling) {
        if (child.nodeType === Node.ELEMENT_NODE && isVisible(child)) {
          return true;
        }

        if (child.nodeType === Node.TEXT_NODE && visibleTextNode(child)) {
          return true;
        }
      }

      return false;
    }

    if (!element.checkVisibility() || style.visibility !== "visible") {
      return false;
    }

    const rect = element.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0;
  };

  const hiddenForAria = (element) =>
    element.closest('[aria-hidden="true"]') !== null ||
    !element.checkVisibility() ||
    getComputedStyle(element).visibility !== "visible";

  const ROLE_SELECTORS = {
    button: 'button, input, [role="button"]',
    option: 'option, [role="option"]',
    combobox: 'select, input[list], [role="combobox"]',
  };

  const roleOf = (element) => {
    const explicit = element.getAttribute("role");

    if (explicit !== null && explicit.trim() !== "") {
      return explicit.trim().split(/\s+/)[0];
    }

    switch (element.nodeName) {
      case "BUTTON":
        return "button";
      case "OPTION":
        return "option";
      case "SELECT":
        return element.multiple || element.size > 1 ? "listbox" : "combobox";
      case "INPUT":
        if (["button", "submit", "reset", "image"].includes(element.type)) {
          return "button";
        }

        return element.hasAttribute("list") ? "combobox" : "textbox";
      default:
        return "";
    }
  };

  const nameFromContent = (element) => {
    let name = "";

    for (let child = element.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        name += child.nodeValue ?? "";
      } else if (child.nodeType === Node.ELEMENT_NODE && !hiddenForAria(child)) {
        const part = accessibleName(child);
        const inline = getComputedStyle(child).display.startsWith("inline");

        name += inline ? part : " " + part + " ";
      }
    }

    return name;
  };

  const accessibleName = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");

    if (labelledBy !== null) {
      const named = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((label) => label !== null)
        .map((label) => nameFromContent(label))
        .join(" ");

      if (normalize(named) !== "") {
        return named;
      }
    }

    const label = element.getAttribute("aria-label");

    if (label !== null && label.trim() !== "") {
      return label;
    }

    if ("labels" in element && element.labels !== null && element.labels.length > 0) {
      return [...element.labels].map((each) => nameFromContent(each)).join(" ");
    }

    if (element.nodeName === "IMG" && element.hasAttribute("alt")) {
      return element.getAttribute("alt");
    }

    if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
      return element.value;
    }

    const content = nameFromContent(element);

    return normalize(content) === "" ? (element.getAttribute("title") ?? "") : content;
  };

  const nameMatcher = (matcher) => {
    if (matcher.regex !== undefined) {
      const regex = new RegExp(matcher.regex.source, matcher.regex.flags);

      return (name) => {
        regex.lastIndex = 0;

        return regex.test(name);
      };
    }

    const wanted = normalize(matcher.text);

    if (matcher.exact === true) {
      return (name) => name === wanted;
    }

    const lowered = wanted.toLowerCase();

    return (name) => name.toLowerCase().includes(lowered);
  };

  const unique = (elements) => [...new Set(elements)];

  const select = (scopes, selector) =>
    unique(scopes.flatMap((scope) => [...scope.querySelectorAll(selector)]));

  const query = (steps) => {
    const cache = new Map();
    let found = [document];

    for (const step of steps) {
      switch (step.kind) {
        case "css":
          found = select(found, step.selector);
          break;
        case "testId":
          found = select(found, "[data-testid=" + JSON.stringify(step.id) + "]");
          break;
        case "role": {
          const named = step.name === undefined ? undefined : nameMatcher(step.name);

          found = select(found, ROLE_SELECTORS[step.role]).filter(
            (element) =>
              roleOf(element) === step.role &&
              !hiddenForAria(element) &&
              (named === undefined || named(normalize(accessibleName(element))))
          );
          break;
        }
        case "text": {
          const matches = textMatcher(step.text);

          found = select(found, "*").filter(
            (element) =>
              !skippedForText(element) &&
              matches(textOf(cache, element)) &&
              ![...element.children].some((child) => matches(textOf(cache, child)))
          );
          break;
        }
        case "hasText": {
          const matches = textMatcher(step.text);

          found = found.filter((element) => matches(textOf(cache, element)));
          break;
        }
        case "visible":
          found = found.filter((element) => isVisible(element) === step.visible);
          break;
        case "nth": {
          const element = step.index < 0 ? found.at(step.index) : found[step.index];

          found = element === undefined ? [] : [element];
          break;
        }
        default:
          throw new Error("Unknown locator step: " + step.kind);
      }
    }

    return found;
  };

  const preview = (element) => {
    const clone = element.cloneNode(false);

    return (clone.outerHTML ?? element.nodeName).slice(0, 160);
  };

  const one = (steps) => {
    const found = query(steps);

    if (found.length === 0) {
      return { kind: "none" };
    }

    if (found.length > 1) {
      return { kind: "strict", count: found.length, previews: found.slice(0, 5).map(preview) };
    }

    return { kind: "done", value: found[0] };
  };

  const retarget = (element, behaviour) => {
    let target = element;

    if (behaviour === "none") {
      return target;
    }

    if (!target.matches("input, textarea, select") && !target.isContentEditable) {
      target =
        behaviour === "button-link"
          ? (target.closest("button, [role=button], a, [role=link]") ?? target)
          : (target.closest("button, [role=button], [role=checkbox], [role=radio]") ?? target);
    }

    if (behaviour === "follow-label") {
      if (
        !target.matches("a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]") &&
        !target.isContentEditable
      ) {
        const label = target.closest("label");

        if (label !== null && label.control !== null) {
          target = label.control;
        }
      }
    }

    return target;
  };

  const isDisabled = (element) =>
    element.matches(":disabled") || element.closest('[aria-disabled="true"]') !== null;

  const isReadOnly = (element) =>
    element.readOnly === true || element.getAttribute("aria-readonly") === "true";

  const stable = (element) =>
    new Promise((resolve) => {
      let last;
      let same = 0;

      const check = () => {
        if (!element.isConnected) {
          resolve(false);

          return;
        }

        const rect = retarget(element, "no-follow-label").getBoundingClientRect();

        if (
          last !== undefined &&
          (rect.top !== last.top ||
            rect.left !== last.left ||
            rect.width !== last.width ||
            rect.height !== last.height)
        ) {
          resolve(false);

          return;
        }

        if (last !== undefined) {
          same += 1;
        }

        if (same >= 1) {
          resolve(true);

          return;
        }

        last = rect;
        requestAnimationFrame(check);
      };

      requestAnimationFrame(check);
    });

  const clickablePoint = (element, position) => {
    if (position !== undefined) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return {
        x: rect.left + parseFloat(style.borderLeftWidth) + position.x,
        y: rect.top + parseFloat(style.borderTopWidth) + position.y,
      };
    }

    for (const rect of element.getClientRects()) {
      const left = Math.max(rect.left, 0);
      const top = Math.max(rect.top, 0);
      const right = Math.min(rect.right, innerWidth);
      const bottom = Math.min(rect.bottom, innerHeight);

      if ((right - left) * (bottom - top) > 0.99) {
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      }
    }

    return undefined;
  };

  const composedParent = (element) => {
    if (element.assignedSlot) {
      return element.assignedSlot;
    }

    if (element.parentElement !== null) {
      return element.parentElement;
    }

    const root = element.getRootNode();

    return root instanceof ShadowRoot ? root.host : null;
  };

  const hitsTarget = (point, target) => {
    let hit = document.elementFromPoint(point.x, point.y);
    const first = hit;

    while (hit !== null && hit !== target) {
      hit = composedParent(hit);
    }

    return hit === target ? undefined : (first === null ? "nothing" : preview(first));
  };

  const SCROLLS = [
    undefined,
    undefined,
    { block: "end", inline: "end" },
    { block: "center", inline: "center" },
    { block: "start", inline: "start" },
  ];

  const scrollInto = (element, attempt) => {
    const scroll = SCROLLS[attempt % SCROLLS.length];

    if (scroll === undefined) {
      element.scrollIntoViewIfNeeded(true);
    } else {
      element.scrollIntoView({ ...scroll, behavior: "instant" });
    }
  };

  const selectOption = (element, value) => {
    const option = [...element.options].find(
      (each) => each.value === value || normalize(each.label) === normalize(value)
    );

    if (option === undefined) {
      return { kind: "retry", reason: "no option is " + value };
    }

    if (option.disabled) {
      return { kind: "retry", reason: "the option is disabled" };
    }

    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));

    return { kind: "done", value: null };
  };

  const FILLABLE = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);

  const selectForFill = (element) => {
    if (element.nodeName === "INPUT") {
      if (!FILLABLE.has(element.type.toLowerCase())) {
        throw new Error("Input of type " + element.type + " cannot be filled");
      }

      element.select();
      element.focus();

      return;
    }

    if (element.nodeName === "TEXTAREA") {
      element.selectionStart = 0;
      element.selectionEnd = element.value.length;
      element.focus();

      return;
    }

    if (!element.isContentEditable) {
      throw new Error("Element is not an <input>, <textarea> or [contenteditable] element");
    }

    element.focus();

    const range = document.createRange();

    range.selectNodeContents(element);

    const selection = getSelection();

    selection.removeAllRanges();
    selection.addRange(range);
  };

  const box = (element) => {
    if (element.getClientRects().length === 0) {
      return null;
    }

    const { x, y, width, height } = element.getBoundingClientRect();

    return { x, y, width, height };
  };

  const READERS = {
    text: (element) => element.textContent,
    attribute: (element, name) => element.getAttribute(name),
    inputValue: (element) => {
      if (!["INPUT", "TEXTAREA", "SELECT"].includes(element.nodeName)) {
        throw new Error("Node is not an <input>, <textarea> or <select> element");
      }

      return element.value;
    },
    box,
    focus: (element) => {
      element.focus();

      return null;
    },
    click: (element) => {
      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, composed: true })
      );

      return null;
    },
  };

  const driver = {
    one,
    all: query,
    count: (steps) => query(steps).length,
    texts: (steps) => query(steps).map((element) => element.textContent ?? ""),
    innerTexts: (steps) => query(steps).map((element) => element.innerText ?? ""),
    fullPageSize: () => {
      const { body, documentElement: root } = document;

      return {
        width: Math.max(body.scrollWidth, root.scrollWidth, body.offsetWidth, root.offsetWidth, body.clientWidth, root.clientWidth),
        height: Math.max(body.scrollHeight, root.scrollHeight, body.offsetHeight, root.offsetHeight, body.clientHeight, root.clientHeight),
      };
    },
    isVisible: (steps) => {
      const found = one(steps);

      if (found.kind === "strict") {
        return found;
      }

      return { kind: "done", value: found.kind === "done" && isVisible(found.value) };
    },
    state: (steps, state, strict) => {
      const found = query(steps);

      if (strict && found.length > 1) {
        return { kind: "strict", count: found.length, previews: found.slice(0, 5).map(preview) };
      }

      const element = found[0];
      const met = {
        attached: element !== undefined,
        detached: element === undefined,
        visible: element !== undefined && isVisible(element),
        hidden: element === undefined || !isVisible(element),
      }[state];

      return met ? { kind: "done", value: null } : { kind: "retry", reason: "not " + state };
    },
    read: (steps, what, argument) => {
      const found = one(steps);

      return found.kind === "done"
        ? { kind: "done", value: READERS[what](found.value, argument) }
        : found;
    },
    scrollIntoView: async (steps) => {
      const found = one(steps);

      if (found.kind !== "done") {
        return found;
      }

      if (!(await stable(found.value))) {
        return { kind: "retry", reason: "not stable" };
      }

      found.value.scrollIntoViewIfNeeded(true);

      return { kind: "done", value: null };
    },
    pointer: async (steps, position, attempt) => {
      const found = one(steps);

      if (found.kind !== "done") {
        return found;
      }

      const element = found.value;

      if (!(await stable(element))) {
        return { kind: "retry", reason: "not stable" };
      }

      if (!isVisible(element)) {
        return { kind: "retry", reason: "not visible" };
      }

      if (isDisabled(retarget(element, "follow-label"))) {
        return { kind: "retry", reason: "not enabled" };
      }

      scrollInto(element, attempt);

      const point = clickablePoint(element, position);

      if (point === undefined) {
        return { kind: "retry", reason: "outside the viewport" };
      }

      const rounded = {
        x: Math.round(point.x * 100) / 100,
        y: Math.round(point.y * 100) / 100,
      };

      const intercepted = hitsTarget(rounded, retarget(element, "button-link"));

      return intercepted === undefined
        ? { kind: "done", value: rounded }
        : { kind: "retry", reason: intercepted + " intercepts pointer events" };
    },
    prepareFill: (steps) => {
      const found = one(steps);

      if (found.kind !== "done") {
        return found;
      }

      const element = retarget(found.value, "follow-label");

      if (!isVisible(found.value)) {
        return { kind: "retry", reason: "not visible" };
      }

      if (isDisabled(element) || isReadOnly(element)) {
        return { kind: "retry", reason: "not editable" };
      }

      selectForFill(element);

      return { kind: "done", value: null };
    },
    selectOption: (steps, value) => {
      const found = one(steps);

      if (found.kind !== "done") {
        return found;
      }

      const element = retarget(found.value, "follow-label");

      if (!isVisible(found.value)) {
        return { kind: "retry", reason: "not visible" };
      }

      if (isDisabled(element)) {
        return { kind: "retry", reason: "not enabled" };
      }

      if (element.nodeName !== "SELECT") {
        throw new Error("Element is not a <select> element");
      }

      return selectOption(element, value);
    },
    prepareScreenshot: (disableAnimations) => {
      const cleanups = [];
      const carets = new Map();

      for (const element of document.querySelectorAll("input,textarea,[contenteditable]")) {
        carets.set(element, {
          value: element.style.getPropertyValue("caret-color"),
          priority: element.style.getPropertyPriority("caret-color"),
        });
        element.style.setProperty("caret-color", "transparent", "important");
      }

      cleanups.push(() => {
        for (const [element, caret] of carets) {
          element.style.setProperty("caret-color", caret.value, caret.priority);
        }
      });

      if (disableAnimations) {
        const resume = new Set();

        const settle = () => {
          for (const animation of document.getAnimations()) {
            if (animation.effect === null || animation.playbackRate === 0 || resume.has(animation)) {
              continue;
            }

            if (Number.isFinite(animation.effect.getComputedTiming().endTime)) {
              animation.finish();
            } else {
              animation.cancel();
              resume.add(animation);
            }
          }
        };

        settle();
        document.addEventListener("transitionrun", settle);
        document.addEventListener("animationstart", settle);
        cleanups.push(() => {
          document.removeEventListener("transitionrun", settle);
          document.removeEventListener("animationstart", settle);

          for (const animation of resume) {
            animation.play();
          }
        });
      }

      driver.restoreScreenshot = () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };

      return document.fonts.ready.then(() => null);
    },
  };

  Object.defineProperty(globalThis, KEY, { value: driver });

  return driver;
})()`;

/**
 * The init script a WebSocket route installs: every socket the page opens becomes a stand-in whose
 * frames the judge's handler sees first, and a real socket opens only when the handler connects
 * one, as `ws.connectToServer()` does. Text frames only: the protocol sends nothing else.
 */
export const webSocketRouteScript = (binding: string): string =>
  String.raw`(() => {
  const Native = globalThis.WebSocket;
  const sockets = new Map();
  let next = 1;
  const tell = (message) => globalThis[${JSON.stringify(binding)}](JSON.stringify(message));

  class RoutedWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    readyState = 0;
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    binaryType = "blob";

    constructor(url, protocols) {
      super();
      this.url = new URL(url, location.href).href.replace(/^http/u, "ws");
      this.protocols = protocols;
      this.id = next;
      next += 1;
      sockets.set(this.id, this);
      tell({ kind: "open", id: this.id, url: this.url });
    }

    send(data) {
      if (this.readyState === 0) {
        throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      }

      if (typeof data !== "string") {
        throw new Error("A routed WebSocket carries text frames only");
      }

      if (this.readyState === 1) {
        tell({ kind: "message", id: this.id, data });
      }
    }

    close(code, reason) {
      if (this.readyState >= 2) {
        return;
      }

      this.readyState = 2;

      if (this.real !== undefined) {
        this.real.close(code, reason);
      } else {
        this.closed(code ?? 1000, reason ?? "");
      }
    }

    fire(event) {
      const handler = this["on" + event.type];

      this.dispatchEvent(event);

      if (typeof handler === "function") {
        handler.call(this, event);
      }
    }

    opened(protocol) {
      this.protocol = protocol;
      this.readyState = 1;
      this.fire(new Event("open"));
    }

    closed(code, reason) {
      this.readyState = 3;
      sockets.delete(this.id);
      this.fire(new CloseEvent("close", { code, reason, wasClean: true }));
    }

    connect() {
      const real = new Native(this.url, this.protocols);

      this.real = real;
      real.addEventListener("open", () => {
        this.opened(real.protocol);
      });
      real.addEventListener("message", (event) => {
        tell({ kind: "serverMessage", id: this.id, data: String(event.data) });
      });
      real.addEventListener("error", () => {
        this.fire(new Event("error"));
      });
      real.addEventListener("close", (event) => {
        this.closed(event.code, event.reason);
      });
    }

    toPage(data) {
      if (this.readyState === 1) {
        this.fire(new MessageEvent("message", { data, origin: new URL(this.url).origin }));
      }
    }
  }

  globalThis.WebSocket = RoutedWebSocket;
  Object.defineProperty(globalThis, Symbol.for("cairn.browser.sockets"), {
    value: (id, command, data) => {
      const socket = sockets.get(id);

      if (socket === undefined) {
        return;
      }

      switch (command) {
        case "connect":
          socket.connect();
          break;
        case "open":
          socket.opened("");
          break;
        case "toPage":
          socket.toPage(data);
          break;
        case "toServer":
          socket.real?.send(data);
          break;
        case "close":
          socket.close();
          break;
        default:
          break;
      }
    },
  });
})()`;

/** The expression that hands one command to the page's routed socket `id`. */
export const socketCommand = (
  id: number,
  command: string,
  data: string | undefined
): string =>
  `globalThis[Symbol.for("cairn.browser.sockets")]?.(${String(id)}, ${JSON.stringify(command)}, ${JSON.stringify(data)})`;

/** The init script that freezes `Date` at `at`, while timers keep running on real time. */
export const fixedTimeScript = (at: number): string =>
  String.raw`(() => {
  const Real = Date;
  const at = ${String(at)};

  function Fixed(...args) {
    if (new.target === undefined) {
      return new Real(at).toString();
    }

    return args.length === 0 ? new Real(at) : new Real(...args);
  }

  Fixed.prototype = Real.prototype;
  Fixed.now = () => at;
  Fixed.parse = Real.parse;
  Fixed.UTC = Real.UTC;
  globalThis.Date = Fixed;
})()`;
