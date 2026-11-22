import { openOverlay } from "herdr";

// The runtime's own menu is authoritative for built-ins and dynamically loaded commands.
// Keep it embedded over the chat and pin every control to the original terminal.
export function openAgentControls(agent, command = "/") {
  if (!agent?.address) return null;
  return openOverlay({ kind: "dialog", width: 0.85, height: 0.8,
    layout: { type: "column", children: [
      { type: "block", size: { px: 54 }, content: { mod: "chat-terminal-tools",
        props: { terminal: agent.address, label: agent.label ?? agent.title ?? agent.address, command } } },
      { type: "block", size: { weight: 1 }, content: { terminal: agent.address } },
    ] },
  });
}
