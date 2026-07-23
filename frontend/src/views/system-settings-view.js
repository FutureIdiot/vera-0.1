import { createHttpClient } from "../api/http-client.js";
import { createSettingsClient } from "../api/settings-client.js";
import { createSystemUpdateClient } from "../api/system-update-client.js";
import { createNotice, field, input, select, setBusy } from "../components/management-ui.js";
import { createPagePoller } from "../hooks/page-poller.js";

const GROUPS = [
  {
    title: "数据隔离",
    fields: [
      ["isolation.memory", "Memory（固定按 Agent 隔离）", "select", [["isolated", "隔离"]]],
      ["isolation.files", "Files", "select", [["isolated", "隔离"], ["specifiedShared", "指定 Space 共享"], ["globalReadable", "全局可读"]]],
      ["isolation.agentState", "Agent State", "select", [["isolated", "隔离"], ["globalVisible", "全局可见"]]],
    ],
  },
  {
    title: "记忆整理",
    fields: [
      ["memory.injectionBudgetResidentLines", "常驻索引行数", "number", { min: 0, step: 1 }],
      ["memory.injectionBudgetRetrievalTokens", "每轮记忆检索 Token 预算", "number", { min: 0, max: 4096, step: 1 }],
    ],
  },
  {
    title: "消息呈现",
    fields: [
      ["presentation.bubbleBoundaryPattern", "段落边界正则", "text"],
      ["presentation.bubbleMinLength", "单气泡最短长度", "number", { min: 0, step: 1 }],
      ["presentation.bubbleMaxLength", "单气泡最长长度", "number", { min: 0, step: 1 }],
    ],
  },
];

const ACTIVE_UPDATE_STATES = new Set(["checking", "queued", "updating"]);
const UPDATE_LABELS = {
  disabled: "未配置",
  idle: "尚未检查",
  checking: "正在检查",
  up_to_date: "已是最新",
  available: "发现更新",
  queued: "等待更新服务",
  updating: "正在更新 Gateway",
  succeeded: "更新成功",
  failed: "更新失败",
  rolled_back: "更新失败，已回滚",
};

function statusRow(label, value) {
  const row = document.createElement("div");
  row.className = "vera-status-row";
  const term = document.createElement("span");
  term.textContent = label;
  const detail = document.createElement("strong");
  detail.textContent = value;
  row.append(term, detail);
  return { row, detail };
}

function shortCommit(value) {
  return typeof value === "string" ? value.slice(0, 12) : "未知（旧部署）";
}

