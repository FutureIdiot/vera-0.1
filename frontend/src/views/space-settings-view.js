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
  const topic = document.createElement("textarea");
  topic.name = "topic";
  topic.value = space.topic ?? "";
  topic.placeholder = "这个 Space 在讨论什么";
  basic.append(basicLegend, name, topic);

  const participants = document.createElement("fieldset");
  const participantLegend = document.createElement("legend");
  participantLegend.textContent = "参与 Account 与响应规则";
  participants.appendChild(participantLegend);
  const seatControls = new Map();
  for (const account of bootstrap.accounts) {
    const seat = space.seats.find((candidate) => candidate.accountId === account.id);
    const row = document.createElement("section");
    row.className = "vera-agent-rule";
    const included = checkbox(account.name, Boolean(seat));
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", `${account.name} 响应模式`);
    for (const [value, label] of [["default", "默认：都响应"], ["silent", "静默：仅指定来源 @"], ["focused", "专注：仅 @自己"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      mode.appendChild(option);
    }
    mode.value = seat?.responseMode ?? "default";
    mode.disabled = !included.input.checked;
    included.input.addEventListener("change", () => { mode.disabled = !included.input.checked; });
    const sources = document.createElement("div");
    sources.className = "vera-agent-rule__details";
    const userSource = checkbox("静默时响应用户", seat?.respondTo?.includes("user"));
    sources.appendChild(userSource.label);
    const respondSources = new Map([["user", userSource.input]]);
    const blocked = new Map();
    for (const other of bootstrap.accounts.filter((candidate) => candidate.id !== account.id)) {
      const responseSource = checkbox(`响应 ${other.name}`, seat?.respondTo?.includes(other.id));
      const control = checkbox(`屏蔽 ${other.name}`, seat?.blockAccountIds?.includes(other.id));
      respondSources.set(other.id, responseSource.input);
      blocked.set(other.id, control.input);
      sources.append(responseSource.label, control.label);
    }
    row.append(included.label, mode, sources);
    participants.appendChild(row);
    seatControls.set(account.id, { included: included.input, mode, respondSources, blocked });
  }

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
  form.append(basic, participants, notifications, error, save);
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
    topic.value = space.topic ?? "";
    notificationMode.value = space.notifications?.mode ?? "accountMessages";
    includeErrors.input.checked = space.notifications?.includeActivityErrors !== false;
    for (const [accountId, control] of seatControls) {
      const seat = space.seats.find((candidate) => candidate.accountId === accountId);
      control.included.checked = Boolean(seat);
      control.mode.disabled = !seat;
      control.mode.value = seat?.responseMode ?? "default";
      for (const [sourceId, input] of control.respondSources) input.checked = seat?.respondTo?.includes(sourceId) ?? false;
      for (const [blockedId, input] of control.blocked) input.checked = seat?.blockAccountIds?.includes(blockedId) ?? false;
    }
    shell?.setSpace(space);
  }

  form.addEventListener("input", () => { dirty = true; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const seats = [];
    for (const [accountId, control] of seatControls) {
      if (!control.included.checked) continue;
      const respondTo = [...control.respondSources].filter(([, input]) => input.checked).map(([id]) => id);
      const blockAccountIds = [...control.blocked].filter(([, input]) => input.checked).map(([id]) => id);
      seats.push({ accountId, responseMode: control.mode.value, ...(respondTo.length ? { respondTo } : {}), ...(blockAccountIds.length ? { blockAccountIds } : {}) });
    }
    if (!seats.length) {
      error.textContent = "Space 至少需要一个参与 Account。";
      error.hidden = false;
      return;
    }
    saving = true;
    save.disabled = true;
    try {
      const response = await client.updateSpace(space.id, {
        name: name.value.trim(),
        topic: topic.value.trim(),
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
