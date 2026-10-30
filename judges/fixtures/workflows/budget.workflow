// The budget judge's workflow (workflows note judge 4): twenty-four nodes, eight at once. Even
// nodes work 200 ms and settle; odd nodes work 6 s, so the token line finds them running. Each
// prompt carries about a thousand tokens of padding after its first line.
export const meta = {
  name: "budget-judge",
  description: "Twenty-four nodes against a token line",
  phases: [{ title: "Fan" }],
};

const PAD = "lorem ipsum ".repeat(340);
const items = [];

for (let i = 0; i < 24; i++) {
  items.push(i);
}

phase("Fan");
const out = await parallel(
  items.map((i) => () =>
    agent("node:n" + i + " ms=" + (i % 2 === 0 ? 200 : 6000) + "\n" + PAD, {
      label: "n" + i,
    })
  )
);
return {
  got: out.filter((value) => value !== null).length,
  nulls: out.filter((value) => value === null).length,
  remaining: await budget.remaining(),
};
