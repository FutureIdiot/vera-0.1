// External extension code runs in a supervised child process. The Gateway
// communicates only with this small JSON/IPC boundary and never imports the
// external entry in its own process.
let extensionModule = null;
let instance = null;

function projection(value, agentId) {
  return {
    status: "initialized",
    provider: value?.provider ? { providerId: value.provider.providerId, capability: value.provider.capability } : null,
    hooks: Object.values(value?.hooks ?? {}).map((hook) => ({ unitId: hook.unitId, phase: hook.phase, enabled: hook.enabled })),
    mcp: value?.mcp ? { tools: value.mcp.tools?.map((tool) => tool.name) ?? [] } : null,
    tasks: Object.values(value?.tasks ?? {}).map((task) => ({ kind: task.kind, status: task.status, ownerAgentId: task.ownerAgentId ?? agentId })),
  };
}

async function handle(message) {
  if (message.action === "load") {
    extensionModule = await import(message.entryUrl);
    if (typeof extensionModule.getManifest !== "function" || typeof extensionModule.initialize !== "function") {
      throw new Error("extension entry must export getManifest and initialize");
    }
    return { manifest: await extensionModule.getManifest() };
  }
  if (message.action === "initialize") {
    if (!extensionModule) throw new Error("extension is not loaded");
    instance = await extensionModule.initialize({
      version: 1,
      extensionId: message.extensionId,
      agentId: message.agentId,
      extension: { id: message.extensionId, version: message.version },
      agent: { id: message.agentId },
      config: message.config ?? {},
      register: () => {},
    });
    if (!instance || typeof instance.shutdown !== "function") throw new Error("extension initialize must return shutdown");
    return { instance: projection(instance, message.agentId) };
  }
  if (message.action === "shutdown") {
    await instance?.shutdown?.();
    instance = null;
    return { ok: true };
  }
  if (message.action === "mcpCall") {
    if (!instance?.mcp?.call) throw new Error("extension MCP is unavailable");
    return { result: await instance.mcp.call({ agentId: message.agentId, name: message.name, arguments: message.arguments ?? {} }) };
  }
  if (message.action === "hookCall") {
    const hook = instance?.hooks?.[message.unitId.split(".").at(-1)] ?? instance?.hooks?.[message.unitId];
    if (!hook?.handle) throw new Error("extension hook is unavailable");
    return { result: await hook.handle({ agentId: message.agentId, event: message.event ?? {} }) };
  }
  throw new Error(`unknown extension worker action: ${message.action}`);
}

process.on("message", (message) => {
  Promise.resolve(handle(message)).then(
    (value) => process.send?.({ id: message.id, ok: true, value }),
    (error) => process.send?.({ id: message.id, ok: false, error: { message: error.message, code: error.code ?? "extension_load_failed", stack: error.stack } }),
  );
});
