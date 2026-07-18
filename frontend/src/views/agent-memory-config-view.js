import { createHttpClient } from "../api/http-client.js";
import { createMemoryClient } from "../api/memory-client.js";
import {
  isMemoryTaskAvailable,
  memorySectionTitle,
  renderMemoryProviderSection,
  renderMemoryStatusSection,
  renderMemoryTaskSection,
} from "../components/memory-config-ui.js";
import { createNotice, field, select, setBusy } from "../components/management-ui.js";

const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "applying"]);

function pendingKey(item) {
  return JSON.stringify([item.accountId, item.spaceId, item.spaceSessionId]);
}

export async function mountAgentMemoryConfigView({ root, platform, runtime, agentId, shell } = {}) {
  root.dataset.routeScope = "management";
  const agent = runtime.getBootstrap().agents.find((item) => item.id === agentId);
  const back = `#/agents/${encodeURIComponent(agentId)}/data`;
  shell?.setManagementHeader({ title: `${agent?.name ?? "Agent"} Memory`, backHref: back, backLabel: "返回" });
  if (!agent) {
    root.appendChild(createNotice("Agent 不存在", "danger"));
    return () => root.replaceChildren();
  }

  const memoryClient = createMemoryClient(createHttpClient(platform));
  let disposed = false;
  let loading = true;
  let loadError = null;
  let config = null;
  let version = null;
  let options = null;
  let status = null;
  let digestDraft = null;
  let dreamDraft = null;
  let selectedPendingKey = null;

  const content = document.createElement("div");
  content.className = "vera-management-content";
  const feedback = createNotice("");
  feedback.hidden = true;
  const providerSection = document.createElement("section");
  providerSection.className = "vera-management-section";
  const statusSection = document.createElement("section");
  statusSection.className = "vera-management-section";
  const digestSection = document.createElement("section");
  digestSection.className = "vera-management-section";
  const dreamSection = document.createElement("section");
  dreamSection.className = "vera-management-section";
  const actionsSection = document.createElement("section");
  actionsSection.className = "vera-management-section";
  const libraryLink = document.createElement("a");
  libraryLink.className = "vera-secondary-button vera-button-link";
  libraryLink.href = `#/agents/${encodeURIComponent(agentId)}/data/memory/library`;
  libraryLink.textContent = "长期记忆管理";
  root.appendChild(content);

  function showFeedback(message, tone = "muted") {
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = false;
  }

  function taskExecutors(kind) {
    return options?.tasks?.[kind]?.executors ?? [];
  }

  function taskAvailable(kind, draft) {
    return isMemoryTaskAvailable(draft, taskExecutors(kind), agentId);
  }

  function providerAvailable() {
    return status?.provider?.state === "available";
  }

  function pendingSpaces() {
    return Array.isArray(status?.pendingContext?.spaces) ? status.pendingContext.spaces : [];
  }

  function syncPendingSelection() {
    const spaces = pendingSpaces();
    if (spaces.length === 1) selectedPendingKey = pendingKey(spaces[0]);
    else if (!spaces.some((item) => pendingKey(item) === selectedPendingKey)) selectedPendingKey = null;
  }

  async function saveTask(kind, button) {
    if (!version) return;
    const draft = kind === "digest" ? digestDraft : dreamDraft;
    setBusy(button, true, "保存中…");
    try {
      const response = await memoryClient.patchConfig(agentId, { [kind]: structuredClone(draft), ifMatch: version });
      config = response.config;
      version = response.version;
      digestDraft = structuredClone(config.digest);
      dreamDraft = structuredClone(config.dream);
      showFeedback(`${kind === "digest" ? "Digest" : "Dream"} 配置已保存`, "success");
      render();
    } catch (err) {
      showFeedback(`配置保存失败：${err.message}`, "danger");
      setBusy(button, false);
    }
  }

  function renderTask(kind) {
    renderMemoryTaskSection(kind === "digest" ? digestSection : dreamSection, {
      kind,
      draft: kind === "digest" ? digestDraft : dreamDraft,
      ownerAgentId: agentId,
      executors: taskExecutors(kind),
      taskStatus: status?.[kind],
      onDraftChange: () => { renderTask(kind); renderActions(); },
      onSave: (button) => saveTask(kind, button),
    });
  }

  function dreamActive() {
    return Boolean(status?.dream?.currentJobId) || ACTIVE_JOB_STATUSES.has(status?.dream?.status);
  }

  async function refreshStatus() {
    try {
      status = await memoryClient.getStatus(agentId);
      if (disposed) return;
      syncPendingSelection();
      render();
    } catch (err) {
      if (!disposed) showFeedback(`状态刷新失败：${err.message}`, "danger");
    }
  }

  function renderActions() {
    actionsSection.replaceChildren(memorySectionTitle("手动任务"));
    const spaces = pendingSpaces();
    const choices = spaces.map((item) => [pendingKey(item), `${item.spaceId} · ${item.spaceSessionId} · ${item.messageCount ?? 0} 条消息`]);
    if (spaces.length !== 1) choices.unshift(["", spaces.length ? "请选择一个待整理窗口" : "没有待整理窗口"]);
    const pending = select(selectedPendingKey ?? "", choices);
    pending.dataset.control = "digest-pending-space";
    pending.disabled = spaces.length === 0;
    pending.addEventListener("change", () => { selectedPendingKey = pending.value || null; renderActions(); });

    const digestButton = document.createElement("button");
    digestButton.type = "button";
    digestButton.className = "vera-secondary-button";
    digestButton.dataset.control = "digest-run";
    digestButton.textContent = "手动 Digest";
    digestButton.disabled = !selectedPendingKey || !taskAvailable("digest", digestDraft) || !providerAvailable();
    digestButton.addEventListener("click", async () => {
      const range = spaces.find((item) => pendingKey(item) === selectedPendingKey);
      if (!range || !taskAvailable("digest", digestDraft) || !providerAvailable()) return;
      setBusy(digestButton, true, "触发中…");
      try {
        await memoryClient.enqueueDigest(agentId, {
          accountId: range.accountId,
          spaceId: range.spaceId,
          spaceSessionId: range.spaceSessionId,
          mode: "incremental",
        });
        showFeedback("Digest 任务已加入队列", "success");
        await refreshStatus();
      } catch (err) {
        showFeedback(`Digest 启动失败：${err.message}`, "danger");
        setBusy(digestButton, false);
      }
    });

    const dreamButton = document.createElement("button");
    dreamButton.type = "button";
    dreamButton.className = "vera-secondary-button";
    dreamButton.dataset.control = "dream-run";
    dreamButton.textContent = dreamActive() ? "Dream 进行中（再次点击合并）" : "立即 Dream";
    dreamButton.disabled = !taskAvailable("dream", dreamDraft) || !providerAvailable();
    dreamButton.addEventListener("click", async () => {
      if (!taskAvailable("dream", dreamDraft) || !providerAvailable()) return;
      setBusy(dreamButton, true, "触发中…");
      try {
        const response = await memoryClient.enqueueDream(agentId, { requestId: crypto.randomUUID() });
        showFeedback(response.coalesced ? "已有 Dream 在运行，本次请求已合并。" : "Dream 任务已加入队列", "success");
        await refreshStatus();
      } catch (err) {
        showFeedback(`Dream 启动失败：${err.message}`, "danger");
        setBusy(dreamButton, false);
      }
    });
    const form = document.createElement("div");
    form.className = "vera-form-actions";
    form.append(field("Digest 窗口", pending), digestButton, dreamButton, libraryLink);
    actionsSection.appendChild(form);
  }

  function render() {
    if (loading) {
      content.replaceChildren(createNotice("正在读取 Memory 配置…"));
      return;
    }
    if (loadError) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "vera-secondary-button";
      retry.textContent = "重试";
      retry.addEventListener("click", () => { void load(); });
      content.replaceChildren(createNotice(`Memory 配置读取失败：${loadError}`, "danger"), retry, libraryLink);
      return;
    }
    content.replaceChildren(feedback, providerSection, statusSection, digestSection, dreamSection, actionsSection);
    renderMemoryProviderSection(providerSection, { config, options, status });
    renderMemoryStatusSection(statusSection, status);
    renderTask("digest");
    renderTask("dream");
    renderActions();
  }

  async function load() {
    loading = true;
    loadError = null;
    render();
    try {
      const [configResponse, optionsResponse, statusResponse] = await Promise.all([
        memoryClient.getConfig(agentId),
        memoryClient.getOptions(agentId),
        memoryClient.getStatus(agentId),
      ]);
      if (disposed) return;
      config = configResponse.config;
      version = configResponse.version;
      options = optionsResponse;
      status = statusResponse;
      digestDraft = structuredClone(config.digest);
      dreamDraft = structuredClone(config.dream);
      syncPendingSelection();
    } catch (err) {
      if (!disposed) loadError = err.message;
    } finally {
      if (!disposed) {
        loading = false;
        render();
      }
    }
  }

  await load();
  const unsubscribe = runtime.subscribe((envelope) => {
    const eventAgentId = envelope.data?.agentId ?? envelope.data?.job?.agentId;
    if (["memory.digest-job.updated", "memory.dream-job.updated"].includes(envelope.type) && eventAgentId === agentId) {
      void refreshStatus();
    }
  });
  return () => {
    disposed = true;
    unsubscribe();
    root.replaceChildren();
  };
}
