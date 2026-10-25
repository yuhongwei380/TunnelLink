import type { LogEntry } from './logs';

export type VpnState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export type ConnectOptions = {
  username: string;
  password: string;
  remember: boolean;
};

export type CommandResult = {
  ok: boolean;
  state?: VpnState;
  error?: string;
};

export type VpnStats = {
  uptime: number;
  bytesIn: number;
  bytesOut: number;
  metricsAvailable: boolean;
};

export type VpnStatus = Omit<VpnStats, 'metricsAvailable'> & {
  state: VpnState;
  metricsAvailable?: boolean;
  lastError?: string;
};

export type SavedCredentialsResult = {
  ok: boolean;
  credentials: ConnectOptions | null;
};

export type LogsResult = {
  ok: boolean;
  logs: LogEntry[];
  lastError?: string;
  state?: VpnState;
};

export type AppMeta = {
  name: string;
  version: string;
  platform: string;
};

export interface DesktopApi {
  connect(options: ConnectOptions): Promise<CommandResult>;
  disconnect(): Promise<CommandResult>;
  status(): Promise<VpnStatus>;
  getSavedCredentials(): Promise<SavedCredentialsResult>;
  getLogs(): Promise<LogsResult>;
  clearLogs(): Promise<{ ok: boolean }>;
  getAppMeta(): Promise<AppMeta>;
  getUiCopy(): Promise<unknown>;
  exit(): Promise<void>;
}
