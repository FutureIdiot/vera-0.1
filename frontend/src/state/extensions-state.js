// The state boundary exists so Phase 6 extension data cannot leak into Space
// or Account state. It remains unloaded until the gateway contract is active.
export function createExtensionsState() {
  let packages = null;
  return {
    hydrate(nextPackages) { packages = [...nextPackages]; },
    snapshot() { return packages === null ? null : [...packages]; },
    clear() { packages = null; },
  };
}
