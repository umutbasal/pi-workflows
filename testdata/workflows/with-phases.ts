export const meta = {
  name: "with-phases",
  description: "Workflow with phases defined",
  phases: [
    { title: "Discover", detail: "find files" },
    { title: "Process", detail: "process each file" },
  ],
};

phase("Discover");
const files = await agent("find all source files");

phase("Process");
await pipeline(files, async (input, item, index) => {
  return await agent(`process ${item}`);
});
