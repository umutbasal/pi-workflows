// args: { repo: string, branch: string }
export const meta = {
  name: "with-args",
  description: "Workflow that accepts arguments",
};

const repo = args.repo;
const branch = args.branch;
await agent(`clone ${repo} on branch ${branch}`);
