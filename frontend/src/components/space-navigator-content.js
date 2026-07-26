import { SPACE_TYPES, getSpaceType } from "../../../src/spaces/space-types.js";
import { createVectorIcon, setIconButtonContent } from "./vector-icon.js";
import {
  activityTime,
  filterAndSortSpaces,
  sortProjectGroups,
} from "./space-navigator-projection.js";

const SORT_OPTIONS = [
  { id: "recents", label: "Recents", hint: "按最近活动排序" },
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

  function renderHeader({ entry, canCreateSpace }) {
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
    titleLine.appendChild(title);
    if (entry?.kind === "group") {
      titleLine.appendChild(makeNavigatorIconButton(
        "edit",
        "vera-navigator__group-edit",
        "编辑群聊",
        () => void actions.editGroup(entry.group),
      ));
    }
    copy.appendChild(titleLine);
    identity.append(avatar, copy);
    header.appendChild(identity);

    const tools = document.createElement("div");
    tools.className = "vera-navigator__tools";
    const searchWrap = document.createElement("label");
    searchWrap.className = "vera-navigator__search";
    searchWrap.appendChild(createVectorIcon("search"));
    const search = document.createElement("input");
    search.type = "search";
    search.value = query;
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
    const createButton = makeNavigatorIconButton(
      "compose",
      "vera-navigator__create",
      "新建 Space",
      () => void actions.createSpace(),
    );
    createButton.disabled = !canCreateSpace;
    tools.append(searchWrap, createButton);
    header.appendChild(tools);
    return header;
  }

  function renderSpaceRow(space, projects, currentSpaceId, { isArchived = false } = {}) {
    const row = document.createElement("article");
    row.className = [
      "vera-space-row",
      space.id === currentSpaceId ? "is-active" : "",
      isArchived ? "is-archived" : "",
    ].filter(Boolean).join(" ");
    const open = makeNavigatorButton("vera-space-row__open", () => actions.navigate(space.id));
    const icon = document.createElement("span");
    icon.className = `vera-space-row__type is-${space.spaceType}`;
    icon.appendChild(createVectorIcon(getSpaceType(space.spaceType).icon));
    const copy = document.createElement("span");
    copy.className = "vera-space-row__copy";
    const name = document.createElement("strong");
    name.textContent = space.name;
    copy.append(name);
    open.append(icon, copy);
    const rowLead = document.createElement("div");
    rowLead.className = "vera-space-row__lead";
    rowLead.appendChild(open);

    const rowActions = document.createElement("div");
    rowActions.className = "vera-space-row__actions";
    let trailingArchive = null;
    if (isArchived) {
      rowLead.prepend(makeNavigatorIconButton(
        "retry",
        "vera-space-row__action is-icon vera-space-row__restore",
        "恢复 Space",
        () => void actions.restoreSpace(space),
      ));
      rowActions.append(
        makeNavigatorIconButton(
          "trash",
          "vera-space-row__action is-icon",
          "永久删除 Space",
          () => void actions.deleteSpace(space),
        ),
      );
    } else {
      const pin = makeNavigatorIconButton(
        "pin",
        `vera-space-row__pin${space.pinned ? " is-pinned" : ""}`,
        space.pinned ? "取消置顶" : "置顶",
        () => void actions.togglePin(space),
      );
      trailingArchive = makeNavigatorIconButton(
        "archive",
        "vera-space-row__action is-icon is-danger is-trailing",
        "归档 Space",
        () => void actions.archiveSpace(space),
      );
      rowLead.prepend(pin);
    }

    row.append(rowLead, rowActions);
    const projectIndex = projects.findIndex((item) => item.id === space.projectId);
    if (projectIndex >= 0) {
      const projectView = document.createElement("span");
      projectView.className = `vera-space-row__project is-palette-${projectIndex % 4}`;
      const dot = document.createElement("span");
      dot.className = "vera-space-row__project-dot";
      const projectName = document.createElement("span");
      projectName.textContent = projects[projectIndex].name;
      projectView.append(dot, projectName);
      row.appendChild(projectView);
    }
    if (trailingArchive) row.appendChild(trailingArchive);
    return row;
  }

  function appendSection(hostElement, label, items, projects, currentSpaceId, {
    icon = null,
    emptyText = "",
    className = "",
    showHeading = true,
  } = {}) {
    const section = document.createElement("section");
    section.className = `vera-space-section ${className}`.trim();
    if (showHeading) {
      const heading = document.createElement("div");
      heading.className = "vera-space-section__heading";
      if (icon) heading.appendChild(createVectorIcon(icon));
      const text = document.createElement("strong");
      text.className = "vera-navigator__section-title";
      text.textContent = label;
      heading.appendChild(text);
      section.appendChild(heading);
    }
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

  function renderSortBar(hostElement) {
    const bar = document.createElement("div");
    bar.className = "vera-navigator__sort";
    const current = SORT_OPTIONS.find((option) => option.id === sortMode);
    const label = document.createElement("strong");
    label.className = "vera-navigator__section-title";
    label.textContent = "ALL";
    const line = document.createElement("span");
    line.className = "vera-navigator__sort-line";
    const currentSort = document.createElement("span");
    currentSort.textContent = current.label;
    const menuButton = makeNavigatorIconButton(
      "sort",
      "vera-navigator__sort-button",
      "切换排序",
      () => {
        sortOpen = !sortOpen;
        render();
      },
    );
    menuButton.setAttribute("aria-expanded", String(sortOpen));
    bar.append(label, line, currentSort, menuButton);
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
    host.appendChild(renderHeader({ entry, canCreateSpace }));
    const filtered = filterAndSortSpaces(visibleSpaces, projects, query);
    const scroll = document.createElement("div");
    scroll.className = "vera-navigator__scroll";
    const pinned = filtered.filter((space) => space.pinned);
    const rest = filtered.filter((space) => !space.pinned);
    appendSection(scroll, "PINNED", pinned, projects, currentSpaceId, {
      className: "is-pinned",
    });
    renderSortBar(scroll);
    if (sortMode === "recents") {
      appendSection(scroll, "", rest, projects, currentSpaceId, {
        className: "is-all",
        showHeading: false,
      });
    } else if (sortMode === "projects") {
      const projectGroups = sortProjectGroups([...projects, { id: null, name: "No project" }]
        .map((project) => ({ ...project, items: rest.filter((space) => space.projectId === project.id) }))
        .filter((group) => group.items.length));
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
    );
    archivedToggle.setAttribute(
      "aria-label",
      archivedSpaces === null ? "展开 ARCHIVED" : "收起 ARCHIVED",
    );
    const archivedLabel = document.createElement("strong");
    archivedLabel.className = "vera-navigator__section-title";
    archivedLabel.textContent = "ARCHIVED";
    const archivedLine = document.createElement("span");
    archivedLine.className = "vera-navigator__sort-line";
    archivedToggle.append(archivedLabel, archivedLine);
    scroll.appendChild(archivedToggle);
    if (archivedSpaces) {
      const sortedArchived = [...archivedSpaces]
        .sort((left, right) => activityTime(right) - activityTime(left));
      appendSection(scroll, "", sortedArchived, projects, currentSpaceId, {
        emptyText: "此联系人或群组没有已归档 Space。",
        className: "is-archived",
        showHeading: false,
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
