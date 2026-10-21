import { defineProvider, object, secrets, string } from "apps";
import { mcpHealth } from "apps/mcp";

// The bridges listen on the docker bridge; the container reaches them as host.docker.internal.
export const origin = "http://host.docker.internal:3776";
export const serverUrl = (name: string) => `${origin}/${name}/mcp`;
export const headers = (account: { fields: { token: string } }) => ({
  Authorization: "Bearer " + account.fields.token,
});

export const provider = defineProvider({
  name: "Cairn bridges",
  hosts: ["host.docker.internal:3776"],
  auth: {
    apiKey: secrets({
      label: "Bridge key",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
  },
  health: (check) => mcpHealth(check, { url: serverUrl("convex"), headers: headers(check.account) }),
});
