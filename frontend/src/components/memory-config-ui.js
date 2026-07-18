import { createNotice, field, input, select } from "./management-ui.js";

function sectionTitle(text) {
  const heading = document.createElement("h2");
  heading.textContent = text;
  return heading;
}

function infoRow(label, value) {
  const row = document.createElement("div");
  row.className = "vera-agent-info-row";
  const key = document.createElement("span");
  key.className = "vera-agent-info-row__label";
  key.textContent = label;
  const content = document.createElement("span");
  content.className = "vera-agent-info-row__value";
  content.textContent = value ?? "—";
  row.append(key, content);
  return row;
}

function tokenText(value) {
  return Number.isFinite(value?.value) ? `${value.value} tokens（${value.estimator ?? "估算"}）` : "不可用";
}

function countText(value, suffix) {
  return Number.isFinite(value) ? `${value} ${suffix}` : "不可用";
}

function selectedExecutorId(draft, ownerAgentId) {
  return draft?.executorAgentId ?? ownerAgentId;
}

function executorFor(draft, executors, ownerAgentId) {
  return executors.find((item) => item.agentId === selectedExecutorId(draft, ownerAgentId)) ?? null;
}

function timezoneDefault() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function memorySectionTitle(text) {
  return sectionTitle(text);
}

export function isMemoryTaskAvailable(draft, executors, ownerAgentId) {
  const executor = executorFor(draft, executors, ownerAgentId);
  if (!draft || !executor || executor.availability !== "available") return false;
  if (draft.modelMode === "inherit") return executor.models?.some((model) => model.isDefault === true) ?? false;
  return draft.modelMode === "fixed" && executor.models?.some((model) => model.model === draft.model) === true;
}

export function renderMemoryProviderSection(section, { config, options, status }) {
  section.replaceChildren(sectionTitle("Memory 结构"));
  const provider = config?.provider;
  const providerState = status?.provider;
  const name = provider?.providerId === "vera.markdown" ? "Vera（兼容 Obsidian）" : provider?.providerId ?? "—";
  const placement = provider?.placement?.runtime
    ? `${provider.placement.runtime}${provider.placement.hostId ? ` · ${provider.placement.hostId}` : ""}`
    : "—";
  const location = providerState?.location?.label ?? providerState?.location?.agentPath ?? "—";
  section.append(
    infoRow("Provider", name),
    infoRow("状态", providerState?.state ?? "未知"),
    infoRow("位置", placement),
    infoRow("数据标识", location),
  );
  if ((options?.providers?.length ?? 0) <= 1) {
    section.appendChild(createNotice("当前只有内置 Provider；结构与位置在此只读展示。"));
  }
  if (providerState?.state !== "available") {
    section.appendChild(createNotice("当前 Memory Provider 不可用；不会回退到其他 Provider。", "danger"));
  }
}

export function renderMemoryStatusSection(section, status) {
  section.replaceChildren(sectionTitle("状态"));
  if (!status) {
    section.appendChild(createNotice("Memory 状态不可用", "danger"));
    return;
  }
  const longTerm = status.longTerm ?? {};
  const pending = status.pendingContext ?? {};
  section.append(
    infoRow("长期记忆", `${countText(longTerm.activeCount, "条活跃")} · ${countText(longTerm.archivedCount, "条归档")}`),
    infoRow("逻辑大小", Number.isFinite(longTerm.logicalBytes) ? `${longTerm.logicalBytes} bytes` : "不可用"),
    infoRow("长期记忆估算", tokenText(longTerm.estimatedTokens)),
    infoRow("待整理内容", `${pending.messageCount ?? 0} 条消息 · ${pending.charCount ?? 0} 字符`),
    infoRow("待整理估算", tokenText(pending.estimatedTokens)),
  );
  for (const item of Array.isArray(pending.spaces) ? pending.spaces : []) {
    const card = document.createElement("article");
    card.className = "vera-management-card";
    const heading = document.createElement("strong");
    heading.textContent = `${item.spaceId} · ${item.spaceSessionId}`;
    card.append(
      heading,
      infoRow("范围", `${item.messageCount ?? 0} 条消息 · ${item.charCount ?? 0} 字符 · ${tokenText(item.estimatedTokens)}`),
    );
    const current = item.currentContext;
    if (current) {
      const pressure = Number.isFinite(current.pressureRatio) ? `${Math.round(current.pressureRatio * 100)}%` : "不可用";
      card.append(infoRow(
        "当前上下文压力",
        `${pressure} · ${current.estimatedInputTokens ?? "—"}/${current.effectiveLimitTokens ?? "—"} tokens · ${current.measurement ?? "估算"}`,
      ));
    } else card.appendChild(infoRow("当前上下文压力", "不可用"));
    section.appendChild(card);
  }
}

