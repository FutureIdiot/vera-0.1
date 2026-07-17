export function createAccountsState() {
  let agents = [];
  let accounts = [];

  return {
    hydrate({ agents: nextAgents = [], accounts: nextAccounts = [] }) {
      agents = [...nextAgents];
      accounts = [...nextAccounts];
    },
    listByAgent() {
      return agents.map((agent) => ({
        agent,
        accounts: accounts.filter((account) => account.ownerAgentId === agent.id),
      }));
    },
    clear() { agents = []; accounts = []; },
  };
}
