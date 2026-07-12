import { createHttpClient } from "../api/http-client.js";
import { createSettingsClient } from "../api/settings-client.js";
import { createThemesClient } from "../api/themes-client.js";
import { applyAppearanceSettings, applyResolvedAppearance, applyThemePalette } from "../state/settings-state.js";
import { createNotice, downloadText, field, input, readFileText, select, setBusy } from "../components/management-ui.js";

const FIELD_GROUPS = [
  ["全局", [
    ["appearance.theme", "模式", "select", [["system", "跟随系统"], ["light", "亮色"], ["dark", "暗色"], ["custom", "自定义 Theme"]]],
    ["appearance.themeColor", "主题色", "color"],
    ["appearance.accentColor", "高亮色", "color"],
    ["appearance.fontFamily", "字体族", "text"],
  ]],
  ["手机", [
    ["appearance.fontSize.phone.chat", "聊天字号", "number"], ["appearance.fontSize.phone.management", "管理页字号", "number"],
    ["appearance.bubbleRadius.phone", "聊天气泡圆角", "number"], ["appearance.bubbleGap.phone", "聊天气泡间距", "number"],
    ["appearance.windowMargin.phone.chat", "聊天边距", "number"], ["appearance.windowMargin.phone.management", "管理页边距", "number"],
  ]],
  ["桌面", [
    ["appearance.fontSize.desktop.chat", "聊天字号", "number"], ["appearance.fontSize.desktop.management", "管理页字号", "number"],
    ["appearance.bubbleRadius.desktop", "聊天气泡圆角", "number"], ["appearance.bubbleGap.desktop", "聊天气泡间距", "number"],
    ["appearance.windowMargin.desktop.chat", "聊天边距", "number"], ["appearance.windowMargin.desktop.management", "管理页边距", "number"],
  ]],
];

function joinUrl(baseUrl, path) { return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString(); }

