import { createSpaceNavigator } from "./space-navigator.js";
import { setIconButtonContent } from "./vector-icon.js";
import { createHttpClient } from "../api/http-client.js";
import { createSpacesClient } from "../api/spaces-client.js";
import { getSpaceType } from "../../../src/spaces/space-types.js";
import { attachNavigatorSwipe } from "../hooks/navigator-swipe.js";

const MANAGEMENT_ROUTES = new Set([
  "space-settings",
  "space-files",
  "settings",
  "accounts",
  "account-detail",
  "agent-detail",
  "agent-skills",
  "agent-hooks",
  "agent-mcp",
  "agent-data",
  "agent-memory-config",
  "agent-memory-library",
  "system-settings",
  "appearance",
  "path-settings",
  "control-center",
]);
const NAVIGATOR_WIDTH_STORAGE_KEY = "vera.ui.navigator-width";

export function isSpaceRouteName(routeName) {
  return routeName === "space" || routeName === "spaces";
}

export function resolveSpaceIdentity(currentSpace, accounts = []) {
  const seats = currentSpace?.seats ?? [];
  const members = seats.map((seat) => (
    accounts.find((account) => account.id === seat.accountId) ?? { id: seat.accountId }
  ));
  if (seats.length === 1) {
    const account = members[0];
    return {
      title: account?.name ?? currentSpace?.name ?? account?.id ?? "选择 Space",
      subtitle: account?.model ?? "模型未知",
    };
  }
  const names = members.map((account) => account?.name ?? account?.id).filter(Boolean);
  return {
    title: currentSpace?.name ?? "选择 Space",
    subtitle: names.length ? `${names.length} 个 Account · ${names.join("、")}` : "尚未添加 Account",
  };
}

function defaultManagementHeader(routeName, currentSpace) {
  const currentChat = currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}` : "#/";
  const defaults = {
    "space-settings": { title: "当前 Space 设置", backHref: currentChat, backLabel: "返回" },
    "space-files": { title: "Files", backHref: currentChat, backLabel: "返回" },
    settings: { title: "Settings", backHref: currentChat, backLabel: "返回" },
    accounts: { title: "Account", backHref: "#/settings", backLabel: "返回" },
    "account-detail": { title: "Account", backHref: "#/settings/accounts", backLabel: "返回" },
    "agent-detail": { title: "Agent", backHref: currentChat, backLabel: "返回" },
    "agent-skills": { title: "Skills", backHref: "#/agents", backLabel: "返回" },
    "agent-hooks": { title: "Hooks", backHref: "#/agents", backLabel: "返回" },
    "agent-mcp": { title: "MCP", backHref: "#/agents", backLabel: "返回" },
    "agent-data": { title: "Data", backHref: "#/agents", backLabel: "返回" },
    "agent-memory-config": { title: "Memory", backHref: "#/agents", backLabel: "返回" },
    "agent-memory-library": { title: "Memory Library", backHref: "#/agents", backLabel: "返回" },
    "system-settings": { title: "System", backHref: "#/settings", backLabel: "返回" },
    appearance: { title: "Appearance", backHref: "#/settings", backLabel: "返回" },
    "path-settings": { title: "Paths", backHref: "#/settings", backLabel: "返回" },
    "control-center": { title: "Control Center", backHref: "#/settings", backLabel: "返回" },
  };
  return defaults[routeName] ?? { title: "Vera", backHref: currentChat, backLabel: "返回" };
}

export function resolveShellHeader({
  routeName,
  currentSpace,
  accounts = [],
  navigatorOpen = false,
  managementHeader = null,
} = {}) {
  if (isSpaceRouteName(routeName)) {
    const identity = resolveSpaceIdentity(currentSpace, accounts);
    return {
      leadingText: navigatorOpen ? "收起" : "目录",
      leadingHref: "#/spaces",
      leadingLabel: navigatorOpen ? "收起 Space 目录" : "打开 Space 目录",
      title: identity.title,
      subtitle: identity.subtitle,
      titleHref: currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}/settings` : "#/spaces",
      titleLabel: currentSpace ? `打开 ${identity.title} 的 Space 设置` : "选择 Space",
      titleIsHeading: false,
      settingsVisible: true,
    };
  }
  const header = managementHeader ?? defaultManagementHeader(routeName, currentSpace);
  return {
    leadingText: header.backLabel ?? "返回",
    leadingHref: header.backHref,
    leadingLabel: header.backLabel ?? "返回",
    title: header.title,
    subtitle: "",
    titleHref: null,
    titleLabel: header.title,
    titleIsHeading: true,
    settingsVisible: false,
  };
}

