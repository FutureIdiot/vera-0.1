import { createHttpClient } from "../api/http-client.js";
import { createProjectsClient } from "../api/projects-client.js";
import { createGroupsClient } from "../api/groups-client.js";
import { createSpacesClient } from "../api/spaces-client.js";
import { SPACE_TYPES, getSpaceType } from "../../../src/spaces/space-types.js";
import {
  confirmNavigatorAction,
  confirmSpaceDeletion,
  requestGroupDetails,
  requestSpaceDetails,
} from "./navigator-dialogs.js";
import { createVectorIcon, setIconButtonContent } from "./vector-icon.js";

const SORT_OPTIONS = [
  { id: "recents", label: "最近", hint: "按最近活动排序" },
  { id: "projects", label: "Projects", hint: "按 Project 分组" },
  { id: "spacetypes", label: "Space Types", hint: "按 Space Type 分组" },
];

function directoryKey(space) {
  if (space.groupId) return `group:${space.groupId}`;
  return `account:${space.seats?.[0]?.accountId ?? "none"}`;
}

function activityTime(space) {
  return Date.parse(space.updatedAt ?? space.createdAt ?? "") || 0;
}

function formatAgo(space) {
  const elapsed = Math.max(0, Date.now() - activityTime(space));
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}时`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}天` : `${Math.floor(days / 30)}月`;
}

function directoryProjection(accounts, groups, spaces) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const entries = accounts.map((account) => ({
    key: `account:${account.id}`,
    kind: "direct",
    id: account.id,
    label: account.name,
    topic: "",
    accountIds: [account.id],
    accounts: [account],
  }));
  for (const group of groups) {
    entries.push({
      key: `group:${group.id}`,
      kind: "group",
      id: group.id,
      label: group.name,
      topic: group.topic,
      accountIds: group.accountIds,
      accounts: group.accountIds.map((id) => byId.get(id)).filter(Boolean),
      group,
    });
  }
  return entries.sort((left, right) => {
    const latest = (entry) => Math.max(
      0,
      ...spaces.filter((space) => directoryKey(space) === entry.key).map(activityTime),
    );
    return latest(right) - latest(left) || left.label.localeCompare(right.label);
  });
}

function makeButton(className, onClick, label = "") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function makeIconButton(icon, className, label, onClick) {
  const element = makeButton(className, onClick);
  setIconButtonContent(element, icon, label);
  element.title = label;
  return element;
}

function avatarText(entry) {
  return entry.accountIds.length > 1 ? "群" : entry.label.trim().slice(0, 1).toUpperCase();
}

function typeMeta(spaceType) {
  return getSpaceType(spaceType);
}

function projectMeta(projects, projectId) {
  return projects.find((project) => project.id === projectId) ?? { id: "", name: "No project" };
}

export function resolveSpaceCreationTarget(accounts, groups, selectedKey) {
  const entry = directoryProjection(accounts, groups, []).find((candidate) => candidate.key === selectedKey);
  return {
    groupId: entry?.kind === "group" ? entry.id : null,
    seats: (entry?.accountIds ?? []).map((accountId) => ({ accountId, responseMode: "default" })),
  };
}