export async function mountAppearanceView({ root, platform, shell } = {}) {
  root.dataset.routeScope = "management";
  const http = createHttpClient(platform);
  const settingsClient = createSettingsClient(http);
  const themesClient = createThemesClient(http);
  let saved = {};
  let themes = [];
  let previewTheme = null;
  let savedTheme = null;
  let disposed = false;
  let dirty = false;
  const controls = new Map();
  shell?.setManagementHeader({ title: "Appearance", backHref: "#/settings", backLabel: "返回" });
  const form = document.createElement("form");
  form.className = "vera-management-form";
  const notice = createNotice("正在读取外观配置…");
  form.appendChild(notice);
  const themeSelect = select("", [["", "无已保存 Theme"]]);
  themeSelect.name = "appearance.themeId";
  controls.set("appearance.themeId", themeSelect);

  function currentPatch() {
    const patch = {};
    for (const [key, control] of controls) {
      patch[key] = control.type === "number" ? Number(control.value) : (key === "appearance.themeId" ? control.value || null : control.value);
    }
    return patch;
  }
  async function preview() {
    const patch = currentPatch();
    applyAppearanceSettings(patch);
    const themeId = patch["appearance.themeId"];
    if (patch["appearance.theme"] === "custom" && themeId) {
      try { previewTheme = (await themesClient.get(themeId)).theme; if (!disposed) applyResolvedAppearance(patch, previewTheme); }
      catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
    } else { previewTheme = null; applyThemePalette(null); }
  }
  function fill(settings) {
    for (const [key, control] of controls) {
      const value = settings[key];
      if (control.type === "color" && !value) control.type = "text";
      control.value = value ?? "";
    }
  }
  function refreshThemeOptions() {
    themeSelect.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = themes.length ? "选择 Theme" : "还没有保存的 Theme";
    themeSelect.appendChild(empty);
    for (const theme of themes) {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.name;
      themeSelect.appendChild(option);
    }
    themeSelect.value = saved["appearance.themeId"] ?? "";
  }

  const palette = document.createElement("fieldset");
  const paletteLegend = document.createElement("legend");
  paletteLegend.textContent = "Theme Palette";
  palette.append(paletteLegend, field("已保存 Theme", themeSelect));
  const themeTools = document.createElement("div");
  themeTools.className = "vera-import-row";
  const themeFormat = select("vera-json", [["vera-json", "Vera JSON"], ["vera-css", "Vera CSS"], ["itermcolors", "iTerm2"], ["terminal-profile", "Terminal.app"]]);
  const themeFile = input({ type: "file" });
  const importTheme = document.createElement("button");
  importTheme.type = "button";
  importTheme.className = "vera-secondary-button";
  importTheme.textContent = "预览并保存导入 Theme";
  const exportJson = document.createElement("button");
  exportJson.type = "button";
  exportJson.className = "vera-secondary-button";
  exportJson.textContent = "导出 Theme JSON";
  const exportCss = document.createElement("button");
  exportCss.type = "button";
  exportCss.className = "vera-secondary-button";
  exportCss.textContent = "导出 Theme CSS";
  themeTools.append(themeFormat, themeFile, importTheme, exportJson, exportCss);
  palette.appendChild(themeTools);
  form.appendChild(palette);

  for (const [groupName, definitions] of FIELD_GROUPS) {
    const section = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = groupName;
    section.appendChild(legend);
    for (const [key, label, kind, options] of definitions) {
      const control = kind === "select" ? select("", options) : input({ type: kind, min: kind === "number" ? 0 : undefined, step: kind === "number" ? 1 : undefined });
      control.name = key;
      control.addEventListener("input", () => { dirty = true; notice.textContent = "预览中，尚未保存"; notice.dataset.tone = "muted"; void preview(); });
      controls.set(key, control);
      section.appendChild(field(label, control));
    }
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "vera-secondary-button";
    reset.textContent = "本组恢复默认并保存";
    reset.addEventListener("click", async () => {
      setBusy(reset, true);
      try {
        const keys = definitions.map(([key]) => key);
        if (groupName === "全局") keys.push("appearance.themeId");
        saved = (await settingsClient.update(Object.fromEntries(keys.map((key) => [key, null])))).settings;
        fill(saved); dirty = false; await preview(); notice.textContent = "本组已恢复默认";
      } catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
      finally { setBusy(reset, false); }
    });
    section.appendChild(reset);
    form.appendChild(section);
  }
  themeSelect.addEventListener("change", () => { dirty = true; controls.get("appearance.theme").value = themeSelect.value ? "custom" : controls.get("appearance.theme").value; void preview(); });
  const profile = document.createElement("fieldset");
  const profileLegend = document.createElement("legend");
  profileLegend.textContent = "Appearance Profile（不含 Theme Palette）";
  const profileFile = input({ type: "file" });
  const importProfile = document.createElement("button");
  importProfile.type = "button";
  importProfile.className = "vera-secondary-button";
  importProfile.textContent = "预览导入 Profile";
  const exportProfile = document.createElement("button");
  exportProfile.type = "button";
  exportProfile.className = "vera-secondary-button";
  exportProfile.textContent = "导出 Profile";
  profile.append(profileLegend, profileFile, importProfile, exportProfile);
  form.appendChild(profile);
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "vera-primary-button";
  save.textContent = "保存外观配置";
  form.appendChild(save);
  root.appendChild(form);

  form.addEventListener("submit", async (event) => {
    event.preventDefault(); setBusy(save, true, "保存中…");
    try { saved = (await settingsClient.update(currentPatch())).settings; savedTheme = previewTheme; dirty = false; notice.textContent = "已保存到 gateway"; notice.dataset.tone = "success"; }
    catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
    finally { setBusy(save, false); }
  });
  importTheme.addEventListener("click", async () => {
    setBusy(importTheme, true);
    try {
      const previewResult = await themesClient.previewImport({ format: themeFormat.value, content: await readFileText(themeFile.files[0]), name: themeFile.files[0]?.name });
      applyThemePalette(previewResult.preview); previewTheme = previewResult.preview;
      if (!window.confirm(`${previewResult.warnings?.join("\n") || "解析完成"}\n\n保存这份 Theme？`)) return;
      const created = (await themesClient.create(previewResult.preview)).theme;
      themes = [...themes, created]; refreshThemeOptions(); themeSelect.value = created.id; controls.get("appearance.theme").value = "custom"; dirty = true; await preview();
      notice.textContent = "Theme 已保存；点击“保存外观配置”后启用。";
    } catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
    finally { setBusy(importTheme, false); }
  });
  async function exportTheme(format) {
    if (!themeSelect.value) { notice.textContent = "请先选择 Theme"; return; }
    try {
      const gatewayUrl = await platform.getGatewayUrl();
      const response = await platform.fetch(joinUrl(gatewayUrl, themesClient.exportPath(themeSelect.value, format)));
      if (!response.ok) throw new Error(`导出失败：${response.status}`);
      downloadText(`vera-theme.${format === "vera-css" ? "css" : "json"}`, await response.text(), format === "vera-css" ? "text/css" : "application/json");
    } catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
  }
  exportJson.addEventListener("click", () => void exportTheme("vera-json"));
  exportCss.addEventListener("click", () => void exportTheme("vera-css"));
  importProfile.addEventListener("click", async () => {
    try {
      const parsed = JSON.parse(await readFileText(profileFile.files[0]));
      const result = await themesClient.previewProfile(parsed);
      for (const [key, value] of Object.entries(result.preview)) if (controls.has(key)) controls.get(key).value = value;
      dirty = true; await preview(); notice.textContent = result.warnings?.join("；") || "Profile 已预览，确认后保存";
    } catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
  });
  exportProfile.addEventListener("click", async () => {
    try { downloadText("vera-appearance-profile.json", JSON.stringify(await themesClient.exportProfile(), null, 2)); }
    catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
  });
  try {
    const [settingsResponse, themesResponse] = await Promise.all([settingsClient.get(), themesClient.list()]);
    saved = settingsResponse.settings; themes = themesResponse.themes; refreshThemeOptions(); fill(saved); await preview(); savedTheme = previewTheme; dirty = false;
    if (!disposed) notice.textContent = themes.length ? "调整控件会实时预览；保存前不会写入 gateway。" : "还没有保存的 Theme，导入一份试试。";
  } catch (err) { notice.textContent = `无法读取已保存配置，展示当前默认样式：${err.message}`; notice.dataset.tone = "danger"; }
  return () => {
    if (dirty && !window.confirm("外观预览尚未保存，确定离开并丢弃？")) return false;
    disposed = true;
    applyResolvedAppearance(saved, savedTheme);
    root.replaceChildren();
  };
}
