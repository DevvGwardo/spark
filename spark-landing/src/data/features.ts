export type Category = "agent" | "tools" | "providers" | "desktop";

export interface Feature {
  id: number;
  name: string;
  category: Category;
  tag: string;
  note: string;
  icon: string;
}

export const features: Feature[] = [
  {
    id: 1,
    name: "Hermes Agent",
    category: "agent",
    tag: "autonomous",
    note: "The Hermes agent reads your code, runs terminals, browses the web, and ships PRs — it acts instead of just chatting.",
    icon: "bot",
  },
  {
    id: 2,
    name: "Parallel Sessions",
    category: "agent",
    tag: "multi-tab",
    note: "Run several agents at once, each in its own tab with a separate model, context, and workspace profile.",
    icon: "tabs",
  },
  {
    id: 3,
    name: "Computer Use",
    category: "agent",
    tag: "new",
    note: "Grant the agent control of the screen, mouse, and keyboard so it can drive real desktop apps end to end.",
    icon: "mouse",
  },
  {
    id: 4,
    name: "Agent Toolsets",
    category: "agent",
    tag: "granular",
    note: "Toggle web, browser, vision, terminal, files, code execution, and computer use on or off per session.",
    icon: "toggles",
  },
  {
    id: 5,
    name: "MCP Servers",
    category: "tools",
    tag: "extensible",
    note: "Connect any Model Context Protocol server over HTTP or stdio and auto-discover its tools for the agent.",
    icon: "plug",
  },
  {
    id: 6,
    name: "GitHub Workflow",
    category: "tools",
    tag: "git-native",
    note: "Browse repositories, read diffs, and open pull requests without leaving the app.",
    icon: "git",
  },
  {
    id: 7,
    name: "Live Code Preview",
    category: "tools",
    tag: "preview",
    note: "Render React, HTML, and SVG side-by-side with the conversation as the agent edits files.",
    icon: "preview",
  },
  {
    id: 8,
    name: "Cron & Skills",
    category: "tools",
    tag: "automation",
    note: "Schedule recurring agent jobs and install reusable skills from the hub to extend what it can do.",
    icon: "clock",
  },
  {
    id: 9,
    name: "15+ LLM Providers",
    category: "providers",
    tag: "bring-your-own-key",
    note: "Anthropic, OpenAI, Gemini, Grok, DeepSeek, OpenRouter and more — route the agent to any model you like.",
    icon: "stack",
  },
  {
    id: 10,
    name: "Memory & Swarm",
    category: "agent",
    tag: "advanced",
    note: "Persistent, editable agent memory plus a swarm pipeline: architect, implementor, and reviewer in sequence.",
    icon: "brain",
  },
  {
    id: 11,
    name: "Native Desktop",
    category: "desktop",
    tag: "cross-platform",
    note: "A real Electron app for macOS, Windows, and Linux with system tray, notifications, and offline support.",
    icon: "desktop",
  },
  {
    id: 12,
    name: "Local & Private",
    category: "desktop",
    tag: "your machine",
    note: "Runs on your machine against your own keys and a local Hermes bridge. Your code and context stay yours.",
    icon: "shield",
  },
];

export const categories: { id: "all" | Category; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agent", label: "Agent" },
  { id: "tools", label: "Tools" },
  { id: "providers", label: "Providers" },
  { id: "desktop", label: "Desktop" },
];
