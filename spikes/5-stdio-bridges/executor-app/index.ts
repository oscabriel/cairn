import { defineApp, router, toolAnnotations, withApprovals } from "apps";
import { mcpRouter } from "apps/mcp";
import { always } from "apps/operations/approval";
import { headers, provider, serverUrl } from "./provider.ts";

const servers = ["convex", "playwright"] as const;

export default defineApp({ app: { accounts: { bridges: provider } } }, async (ctx) => {
  const account = ctx.app.accounts.bridges;
  const mount = async (name: (typeof servers)[number]) =>
    withApprovals(
      await mcpRouter({
        url: serverUrl(name),
        account,
        headers: headers(account),
        cache: ctx.cache,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      }),
      (tool) => (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined),
    );
  return { tools: router({ convex: await mount("convex"), playwright: await mount("playwright") }) };
});
