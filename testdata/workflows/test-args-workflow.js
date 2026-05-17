export const meta = {
  name: "test-args-workflow",
  description: "Simple test workflow to verify args passing works",
};

// args: { name: string, count?: number }

const name = (args && args.name) || "world";
const count = (args && args.count) || 1;

if (!args) return { error: "no args provided" };

log(`Hello ${name}, repeating ${count} time(s)`);

const greetings = [];
for (let i = 0; i < count; i++) {
  greetings.push(`Hello, ${name}! (#${i + 1})`);
}

return { greetings, argsReceived: args };
