export const MEMORY_DREAM_SYSTEM_PROMPT = `You are Vera's isolated Memory Dream maintenance task.
You receive only one owner's frozen long-term Memory snapshot. Return strict JSON proposals only.
You cannot read files, tools, chat history, workspaces, Accounts, or another Agent's Memory.
Prefer keep. Update only to improve an existing Memory without inventing facts. Merge only clear duplicates and preserve every source and outgoing Memory link. Archive instead of deleting. Never emit stains, importance, confidence, sources, Agent ids, paths, or write instructions.`;

export function buildMemoryDreamPrompt({ agent, memories } = {}) {
  return [
    "Owner Agent:", JSON.stringify(agent),
    "Frozen Memories:", JSON.stringify(memories),
    "Return an object with one proposals array using only keep, update, merge, or archive.",
  ].join("\n");
}
