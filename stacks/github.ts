import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { Effect, Layer, Redacted } from "effect";

const owner = "oscabriel";

const repository = "cairn";

// Credentials as code for GitHub Actions. Deploy once, under the `admin` profile, which can mint tokens:
//   pnpm alchemy deploy --config stacks/github.ts --profile admin
// CI's only job today is building the stone base image and publishing it to registry.cloudflare.com,
// so its token covers that and Alchemy's state store, nothing else.
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
          permissionGroups: [
            "Workers Containers Write",
            // Alchemy's state store reads its bearer token through an edge-preview Worker binding.
            "Workers Scripts Write",
            "Secrets Store Write",
            "Account Settings Write",
          ],
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
