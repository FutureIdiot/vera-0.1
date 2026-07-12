export function createSpaceNavigatorState() {
  let selectedMemberKey = null;

  return {
    selectMembers(memberKey) { selectedMemberKey = memberKey; },
    snapshot() { return { selectedMemberKey }; },
    reset() { selectedMemberKey = null; },
  };
}
