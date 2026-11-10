// Judges the browser driver against a real headless Chromium: what a locator waits for and refuses,
// what a click checks first, real key events, touch, routes, socket routes, init scripts and
// screenshots, on small pages served from loopback. Each broken control turns one of the driver's
// promises off and shows the test of that promise would fail: auto-waiting and strictness are what
// every browser judge stands on. Page code is text, as the judges' plants are, because it reads
// globals no module type describes.

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { Predicate } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testLimit } from "../../apps/server/src/EventuallyTestKit.ts";
import { chromium, IPHONE_15, TimeoutError } from "./Browser.ts";
import type { Browser, BrowserContext, Page } from "./Browser.ts";

const SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const BLANK_PAGE =
  '<!doctype html><title>t</title><meta name="viewport" content="width=device-width"><body>ok</body>';

/** A one-frame text echo: enough of RFC 6455 to judge frames crossing a real socket. */
const echoFrame = (text: string): Buffer => {
  const body = Buffer.from(`echo ${text}`);

  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
};

const unmask = (frame: Buffer): string => {
  const length = (frame[1] ?? 0) % 128;
  const mask = frame.subarray(2, 6);
  const body = frame.subarray(6, 6 + length);

  const unmasked = body.map(
    // oxlint-disable-next-line no-bitwise -- RFC 6455 masks a frame's body by XOR
    (byte, index) => byte ^ (mask[index % 4] ?? 0)
  );

  return Buffer.from(unmasked).toString();
};

