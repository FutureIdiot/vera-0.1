import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/chat.css";

import { createAppRouter } from "./state/router.js";
import { initializePlatform } from "./state/platform.js";
import { createHttpClient } from "./api/http-client.js";
import { createSettingsClient } from "./api/settings-client.js";
import { applyAppearanceSettings } from "./state/settings-state.js";
import { createAppRuntime } from "./state/app-runtime.js";

async function boot() {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app root");

  const platform = await initializePlatform();
  try {
    const response = await createSettingsClient(createHttpClient(platform)).get();
    applyAppearanceSettings(response.settings);
  } catch (err) {
    console.warn("vera: using bundled appearance defaults", err);
  }
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  const router = createAppRouter({ root, platform, runtime });
  window.addEventListener("pagehide", () => runtime.close(), { once: true });
  await router.start();
}

boot().catch((err) => {
  console.error("vera: failed to boot frontend", err);
  const root = document.getElementById("app");
  if (root) root.textContent = `启动失败：${err.message}`;
});