export async function mountSystemSettingsView({ root, platform, shell } = {}) {
  root.dataset.routeScope = "management";
  const client = createSettingsClient(createHttpClient(platform));
  const updateClient = createSystemUpdateClient(createHttpClient(platform));
  let disposed = false;
  let dirty = false;
  let loaded = {};
  const controls = new Map();
  const onBeforeUnload = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", onBeforeUnload);
  shell?.setManagementHeader({ title: "System", backHref: "#/settings", backLabel: "返回" });
  const form = document.createElement("form");
  form.className = "vera-management-form";
  const notice = createNotice("正在读取设置…");
  form.appendChild(notice);

  const updateSection = document.createElement("fieldset");
  const updateLegend = document.createElement("legend");
  updateLegend.textContent = "Gateway 更新";
  const updateHint = createNotice("这里只更新当前 Gateway；Agent daemon 和客户端不会随之更新。");
  const updateState = statusRow("状态", "正在读取…");
  const currentCommit = statusRow("当前 commit", "—");
  const targetCommit = statusRow("目标 commit", "—");
  const updateNotice = createNotice("正在读取更新状态…");
  const updateActions = document.createElement("div");
  updateActions.className = "vera-form-actions";
  const checkUpdate = document.createElement("button");
  checkUpdate.type = "button";
  checkUpdate.className = "vera-secondary-button";
  checkUpdate.textContent = "检查更新";
  const applyUpdate = document.createElement("button");
  applyUpdate.type = "button";
  applyUpdate.className = "vera-primary-button";
  applyUpdate.textContent = "立即更新";
  const reloadPage = document.createElement("button");
  reloadPage.type = "button";
  reloadPage.className = "vera-secondary-button";
  reloadPage.textContent = "刷新页面";
  reloadPage.hidden = true;
  updateActions.append(checkUpdate, applyUpdate, reloadPage);
  updateSection.append(updateLegend, updateHint, updateState.row, currentCommit.row, targetCommit.row, updateNotice, updateActions);
  form.appendChild(updateSection);

  for (const group of GROUPS) {
    const section = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = group.title;
    section.appendChild(legend);
    for (const [key, label, kind, options] of group.fields) {
      const control = kind === "select" ? select("", options) : input({ type: kind, ...(options ?? {}) });
      control.name = key;
      control.addEventListener("input", () => { dirty = true; notice.textContent = "有未保存更改"; });
      controls.set(key, control);
      section.appendChild(field(label, control));
    }
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "vera-secondary-button";
    reset.textContent = "本组恢复默认";
    reset.addEventListener("click", async () => {
      setBusy(reset, true);
      try {
        const patch = Object.fromEntries(group.fields.map(([key]) => [key, null]));
        const response = await client.update(patch);
        loaded = response.settings;
        fill();
        dirty = false;
        notice.textContent = "已恢复并保存默认值";
      } catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
      finally { setBusy(reset, false); }
    });
    section.appendChild(reset);
    form.appendChild(section);
  }
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "vera-primary-button";
  save.textContent = "保存系统设置";
  form.appendChild(save);
  root.appendChild(form);

  let update = null;
  function renderUpdate() {
    const state = update?.state ?? "disabled";
    const active = ACTIVE_UPDATE_STATES.has(state);
    updateState.detail.textContent = UPDATE_LABELS[state] ?? "状态不可用";
    currentCommit.detail.textContent = shortCommit(update?.current?.commit);
    targetCommit.detail.textContent = update?.target?.commit ? shortCommit(update.target.commit) : "—";
    checkUpdate.disabled = !update?.supported || active;
    applyUpdate.disabled = state !== "available" || !update?.target?.commit || !update?.requestId;
    reloadPage.hidden = state !== "succeeded";
    if (state === "disabled") updateNotice.textContent = "当前宿主没有配置独立更新服务。";
    else if (state === "available") updateNotice.textContent = "已冻结这个目标版本；确认后只更新 Gateway。";
    else if (state === "up_to_date") updateNotice.textContent = "当前 Gateway 已是公开稳定分支的最新提交。";
    else if (state === "checking") updateNotice.textContent = "正在从固定远端检查最新提交…";
    else if (state === "queued") updateNotice.textContent = "请求已交给独立更新服务。";
    else if (state === "updating") updateNotice.textContent = "正在备份、切换并重启；页面会继续重连。";
    else if (state === "succeeded") updateNotice.textContent = "Gateway 更新成功。刷新页面可加载新的前端资源。";
    else if (state === "rolled_back") updateNotice.textContent = update?.error?.message ?? "新版未通过验证，已恢复旧版本。";
    else if (state === "failed") updateNotice.textContent = update?.error?.message ?? "更新失败，当前版本未被替换。";
    else updateNotice.textContent = "可以手动检查公开稳定分支。";
    updateNotice.dataset.tone = ["failed", "rolled_back"].includes(state) ? "danger" : state === "succeeded" ? "success" : "muted";
  }

  async function refreshUpdate() {
    try {
      update = (await updateClient.get()).update;
      if (!disposed) renderUpdate();
      if (!ACTIVE_UPDATE_STATES.has(update?.state)) updatePoller.stop();
    } catch {
      if (!disposed) {
        updateNotice.textContent = "Gateway 正在重启或暂不可达，2 秒后继续重连…";
        updateNotice.dataset.tone = "muted";
      }
    }
  }
  const updatePoller = createPagePoller({ task: refreshUpdate, intervalMs: 2000 });
  function pollIfActive() {
    if (ACTIVE_UPDATE_STATES.has(update?.state)) void updatePoller.start();
  }

  checkUpdate.addEventListener("click", async () => {
    checkUpdate.disabled = true;
    updateNotice.textContent = "正在提交检查请求…";
    try {
      update = (await updateClient.check()).update;
      renderUpdate();
      pollIfActive();
    } catch (error) {
      renderUpdate();
      updateNotice.textContent = error.message;
      updateNotice.dataset.tone = "danger";
    }
  });

  applyUpdate.addEventListener("click", async () => {
    if (update?.state !== "available" || !update.target?.commit || !update.requestId) return;
    const target = update.target.commit;
    if (!window.confirm(`只更新 Gateway 到 ${shortCommit(target)}。更新期间会短暂重启，是否继续？`)) return;
    applyUpdate.disabled = true;
    updateNotice.textContent = "正在提交更新请求…";
    try {
      update = (await updateClient.apply(target, update.requestId)).update;
      renderUpdate();
      pollIfActive();
    } catch (error) {
      update = { ...update, state: "queued" };
      renderUpdate();
      updateNotice.textContent = `${error.message}；将继续查询 Gateway 状态。`;
      updateNotice.dataset.tone = "danger";
      pollIfActive();
    }
  });
  reloadPage.addEventListener("click", () => window.location.reload());

  function fill() {
    for (const [key, control] of controls) control.value = loaded[key] ?? "";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(save, true, "保存中…");
    try {
      const patch = {};
      for (const [key, control] of controls) patch[key] = control.type === "number" ? Number(control.value) : control.value;
      loaded = (await client.update(patch)).settings;
      fill();
      dirty = false;
      notice.textContent = "已保存到 gateway";
      notice.dataset.tone = "success";
    } catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
    finally { setBusy(save, false); }
  });
  try {
    loaded = (await client.get()).settings;
    if (!disposed) { fill(); notice.textContent = "设置由 gateway 保存，其他浏览器会读取同一份。"; }
  } catch (err) {
    notice.textContent = `无法读取已保存配置：${err.message}`;
    notice.dataset.tone = "danger";
  }
  try {
    update = (await updateClient.get()).update;
    if (!disposed) { renderUpdate(); pollIfActive(); }
  } catch (error) {
    updateNotice.textContent = `无法读取更新状态：${error.message}`;
    updateNotice.dataset.tone = "danger";
  }
  return () => {
    if (dirty && !window.confirm("系统设置尚未保存，确定离开？")) return false;
    disposed = true;
    updatePoller.stop();
    window.removeEventListener("beforeunload", onBeforeUnload);
    root.replaceChildren();
  };
}
