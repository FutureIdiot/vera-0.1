export function createSpaceNavigatorState() {
  let selectedDirectoryKey = null;

  return {
    selectDirectory(directoryKey) { selectedDirectoryKey = directoryKey; },
    snapshot() { return { selectedDirectoryKey }; },
    reset() { selectedDirectoryKey = null; },
  };
}
