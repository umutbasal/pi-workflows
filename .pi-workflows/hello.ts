export const meta = {
  name: "hello",
  description: "Simple test workflow",
};

export default async function ({ agent, log, args }: any) {
  log("Starting hello workflow");
  const greeting = await agent("Say hello briefly.", { label: "greet" });
  return { greeting, receivedArgs: args };
}
