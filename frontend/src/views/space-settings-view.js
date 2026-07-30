import { createHttpClient } from "../api/http-client.js";
import { createSpacesClient } from "../api/spaces-client.js";

function checkbox(labelText, checked = false) {
  const label = document.createElement("label");
  label.className = "vera-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(input, text);
  return { label, input };
}

function projectSeat(
  seat,
  responseMode = seat?.responseMode ?? "default",
  respondTo = seat?.respondTo,
  approvalPolicy = seat?.approvalPolicy ?? "ask",
) {
  return {
    accountId: seat.accountId,
    responseMode,
    approvalPolicy,
    ...(Array.isArray(respondTo) && respondTo.length ? { respondTo: [...respondTo] } : {}),
    ...(Array.isArray(seat.blockAccountIds) && seat.blockAccountIds.length
      ? { blockAccountIds: [...seat.blockAccountIds] }
      : {}),
  };
}

export function mountSpaceSettingsView({ root, platform, runtime, spaceId, shell } = {}) {
  const client = createSpacesClient(createHttpClient(platform));
  const bootstrap = runtime.getBootstrap();
  let space = bootstrap.spaces.find((candidate) => candidate.id === spaceId) ?? null;
  let dirty = false;
  let saving = false;
  let mounted = true;
  root.dataset.routeScope = "management";
  shell?.setManagementHeader({
    title: "当前 Space 设置",
    backHref: `#/spaces/${encodeURIComponent(spaceId)}`,
    backLabel: "返回",
  });

  if (!space) {
    const missing = document.createElement("p");
    missing.className = "vera-route-error";
    missing.textContent = "Space 不存在。";
    root.appendChild(missing);
    return () => root.replaceChildren();
  }

  const form = document.createElement("form");
  form.className = "vera-space-form";
  const basic = document.createElement("fieldset");
  const basicLegend = document.createElement("legend");
  basicLegend.textContent = "基本信息";
  const name = document.createElement("input");
  name.name = "name";
  name.required = true;
  name.value = space.name;
  name.placeholder = "Space 名称";
  basic.append(basicLegend, name);

  const grouped = Boolean(space.groupId);
  const participants = grouped ? document.createElement("fieldset") : null;
  const seatControls = new Map();
  const permissionControls = new Map();

  if (participants) {
    const participantLegend = document.createElement("legend");
    participantLegend.textContent = "参与 Account";
    participants.appendChild(participantLegend);
  }

  function renderParticipants() {
    if (!participants) return;
    const participantLegend = participants.children[0];
    participants.replaceChildren(participantLegend);
    seatControls.clear();
    const accountById = new Map(runtime.getBootstrap().accounts.map((account) => [account.id, account]));
    for (const seat of space.seats ?? []) {
      const account = accountById.get(seat.accountId);
      const row = document.createElement("div");
      row.className = "vera-space-participant";
      const name = document.createElement("span");
      name.className = "vera-space-participant__name";
      name.textContent = account?.name ?? "未知 Account";
      const mode = document.createElement("select");
      mode.setAttribute("aria-label", `${name.textContent} 响应模式`);
      for (const [value, label] of [["default", "默认"], ["focused", "专注"], ["mentioned", "仅点名"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        mode.appendChild(option);
      }
      mode.value = seat.responseMode ?? "default";
      const sourceField = document.createElement("div");
      sourceField.className = "vera-space-response-sources";
      sourceField.hidden = mode.value !== "focused";
      const sourceLabel = document.createElement("small");
      sourceLabel.textContent = "响应来源";
      const sourceOptions = document.createElement("div");
      sourceOptions.className = "vera-space-response-sources__options";
      const respondTo = new Map();
      const candidates = [
        { id: "user", name: "User" },
        ...(space.seats ?? [])
          .filter((candidate) => candidate.accountId !== seat.accountId)
          .map((candidate) => ({
            id: candidate.accountId,
            name: accountById.get(candidate.accountId)?.name ?? "未知 Account",
          })),
      ];
      for (const candidate of candidates) {
        const option = document.createElement("label");
        option.className = "vera-space-response-source";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = candidate.id;
        input.checked = seat.respondTo?.includes(candidate.id) ?? false;
        input.setAttribute("aria-label", `${name.textContent} 响应 ${candidate.name}`);
        const text = document.createElement("span");
        text.textContent = candidate.name;
        option.append(input, text);
        sourceOptions.appendChild(option);
        respondTo.set(candidate.id, input);
      }
      sourceField.append(sourceLabel, sourceOptions);
      mode.addEventListener("change", () => {
        sourceField.hidden = mode.value !== "focused";
      });
      row.append(name, mode, sourceField);
      participants.appendChild(row);
      seatControls.set(seat.accountId, { mode, respondTo });
    }
  }

  renderParticipants();

  const permissions = document.createElement("fieldset");
  const permissionLegend = document.createElement("legend");
  permissionLegend.textContent = "权限";
  const permissionList = document.createElement("div");
  permissionList.className = "vera-settings-list vera-space-permission-list";
  permissions.append(permissionLegend, permissionList);

  function renderPermissions() {
    permissionList.replaceChildren();
    permissionControls.clear();
    const currentBootstrap = runtime.getBootstrap();
    const accountById = new Map(currentBootstrap.accounts.map((account) => [account.id, account]));
    const agentById = new Map((currentBootstrap.agents ?? []).map((agent) => [agent.id, agent]));
    for (const seat of space.seats ?? []) {
      const account = accountById.get(seat.accountId);
      const agentId = account?.activeAgentId ?? account?.ownerAgentId;
      const agentName = agentById.get(agentId)?.name ?? account?.name ?? "未知 Agent";
      const row = document.createElement("div");
      row.className = "vera-settings-row vera-space-permission-row";
      const identity = document.createElement("span");
      identity.textContent = agentName;
      const policy = document.createElement("select");
      policy.setAttribute("aria-label", `${agentName} 权限策略`);
      for (const [value, label] of [["ask", "Ask for"], ["approve", "Approve for me"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        policy.appendChild(option);
      }
      policy.value = seat.approvalPolicy ?? "ask";
      row.append(identity, policy);
      permissionList.appendChild(row);
      permissionControls.set(seat.accountId, policy);
    }
  }

  renderPermissions();

  /*
   * Direct Space的唯一Seat由目录归属固定；Group成员由Group管理。
   * 本页编辑所有现有Seat的approvalPolicy，以及Group Seat的
   * responseMode/respondTo；隐藏的blockAccountIds在projectSeat中原样保留。
   */
  const notifications = document.createElement("fieldset");
  const notificationLegend = document.createElement("legend");
  notificationLegend.textContent = "消息提醒";
  const notificationMode = document.createElement("select");
  for (const [value, label] of [["all", "全部消息与 Activity"], ["accountMessages", "只提醒 Account 消息"], ["off", "关闭"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    notificationMode.appendChild(option);
  }
  notificationMode.value = space.notifications?.mode ?? "accountMessages";
  const includeErrors = checkbox("仍提醒错误 Activity", space.notifications?.includeActivityErrors !== false);
  notifications.append(notificationLegend, notificationMode, includeErrors.label);

  const error = document.createElement("p");
  error.className = "vera-inline-error";
  error.hidden = true;
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "vera-primary-button";
  save.textContent = "保存设置";
  save.disabled = !space.seats?.length;
  form.append(basic);
  if (participants) form.appendChild(participants);
  form.append(permissions, notifications, error, save);
  const historyLink = document.createElement("a");
  historyLink.className = "vera-text-button";
  historyLink.href = `#/spaces/${encodeURIComponent(space.id)}/history`;
  historyLink.textContent = "查看历史对话";
  const filesLink = document.createElement("a");
  filesLink.className = "vera-text-button";
  filesLink.href = `#/spaces/${encodeURIComponent(space.id)}/files`;
  filesLink.textContent = "管理 Space 附件";
  root.append(form, historyLink, filesLink);

  function applyExternalSpace(nextSpace) {
    space = nextSpace;
    name.value = space.name;
    notificationMode.value = space.notifications?.mode ?? "accountMessages";
    includeErrors.input.checked = space.notifications?.includeActivityErrors !== false;
    renderParticipants();
    renderPermissions();
    save.disabled = !space.seats?.length;
    shell?.setSpace(space);
  }

  form.addEventListener("input", () => { dirty = true; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const seats = (space.seats ?? []).map((seat) => {
      const controls = seatControls.get(seat.accountId);
      const respondTo = controls
        ? [...controls.respondTo].filter(([, input]) => input.checked).map(([sourceId]) => sourceId)
        : seat.respondTo;
      return projectSeat(
        seat,
        controls?.mode.value ?? seat.responseMode,
        respondTo,
        permissionControls.get(seat.accountId)?.value ?? seat.approvalPolicy,
      );
    });
    if (!seats.length) {
      error.textContent = "这个 Space 的参与 Account 数据异常，无法保存。";
      error.hidden = false;
      return;
    }
    saving = true;
    save.disabled = true;
    try {
      const response = await client.updateSpace(space.id, {
        name: name.value.trim(),
        seats,
        notifications: { mode: notificationMode.value, includeActivityErrors: includeErrors.input.checked },
      });
      if (!mounted) return;
      space = response.space;
      dirty = false;
      shell?.setSpace(space);
      save.textContent = "已保存";
      setTimeout(() => { if (mounted) save.textContent = "保存设置"; }, 1200);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      saving = false;
      save.disabled = false;
    }
  });

  const beforeUnload = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const unsubscribeRuntime = runtime.subscribe((envelope) => {
    if (envelope.type === "runtime.reset") {
      const next = envelope.data.bootstrap.spaces.find((candidate) => candidate.id === space.id);
      if (next && !dirty) applyExternalSpace(next);
      return;
    }
    if (envelope.type !== "space.updated" || envelope.data?.space?.id !== space.id) return;
    if (saving) return;
    if (dirty) {
      error.textContent = "这个 Space 刚在别处改过；请重新加载后再保存。";
      error.hidden = false;
      save.disabled = true;
      return;
    }
    applyExternalSpace(envelope.data.space);
  }, { since: bootstrap.seq });
  return () => {
    if (dirty && !window.confirm("有未保存的 Space 设置，确定离开？")) {
      return false;
    }
    mounted = false;
    unsubscribeRuntime();
    window.removeEventListener("beforeunload", beforeUnload);
    root.replaceChildren();
    return true;
  };
}
