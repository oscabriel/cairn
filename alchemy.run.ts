import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

// The one Stack. It owns every Cloudflare resource; the brain on the Beelink is not an Alchemy resource.
export default Alchemy.Stack(
  "Cairn",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    return {};
  })
);
