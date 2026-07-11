let activePlatform = null;

export async function initializePlatform() {
  const { createWebPlatform } = await import("../platform/web.js");
  activePlatform = createWebPlatform();
  document.documentElement.dataset.platform = activePlatform.id;
  return activePlatform;
}

export function getPlatform() {
  if (!activePlatform) throw new Error("platform is not initialized");
  return activePlatform;
}