export function resolveNavigatorState({ routeName, navigatorOpen = false } = {}) {
  return { visible: isSpaceRouteName(routeName) && navigatorOpen };
}

export function clampNavigatorWidth(width, minWidth, maxWidth) {
  return Math.min(Math.max(width, minWidth), Math.max(minWidth, maxWidth));
}

export function createAppShell({ root, platform, runtime } = {}) {
  const spacesClient = createSpacesClient(createHttpClient(platform));
  let currentSpace = runtime.getBootstrap().spaces[0] ?? null;
  let activeRouteName = "space";
  let navigatorOpen = false;
  let managementHeader = null;
  let shellDestroyed = false;

  const shell = document.createElement("section");
  shell.className = "vera-shell is-space-route";
  const documentRoot = root.ownerDocument?.documentElement ?? document.documentElement;
  documentRoot.classList.add("vera-navigator-swipe-route");

  const header = document.createElement("header");
  header.className = "vera-shell__header";

  const leading = document.createElement("a");
  leading.className = "vera-icon-button vera-shell__leading";
  leading.addEventListener("click", (event) => {
    if (!isSpaceRoute()) return;
    event.preventDefault();
    toggleNavigator();
  });

  const title = document.createElement("a");
  title.className = "vera-shell__title";

  const participants = document.createElement("div");
  participants.className = "vera-shell__participants";
  participants.setAttribute("aria-hidden", "true");

  const identity = document.createElement("div");
  identity.className = "vera-shell__identity";
  const subtitle = document.createElement("p");
  subtitle.className = "vera-shell__subtitle";
  identity.append(title, subtitle);

  const settings = document.createElement("a");
  settings.className = "vera-icon-button vera-shell__settings";
  settings.href = "#/settings";
  settings.setAttribute("aria-label", "全局 Settings");
  setIconButtonContent(settings, "settings", "设置");

  const observe = document.createElement("button");
  observe.type = "button";
  observe.className = "vera-icon-button vera-shell__observe";
  setIconButtonContent(observe, "observe", "关注");
  observe.addEventListener("click", async () => {
    if (observe.disabled || currentSpace?.seats?.length !== 1) return;
    const observation = runtime.getBootstrap().observation ?? { observedSpaceId: null, revision: 0 };
    const observed = observation.observedSpaceId === currentSpace.id;
    observe.disabled = true;
    try {
      const result = await spacesClient.updateObservation({
        spaceId: observed ? null : currentSpace.id,
        ifRevision: observation.revision,
      });
      if (result?.observation) {
        runtime.getBootstrap().observation = result.observation;
        updateHeader();
      }
    } catch (error) {
      setConnection(error?.code === "conflict" ? "关注状态已变化" : "关注失败", "danger");
    } finally {
      observe.disabled = false;
    }
  });

  const actions = document.createElement("div");
  actions.className = "vera-shell__actions";
  actions.append(observe, settings);

  const connection = document.createElement("span");
  connection.className = "vera-shell__connection";
  connection.setAttribute("role", "status");
  connection.setAttribute("aria-live", "polite");
  connection.hidden = true;

  const main = document.createElement("div");
  main.className = "vera-shell__main";

  const navigator = createSpaceNavigator({
    platform,
    runtime,
    currentSpaceId: currentSpace?.id,
  });
  let navigatorWidth = null;
  let resizePointerId = null;
  let resizeChanged = false;

  header.append(leading, participants, identity, actions, connection);
  shell.append(navigator.element, header, main);
  root.replaceChildren(shell);

  function readNavigatorResizeBounds() {
    const styles = getComputedStyle(shell);
    const minWidth = Number.parseFloat(styles.getPropertyValue("--vera-navigator-min-width"));
    const configuredMaxWidth = Number.parseFloat(styles.getPropertyValue("--vera-navigator-max-width"));
    const maxViewportRatio = Number.parseFloat(
      styles.getPropertyValue("--vera-navigator-max-viewport-ratio"),
    );
    return {
      minWidth,
      maxWidth: Math.min(configuredMaxWidth, window.innerWidth * maxViewportRatio),
    };
  }

  function setNavigatorWidth(width) {
    const { minWidth, maxWidth } = readNavigatorResizeBounds();
    navigatorWidth = clampNavigatorWidth(width, minWidth, maxWidth);
    shell.style.setProperty("--vera-navigator-width", `${Math.round(navigatorWidth)}px`);
    navigator.resizeHandle.setAttribute("aria-valuemin", String(Math.round(minWidth)));
    navigator.resizeHandle.setAttribute("aria-valuemax", String(Math.round(maxWidth)));
    navigator.resizeHandle.setAttribute("aria-valuenow", String(Math.round(navigatorWidth)));
  }

  function currentNavigatorWidth() {
    return navigatorWidth ?? navigator.element.getBoundingClientRect().width;
  }

  function persistNavigatorWidth() {
    if (navigatorWidth === null) return;
    void platform.secureStorage
      ?.set(NAVIGATOR_WIDTH_STORAGE_KEY, String(Math.round(navigatorWidth)))
      .catch(() => {});
  }

  function stopNavigatorResize(event) {
    if (event && event.pointerId !== resizePointerId) return;
    if (resizeChanged) persistNavigatorWidth();
    resizePointerId = null;
    resizeChanged = false;
    shell.classList.remove("is-navigator-resizing");
  }

  function onNavigatorResizePointerDown(event) {
    if (!event.isPrimary || event.pointerType === "touch") return;
    resizePointerId = event.pointerId;
    resizeChanged = false;
    navigator.resizeHandle.setPointerCapture(event.pointerId);
    shell.classList.add("is-navigator-resizing");
    event.preventDefault();
  }

  function onNavigatorResizePointerMove(event) {
    if (event.pointerId !== resizePointerId) return;
    setNavigatorWidth(event.clientX - shell.getBoundingClientRect().left);
    resizeChanged = true;
    event.preventDefault();
  }

  function onNavigatorResizeKeyDown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const styles = getComputedStyle(shell);
    const step = Number.parseFloat(styles.getPropertyValue("--vera-navigator-resize-step"));
    const { minWidth, maxWidth } = readNavigatorResizeBounds();
    const nextWidth = event.key === "Home"
      ? minWidth
      : event.key === "End"
        ? maxWidth
        : currentNavigatorWidth() + (event.key === "ArrowLeft" ? -step : step);
    setNavigatorWidth(nextWidth);
    persistNavigatorWidth();
    event.preventDefault();
  }

  navigator.resizeHandle.addEventListener("pointerdown", onNavigatorResizePointerDown);
  navigator.resizeHandle.addEventListener("pointermove", onNavigatorResizePointerMove);
  navigator.resizeHandle.addEventListener("pointerup", stopNavigatorResize);
  navigator.resizeHandle.addEventListener("pointercancel", stopNavigatorResize);
  navigator.resizeHandle.addEventListener("keydown", onNavigatorResizeKeyDown);
  void platform.secureStorage
    ?.get(NAVIGATOR_WIDTH_STORAGE_KEY)
    .then((storedWidth) => {
      if (shellDestroyed || navigatorWidth !== null) return;
      const width = Number.parseFloat(storedWidth);
      if (!Number.isFinite(width) || width <= 0) return;
      navigatorWidth = width;
      if (getComputedStyle(navigator.resizeHandle).display !== "none") {
        setNavigatorWidth(navigatorWidth);
      }
    })
    .catch(() => {});

  function isSpaceRoute() {
    return isSpaceRouteName(activeRouteName);
  }

  function isChatSurface() {
    return isSpaceRoute() && getSpaceType(currentSpace?.spaceType).surface === "chat";
  }

  function updateHeader() {
    const headerState = resolveShellHeader({
      routeName: activeRouteName,
      currentSpace,
      accounts: runtime.getBootstrap().accounts ?? [],
      navigatorOpen,
      managementHeader,
    });
    setIconButtonContent(leading, isSpaceRoute() ? "menu" : "arrow-left", headerState.leadingText);
    leading.href = headerState.leadingHref;
    leading.setAttribute("aria-label", headerState.leadingLabel);
    title.textContent = headerState.title;
    if (headerState.titleHref) title.href = headerState.titleHref;
    else title.removeAttribute("href");
    title.setAttribute("aria-label", headerState.titleLabel);
    title.toggleAttribute("role", headerState.titleIsHeading);
    if (headerState.titleIsHeading) {
      title.setAttribute("role", "heading");
      title.setAttribute("aria-level", "1");
    } else {
      title.removeAttribute("role");
      title.removeAttribute("aria-level");
    }
    settings.hidden = !headerState.settingsVisible;
    const observation = runtime.getBootstrap().observation ?? { observedSpaceId: null };
    const canObserve = isChatSurface() && currentSpace?.archivedAt == null && currentSpace?.seats?.length === 1;
    const isObserved = canObserve && observation.observedSpaceId === currentSpace.id;
    observe.hidden = !canObserve;
    observe.classList.toggle("is-active", isObserved);
    observe.setAttribute("aria-pressed", String(isObserved));
    observe.setAttribute("aria-label", isObserved ? "取消关注当前私聊" : "关注当前私聊");
    setIconButtonContent(observe, "observe", isObserved ? "取消关注" : "关注");
    participants.hidden = !isSpaceRoute();
    subtitle.textContent = headerState.subtitle;
    subtitle.hidden = !isSpaceRoute() || !headerState.subtitle;
    renderParticipants();
  }

  function renderParticipants() {
    participants.replaceChildren();
    const bootstrap = runtime.getBootstrap();
    const accounts = bootstrap.accounts ?? [];
    const seats = currentSpace?.seats ?? [];
    const visible = seats.slice(0, 3);
    for (const seat of visible) {
      const account = accounts.find((candidate) => candidate.id === seat.accountId);
      const avatar = document.createElement("span");
      avatar.className = "vera-shell__participant";
      avatar.textContent = (account?.name ?? seat.accountId ?? "?").charAt(0).toUpperCase();
      avatar.title = account?.name ?? seat.accountId ?? "Account";
      participants.appendChild(avatar);
    }
    if (seats.length > visible.length) {
      const more = document.createElement("span");
      more.className = "vera-shell__participant vera-shell__participant--more";
      more.textContent = `+${seats.length - visible.length}`;
      participants.appendChild(more);
    }
  }

  function setSpace(nextSpace) {
    currentSpace = nextSpace;
    navigator.setCurrentSpace(currentSpace?.id ?? null);
    if (isSpaceRoute()) shell.dataset.routeScope = isChatSurface() ? "chat" : "management";
    updateHeader();
  }

  function setConnection(message, tone = "muted") {
    connection.textContent = message ?? "";
    connection.dataset.tone = tone;
    connection.hidden = !message;
  }

  function applyNavigatorState() {
    const { visible } = resolveNavigatorState({ routeName: activeRouteName, navigatorOpen });
    shell.classList.toggle("is-navigator-open", visible);
    navigator.element.toggleAttribute("inert", !visible);
    navigator.element.setAttribute("aria-hidden", String(!visible));
    updateHeader();
  }

  function openNavigator() {
    if (!isSpaceRoute()) return;
    navigatorOpen = true;
    applyNavigatorState();
    navigator.focusFirst();
  }

  function closeNavigator() {
    if (!navigatorOpen) return;
    navigator.cancelDialogs();
    navigatorOpen = false;
    applyNavigatorState();
    leading.focus();
    if (window.location.hash === "#/spaces") {
      window.location.hash = currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}` : "#/";
    }
  }

  function toggleNavigator() {
    if (navigatorOpen) closeNavigator();
    else openNavigator();
  }

  function setManagementHeader(nextHeader) {
    managementHeader = nextHeader;
    if (MANAGEMENT_ROUTES.has(activeRouteName)) updateHeader();
  }

  function setRoute(route, { space: projectedSpace } = {}) {
    navigator.cancelDialogs();
    activeRouteName = route.name;
    const spaceRoute = isSpaceRoute();
    shell.classList.toggle("is-space-route", spaceRoute);
    documentRoot.classList.toggle("vera-navigator-swipe-route", spaceRoute);
    managementHeader = null;
    const bootstrap = runtime.getBootstrap();
    if (spaceRoute) {
      const routeSpace = projectedSpace !== undefined
        ? projectedSpace
        : route.spaceId
          ? bootstrap.spaces.find((space) => space.id === route.spaceId) ?? null
          : currentSpace ?? bootstrap.spaces[0] ?? null;
      setSpace(routeSpace);
    } else {
      const routeSpace = route.spaceId ? bootstrap.spaces.find((space) => space.id === route.spaceId) : null;
      if (routeSpace) setSpace(routeSpace);
    }
    shell.dataset.routeScope = isChatSurface() ? "chat" : "management";
    if (route.name === "spaces") navigatorOpen = true;
    else if (!isSpaceRoute()) navigatorOpen = false;
    updateHeader();
    applyNavigatorState();
    if (route.name === "spaces") navigator.focusFirst();
  }

  const onOnline = () => setConnection(null);
  const onOffline = () => setConnection("离线", "danger");
  const onKeyDown = (event) => {
    if (event.key === "Escape" && navigatorOpen) closeNavigator();
  };
  const onResize = () => {
    if (navigatorWidth !== null) {
      if (getComputedStyle(navigator.resizeHandle).display === "none") {
        shell.style.removeProperty("--vera-navigator-width");
      } else {
        setNavigatorWidth(navigatorWidth);
      }
    }
    applyNavigatorState();
  };
  const detachNavigatorSwipe = attachNavigatorSwipe(shell, {
    onOpen: openNavigator,
    onClose: closeNavigator,
    isOpen: () => navigatorOpen,
    isEnabled: isSpaceRoute,
  });
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);
  const unsubscribeRuntime = runtime.subscribe((envelope) => {
    if (envelope.type === "runtime.connection") {
      if (envelope.data.status === "open" && window.navigator.onLine) setConnection(null);
      else if (window.navigator.onLine) setConnection(envelope.data.status === "reconnecting" ? "重连中" : "连接中");
    } else if (envelope.type === "runtime.degraded") setConnection("同步失败", "danger");
    else if (envelope.type === "space.updated" && envelope.data?.space?.id === currentSpace?.id) setSpace(envelope.data.space);
    else if (envelope.type === "observation.updated") updateHeader();
    else if (envelope.type === "runtime.reset") {
      const retainedArchivedSpace = isSpaceRoute() && currentSpace?.archivedAt ? currentSpace : null;
      const next = envelope.data.bootstrap.spaces.find((space) => space.id === currentSpace?.id)
        ?? retainedArchivedSpace
        ?? envelope.data.bootstrap.spaces[0]
        ?? null;
      setSpace(next);
    }
  });
  if (!window.navigator.onLine) onOffline();
  setSpace(currentSpace);
  applyNavigatorState();

  return {
    element: shell,
    outlet: main,
    setRoute,
    setSpace,
    setConnection,
    setManagementHeader,
    openNavigator,
    toggleNavigator,
    getCurrentSpace() { return currentSpace; },
    destroy() {
      shellDestroyed = true;
      documentRoot.classList.remove("vera-navigator-swipe-route");
      unsubscribeRuntime();
      detachNavigatorSwipe();
      navigator.resizeHandle.removeEventListener("pointerdown", onNavigatorResizePointerDown);
      navigator.resizeHandle.removeEventListener("pointermove", onNavigatorResizePointerMove);
      navigator.resizeHandle.removeEventListener("pointerup", stopNavigatorResize);
      navigator.resizeHandle.removeEventListener("pointercancel", stopNavigatorResize);
      navigator.resizeHandle.removeEventListener("keydown", onNavigatorResizeKeyDown);
      navigator.destroy();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      shell.remove();
    },
  };
}
