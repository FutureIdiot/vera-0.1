import { createHttpClient } from "../api/http-client.js";
import { createSettingsClient } from "../api/settings-client.js";
import { createNotice, field, input, select, setBusy } from "../components/management-ui.js";

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
      ["memory.digestTrigger", "触发方式", "select", [["scheduled", "定时"], ["realtime", "实时同步"], ["manual", "手动"]]],
      ["memory.digestSchedule", "定时表达式", "text"],
      ["memory.injectionBudgetResidentLines", "常驻索引行数", "number", { min: 0, step: 1 }],
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

export async function mountSystemSettingsView({ root, platform, shell } = {}) {
  root.dataset.routeScope = "management";
  const client = createSettingsClient(createHttpClient(platform));
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
  return () => {
    if (dirty && !window.confirm("系统设置尚未保存，确定离开？")) return false;
    disposed = true;
    window.removeEventListener("beforeunload", onBeforeUnload);
    root.replaceChildren();
  };
}
