// The side panel's own pages (sidebar.html) and the AI assistants it can
// show -- for the rail's buttons, the side panel page and Settings alike.

export const SIDEBAR_PANELS = [
  { id: "bookmarks", label: "Bookmarks", icon: "bookmark" },
  { id: "reading", label: "Reading list", icon: "glasses" },
  { id: "history", label: "History", icon: "history" },
  { id: "notes", label: "Notes", icon: "note" },
  { id: "search", label: "Search", icon: "search" },
  { id: "workspaces", label: "Workspaces", icon: "layers" },
  { id: "extensions", label: "Extensions", icon: "puzzle" },
];

// The rail's buttons, as Settings -> Side panel lists them ("ai" too).
export const RAIL_ITEMS = [...SIDEBAR_PANELS, { id: "ai", label: "AI assistant", icon: "sparkle" }];

export const DEFAULT_RAIL_ITEMS = ["bookmarks", "reading", "history", "notes", "ai"];

// `ask(prompt)`: the assistant's address with a question already typed in,
// where it takes one in its address.
export const AI_PROVIDERS = {
  chatgpt: { name: "ChatGPT", home: "https://chatgpt.com/", ask: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}` },
  claude: { name: "Claude", home: "https://claude.ai/new", ask: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
  gemini: { name: "Gemini", home: "https://gemini.google.com/app", ask: null },
  copilot: { name: "Copilot", home: "https://copilot.microsoft.com/", ask: (q) => `https://copilot.microsoft.com/?q=${encodeURIComponent(q)}` },
  perplexity: { name: "Perplexity", home: "https://www.perplexity.ai/", ask: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}` },
  mistral: { name: "Le Chat", home: "https://chat.mistral.ai/chat", ask: (q) => `https://chat.mistral.ai/chat?q=${encodeURIComponent(q)}` },
  custom: { name: "Your assistant", home: "", ask: null },
};

// The assistant Settings picked: { name, url, typed } -- `typed` when the
// question is in its address; otherwise it has to be pasted in.
export function aiTarget(settings, prompt = "") {
  const id = settings?.ai_provider in AI_PROVIDERS ? settings.ai_provider : "chatgpt";
  if (id === "custom") {
    const custom = (settings?.ai_custom_url || "").trim();
    if (!/^https?:\/\//i.test(custom)) return aiTarget({ ai_provider: "chatgpt" }, prompt);
    // "%s" in its address stands for the question.
    const typed = !!prompt && custom.includes("%s");
    return { name: AI_PROVIDERS.custom.name, url: custom.replace("%s", typed ? encodeURIComponent(prompt) : ""), typed };
  }
  const p = AI_PROVIDERS[id];
  if (prompt && p.ask) return { name: p.name, url: p.ask(prompt), typed: true };
  return { name: p.name, url: p.home, typed: false };
}

// Workspaces' looks.
export const WORKSPACE_COLORS = ["#7c5cff", "#4a8cff", "#20b9c5", "#2fbf71", "#f5a524", "#ff7a45", "#ff5d6c", "#ff7ac6", "#8a8f9e"];
export const WORKSPACE_ICONS = ["🏠", "💼", "🎮", "🎵", "📚", "🛒", "💬", "🧪", "✈️", "🎨", "💰", "⚽", "🍳", "🌱", "⭐", "🔒"];

// What to ask about a page, or about text picked on one.
export function aiPrompt({ page, title, selection }) {
  if (selection) return `${selection.trim().slice(0, 4000)}\n\n(From ${title ? `"${title}", ` : ""}${page})\nExplain this.`;
  return `Summarize this page for me: ${page}`;
}
