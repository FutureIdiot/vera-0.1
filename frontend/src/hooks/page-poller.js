export function createPagePoller({ task, intervalMs, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let timer = null;
  let active = false;
  return {
    async start() {
      if (active) return;
      active = true;
      await task();
      if (active) timer = setIntervalFn(() => void task(), intervalMs);
    },
    stop() {
      active = false;
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
    },
  };
}