const startServer = async (): Promise<{ server: Server; origin: string }> => {
  const answers = new Map([
    ["/slow", { delay: 700, type: "text/html", body: "<p id=late>late</p>" }],
    ["/held", { delay: 800, type: "text/plain", body: "held" }],
    ["/fetched", { delay: 0, type: "text/plain", body: "from the network" }],
  ]);

  const server = createServer((request, response) => {
    const answer = answers.get(request.url ?? "") ?? {
      delay: 0,
      type: "text/html",
      body: BLANK_PAGE,
    };

    setTimeout(() => {
      response.setHeader("content-type", answer.type);
      response.end(answer.body);
    }, answer.delay);
  });

  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"] ?? ""}${SOCKET_GUID}`)
      .digest("base64");

    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.on("data", (frame: Buffer) => {
      if (frame[0] === 0x81) {
        socket.write(echoFrame(unmask(frame)));
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (address === null || Predicate.isString(address)) {
    throw new Error("the test server has no port");
  }

  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
};

const titleOf = async (page: Page): Promise<string> =>
  await page.evaluate(() => document.title);

// The driver's whole API on one browser: one launch costs about a second.
describe("browser driver", () => {
  let browser: Browser;

  let server: Server;

  let origin: string;

  beforeAll(async () => {
    ({ server, origin } = await startServer());
    browser = await chromium.launch();
  }, testLimit(30_000));

  afterAll(async () => {
    await browser.close();
    server.close();
    server.closeAllConnections();
  });

  /** A fresh page on a real origin, holding `html`. */
  const pageWith = async (
    html: string,
    on: Browser = browser
  ): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await on.newContext();
    const page = await context.newPage();

    await page.goto(origin);
    await page.evaluate((body) => {
      document.body.innerHTML = body;
    }, html);

    return { context, page };
  };

  /** What a click on one of two matches comes to: the refusal, or the element it took. */
  const clickOneOfTwo = async (on: Browser): Promise<string> => {
    const { context, page } = await pageWith(
      `<button onclick="document.title='first'">a</button><button onclick="document.title='second'">b</button>`,
      on
    );

    try {
      await page.locator("button").click({ timeout: testLimit(2000) });

      return await titleOf(page);
    } catch (error) {
      return error instanceof Error ? error.message : "not an error";
    } finally {
      await context.close();
    }
  };

  /** What a click on an element that arrives 300 ms later comes to. */
  const clickArrivingLater = async (on: Browser): Promise<string> => {
    const { context, page } = await pageWith("<p>empty</p>", on);

    await page.evaluate(() => {
      setTimeout(() => {
        document.body.innerHTML = `<button onclick="document.title='clicked'">late</button>`;
      }, 300);
    });

    try {
      await page.locator("button").click({ timeout: testLimit(2000) });

      return await titleOf(page);
    } catch (error) {
      return error instanceof TimeoutError ? "timed out" : "another error";
    } finally {
      await context.close();
    }
  };

  describe("locators", () => {
    it("refuses to act on one of several matches", async () => {
      await expect(clickOneOfTwo(browser)).resolves.toMatch(
        /strict mode violation.*2 elements/su
      );
    });

    it(
      "broken control: without strictness the same click goes through",
      async () => {
        const broken = await chromium.launch({ control: "no-strict" });

        try {
          await expect(clickOneOfTwo(broken)).resolves.toBe("first");
        } finally {
          await broken.close();
        }
      },
      testLimit(30_000)
    );

    it("waits for an element that is not there yet", async () => {
      await expect(clickArrivingLater(browser)).resolves.toBe("clicked");
    });

    it(
      "broken control: without auto-waiting the same click gives up",
      async () => {
        const broken = await chromium.launch({ control: "no-auto-wait" });

        try {
          await expect(clickArrivingLater(broken)).resolves.toBe("timed out");
        } finally {
          await broken.close();
        }
      },
      testLimit(30_000)
    );

    it("chains, filters and counts as a judge's locators do", async () => {
      const { context, page } = await pageWith(`
      <ul data-testid="list">
        <li data-testid="row">Alpha  one</li>
        <li data-testid="row">beta two</li>
        <li data-testid="row" style="display:none">gamma</li>
      </ul>
      <li data-testid="row">outside</li>`);

      const rows = page.getByTestId("list").getByTestId("row");

      await expect(rows.count()).resolves.toBe(3);
      await expect(rows.filter({ hasText: "alpha ONE" }).count()).resolves.toBe(
        1
      );
      await expect(rows.filter({ hasText: /^beta/u }).count()).resolves.toBe(1);
      await expect(rows.filter({ visible: true }).count()).resolves.toBe(2);
      await context.close();
    });

    it("reads the first, last and nth of a chain", async () => {
      const { context, page } = await pageWith(`
      <ul data-testid="list">
        <li data-testid="row">Alpha  one</li>
        <li data-testid="row">beta two</li>
        <li data-testid="row" style="display:none">gamma</li>
      </ul>`);

      const rows = page.getByTestId("list").getByTestId("row");

      await expect(rows.first().textContent()).resolves.toBe("Alpha  one");
      await expect(rows.last().isVisible()).resolves.toBeFalsy();
      await expect(rows.nth(1).textContent()).resolves.toBe("beta two");
      await expect(rows.allTextContents()).resolves.toStrictEqual([
        "Alpha  one",
        "beta two",
        "gamma",
      ]);
      await context.close();
    });

    it("reads every match of a chain as it stands", async () => {
      const { context, page } = await pageWith(`
      <ul data-testid="list">
        <li data-testid="row">one</li>
        <li data-testid="row">two</li>
        <li data-testid="row">three</li>
      </ul>
      <li>outside</li>`);

      const rows = page.getByTestId("list").getByTestId("row");

      await expect(rows.all()).resolves.toHaveLength(3);
      await expect(
        rows.evaluateAll((elements) =>
          elements.map((element) => element.tagName)
        )
      ).resolves.toStrictEqual(["LI", "LI", "LI"]);
      await expect(
        page.locator("li", { hasText: "outside" }).count()
      ).resolves.toBe(1);
      await context.close();
    });

    it("finds by role and accessible name, and skips what is hidden", async () => {
      const { context, page } = await pageWith(`
      <button aria-label="Toggle main sidebar"><svg></svg></button>
      <button>Open <span>diff</span></button>
      <button aria-hidden="true">Open hidden</button>
      <button style="display:none">Open none</button>
      <div role="button">myr project</div>
      <label for="s">Follow-up behaviour</label>
      <select id="s"><option value="queue">Queue</option><option value="steer">Steer</option></select>
      <ul role="listbox"><li role="option">exact name</li><li role="option">exact name too</li></ul>`);

      const buttons = async (name: string | RegExp): Promise<number> =>
        await page.getByRole("button", { name }).count();

      await expect(buttons("toggle main")).resolves.toBe(1);
      await expect(buttons("Open diff")).resolves.toBe(1);
      await expect(buttons(/^Open/u)).resolves.toBe(1);
      await expect(buttons(/^myr/u)).resolves.toBe(1);
      await expect(
        page.getByRole("option", { name: "exact name", exact: true }).count()
      ).resolves.toBe(1);

      await context.close();
    });

    it("selects an option of a combobox found by its label", async () => {
      const { context, page } = await pageWith(`
      <label for="s">Follow-up behaviour</label>
      <select id="s"><option value="queue">Queue</option><option value="steer">Steer</option></select>`);

      const select = page.getByRole("combobox", {
        name: "Follow-up behaviour",
      });

      await select.selectOption("steer");
      await expect(select.inputValue()).resolves.toBe("steer");
      await context.close();
    });

    it("takes the smallest element for a text, by regular expression too", async () => {
      const { context, page } = await pageWith(
        `<div><section><span>Pinned</span></section><p>Noted. And more</p></div>`
      );

      await expect(
        page
          .getByText(/^(?:Active|Pinned)$/u)
          .evaluate((element) => element.tagName)
      ).resolves.toBe("SPAN");
      await expect(
        page.getByText("noted.").evaluate((element) => element.tagName)
      ).resolves.toBe("P");
      await context.close();
    });

    it("waits for each state", async () => {
      const { context, page } = await pageWith(
        `<p id="p" style="display:none">x</p>`
      );

      const paragraph = page.locator("#p");

      await expect(
        paragraph.waitFor({ state: "attached", timeout: testLimit(2000) })
      ).resolves.toBeUndefined();
      await expect(
        paragraph.waitFor({ state: "hidden", timeout: testLimit(2000) })
      ).resolves.toBeUndefined();
      await expect(
        paragraph.waitFor({ state: "visible", timeout: 200 })
      ).rejects.toBeInstanceOf(TimeoutError);
      await page.evaluate(() => {
        setTimeout(() => {
          document.querySelector("#p")?.remove();
        }, 100);
      });
      await expect(
        paragraph.waitFor({ state: "detached", timeout: testLimit(2000) })
      ).resolves.toBeUndefined();
      await context.close();
    });

    it("evaluate runs in the page on the one match", async () => {
      const { context, page } = await pageWith(`<p title="7">x</p>`);

      const paragraph = page.locator("p");

      await expect(
        paragraph.evaluate((element, add) => element.tagName.length + add, 1)
      ).resolves.toBe(2);
      await expect(paragraph.getAttribute("title")).resolves.toBe("7");
      await expect(paragraph.boundingBox()).resolves.toMatchObject({ x: 8 });
      await context.close();
    });
  });

  describe("actions", () => {
    it("does not click what another element covers, and clicks once it is uncovered", async () => {
      const { context, page } = await pageWith(`
      <button onclick="document.title='hit'" style="position:fixed;left:0;top:0;width:100px;height:40px">b</button>
      <div id="cover" style="position:fixed;left:0;top:0;width:200px;height:200px"></div>`);

      await expect(
        page.locator("button").click({ timeout: 300 })
      ).rejects.toBeInstanceOf(TimeoutError);
      await page.evaluate(() => {
        document.querySelector("#cover")?.remove();
      });
      await page.locator("button").click({ timeout: testLimit(2000) });
      await expect(titleOf(page)).resolves.toBe("hit");
      await context.close();
    });

    it("does not click a disabled button or one still moving", async () => {
      const { context, page } = await pageWith(
        `<button disabled onclick="document.title='hit'">b</button>`
      );

      await expect(
        page.locator("button").click({ timeout: 300 })
      ).rejects.toBeInstanceOf(TimeoutError);
      await page.evaluate(`(() => {
      const button = document.querySelector("button");
      let left = 0;
      const move = () => {
        left += 5;
        button.style.left = left + "px";
        if (left < 5000) requestAnimationFrame(move);
      };

      button.disabled = false;
      button.style.position = "fixed";
      move();
    })()`);
      await expect(
        page.locator("button").click({ timeout: 300 })
      ).rejects.toBeInstanceOf(TimeoutError);
      await expect(titleOf(page)).resolves.toBe("t");
      await context.close();
    });

    it("returns from a click once the frame it caused is drawn", async () => {
      const { context, page } = await pageWith(
        `<button onclick="requestAnimationFrame(() => { document.title = 'drawn'; })">b</button>`
      );

      await page.locator("button").click();
      await expect(titleOf(page)).resolves.toBe("drawn");
      await context.close();
    });

    it("scrolls an element into view before clicking it", async () => {
      const { context, page } = await pageWith(
        `<div style="height:3000px"></div><button onclick="document.title='far'">far</button>`
      );

      await page.locator("button").click();
      await expect(titleOf(page)).resolves.toBe("far");
      await context.close();
    });

    it("types real key events and fills in one insertion", async () => {
      const { context, page } = await pageWith(
        `<textarea data-testid="t"></textarea>`
      );

      await page.evaluate(`(() => {
      globalThis.seen = [];
      document.querySelector("textarea").addEventListener("keydown", (event) => {
        globalThis.seen.push(event.code + ":" + event.key + ":" + event.ctrlKey);
      });
    })()`);

      const area = page.getByTestId("t");

      await area.click();
      await page.keyboard.type("aB/日");
      await page.keyboard.press("Enter");
      await expect(area.inputValue()).resolves.toBe("aB/日\n");

      await page.keyboard.press("Control+j");

      await expect(page.evaluate("globalThis.seen")).resolves.toStrictEqual([
        "KeyA:a:false",
        "KeyB:B:false",
        "Slash:/:false",
        "Enter:Enter:false",
        "ControlLeft:Control:true",
        "KeyJ:j:true",
      ]);

      await area.fill("replaced");
      await expect(area.inputValue()).resolves.toBe("replaced");
      await area.fill("");
      await expect(area.inputValue()).resolves.toBe("");
      await context.close();
    });

    it("scrolls with the wheel where the mouse is", async () => {
      const { context, page } = await pageWith(
        `<div id="s" style="height:200px;width:200px;overflow:auto"><div style="height:2000px"></div></div>`
      );

      await page.mouse.move(50, 50);
      await page.mouse.wheel(0, 300);

      const moved = await page.waitForFunction(
        () => document.querySelector("#s")?.scrollTop ?? 0,
        undefined,
        { timeout: testLimit(3000) }
      );

      await expect(moved.jsonValue()).resolves.toBeGreaterThan(0);
      await context.close();
    });

    it("taps with touch events on a touch context, and refuses without one", async () => {
      const context = await browser.newContext({
        ...IPHONE_15,
        viewport: { width: 390, height: 844 },
      });

      const page = await context.newPage();

      await page.goto(origin);
      await page.evaluate(`(() => {
      document.body.innerHTML = '<button style="width:200px;height:80px">b</button>';
      globalThis.touches = 0;
      globalThis.clicks = 0;

      const button = document.querySelector("button");

      button.addEventListener("touchstart", () => { globalThis.touches += 1; });
      button.addEventListener("click", () => { globalThis.clicks += 1; });
    })()`);

      await page.locator("button").tap();
      await page.waitForFunction("globalThis.clicks === 1", undefined, {
        timeout: testLimit(3000),
      });
      await expect(
        page.evaluate(
          "[innerWidth, navigator.maxTouchPoints > 0, globalThis.touches]"
        )
      ).resolves.toStrictEqual([390, true, 1]);
      await context.close();

      const desktop = await pageWith("<button>b</button>");

      await expect(desktop.page.locator("button").tap()).rejects.toThrow(
        /does not support tap/u
      );
      await desktop.context.close();
    });
  });

  describe("pages", () => {
    it("evaluate returns the page function's result", async () => {
      const { context, page } = await pageWith("<p>x</p>");

      await expect(page.evaluate(() => 1 + 1)).resolves.toBe(2);
      await expect(page.evaluate((text) => text.length, "abc")).resolves.toBe(
        3
      );
      await expect(page.evaluate("6 * 7")).resolves.toBe(42);
      await expect(page.evaluate(() => null)).resolves.toBeNull();
      await expect(
        page.evaluate(() => {
          throw new Error("from the page");
        })
      ).rejects.toThrow(/from the page/u);
      await context.close();
    });

    it("waitForFunction resolves to the page's truthy value", async () => {
      const { context, page } = await pageWith("<p>x</p>");

      await page.evaluate(`setTimeout(() => { globalThis.ready = 41; }, 50)`);

      const handle = await page.waitForFunction(
        "globalThis.ready ?? false",
        undefined,
        { timeout: testLimit(2000), polling: 16 }
      );

      await expect(handle.jsonValue()).resolves.toBe(41);
      await expect(
        page.waitForFunction("false", undefined, { timeout: 100 })
      ).rejects.toBeInstanceOf(TimeoutError);
      await context.close();
    });

    it(
      "goto waits for the state it was asked for, and fails on a net error",
      async () => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(`${origin}/slow`, { waitUntil: "commit" });
        await page
          .locator("#late")
          .waitFor({ state: "attached", timeout: testLimit(5000) });

        await page.goto(origin);
        await page.evaluate(`fetch("/held")`);

        const started = performance.now();

        await page.goto(`${origin}/?idle`, { waitUntil: "networkidle" });
        expect(performance.now() - started).toBeGreaterThanOrEqual(500);

        await expect(
          page.goto("http://127.0.0.1:9/nothing-listens")
        ).rejects.toThrow(/net::ERR_/u);
        await context.close();
      },
      testLimit(20_000)
    );

    it("tracks the URL through history, with globs, regexes and tests", async () => {
      const { context, page } = await pageWith("<p>x</p>");

      await page.evaluate(() => {
        setTimeout(() => {
          history.pushState(null, "", "/t/abc?x=1");
        }, 50);
      });
      await page.waitForURL("**/t/abc*", { timeout: testLimit(2000) });
      await page.waitForURL(/\/t\//u, { timeout: testLimit(2000) });
      await page.waitForURL((url) => url.pathname === "/t/abc", {
        timeout: testLimit(2000),
      });
      expect(page.url()).toBe(`${origin}/t/abc?x=1`);
      await expect(
        page.waitForURL("**/nowhere", { timeout: 50 })
      ).rejects.toBeInstanceOf(TimeoutError);
      await page.reload({ waitUntil: "load" });
      expect(page.url()).toBe(`${origin}/t/abc?x=1`);
      await context.close();
    });

    it("reports page errors, console calls and socket frames", async () => {
      const { context, page } = await pageWith("<p>x</p>");
      const errors: Array<string> = [];
      const logs: Array<string> = [];
      const sent: Array<string | Buffer> = [];
      const received: Array<string | Buffer> = [];
      const loads: Array<string> = [];

      const { promise: answered, resolve: answer } =
        Promise.withResolvers<null>();

      page.on("pageerror", (error) => {
        errors.push(String(error));
      });
      page.on("console", (message) => {
        logs.push(message.text());
      });
      page.on("load", () => {
        loads.push(page.url());
      });
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          sent.push(payload);
        });
        socket.on("framereceived", ({ payload }) => {
          received.push(payload);
          answer(null);
        });
      });
      await page.evaluate(
        (url) => {
          console.log("hello", 2);
          setTimeout(() => {
            throw new TypeError("thrown");
          }, 0);

          const socket = new WebSocket(url);

          socket.addEventListener("open", () => {
            socket.send("ping");
          });
        },
        origin.replace("http", "ws")
      );

      await answered;
      await page.waitForFunction("true");
      await page.waitForTimeout(100);

      expect(errors).toStrictEqual(["TypeError: thrown"]);
      expect(logs).toStrictEqual(["hello 2"]);
      expect(sent).toStrictEqual(["ping"]);
      expect(received).toStrictEqual(["echo ping"]);
      await page.reload();
      expect(loads).toHaveLength(1);
      await context.close();
    });

    it("captures the viewport at the device's scale, with animations settled", async () => {
      const context = await browser.newContext({
        viewport: { width: 200, height: 100 },
        deviceScaleFactor: 2,
      });

      const page = await context.newPage();

      await page.goto(origin);
      await page.evaluate(() => {
        document.body.innerHTML = `<style>@keyframes spin { to { rotate: 360deg } } b { animation: spin 1s linear infinite; display: block; width: 20px; height: 20px; background: red }</style><b></b><textarea autofocus></textarea>`;
      });

      const png = await page.screenshot({
        caret: "hide",
        animations: "disabled",
      });

      expect(png.readUInt32BE(16)).toBe(400);
      expect(png.readUInt32BE(20)).toBe(200);
      await expect(
        page.evaluate(
          () => document.querySelector("b")?.getAnimations()[0]?.playState
        )
      ).resolves.toBe("running");

      await page.evaluate(() => {
        document.body.style.height = "300px";
      });

      const whole = await page.screenshot({ fullPage: true });

      expect(whole.readUInt32BE(20)).toBeGreaterThanOrEqual(600);
      await context.close();
    });
  });

  describe("contexts", () => {
    it("keeps contexts apart and emulates what they ask for", async () => {
      const one = await browser.newContext({
        viewport: { width: 500, height: 400 },
        colorScheme: "dark",
        reducedMotion: "reduce",
        timezoneId: "Asia/Tokyo",
        locale: "de-DE",
        deviceScaleFactor: 2,
      });

      const page = await one.newPage();

      await page.goto(origin);
      await page.evaluate(() => {
        localStorage.setItem("k", "1");
      });
      await expect(
        page.evaluate(() => ({
          width: innerWidth,
          scale: devicePixelRatio,
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
          still: matchMedia("(prefers-reduced-motion: reduce)").matches,
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language: navigator.language,
          hover: matchMedia("(hover: hover)").matches,
        }))
      ).resolves.toStrictEqual({
        width: 500,
        scale: 2,
        dark: true,
        still: true,
        zone: "Asia/Tokyo",
        language: "de-DE",
        hover: true,
      });
      await page.setViewportSize({ width: 320, height: 300 });
      await expect(page.evaluate(() => innerWidth)).resolves.toBe(320);

      const other = await pageWith("<p>x</p>");

      await expect(
        other.page.evaluate(() => localStorage.getItem("k"))
      ).resolves.toBeNull();
      await expect(
        other.page.evaluate(
          () => matchMedia("(prefers-color-scheme: dark)").matches
        )
      ).resolves.toBeFalsy();
      await other.context.close();
      await one.close();
    });

    it("runs init scripts in every document, before its own code", async () => {
      const context = await browser.newContext();

      await context.addInitScript((value) => {
        Object.assign(globalThis, { planted: value });
      }, "yes");
      await context.addInitScript({ content: "globalThis.text = 'too'" });
      await context.clock.setFixedTime("2026-01-02T03:04:05Z");

      const page = await context.newPage();

      await page.goto(origin);
      await page.reload();
      await expect(
        page.evaluate(
          "[globalThis.planted, globalThis.text, new Date().toISOString(), Date.now()]"
        )
      ).resolves.toStrictEqual([
        "yes",
        "too",
        "2026-01-02T03:04:05.000Z",
        Date.parse("2026-01-02T03:04:05Z"),
      ]);
      await context.close();
    });

    it("grants clipboard permissions", async () => {
      const context = await browser.newContext({
        permissions: ["clipboard-read", "clipboard-write"],
      });

      const page = await context.newPage();

      await page.goto(origin);
      await expect(
        page.evaluate(async () => {
          await navigator.clipboard.writeText("copied");

          return await navigator.clipboard.readText();
        })
      ).resolves.toBe("copied");
      await context.close();
    });
  });

  describe("routes", () => {
    it("fulfils, observes and lets requests through", async () => {
      const { context, page } = await pageWith("<p>x</p>");
      const seen: Array<string> = [];

      await page.route("**/answered/**", async (route) => {
        const request = route.request();

        seen.push(
          `${request.headers()["content-type"] ?? ""} ${String(request.postDataBuffer()?.length)}`
        );
        await route.fulfill({ status: 201, json: { from: "route" } });
      });
      await page.route(/\/fetched$/u, async (route) => {
        await route.continue();
      });

      const answered = await page.evaluate(async () => {
        const response = await fetch("/answered/x", {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: new Uint8Array([1, 2, 3]),
        });

        return { status: response.status, text: await response.text() };
      });

      expect(answered).toStrictEqual({ status: 201, text: '{"from":"route"}' });
      expect(seen).toStrictEqual(["image/png 3"]);
      await expect(
        page.evaluate(async () => {
          const response = await fetch("/fetched");

          return await response.text();
        })
      ).resolves.toBe("from the network");
      await context.close();
    });

    it("stands in for a socket, and forwards what a handler leaves alone", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const fromPage: Array<string> = [];

      await page.routeWebSocket(/\/routed$/u, (socket) => {
        socket.onMessage((message) => {
          fromPage.push(message);
          socket.send(`answered ${message}`);
        });
      });
      await page.routeWebSocket(/\/through$/u, (socket) => {
        socket.connectToServer();
      });
      await page.goto(origin);

      const talk = async (route: string): Promise<string> =>
        await page.evaluate(
          `new Promise((resolve) => {
          const socket = new WebSocket(${JSON.stringify(`${origin.replace("http", "ws")}${route}`)});

          socket.addEventListener("message", (event) => resolve(String(event.data)));
          socket.addEventListener("open", () => socket.send("hi"));
        })`
        );

      await expect(talk("/routed")).resolves.toBe("answered hi");
      expect(fromPage).toStrictEqual(["hi"]);
      await expect(talk("/through")).resolves.toBe("echo hi");
      await expect(talk("/unrouted")).resolves.toBe("echo hi");
      await context.close();
    });
  });
});
