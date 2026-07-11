import { createAppShell } from "../components/app-shell.js";

export function parseRoute(hash = "") {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = normalized.startsWith("/") ? normalized : `/${normalized}`;
  if (path === "/" || path === "//") return { name: "space", spaceId: null };
  if (path === "/spaces" || path === "/spaces/") return { name: "spaces", spaceId: null };
  if (path === "/settings" || path === "/settings/") return { name: "settings" };
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
  loadSettingsView = () => import("../views/settings-view.js"),
} = {}) {
  let activeCleanup = null;
  let shell = null;
  let started = false;
  let transition = 0;

  async function render() {
    const route = parseRoute(windowTarget.location.hash);
    const currentTransition = ++transition;
    if (activeCleanup?.() === false) return;
    activeCleanup = null;
    const outlet = shell?.outlet ?? root;
    outlet.replaceChildren();
    shell?.setRoute(route);

    let loader = null;
    let mountName = null;
    if (route.name === "space") { loader = loadSpaceView; mountName = "mountSpaceView"; }
    else if (route.name === "space-settings") { loader = loadSpaceSettingsView; mountName = "mountSpaceSettingsView"; }
    else if (route.name === "settings") { loader = loadSettingsView; mountName = "mountSettingsView"; }
    else if (route.name === "spaces") {
      const hint = windowTarget.document?.createElement?.("p") ?? document.createElement("p");
      hint.className = "vera-route-hint";
      hint.textContent = "从 Space 导航选择一项";
      outlet.appendChild(hint);
      activeCleanup = () => hint.remove();
      return;
    }

    if (loader) {
      const routeRoot = windowTarget.document?.createElement?.("main") ?? document.createElement("main");
      routeRoot.className = "vera-route";
      outlet.appendChild(routeRoot);
      const module = await loader();
      if (currentTransition !== transition) { routeRoot.remove(); return; }
      const cleanup = await module[mountName]({ root: routeRoot, platform, runtime, spaceId: route.spaceId, shell });
      if (currentTransition !== transition) { cleanup?.(); routeRoot.remove(); return; }
      activeCleanup = () => {
        const result = cleanup?.();
        if (result !== false) routeRoot.remove();
        return result;
      };
      return;
    }

    const message = windowTarget.document?.createElement?.("p") ?? document.createElement("p");
    message.className = "vera-route-error";
    message.textContent = "页面不存在";
    outlet.appendChild(message);
    activeCleanup = () => message.remove();
  }

  function onHashChange() {
    const expectedTransition = transition + 1;
    void render().catch((err) => {
      if (transition !== expectedTransition) return;
      const outlet = shell?.outlet ?? root;
      outlet.replaceChildren();
      const message = windowTarget.document?.createElement?.("p") ?? document.createElement("p");
      message.className = "vera-route-error";
      message.textContent = `页面加载失败：${err.message}`;
      outlet.appendChild(message);
    });
  }

  return {
    async start() {
      if (started) return;
      started = true;
      shell = createShell({ root, platform, runtime });
      windowTarget.addEventListener("hashchange", onHashChange);
      await render();
    },
    stop() {
      if (!started) return;
      started = false;
      transition += 1;
      windowTarget.removeEventListener("hashchange", onHashChange);
      activeCleanup?.();
      activeCleanup = null;
      shell?.destroy?.();
      shell = null;
      root.replaceChildren();
    },
  };
}
