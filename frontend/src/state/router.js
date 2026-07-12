import { createAppShell } from "../components/app-shell.js";

export function parseRoute(hash = "") {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = normalized.startsWith("/") ? normalized : `/${normalized}`;
  if (path === "/" || path === "//") return { name: "space", spaceId: null };
  if (path === "/spaces" || path === "/spaces/") return { name: "spaces", spaceId: null };
  if (path === "/settings" || path === "/settings/") return { name: "settings" };
  const memoryMatch = path.match(/^\/settings\/accounts\/([^/]+)\/memory\/?$/);
  if (memoryMatch) {
    try { return { name: "agent-memory", agentId: decodeURIComponent(memoryMatch[1]) }; }
    catch { return { name: "not-found", path }; }
  }
  const accountMatch = path.match(/^\/settings\/accounts\/([^/]+)\/?$/);
  if (accountMatch) {
    try { return { name: "account-detail", agentId: decodeURIComponent(accountMatch[1]) }; }
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
  loadSettingsView = () => import("../views/settings-index-view.js"),
  loadAccountsView = () => import("../views/account-list-view.js"),
  loadAccountDetailView = () => import("../views/account-detail-view.js"),
  loadAgentMemoryView = () => import("../views/agent-memory-view.js"),
  loadSystemSettingsView = () => import("../views/system-settings-view.js"),
  loadAppearanceView = () => import("../views/appearance-view.js"),
  loadPathSettingsView = () => import("../views/path-settings-view.js"),
  loadControlCenterView = () => import("../views/control-center-view.js"),
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

    let loader = null;
    let mountName = null;
    if (route.name === "space" || route.name === "spaces") { loader = loadSpaceView; mountName = "mountSpaceView"; }
    else if (route.name === "space-settings") { loader = loadSpaceSettingsView; mountName = "mountSpaceSettingsView"; }
    else if (route.name === "settings") { loader = loadSettingsView; mountName = "mountSettingsIndexView"; }
    else if (route.name === "accounts") { loader = loadAccountsView; mountName = "mountAccountListView"; }
    else if (route.name === "account-detail") { loader = loadAccountDetailView; mountName = "mountAccountDetailView"; }
    else if (route.name === "agent-memory") { loader = loadAgentMemoryView; mountName = "mountAgentMemoryView"; }
    else if (route.name === "system-settings") { loader = loadSystemSettingsView; mountName = "mountSystemSettingsView"; }
    else if (route.name === "appearance") { loader = loadAppearanceView; mountName = "mountAppearanceView"; }
    else if (route.name === "path-settings") { loader = loadPathSettingsView; mountName = "mountPathSettingsView"; }
    else if (route.name === "control-center") { loader = loadControlCenterView; mountName = "mountControlCenterView"; }

    if (loader) {
      const routeRoot = windowTarget.document?.createElement?.("main") ?? document.createElement("main");
      routeRoot.className = "vera-route";
      outlet.appendChild(routeRoot);
      const module = await loader();
      if (currentTransition !== transition) { routeRoot.remove(); return; }
      const cleanup = await module[mountName]({ root: routeRoot, platform, runtime, spaceId: route.spaceId, agentId: route.agentId, shell });
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
