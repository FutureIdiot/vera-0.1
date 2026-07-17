import { createAppShell } from "../components/app-shell.js";

export function parseRoute(hash = "") {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = normalized.startsWith("/") ? normalized : `/${normalized}`;
  if (path === "/" || path === "//") return { name: "space", spaceId: null };
  if (path === "/spaces" || path === "/spaces/") return { name: "spaces", spaceId: null };
  if (path === "/settings" || path === "/settings/") return { name: "settings" };

  // Agent usage management — most specific first
  const memoryLibraryMatch = path.match(/^\/agents\/([^/]+)\/data\/memory\/library\/?$/);
  if (memoryLibraryMatch) {
    try { return { name: "agent-memory-library", agentId: decodeURIComponent(memoryLibraryMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const memoryConfigMatch = path.match(/^\/agents\/([^/]+)\/data\/memory\/?$/);
  if (memoryConfigMatch) {
    try { return { name: "agent-memory-config", agentId: decodeURIComponent(memoryConfigMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const dataMatch = path.match(/^\/agents\/([^/]+)\/data\/?$/);
  if (dataMatch) {
    try { return { name: "agent-data", agentId: decodeURIComponent(dataMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const mcpMatch = path.match(/^\/agents\/([^/]+)\/mcp\/?$/);
  if (mcpMatch) {
    try { return { name: "agent-mcp", agentId: decodeURIComponent(mcpMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const hooksMatch = path.match(/^\/agents\/([^/]+)\/hooks\/?$/);
  if (hooksMatch) {
    try { return { name: "agent-hooks", agentId: decodeURIComponent(hooksMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const skillsMatch = path.match(/^\/agents\/([^/]+)\/skills\/?$/);
  if (skillsMatch) {
    try { return { name: "agent-skills", agentId: decodeURIComponent(skillsMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const agentMatch = path.match(/^\/agents\/([^/]+)\/?$/);
  if (agentMatch) {
    try { return { name: "agent-detail", agentId: decodeURIComponent(agentMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  if (path === "/agents" || path === "/agents/") return { name: "agent-detail", agentId: null };

  const accountMatch = path.match(/^\/settings\/accounts\/([^/]+)\/?$/);
  if (accountMatch) {
    try { return { name: "account-detail", accountId: decodeURIComponent(accountMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }

  if (path === "/settings/accounts" || path === "/settings/accounts/") return { name: "accounts" };
  if (path === "/settings/system" || path === "/settings/system/") return { name: "system-settings" };
  if (path === "/settings/appearance" || path === "/settings/appearance/") return { name: "appearance" };
  if (path === "/settings/paths" || path === "/settings/paths/") return { name: "path-settings" };
  if (path === "/settings/control-center" || path === "/settings/control-center/") return { name: "control-center" };
  const settingsMatch = path.match(/^\/spaces\/([^/]+)\/settings\/?$/);
  if (settingsMatch) {
    try { return { name: "space-settings", spaceId: decodeURIComponent(settingsMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const historyDetailMatch = path.match(/^\/spaces\/([^/]+)\/history\/([^/]+)\/?$/);
  if (historyDetailMatch) {
    try {
      return {
        name: "space-history",
        spaceId: decodeURIComponent(historyDetailMatch[1]),
        spaceSessionId: decodeURIComponent(historyDetailMatch[2]),
      };
    } catch { return { name: "not-found", path }; }
  }
  const historyMatch = path.match(/^\/spaces\/([^/]+)\/history\/?$/);
  if (historyMatch) {
    try { return { name: "space-history", spaceId: decodeURIComponent(historyMatch[1]), spaceSessionId: null }; }
    catch { return { name: "not-found", path }; }
  }
  const filesMatch = path.match(/^\/spaces\/([^/]+)\/files\/?$/);
  if (filesMatch) {
    try { return { name: "space-files", spaceId: decodeURIComponent(filesMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const match = path.match(/^\/spaces\/([^/]+)\/?$/);
  if (match) {
    try { return { name: "space", spaceId: decodeURIComponent(match[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  return { name: "not-found", path };
}

export function createAppRouter({
  root,
  platform,
  runtime,
  windowTarget = window,
  createShell = (options) => createAppShell(options),
  loadSpaceView = () => import("../views/space-view.js"),
  loadSpaceSettingsView = () => import("../views/space-settings-view.js"),
  loadSpaceHistoryView = () => import("../views/space-history-view.js"),
  loadSpaceFilesView = () => import("../views/space-files-view.js"),
  loadSettingsView = () => import("../views/settings-index-view.js"),
  loadAccountsView = () => import("../views/account-list-view.js"),
  loadAccountDetailView = () => import("../views/account-detail-view.js"),
  loadAgentDetailView = () => import("../views/agent-detail-view.js"),
  loadSystemSettingsView = () => import("../views/system-settings-view.js"),
  loadAppearanceView = () => import("../views/appearance-view.js"),
  loadPathSettingsView = () => import("../views/path-settings-view.js"),
  loadControlCenterView = () => import("../views/control-center-view.js"),
  loadCapabilityDirectoryView = () => import("../views/capability-directory-view.js"),
  loadAgentDataView = () => import("../views/agent-data-view.js"),
  loadAgentMemoryConfigView = () => import("../views/agent-memory-config-view.js"),
  loadAgentMemoryLibraryView = () => import("../views/agent-memory-library-view.js"),
} = {}) {
  let activeCleanup = null;
  let shell = null;
  let started = false;
  let transition = 0;
  let activeHash = null;
  let revertingHash = null;

  function renderFailure(messageText, { retry = false } = {}) {
    const outlet = shell?.outlet ?? root;
    outlet.replaceChildren();
    const page = windowTarget.document?.createElement?.("section") ?? document.createElement("section");
    page.className = "vera-route-error";
    page.setAttribute("role", "alert");
    const message = windowTarget.document?.createElement?.("p") ?? document.createElement("p");
    message.textContent = messageText;
    page.appendChild(message);
    if (retry) {
      const button = windowTarget.document?.createElement?.("button") ?? document.createElement("button");
      button.type = "button";
      button.className = "vera-primary-button";
      button.textContent = "重试";
      button.addEventListener("click", onHashChange);
      page.appendChild(button);
    }
    outlet.appendChild(page);
    activeCleanup = () => page.remove();
  }

  async function render() {
    const targetHash = windowTarget.location.hash;
    const route = parseRoute(targetHash);
    const currentTransition = ++transition;
    if (activeCleanup?.() === false) {
      if (activeHash !== null && targetHash !== activeHash) {
        revertingHash = activeHash;
        if (windowTarget.location.hash !== activeHash) windowTarget.location.hash = activeHash;
      }
      return;
    }
    activeCleanup = null;
    const outlet = shell?.outlet ?? root;
    outlet.replaceChildren();
    shell?.setRoute(route);

    const routeMap = [
      { names: ["space", "spaces"], loader: loadSpaceView, mount: "mountSpaceView" },
      { names: ["space-settings"], loader: loadSpaceSettingsView, mount: "mountSpaceSettingsView" },
      { names: ["space-history"], loader: loadSpaceHistoryView, mount: "mountSpaceHistoryView" },
      { names: ["space-files"], loader: loadSpaceFilesView, mount: "mountSpaceFilesView" },
      { names: ["settings"], loader: loadSettingsView, mount: "mountSettingsIndexView" },
      { names: ["accounts"], loader: loadAccountsView, mount: "mountAccountListView" },
      { names: ["account-detail"], loader: loadAccountDetailView, mount: "mountAccountDetailView" },
      { names: ["agent-detail"], loader: loadAgentDetailView, mount: "mountAgentDetailView" },
      { names: ["system-settings"], loader: loadSystemSettingsView, mount: "mountSystemSettingsView" },
      { names: ["appearance"], loader: loadAppearanceView, mount: "mountAppearanceView" },
      { names: ["path-settings"], loader: loadPathSettingsView, mount: "mountPathSettingsView" },
      { names: ["control-center"], loader: loadControlCenterView, mount: "mountControlCenterView" },
      { names: ["agent-skills", "agent-hooks", "agent-mcp"], loader: loadCapabilityDirectoryView, mount: "mountCapabilityDirectoryView" },
      { names: ["agent-data"], loader: loadAgentDataView, mount: "mountAgentDataView" },
      { names: ["agent-memory-config"], loader: loadAgentMemoryConfigView, mount: "mountAgentMemoryConfigView" },
      { names: ["agent-memory-library"], loader: loadAgentMemoryLibraryView, mount: "mountAgentMemoryLibraryView" },
    ];

    const entry = routeMap.find((r) => r.names.includes(route.name));

    if (entry) {
      const routeRoot = windowTarget.document?.createElement?.("main") ?? document.createElement("main");
      routeRoot.className = "vera-route";
      outlet.appendChild(routeRoot);
      const module = await entry.loader();
      if (currentTransition !== transition) { routeRoot.remove(); return; }
      const cleanup = await module[entry.mount]({
        root: routeRoot,
        platform,
        runtime,
        spaceId: route.spaceId,
        spaceSessionId: route.spaceSessionId,
        agentId: route.agentId,
        accountId: route.accountId,
        shell,
      });
      if (currentTransition !== transition) { cleanup?.(); routeRoot.remove(); return; }
      activeCleanup = () => {
        const result = cleanup?.();
        if (result !== false) routeRoot.remove();
        return result;
      };
      activeHash = targetHash;
      return;
    }

    renderFailure("页面不存在");
    activeHash = targetHash;
  }

  function onHashChange() {
    if (revertingHash !== null && windowTarget.location.hash === revertingHash) {
      revertingHash = null;
      return;
    }
    revertingHash = null;
    const expectedTransition = transition + 1;
    void render().catch((err) => {
      if (transition !== expectedTransition) return;
      renderFailure(`页面加载失败：${err.message}`, { retry: true });
    });
  }

  return {
    async start() {
      if (started) return;
      started = true;
      shell = createShell({ root, platform, runtime });
      windowTarget.addEventListener("hashchange", onHashChange);
      try {
        await render();
      } catch (err) {
        renderFailure(`页面加载失败：${err.message}`, { retry: true });
      }
    },
    stop() {
      if (!started) return;
      started = false;
      transition += 1;
      windowTarget.removeEventListener("hashchange", onHashChange);
      activeCleanup?.();
      activeCleanup = null;
      activeHash = null;
      revertingHash = null;
      shell?.destroy?.();
      shell = null;
      root.replaceChildren();
    },
  };
}
