import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/chat.css";
import "./styles/navigation.css";
import "./styles/management.css";

import { createAppRouter } from "./state/router.js";
import { initializePlatform } from "./state/platform.js";
import { createHttpClient } from "./api/http-client.js";
import { createSettingsClient } from "./api/settings-client.js";
import { createThemesClient } from "./api/themes-client.js";
import { applyAppearanceSettings, applyResolvedAppearance } from "./state/settings-state.js";
import { createAppRuntime } from "./state/app-runtime.js";

async function boot() {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app root");

  const platform = await initializePlatform();
  try {
    const http = createHttpClient(platform);
    const response = await createSettingsClient(http).get();
    applyAppearanceSettings(response.settings);
    const themeId = response.settings["appearance.themeId"];
    if (response.settings["appearance.theme"] === "custom" && themeId) {
      try {
        const theme = await createThemesClient(http).get(themeId);
        applyResolvedAppearance(response.settings, theme.theme);
      } catch (err) {
        console.warn("vera: saved custom theme is unavailable", err);
      }
    }
  } catch (err) {
    console.warn("vera: using bundled appearance defaults", err);
  }
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  const router = createAppRouter({ root, platform, runtime });
  window.addEventListener("pagehide", () => runtime.close(), { once: true });
  await router.start();
}

function renderBootFailure(root, err) {
  const page = document.createElement("main");
  page.className = "vera-boot-error";
  const title = document.createElement("h1");
  title.textContent = "Vera 暂时无法连接";
  const detail = document.createElement("p");
  detail.textContent = err.message || "gateway 不可达";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "vera-primary-button";
  retry.textContent = "重试";
  retry.addEventListener("click", () => window.location.reload());
  page.append(title, detail, retry);
  root.replaceChildren(page);
}

boot().catch((err) => {
  console.error("vera: failed to boot frontend", err);
  const root = document.getElementById("app");
  if (root) renderBootFailure(root, err);
});
