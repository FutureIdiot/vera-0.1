import { createHttpClient } from "../api/http-client.js";
import { createSpacesClient } from "../api/spaces-client.js";

function memberKey(space) {
  const ids = [...new Set((space.seats ?? []).map((seat) => seat.agentId))].sort();
  return ids.length > 1 ? `group:${ids.join(",")}` : `agent:${ids[0] ?? "none"}`;
}

function memberProjection(agents, spaces) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const entries = agents.map((agent) => ({ key: `agent:${agent.id}`, label: agent.name, agentIds: [agent.id] }));
  const seen = new Set(entries.map((entry) => entry.key));
  for (const space of spaces) {
    const key = memberKey(space);
    if (seen.has(key) || !key.startsWith("group:")) continue;
    const agentIds = key.slice(6).split(",");
    entries.push({ key, agentIds, label: agentIds.map((id) => byId.get(id)?.name ?? id).join("、") });
    seen.add(key);
  }
  return entries;
}

export function createSpaceNavigator({ platform, runtime, currentSpaceId, pinned = false, onClose } = {}) {
  const client = createSpacesClient(createHttpClient(platform));
  let spaces = [...runtime.getBootstrap().spaces];
  let archived = null;
  let selectedKey = memberKey(spaces.find((space) => space.id === currentSpaceId) ?? spaces[0] ?? { seats: [] });
  let isPinned = pinned;

  const panel = document.createElement("aside");
  panel.className = "vera-navigator";
  panel.setAttribute("aria-label", "Space 导航");
  const contacts = document.createElement("nav");
  contacts.className = "vera-navigator__contacts";
  const spacesPanel = document.createElement("section");
  spacesPanel.className = "vera-navigator__spaces";
  panel.append(contacts, spacesPanel);

  function requestText(title, initialValue = "") {
    return new Promise((resolve) => {
      const dialog = document.createElement("form");
      dialog.className = "vera-dialog";
      const heading = document.createElement("strong");
      heading.textContent = title;
      const input = document.createElement("input");
      input.value = initialValue;
      input.required = true;
      input.setAttribute("aria-label", title);
      const actions = document.createElement("div");
      actions.className = "vera-dialog__actions";
      const cancel = button("取消", "vera-text-button", () => finish(null));
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "vera-primary-button";
      submit.textContent = "确定";
      actions.append(cancel, submit);
      dialog.append(heading, input, actions);
      panel.appendChild(dialog);
      input.focus();
      function finish(value) { dialog.remove(); resolve(value); }
      dialog.addEventListener("submit", (event) => { event.preventDefault(); finish(input.value.trim() || null); });
    });
  }

  function confirmAction(message) {
    return new Promise((resolve) => {
      const dialog = document.createElement("section");
      dialog.className = "vera-dialog";
      dialog.setAttribute("role", "dialog");
      const text = document.createElement("p");
      text.textContent = message;
      const actions = document.createElement("div");
      actions.className = "vera-dialog__actions";
      const finish = (value) => { dialog.remove(); resolve(value); };
      actions.append(
        button("取消", "vera-text-button", () => finish(false)),
        button("确认归档", "vera-primary-button vera-primary-button--danger", () => finish(true)),
      );
      dialog.append(text, actions);
      panel.appendChild(dialog);
    });
  }

  function navigate(spaceId) {
    window.location.hash = `#/spaces/${encodeURIComponent(spaceId)}`;
    if (!isPinned) onClose?.();
  }

  function button(label, className, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className;
    el.textContent = label;
    el.addEventListener("click", onClick);
    return el;
  }

  function selectedMembers() {
    const entry = memberProjection(runtime.getBootstrap().agents, spaces).find((candidate) => candidate.key === selectedKey);
    return entry?.agentIds ?? [];
  }

  async function createSpace() {
    const name = await requestText("新 Space 名称");
    if (!name?.trim()) return;
    try {
      const response = await client.createSpace({
        name: name.trim(),
        seats: selectedMembers().map((agentId) => ({ agentId, responseMode: "default" })),
      });
      runtime.mergeSpace(response.space);
      spaces = [...spaces.filter((space) => space.id !== response.space.id), response.space];
      render();
      navigate(response.space.id);
    } catch (err) {
      showError(err.message);
    }
  }

  async function renameSpace(space) {
    const name = await requestText("重命名 Space", space.name);
    if (!name?.trim() || name.trim() === space.name) return;
    try {
      const response = await client.updateSpace(space.id, { name: name.trim() });
      runtime.mergeSpace(response.space);
      spaces = spaces.map((item) => item.id === space.id ? response.space : item);
      render();
    } catch (err) {
      showError(err.message);
    }
  }

  async function archiveSpace(space) {
    if (!await confirmAction(`归档“${space.name}”？历史与会话状态都会保留。`)) return;
    try {
      const response = await client.archiveSpace(space.id);
      runtime.mergeSpace(response.space);
      spaces = spaces.filter((item) => item.id !== space.id);
      archived = [...(archived ?? []).filter((item) => item.id !== response.space.id), response.space];
      render();
      if (space.id === currentSpaceId) {
        const next = spaces.find((item) => memberKey(item) === selectedKey) ?? spaces[0];
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
      spaces = [...spaces.filter((item) => item.id !== response.space.id), response.space];
      selectedKey = memberKey(response.space);
      render();
      navigate(response.space.id);
    } catch (err) {
      showError(err.message);
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
    for (const entry of memberProjection(runtime.getBootstrap().agents, spaces)) {
      const item = button(entry.agentIds.length > 1 ? "群" : entry.label.slice(0, 1), "vera-contact", () => {
        selectedKey = entry.key;
        render();
      });
      item.classList.toggle("is-active", entry.key === selectedKey);
      item.title = entry.label;
      item.setAttribute("aria-label", entry.label);
      contacts.appendChild(item);
    }
    const pin = button(isPinned ? "取消固定" : "固定", "vera-navigator__pin", () => {
      isPinned = !isPinned;
      window.localStorage.setItem("vera.navigatorPinned", String(isPinned));
      panel.dispatchEvent(new CustomEvent("vera:navigator-pin", { detail: { pinned: isPinned } }));
      renderContacts();
    });
    contacts.appendChild(pin);
  }

  function renderSpaceRow(space, { archived: isArchived = false } = {}) {
    const row = document.createElement("div");
    row.className = `vera-space-row${space.id === currentSpaceId ? " is-active" : ""}`;
    const open = button(space.name, "vera-space-row__open", () => navigate(space.id));
    const actions = document.createElement("div");
    actions.className = "vera-space-row__actions";
    if (isArchived) actions.append(button("恢复", "vera-text-button", () => void restoreSpace(space)));
    else actions.append(
      button("改名", "vera-text-button", () => void renameSpace(space)),
      button("归档", "vera-text-button vera-text-button--danger", () => void archiveSpace(space)),
    );
    row.append(open, actions);
    return row;
  }

  function render() {
    renderContacts();
    spacesPanel.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "vera-navigator__heading";
    const title = document.createElement("strong");
    title.textContent = "Spaces";
    heading.append(title, button("新建", "vera-text-button", () => void createSpace()));
    spacesPanel.appendChild(heading);
    const visible = spaces.filter((space) => memberKey(space) === selectedKey);
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "vera-empty";
      empty.textContent = selectedKey === "agent:none" ? "选一个联系人或群组" : "还没有 Space";
      spacesPanel.appendChild(empty);
    }
    for (const space of visible) spacesPanel.appendChild(renderSpaceRow(space));
    const archivedToggle = button(archived === null ? "已归档 Spaces" : "收起已归档", "vera-navigator__archived", () => {
      if (archived === null) void loadArchived();
      else { archived = null; render(); }
    });
    spacesPanel.appendChild(archivedToggle);
    if (archived) for (const space of archived) spacesPanel.appendChild(renderSpaceRow(space, { archived: true }));
  }

  const unsubscribe = runtime.subscribe((envelope) => {
    if (envelope.type === "runtime.reset") {
      spaces = [...envelope.data.bootstrap.spaces];
      archived = null;
      if (!spaces.some((space) => memberKey(space) === selectedKey)) selectedKey = memberKey(spaces[0] ?? { seats: [] });
      render();
      return;
    }
    if (envelope.type !== "space.updated" || !envelope.data?.space) return;
    const space = envelope.data.space;
    spaces = space.archivedAt
      ? spaces.filter((item) => item.id !== space.id)
      : [...spaces.filter((item) => item.id !== space.id), space];
    if (archived) archived = space.archivedAt
      ? [...archived.filter((item) => item.id !== space.id), space]
      : archived.filter((item) => item.id !== space.id);
    render();
  });
  render();

  return {
    element: panel,
    setCurrentSpace(spaceId) { currentSpaceId = spaceId; selectedKey = memberKey(spaces.find((space) => space.id === spaceId) ?? { seats: [] }); render(); },
    destroy() { unsubscribe(); panel.remove(); },
  };
}
