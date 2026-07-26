import { createHttpClient } from "../api/http-client.js";
import { createProjectsClient } from "../api/projects-client.js";
import { createGroupsClient } from "../api/groups-client.js";
import { createSpacesClient } from "../api/spaces-client.js";
import { createSpaceNavigatorState } from "../state/space-navigator-state.js";
import {
  confirmNavigatorAction,
  confirmSpaceDeletion,
} from "./navigator-dialogs.js";
import {
  requestGroupDetails,
  requestSpaceDetails,
} from "./navigator-form-dialogs.js";
import {
  createSpaceNavigatorContent,
  makeNavigatorButton,
  makeNavigatorIconButton,
} from "./space-navigator-content.js";
import {
  directoryKey,
  directoryProjection,
  resolveSpaceCreationTarget,
} from "./space-navigator-projection.js";

function avatarText(entry) {
  return entry.accountIds.length > 1 ? "群" : entry.label.trim().slice(0, 1).toUpperCase();
}

export { resolveSpaceCreationTarget } from "./space-navigator-projection.js";

export function createSpaceNavigator({ platform, runtime, currentSpaceId } = {}) {
  const http = createHttpClient(platform);
  const client = createSpacesClient(http);
  const projectsClient = createProjectsClient(http);
  const groupsClient = createGroupsClient(http);
  const navigatorState = createSpaceNavigatorState();
  let archived = null;
  let dialogController = new AbortController();
  let renderQueued = false;
  let destroyed = false;

  const initialSpaces = runtime.getBootstrap().spaces;
  navigatorState.selectDirectory(
    directoryKey(initialSpaces.find((space) => space.id === currentSpaceId) ?? initialSpaces[0] ?? { seats: [] }),
  );

  const panel = document.createElement("aside");
  panel.className = "vera-navigator";
  panel.setAttribute("aria-label", "Space 目录");
  const contacts = document.createElement("nav");
  contacts.className = "vera-navigator__contacts";
  contacts.setAttribute("aria-label", "最近联系人和群组");
  const spacesPanel = document.createElement("section");
  spacesPanel.className = "vera-navigator__spaces";
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "vera-navigator__resize-handle";
  resizeHandle.setAttribute("role", "separator");
  resizeHandle.setAttribute("aria-label", "调整导航宽度");
  resizeHandle.setAttribute("aria-orientation", "vertical");
  resizeHandle.tabIndex = 0;
  panel.append(contacts, spacesPanel, resizeHandle);

  function selectedKey() {
    return navigatorState.snapshot().selectedDirectoryKey;
  }

  function selectDirectory(key) {
    navigatorState.selectDirectory(key);
  }

  function activeProjection() {
    const bootstrap = runtime.getBootstrap();
    return {
      accounts: bootstrap.accounts ?? [],
      groups: bootstrap.groups ?? [],
      projects: bootstrap.projects ?? [],
      spaces: bootstrap.spaces ?? [],
    };
  }

  function navigate(spaceId) {
    window.location.hash = `#/spaces/${encodeURIComponent(spaceId)}`;
  }

  function selectedTarget() {
    const { accounts, groups } = activeProjection();
    return resolveSpaceCreationTarget(accounts, groups, selectedKey());
  }

  function dialogOptions() {
    return { signal: dialogController.signal };
  }

  function cancelDialogs() {
    dialogController.abort();
    dialogController = new AbortController();
  }

  async function createProject(name) {
    const response = await projectsClient.createProject({ name });
    runtime.mergeProject(response.project);
    return response.project;
  }

  async function createGroupDirectory() {
    const details = await requestGroupDetails(panel, {
      title: "新建群聊",
      accounts: runtime.getBootstrap().accounts,
      ...dialogOptions(),
    });
    if (!details?.name) return;
    try {
      const response = await groupsClient.createGroup(details);
      selectDirectory(`group:${response.group.id}`);
      runtime.mergeGroup(response.group);
    } catch (err) {
      showError(err.message);
    }
  }

  async function editGroupDirectory(group) {
    const details = await requestGroupDetails(panel, {
      title: "编辑群聊",
      initialValue: group,
      accounts: runtime.getBootstrap().accounts,
      ...dialogOptions(),
    });
    if (!details?.name) return;
    try {
      const response = await groupsClient.updateGroup(group.id, details);
      runtime.mergeGroup(response.group);
      for (const space of response.spaces) runtime.mergeSpace(space);
    } catch (err) {
      showError(err.message);
    }
  }

  async function createSpace() {
    const target = selectedTarget();
    if (!target.seats.length) return showError("请先选择一个联系人或群组");
    const details = await requestSpaceDetails(panel, {
      title: "新 Space",
      projects: runtime.getBootstrap().projects ?? [],
      onCreateProject: createProject,
      ...dialogOptions(),
    });
    if (!details?.name) return;
    try {
      const response = await client.createSpace({ ...details, ...target });
      runtime.mergeSpace(response.space);
      navigate(response.space.id);
    } catch (err) {
      showError(err.message);
    }
  }

  async function togglePin(space) {
    try {
      const response = await client.updateSpace(space.id, { pinned: !space.pinned });
      runtime.mergeSpace(response.space);
    } catch (err) {
      showError(err.message);
    }
  }

  async function archiveSpace(space) {
    const confirmed = await confirmNavigatorAction(
      panel,
      `归档“${space.name}”？历史与会话状态都会保留。`,
      dialogOptions(),
    );
    if (!confirmed) return;
    try {
      const response = await client.archiveSpace(space.id);
      runtime.mergeSpace(response.space);
      if (space.id === currentSpaceId) {
        const { spaces } = activeProjection();
        const next = spaces.find((item) => directoryKey(item) === selectedKey()) ?? spaces[0];
        window.location.hash = next ? `#/spaces/${encodeURIComponent(next.id)}` : "#/";
      }
    } catch (err) {
      showError(err.status === 409 ? "有进行中的对话，等结束或取消后再归档" : err.message);
    }
  }

  async function loadArchived() {
    try {
      archived = (await client.listSpaces({ archived: true })).spaces;
      content.render();
    } catch (err) {
      showError(err.message);
    }
  }

  async function toggleArchived() {
    if (archived === null) await loadArchived();
    else {
      archived = null;
      content.render();
    }
  }

  async function restoreSpace(space) {
    try {
      const response = await client.restoreSpace(space.id);
      selectDirectory(directoryKey(response.space));
      runtime.mergeSpace(response.space);
      navigate(response.space.id);
    } catch (err) {
      showError(err.message);
    }
  }

  async function deleteSpace(space) {
    try {
      const { preview } = await client.getDeletionPreview(space.id);
      const choice = await confirmSpaceDeletion(
        panel,
        space,
        preview,
        dialogOptions(),
      );
      if (!choice) return;
      await client.deleteSpace(space.id, choice);
      runtime.removeSpace(space.id);
    } catch (err) {
      showError(err.status === 409 ? "Space 仍有进行中的任务或 Memory 已变化，请稍后重试" : err.message);
    }
  }

  function showError(message) {
    let error = spacesPanel.querySelector(".vera-inline-error");
    if (!error) {
      error = document.createElement("p");
      error.className = "vera-inline-error";
      spacesPanel.prepend(error);
    }
    error.textContent = message;
  }

  function renderContacts() {
    contacts.replaceChildren();
    const { accounts, groups, spaces } = activeProjection();
    const brand = document.createElement("div");
    brand.className = "vera-contact-brand";
    brand.textContent = "V";
    const recent = document.createElement("span");
    recent.className = "vera-contact-rail-label";
    recent.textContent = "最近";
    const list = document.createElement("div");
    list.className = "vera-contact-list";
    const entries = directoryProjection(accounts, groups, spaces);
    for (const entry of entries) {
      const item = makeNavigatorButton("vera-contact", () => {
        selectDirectory(entry.key);
        content.resetFilter();
        render();
      });
      item.classList.toggle("is-active", entry.key === selectedKey());
      item.title = entry.label;
      item.setAttribute("aria-label", entry.label);
      const avatar = document.createElement("span");
      avatar.className = `vera-contact__avatar${entry.kind === "group" ? " is-group" : ""}`;
      avatar.textContent = avatarText(entry);
      const activeAccount = entry.accounts.find((account) => account.presence === "online");
      if (entry.kind === "direct" && activeAccount) {
        const status = document.createElement("span");
        status.className = "vera-contact__status";
        avatar.appendChild(status);
      }
      const label = document.createElement("span");
      label.className = "vera-contact__label";
      label.textContent = entry.label;
      item.append(avatar, label);
      list.appendChild(item);
    }
    contacts.append(
      brand,
      recent,
      list,
      makeNavigatorIconButton(
        "plus",
        "vera-contact vera-contact--manage",
        "新建群聊",
        () => void createGroupDirectory(),
      ),
    );
  }

  function contentSnapshot() {
    const { accounts, groups, projects, spaces } = activeProjection();
    const entry = directoryProjection(accounts, groups, spaces)
      .find((candidate) => candidate.key === selectedKey());
    return {
      entry,
      visibleSpaces: spaces.filter((space) => directoryKey(space) === selectedKey()),
      projects,
      archivedSpaces: archived?.filter((space) => directoryKey(space) === selectedKey()) ?? archived,
      currentSpaceId,
      canCreateSpace: selectedTarget().seats.length > 0,
    };
  }

  const content = createSpaceNavigatorContent({
    host: spacesPanel,
    getSnapshot: contentSnapshot,
    actions: {
      navigate,
      createSpace,
      editGroup: editGroupDirectory,
      togglePin,
      archiveSpace,
      restoreSpace,
      deleteSpace,
      toggleArchived,
    },
  });

  function ensureSelectedDirectory() {
    const { accounts, groups, spaces } = activeProjection();
    const entries = directoryProjection(accounts, groups, spaces);
    if (!entries.some((entry) => entry.key === selectedKey())) {
      selectDirectory(directoryKey(spaces[0] ?? { seats: [] }));
    }
  }

  function render() {
    renderContacts();
    content.render();
  }

  function scheduleRender() {
    if (renderQueued || destroyed) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      if (destroyed) return;
      render();
    });
  }

  const unsubscribe = runtime.subscribe((envelope) => {
    if (envelope.type === "runtime.reset") {
      archived = null;
    } else if (envelope.type === "space.deleted" && envelope.data?.spaceId && archived !== null) {
      archived = archived.filter((item) => item.id !== envelope.data.spaceId);
    } else if (envelope.type === "space.updated" && envelope.data?.space && archived !== null) {
      const space = envelope.data.space;
      archived = space.archivedAt
        ? [...archived.filter((item) => item.id !== space.id), space]
        : archived.filter((item) => item.id !== space.id);
    } else if (![
      "space.updated",
      "space.deleted",
      "group.updated",
      "group.deleted",
      "project.updated",
      "project.deleted",
      "account.upserted",
      "account.presence.updated",
    ].includes(envelope.type)) {
      return;
    }
    ensureSelectedDirectory();
    scheduleRender();
  });

  render();

  return {
    element: panel,
    resizeHandle,
    focusFirst() { panel.querySelector("button")?.focus(); },
    cancelDialogs,
    setCurrentSpace(spaceId) {
      currentSpaceId = spaceId;
      const { spaces } = activeProjection();
      selectDirectory(directoryKey(
        spaces.find((space) => space.id === spaceId)
        ?? archived?.find((space) => space.id === spaceId)
        ?? { seats: [] },
      ));
      render();
    },
    destroy() {
      destroyed = true;
      cancelDialogs();
      unsubscribe();
      content.destroy();
      panel.remove();
    },
  };
}
