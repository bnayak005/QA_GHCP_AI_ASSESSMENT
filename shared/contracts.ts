export interface AccountView {
  id: string;
  type: 'savings' | 'checking';
  label: string;
  currency: 'USD';
  balanceType: 'available';
  amount: string;
  version: number;
  changedAt: string;
  status: 'current' | 'unavailable';
}

export interface Snapshot {
  kind: 'snapshot';
  sourceEpoch: string;
  cursor: number;
  verifiedAt: string;
  accounts: AccountView[];
}

export interface Unavailable {
  kind: 'unavailable';
  message: string;
}

export interface SessionEnded {
  kind: 'session-ended';
  message: string;
}

export type StreamMessage = Snapshot | Unavailable | SessionEnded;

export function isStreamMessage(value: unknown): value is StreamMessage {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  if (value.kind === 'unavailable' || value.kind === 'session-ended') {
    return 'message' in value && typeof value.message === 'string';
  }
  return isSnapshot(value);
}

export function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  if (value.kind !== 'snapshot' || !('accounts' in value) || !Array.isArray(value.accounts))
    return false;
  return (
    'sourceEpoch' in value &&
    typeof value.sourceEpoch === 'string' &&
    'cursor' in value &&
    Number.isSafeInteger(value.cursor) &&
    'verifiedAt' in value &&
    typeof value.verifiedAt === 'string' &&
    value.accounts.every((account: unknown) => {
      if (!account || typeof account !== 'object') return false;
      return (
        'id' in account &&
        typeof account.id === 'string' &&
        'type' in account &&
        (account.type === 'savings' || account.type === 'checking') &&
        'label' in account &&
        typeof account.label === 'string' &&
        'currency' in account &&
        account.currency === 'USD' &&
        'balanceType' in account &&
        account.balanceType === 'available' &&
        'amount' in account &&
        typeof account.amount === 'string' &&
        /^-?\d{1,10}\.\d{2}$/.test(account.amount) &&
        'version' in account &&
        Number.isSafeInteger(account.version) &&
        'changedAt' in account &&
        typeof account.changedAt === 'string' &&
        'status' in account &&
        (account.status === 'current' || account.status === 'unavailable')
      );
    })
  );
}

export interface ApiError {
  error: string;
  correlationId: string;
}

export function isApiError(value: unknown): value is ApiError {
  return (
    !!value &&
    typeof value === 'object' &&
    'error' in value &&
    typeof value.error === 'string' &&
    value.error.length > 0 &&
    'correlationId' in value &&
    typeof value.correlationId === 'string'
  );
}
