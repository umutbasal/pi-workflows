export const meta = {
  name: "simple",
  description: "A simple valid workflow",
};

phase("Run");
const result = await agent("do something");