function timingFields(kind, draft, onDraftChange) {
  const timing = kind === "digest" ? draft.trigger : draft.schedule;
  const modes = kind === "digest"
    ? [["manual", "手动"], ["scheduled", "定时"], ["realtime", "实时"]]
    : [["manual", "手动"], ["daily", "每天"], ["weekly", "每周"], ["custom", "自定义"]];
  const mode = select(timing.mode, modes);
  mode.dataset.control = `${kind}-timing-mode`;
  mode.addEventListener("change", () => {
    const timezone = timezoneDefault();
    if (kind === "digest") {
      draft.trigger = mode.value === "scheduled" ? { mode: "scheduled", cron: "0 3 * * *", timezone }
        : mode.value === "realtime" ? { mode: "realtime", thresholdChars: 20000 } : { mode: "manual" };
    } else {
      draft.schedule = mode.value === "daily" ? { mode: "daily", timezone, time: "03:00" }
        : mode.value === "weekly" ? { mode: "weekly", timezone, weekday: 1, time: "03:00" }
          : mode.value === "custom" ? { mode: "custom", timezone, cron: "0 3 * * *" } : { mode: "manual" };
    }
    onDraftChange();
  });
  const controls = [field(kind === "digest" ? "触发方式" : "调度方式", mode)];
  const bind = (label, key, control) => {
    control.dataset.control = `${kind}-${key}`;
    control.addEventListener("change", () => { timing[key] = control.type === "number" ? Number(control.value) : control.value; });
    controls.push(field(label, control));
  };
  if (timing.mode === "scheduled" || timing.mode === "custom") bind("Cron", "cron", input({ value: timing.cron, placeholder: "0 3 * * *" }));
  if (["scheduled", "daily", "weekly", "custom"].includes(timing.mode)) bind("时区", "timezone", input({ value: timing.timezone, placeholder: "Asia/Tokyo" }));
  if (["daily", "weekly"].includes(timing.mode)) bind("时间", "time", input({ type: "time", value: timing.time }));
  if (timing.mode === "weekly") bind("星期（1-7）", "weekday", input({ type: "number", value: timing.weekday, min: 1 }));
  if (timing.mode === "realtime") bind("字符阈值", "thresholdChars", input({ type: "number", value: timing.thresholdChars, min: 1 }));
  return controls;
}

export function renderMemoryTaskSection(section, {
  kind, draft, ownerAgentId, executors, taskStatus, onDraftChange, onSave,
}) {
  section.replaceChildren(sectionTitle(kind === "digest" ? "Digest" : "Dream"));
  if (!draft) {
    section.appendChild(createNotice("配置不可用", "danger"));
    return;
  }
  const selectedId = selectedExecutorId(draft, ownerAgentId);
  const choices = [...executors];
  if (!choices.some((item) => item.agentId === selectedId)) {
    choices.push({ agentId: selectedId, name: selectedId, availability: "unavailable", models: [] });
  }
  const form = document.createElement("div");
  form.className = "vera-inline-form";
  const executor = select(selectedId, choices.map((item) => [
    item.agentId,
    `${item.name ?? item.agentId}${item.agentId === ownerAgentId ? "（自身）" : ""}${item.availability === "unavailable" ? "（不可用）" : ""}`,
  ]));
  executor.dataset.control = `${kind}-executor`;
  executor.addEventListener("change", () => {
    draft.executorAgentId = executor.value === ownerAgentId ? null : executor.value;
    onDraftChange();
  });
  const modelMode = select(draft.modelMode, [["inherit", "继承已验证默认模型"], ["fixed", "固定已验证模型"]]);
  modelMode.dataset.control = `${kind}-model-mode`;
  modelMode.addEventListener("change", () => {
    draft.modelMode = modelMode.value;
    draft.model = modelMode.value === "inherit" ? null : "";
    onDraftChange();
  });
  form.append(field("执行 Agent", executor), field("模型策略", modelMode));
  const executorOption = executorFor(draft, executors, ownerAgentId);
  if (draft.modelMode === "fixed") {
    const models = (executorOption?.models ?? []).map((item) => [item.model, item.model]);
    if (draft.model && !models.some(([value]) => value === draft.model)) models.push([draft.model, `${draft.model}（不可用）`]);
    if (!models.length) models.push(["", "没有已验证模型"]);
    const model = select(draft.model ?? "", models);
    model.dataset.control = `${kind}-model`;
    model.addEventListener("change", () => { draft.model = model.value; onDraftChange(); });
    form.appendChild(field("模型", model));
  } else {
    form.appendChild(infoRow("继承模型", executorOption?.models?.find((item) => item.isDefault === true)?.model ?? "当前默认模型不可用"));
  }
  form.append(...timingFields(kind, draft, onDraftChange));
  const save = document.createElement("button");
  save.type = "button";
  save.className = "vera-secondary-button";
  save.dataset.control = `${kind}-save`;
  save.textContent = "保存配置";
  save.addEventListener("click", async () => { await onSave(save); });
  form.appendChild(save);
  section.appendChild(form);
  if (!isMemoryTaskAvailable(draft, executors, ownerAgentId)) {
    section.appendChild(createNotice("已保存的执行者或模型当前不可用；选择会保留，不会自动改投。", "danger"));
  }
  if (taskStatus?.lastJob) section.appendChild(infoRow("上次任务", taskStatus.lastJob.status ?? "—"));
  if (taskStatus?.nextRunAt) section.appendChild(infoRow("下次运行", new Date(taskStatus.nextRunAt).toLocaleString()));
}