export function createSpaceNavigator({ platform, runtime, currentSpaceId } = {}) {
  const http = createHttpClient(platform);
  const client = createSpacesClient(http);
  const projectsClient = createProjectsClient(http);
  const groupsClient = createGroupsClient(http);
  let spaces = [...runtime.getBootstrap().spaces];
  let projects = [...(runtime.getBootstrap().projects ?? [])];
  let groups = [...(runtime.getBootstrap().groups ?? [])];
  let archived = null;
  let query = "";
  let sortMode = "recents";
  let sortOpen = false;
  let selectedKey = directoryKey(spaces.find((space) => space.id === currentSpaceId) ?? spaces[0] ?? { seats: [] });

  const panel = document.createElement("aside");
  panel.className = "vera-navigator";
  panel.setAttribute("aria-label", "Space 目录");
  const contacts = document.createElement("nav");
  contacts.className = "vera-navigator__contacts";
  contacts.setAttribute("aria-label", "最近联系人和群组");
  const spacesPanel = document.createElement("section");
  spacesPanel.className = "vera-navigator__spaces";
  panel.append(contacts, spacesPanel);

  function navigate(spaceId) {
    window.location.hash = `#/spaces/${encodeURIComponent(spaceId)}`;
  }

  function selectedTarget() {
    return resolveSpaceCreationTarget(runtime.getBootstrap().accounts, groups, selectedKey);
  }

  async function createProject(name) {
    const response = await projectsClient.createProject({ name });
    projects = [...projects.filter((item) => item.id !== response.project.id), response.project];
    return response.project;
  }

  async function createGroupDirectory() {
    const details = await requestGroupDetails(panel, {
      title: "新建群聊",
      accounts: runtime.getBootstrap().accounts,
    });
    if (!details?.name) return;
    try {
      const response = await groupsClient.createGroup(details);
      selectedKey = `group:${response.group.id}`;
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
      projects,
      onCreateProject: createProject,
    });
    if (!details?.name) return;
    try {
      const response = await client.createSpace({ ...details, ...target });
      runtime.mergeSpace(response.space);
      spaces = [...spaces.filter((space) => space.id !== response.space.id), response.space];
      render();
      navigate(response.space.id);
    } catch (err) {
      showError(err.message);
    }
  }

  async function editSpace(space) {
    const details = await requestSpaceDetails(panel, {
      title: "编辑 Space",
      initialValue: space,
      projects,
      onCreateProject: createProject,
      allowSpaceType: false,
    });
    if (!details?.name) return;
    try {
      const response = await client.updateSpace(space.id, details);
      runtime.mergeSpace(response.space);
      spaces = spaces.map((item) => item.id === space.id ? response.space : item);
      render();
    } catch (err) {
      showError(err.message);
    }
  }

  async function togglePin(space) {
    try {
      const response = await client.updateSpace(space.id, { pinned: !space.pinned });
      runtime.mergeSpace(response.space);
      spaces = spaces.map((item) => item.id === space.id ? response.space : item);
      render();
    } catch (err) {
      showError(err.message);
    }
  }

  async function archiveSpace(space) {
    if (!await confirmNavigatorAction(panel, `归档“${space.name}”？历史与会话状态都会保留。`)) return;
    try {
      const response = await client.archiveSpace(space.id);
      runtime.mergeSpace(response.space);
      spaces = spaces.filter((item) => item.id !== space.id);
      archived = [...(archived ?? []).filter((item) => item.id !== response.space.id), response.space];
      render();
      if (space.id === currentSpaceId) {
        const next = spaces.find((item) => directoryKey(item) === selectedKey) ?? spaces[0];
        window.location.hash = next ? `#/spaces/${encodeURIComponent(next.id)}` : "#/";
      }
    } catch (err) {
      showError(err.status === 409 ? "有进行中的对话，等结束或取消后再归档" : err.message);
    }
  }

  async function loadArchived() {
    try {
      archived = (await client.listSpaces({ archived: true })).spaces;
      render();
    } catch (err) {
      showError(err.message);
    }
  }

  async function restoreSpace(space) {
    try {
      const response = await client.restoreSpace(space.id);
      runtime.mergeSpace(response.space);
      archived = archived.filter((item) => item.id !== space.id);
      selectedKey = directoryKey(response.space);
      render();
      navigate(response.space.id);
    } catch (err) {
      showError(err.message);
    }
  }

  async function deleteSpace(space) {
    try {
      const { preview } = await client.getDeletionPreview(space.id);
      const choice = await confirmSpaceDeletion(panel, space, preview);
      if (!choice) return;
      await client.deleteSpace(space.id, choice);
      runtime.removeSpace(space.id);
      archived = archived.filter((item) => item.id !== space.id);
      render();
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
    const brand = document.createElement("div");
    brand.className = "vera-contact-brand";
    brand.textContent = "V";
    const recent = document.createElement("span");
    recent.className = "vera-contact-rail-label";
    recent.textContent = "最近";
    const list = document.createElement("div");
    list.className = "vera-contact-list";
    const entries = directoryProjection(runtime.getBootstrap().accounts, groups, spaces);
    for (const entry of entries) {
      const item = makeButton("vera-contact", () => {
        selectedKey = entry.key;
        query = "";
        sortOpen = false;
        render();
      });
      item.classList.toggle("is-active", entry.key === selectedKey);
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
    const createGroup = makeIconButton(
      "plus",
      "vera-contact vera-contact--manage",
      "新建群聊",
      () => void createGroupDirectory(),
    );
    contacts.append(brand, recent, list, createGroup);
  }

  function renderHeader(entry, visible) {
    const header = document.createElement("header");
    header.className = "vera-navigator__header";
    const identity = document.createElement("div");
    identity.className = "vera-navigator__identity";
    const avatar = document.createElement("span");
    avatar.className = `vera-navigator__avatar${entry?.kind === "group" ? " is-group" : ""}`;
    avatar.textContent = entry ? avatarText(entry) : "?";
    const copy = document.createElement("div");
    copy.className = "vera-navigator__identity-copy";
    const titleLine = document.createElement("div");
    titleLine.className = "vera-navigator__title-line";
    const title = document.createElement("strong");
    title.textContent = entry?.label ?? "Space 目录";
    const badge = document.createElement("span");
    badge.className = "vera-navigator__badge";
    badge.textContent = entry?.kind === "group" ? "Group" : "Direct";
    titleLine.append(title, badge);
    if (entry?.kind === "group") {
      const editGroup = makeIconButton(
        "edit",
        "vera-navigator__group-edit",
        "编辑群聊",
        () => void editGroupDirectory(entry.group),
      );
      titleLine.appendChild(editGroup);
    }
    const subtitle = document.createElement("span");
    subtitle.className = "vera-navigator__subtitle";
    subtitle.textContent = entry?.kind === "group"
      ? `${entry.topic || "暂无主题"} · ${entry.accountIds.length} Accounts`
      : `${entry?.accountIds[0] ?? "未选择"} · ${visible.length} Spaces`;
    copy.append(titleLine, subtitle);
    identity.append(avatar, copy);
    header.appendChild(identity);

    const counts = document.createElement("div");
    counts.className = "vera-navigator__type-counts";
    for (const type of SPACE_TYPES) {
      const count = visible.filter((space) => space.spaceType === type.id).length;
      if (count < 1) continue;
      const chip = document.createElement("span");
      chip.className = `vera-type-chip is-${type.id}`;
      chip.append(createVectorIcon(type.icon), document.createTextNode(type.label));
      const number = document.createElement("span");
      number.textContent = String(count);
      chip.appendChild(number);
      counts.appendChild(chip);
    }
    const tools = document.createElement("div");
    tools.className = "vera-navigator__tools";
    const searchWrap = document.createElement("label");
    searchWrap.className = "vera-navigator__search";
    searchWrap.appendChild(createVectorIcon("search"));
    const search = document.createElement("input");
    search.type = "search";
    search.value = query;
    search.placeholder = "筛选 Spaces";
    search.setAttribute("aria-label", "筛选 Spaces");
    search.addEventListener("input", () => {
      query = search.value;
      renderContent();
      queueMicrotask(() => {
        const next = spacesPanel.querySelector(".vera-navigator__search input");
        next?.focus();
        next?.setSelectionRange(query.length, query.length);
      });
    });
    searchWrap.appendChild(search);
    const createButton = makeButton("vera-navigator__create", () => void createSpace(), "新 Space");
    createButton.prepend(createVectorIcon("plus"));
    createButton.disabled = selectedTarget().seats.length === 0;
    tools.append(searchWrap, createButton);
    header.append(counts, tools);
    return header;
  }

  function renderSpaceRow(space, { isArchived = false } = {}) {
    const row = document.createElement("article");
    row.className = `vera-space-row${space.id === currentSpaceId ? " is-active" : ""}`;
    const open = makeButton("vera-space-row__open", () => navigate(space.id));
    const icon = document.createElement("span");
    icon.className = `vera-space-row__type is-${space.spaceType}`;
    icon.appendChild(createVectorIcon(typeMeta(space.spaceType).icon));
    const copy = document.createElement("span");
    copy.className = "vera-space-row__copy";
    const name = document.createElement("strong");
    name.textContent = space.name;
    const preview = document.createElement("span");
    preview.className = "vera-space-row__preview";
    const topic = document.createElement("span");
    topic.textContent = space.topic || "暂无主题";
    const time = document.createElement("time");
    time.className = "vera-space-row__time";
    time.dateTime = space.updatedAt ?? space.createdAt ?? "";
    time.textContent = formatAgo(space);
    preview.append(topic, document.createTextNode(" · "), time);
    copy.append(name, preview);
    open.append(icon, copy);
    const actions = document.createElement("div");
    actions.className = "vera-space-row__actions";
    if (isArchived) {
      actions.append(
        makeButton("vera-space-row__action", () => void restoreSpace(space), "恢复"),
        makeButton("vera-space-row__action is-danger", () => void deleteSpace(space), "删除"),
      );
    } else {
      const pin = makeIconButton("pin", `vera-space-row__pin${space.pinned ? " is-pinned" : ""}`,
        space.pinned ? "取消置顶" : "置顶", () => void togglePin(space));
      const edit = makeIconButton("edit", "vera-space-row__action is-icon", "编辑 Space", () => void editSpace(space));
      const archive = makeIconButton(
        "archive",
        "vera-space-row__action is-icon is-danger",
        "归档 Space",
        () => void archiveSpace(space),
      );
      actions.append(pin, edit, archive);
    }
    const project = projectMeta(projects, space.projectId);
    const projectView = document.createElement("span");
    projectView.className = `vera-space-row__project is-palette-${Math.max(0, projects.findIndex((item) => item.id === project.id)) % 4}`;
    const dot = document.createElement("span");
    dot.className = "vera-space-row__project-dot";
    const projectName = document.createElement("span");
    projectName.textContent = project.name;
    projectView.append(dot, projectName);
    row.append(open, actions, projectView);
    return row;
  }

  function appendSection(host, label, items, { icon = null, emptyText = "", className = "" } = {}) {
    const section = document.createElement("section");
    section.className = `vera-space-section ${className}`.trim();
    const heading = document.createElement("div");
    heading.className = "vera-space-section__heading";
    if (icon) heading.appendChild(createVectorIcon(icon));
    const text = document.createElement("strong");
    text.textContent = label;
    const count = document.createElement("span");
    count.className = "vera-space-section__count";
    count.textContent = String(items.length);
    heading.append(text, count);
    section.appendChild(heading);
    if (items.length) {
      const rows = document.createElement("div");
      rows.className = "vera-space-section__rows";
      for (const space of items) rows.appendChild(renderSpaceRow(space, { isArchived: className.includes("is-archived") }));
      section.appendChild(rows);
    } else if (emptyText) {
      const empty = document.createElement("p");
      empty.className = "vera-space-section__empty";
      empty.textContent = emptyText;
      section.appendChild(empty);
    }
    host.appendChild(section);
  }

  function renderSortBar(host, count) {
    const bar = document.createElement("div");
    bar.className = "vera-navigator__sort";
    const current = SORT_OPTIONS.find((option) => option.id === sortMode);
    const label = document.createElement("strong");
    label.textContent = current.label;
    const hint = document.createElement("span");
    hint.textContent = sortMode === "recents" ? "默认排序" : "分组";
    const line = document.createElement("span");
    line.className = "vera-navigator__sort-line";
    const total = document.createElement("span");
    total.textContent = `${count} Spaces`;
    const menuButton = makeIconButton("chevron-down", "vera-navigator__sort-button", "切换排序", () => {
      sortOpen = !sortOpen;
      renderContent();
    });
    menuButton.classList.toggle("is-open", sortOpen);
    bar.append(label, hint, line, total, menuButton);
    if (sortOpen) {
      const menu = document.createElement("div");
      menu.className = "vera-navigator__sort-menu";
      const menuLabel = document.createElement("span");
      menuLabel.className = "vera-navigator__sort-menu-label";
      menuLabel.textContent = "Spaces 排序";
      menu.appendChild(menuLabel);
      for (const option of SORT_OPTIONS) {
        const item = makeButton("vera-navigator__sort-option", () => {
          sortMode = option.id;
          sortOpen = false;
          renderContent();
        });
        const marker = document.createElement("span");
        marker.className = "vera-navigator__sort-check";
        if (option.id === sortMode) marker.appendChild(createVectorIcon("check"));
        const copy = document.createElement("span");
        const itemLabel = document.createElement("strong");
        itemLabel.textContent = option.label;
        const itemHint = document.createElement("small");
        itemHint.textContent = option.hint;
        copy.append(itemLabel, itemHint);
        item.append(marker, copy);
        menu.appendChild(item);
      }
      bar.appendChild(menu);
    }
    host.appendChild(bar);
  }

  function renderContent() {
    spacesPanel.replaceChildren();
    const entries = directoryProjection(runtime.getBootstrap().accounts, groups, spaces);
    const entry = entries.find((candidate) => candidate.key === selectedKey);
    const visible = spaces.filter((space) => directoryKey(space) === selectedKey);
    spacesPanel.appendChild(renderHeader(entry, visible));
    const q = query.trim().toLocaleLowerCase();
    const filtered = visible.filter((space) => {
      const project = projectMeta(projects, space.projectId);
      const haystack = [space.name, space.topic, typeMeta(space.spaceType).label, project.name].join(" ").toLocaleLowerCase();
      return !q || haystack.includes(q);
    }).sort((left, right) => activityTime(right) - activityTime(left) || left.name.localeCompare(right.name));
    const scroll = document.createElement("div");
    scroll.className = "vera-navigator__scroll";
    const pinned = filtered.filter((space) => space.pinned);
    const rest = filtered.filter((space) => !space.pinned);
    appendSection(scroll, "Pinned", pinned, {
      icon: "pin",
      emptyText: "没有置顶 Space。悬停在 Space 上即可置顶。",
      className: "is-pinned",
    });
    renderSortBar(scroll, rest.length);
    if (sortMode === "recents") {
      appendSection(scroll, "全部 Spaces", rest);
    } else if (sortMode === "projects") {
      const projectGroups = [...projects, { id: null, name: "No project" }]
        .map((project) => ({ ...project, items: rest.filter((space) => space.projectId === project.id) }))
        .filter((group) => group.items.length)
        .sort((left, right) => activityTime(right.items[0]) - activityTime(left.items[0]));
      for (const group of projectGroups) appendSection(scroll, group.name, group.items, { className: "is-group" });
    } else {
      for (const type of SPACE_TYPES) {
        const items = rest.filter((space) => space.spaceType === type.id);
        if (items.length) appendSection(scroll, type.label, items, { icon: type.icon, className: `is-group is-${type.id}` });
      }
    }
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "vera-empty";
      empty.textContent = q ? `没有匹配“${query}”的 Space` : "还没有 Space";
      scroll.appendChild(empty);
    }
    const archivedToggle = makeButton("vera-navigator__archived", () => {
      if (archived === null) void loadArchived();
      else {
        archived = null;
        renderContent();
      }
    }, archived === null ? "查看已归档 Spaces" : "收起已归档 Spaces");
    scroll.appendChild(archivedToggle);
    if (archived) {
      const archivedVisible = archived
        .filter((space) => directoryKey(space) === selectedKey)
        .sort((left, right) => activityTime(right) - activityTime(left));
      appendSection(scroll, "Archived", archivedVisible, {
        emptyText: "此联系人或群组没有已归档 Space。",
        className: "is-archived",
      });
    }
    spacesPanel.appendChild(scroll);
  }

  function render() {
    renderContacts();
    renderContent();
  }

  const unsubscribe = runtime.subscribe((envelope) => {
    if (envelope.type === "runtime.reset") {
      spaces = [...envelope.data.bootstrap.spaces];
      projects = [...(envelope.data.bootstrap.projects ?? [])];
      groups = [...(envelope.data.bootstrap.groups ?? [])];
      archived = null;
      const entries = directoryProjection(runtime.getBootstrap().accounts, groups, spaces);
      if (!entries.some((entry) => entry.key === selectedKey)) {
        selectedKey = directoryKey(spaces[0] ?? { seats: [] });
      }
    } else if (envelope.type === "space.deleted" && envelope.data?.spaceId) {
      spaces = spaces.filter((item) => item.id !== envelope.data.spaceId);
      if (archived) archived = archived.filter((item) => item.id !== envelope.data.spaceId);
    } else if (envelope.type === "space.updated" && envelope.data?.space) {
      const space = envelope.data.space;
      spaces = space.archivedAt
        ? spaces.filter((item) => item.id !== space.id)
        : [...spaces.filter((item) => item.id !== space.id), space];
      if (archived) archived = space.archivedAt
        ? [...archived.filter((item) => item.id !== space.id), space]
        : archived.filter((item) => item.id !== space.id);
    } else if (envelope.type === "project.updated" && envelope.data?.project) {
      const project = envelope.data.project;
      projects = [...projects.filter((item) => item.id !== project.id), project];
    } else if (envelope.type === "project.deleted" && envelope.data?.projectId) {
      projects = projects.filter((item) => item.id !== envelope.data.projectId);
    } else if (envelope.type === "group.updated" && envelope.data?.group) {
      const group = envelope.data.group;
      groups = [...groups.filter((item) => item.id !== group.id), group];
    } else if (envelope.type === "group.deleted" && envelope.data?.groupId) {
      groups = groups.filter((item) => item.id !== envelope.data.groupId);
      if (selectedKey === `group:${envelope.data.groupId}`) {
        selectedKey = directoryKey(spaces[0] ?? { seats: [] });
      }
    } else {
      return;
    }
    render();
  });
  const closeSortMenu = (event) => {
    if (!sortOpen || event.target.closest(".vera-navigator__sort")) return;
    sortOpen = false;
    renderContent();
  };
  panel.addEventListener("click", closeSortMenu);
  render();

  return {
    element: panel,
    focusFirst() { panel.querySelector("button")?.focus(); },
    setCurrentSpace(spaceId) {
      currentSpaceId = spaceId;
      selectedKey = directoryKey(
        spaces.find((space) => space.id === spaceId)
        ?? archived?.find((space) => space.id === spaceId)
        ?? { seats: [] },
      );
      render();
    },
    destroy() {
      unsubscribe();
      panel.removeEventListener("click", closeSortMenu);
      panel.remove();
    },
  };
}
