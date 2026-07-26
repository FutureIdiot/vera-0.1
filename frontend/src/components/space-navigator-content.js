import { SPACE_TYPES, getSpaceType } from "../../../src/spaces/space-types.js";
import { createVectorIcon, setIconButtonContent } from "./vector-icon.js";
import {
  activityTime,
  filterAndSortSpaces,
  formatSpaceActivity,
  projectMeta,
} from "./space-navigator-projection.js";

const SORT_OPTIONS = [
  { id: "recents", label: "最近", hint: "按最近活动排序" },
  { id: "projects", label: "Projects", hint: "按 Project 分组" },
  { id: "spacetypes", label: "Space Types", hint: "按 Space Type 分组" },
];

export function makeNavigatorButton(className, onClick, label = "") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

export function makeNavigatorIconButton(icon, className, label, onClick) {
  const element = makeNavigatorButton(className, onClick);
  setIconButtonContent(element, icon, label);
  element.title = label;
  return element;
}

export function createSpaceNavigatorContent({ host, getSnapshot, actions } = {}) {
  let query = "";
  let sortMode = "recents";
  let sortOpen = false;

  function renderHeader({ entry, visibleSpaces, canCreateSpace }) {
    const header = document.createElement("header");
    header.className = "vera-navigator__header";
    const identity = document.createElement("div");
    identity.className = "vera-navigator__identity";
    const avatar = document.createElement("span");
    avatar.className = `vera-navigator__avatar${entry?.kind === "group" ? " is-group" : ""}`;
    avatar.textContent = entry
      ? entry.accountIds.length > 1 ? "群" : entry.label.trim().slice(0, 1).toUpperCase()
      : "?";
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
      titleLine.appendChild(makeNavigatorIconButton(
        "edit",
        "vera-navigator__group-edit",
        "编辑群聊",
        () => void actions.editGroup(entry.group),
      ));
    }
    const subtitle = document.createElement("span");
    subtitle.className = "vera-navigator__subtitle";
    subtitle.textContent = entry?.kind === "group"
      ? `${entry.topic || "暂无主题"} · ${entry.accountIds.length} Accounts`
      : `${entry?.accountIds[0] ?? "未选择"} · ${visibleSpaces.length} Spaces`;
    copy.append(titleLine, subtitle);
    identity.append(avatar, copy);
    header.appendChild(identity);

    const counts = document.createElement("div");
    counts.className = "vera-navigator__type-counts";
    for (const type of SPACE_TYPES) {
      const count = visibleSpaces.filter((space) => space.spaceType === type.id).length;
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
      render();
      queueMicrotask(() => {
        const next = host.querySelector(".vera-navigator__search input");
        next?.focus();
        next?.setSelectionRange(query.length, query.length);
      });
    });
    searchWrap.appendChild(search);
    const createButton = makeNavigatorButton(
      "vera-navigator__create",
      () => void actions.createSpace(),
      "新 Space",
    );
    createButton.prepend(createVectorIcon("plus"));
    createButton.disabled = !canCreateSpace;
    tools.append(searchWrap, createButton);
    header.append(counts, tools);
    return header;
  }

  function renderSpaceRow(space, projects, currentSpaceId, { isArchived = false } = {}) {
    const row = document.createElement("article");
    row.className = `vera-space-row${space.id === currentSpaceId ? " is-active" : ""}`;
    const open = makeNavigatorButton("vera-space-row__open", () => actions.navigate(space.id));
    const icon = document.createElement("span");
    icon.className = `vera-space-row__type is-${space.spaceType}`;
    icon.appendChild(createVectorIcon(getSpaceType(space.spaceType).icon));
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
    time.textContent = formatSpaceActivity(space);
    preview.append(topic, document.createTextNode(" · "), time);
    copy.append(name, preview);
    open.append(icon, copy);

    const rowActions = document.createElement("div");
    rowActions.className = "vera-space-row__actions";
    if (isArchived) {
      rowActions.append(
        makeNavigatorButton("vera-space-row__action", () => void actions.restoreSpace(space), "恢复"),
        makeNavigatorButton("vera-space-row__action is-danger", () => void actions.deleteSpace(space), "删除"),
      );
    } else {
      const pin = makeNavigatorIconButton(
        "pin",
        `vera-space-row__pin${space.pinned ? " is-pinned" : ""}`,
        space.pinned ? "取消置顶" : "置顶",
        () => void actions.togglePin(space),
      );
      const edit = makeNavigatorIconButton(
        "edit",
        "vera-space-row__action is-icon",
        "编辑 Space",
        () => void actions.editSpace(space),
      );
      const archive = makeNavigatorIconButton(
        "archive",
        "vera-space-row__action is-icon is-danger",
        "归档 Space",
        () => void actions.archiveSpace(space),
      );
      rowActions.append(pin, edit, archive);
    }

    const project = projectMeta(projects, space.projectId);
    const projectView = document.createElement("span");
    projectView.className =
      `vera-space-row__project is-palette-${Math.max(0, projects.findIndex((item) => item.id === project.id)) % 4}`;
    const dot = document.createElement("span");
    dot.className = "vera-space-row__project-dot";
    const projectName = document.createElement("span");
    projectName.textContent = project.name;
    projectView.append(dot, projectName);
    row.append(open, rowActions, projectView);
    return row;
  }

  function appendSection(hostElement, label, items, projects, currentSpaceId, {
    icon = null,
    emptyText = "",
    className = "",
  } = {}) {
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
      for (const space of items) {
        rows.appendChild(renderSpaceRow(space, projects, currentSpaceId, {
          isArchived: className.includes("is-archived"),
        }));
      }
      section.appendChild(rows);
    } else if (emptyText) {
      const empty = document.createElement("p");
      empty.className = "vera-space-section__empty";
      empty.textContent = emptyText;
      section.appendChild(empty);
    }
    hostElement.appendChild(section);
  }

  function renderSortBar(hostElement, count) {
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
    const menuButton = makeNavigatorIconButton(
      "chevron-down",
      "vera-navigator__sort-button",
      "切换排序",
      () => {
        sortOpen = !sortOpen;
        render();
      },
    );
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
        const item = makeNavigatorButton("vera-navigator__sort-option", () => {
          sortMode = option.id;
          sortOpen = false;
          render();
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
    hostElement.appendChild(bar);
  }

  function render() {
    const {
      entry,
      visibleSpaces,
      projects,
      archivedSpaces,
      currentSpaceId,
      canCreateSpace,
    } = getSnapshot();
    host.replaceChildren();
    host.appendChild(renderHeader({ entry, visibleSpaces, canCreateSpace }));
    const filtered = filterAndSortSpaces(visibleSpaces, projects, query);
    const scroll = document.createElement("div");
    scroll.className = "vera-navigator__scroll";
    const pinned = filtered.filter((space) => space.pinned);
    const rest = filtered.filter((space) => !space.pinned);
    appendSection(scroll, "Pinned", pinned, projects, currentSpaceId, {
      icon: "pin",
      emptyText: "没有置顶 Space。悬停在 Space 上即可置顶。",
      className: "is-pinned",
    });
    renderSortBar(scroll, rest.length);
    if (sortMode === "recents") {
      appendSection(scroll, "全部 Spaces", rest, projects, currentSpaceId);
    } else if (sortMode === "projects") {
      const projectGroups = [...projects, { id: null, name: "No project" }]
        .map((project) => ({ ...project, items: rest.filter((space) => space.projectId === project.id) }))
        .filter((group) => group.items.length)
        .sort((left, right) => activityTime(right.items[0]) - activityTime(left.items[0]));
      for (const group of projectGroups) {
        appendSection(scroll, group.name, group.items, projects, currentSpaceId, { className: "is-group" });
      }
    } else {
      for (const type of SPACE_TYPES) {
        const items = rest.filter((space) => space.spaceType === type.id);
        if (items.length) {
          appendSection(scroll, type.label, items, projects, currentSpaceId, {
            icon: type.icon,
            className: `is-group is-${type.id}`,
          });
        }
      }
    }
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "vera-empty";
      empty.textContent = query.trim() ? `没有匹配“${query}”的 Space` : "还没有 Space";
      scroll.appendChild(empty);
    }
    const archivedToggle = makeNavigatorButton(
      "vera-navigator__archived",
      () => void actions.toggleArchived(),
      archivedSpaces === null ? "查看已归档 Spaces" : "收起已归档 Spaces",
    );
    scroll.appendChild(archivedToggle);
    if (archivedSpaces) {
      const sortedArchived = [...archivedSpaces]
        .sort((left, right) => activityTime(right) - activityTime(left));
      appendSection(scroll, "Archived", sortedArchived, projects, currentSpaceId, {
        emptyText: "此联系人或群组没有已归档 Space。",
        className: "is-archived",
      });
    }
    host.appendChild(scroll);
  }

  const closeSortMenu = (event) => {
    if (!sortOpen || event.target.closest(".vera-navigator__sort")) return;
    sortOpen = false;
    render();
  };
  host.addEventListener("click", closeSortMenu);

  return {
    render,
    resetFilter() {
      query = "";
      sortOpen = false;
    },
    destroy() {
      host.removeEventListener("click", closeSortMenu);
    },
  };
}
