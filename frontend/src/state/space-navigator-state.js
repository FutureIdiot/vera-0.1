export function createSpaceNavigatorState() {
  let selectedMemberKey = null;
  let pinned = false;

  return {
    selectMembers(memberKey) { selectedMemberKey = memberKey; },
    setPinned(value) { pinned = Boolean(value); },
    snapshot() { return { selectedMemberKey, pinned }; },
    reset() { selectedMemberKey = null; pinned = false; },
  };
}
