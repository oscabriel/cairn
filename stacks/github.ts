import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import { Effect, Layer, Redacted } from "effect";

const owner = "oscabriel";

const repository = "cairn";

// Credentials as code for GitHub Actions (ADR 0051): the one Stack beside `alchemy.run.ts`. Deploy it
// through `ops/wizards/phase-3.sh` stage 2, under the `admin` profile, which can mint tokens:
//   pnpm exec alchemy deploy --config stacks/github.ts --profile admin
// CI's only job is building the stone base image and pushing it to registry.cloudflare.com, which
// needs registry credentials and nothing else, so the token holds Workers Containers Write alone.
// No workflow runs Alchemy; one that does gets a token of its own, minted then.
export default Alchemy.Stack(
  "CairnGitHub",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const token = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {
      name: "cairn-ci",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: ["Workers Containers Write"],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });

    yield* GitHub.Secret("CloudflareApiToken", {
      owner,
      repository,
      name: "CLOUDFLARE_API_TOKEN",
      value: token.value,
    });

    yield* GitHub.Secret("CloudflareAccountId", {
      owner,
      repository,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: Redacted.make(accountId),
    });

    return {};
  })
);
