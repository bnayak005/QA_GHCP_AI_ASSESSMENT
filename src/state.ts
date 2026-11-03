import type { Snapshot } from '../shared/contracts';

export function acceptSnapshot(current: Snapshot | null, incoming: Snapshot): Snapshot {
  if (!current || current.sourceEpoch !== incoming.sourceEpoch) return incoming;
  if (incoming.cursor < current.cursor) return current;
  const versions = new Map(current.accounts.map((account) => [account.id, account.version]));
  if (incoming.accounts.some((account) => account.version < (versions.get(account.id) ?? -1)))
    return current;
  return incoming;
}

export function formatAmount(amount: string): string {
  const [whole = '', fraction = ''] = amount.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}
