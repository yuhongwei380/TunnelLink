import type { LogEntry } from './logs';

export type VpnState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
export type VpnAction = 'connecting' | 'cancelling' | 'disconnecting' | null;

export type ConnectOptions = {
  profileId?: string;
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
  assignedIp: string | null;
  gatewayAddress: string | null;
};

export type VpnStatus = Omit<VpnStats, 'metricsAvailable' | 'assignedIp' | 'gatewayAddress'> & {
  activeProfileId?: string | null;
  activeProfileRevision?: string | null;
  state: VpnState;
  metricsAvailable?: boolean;
  assignedIp?: string | null;
  gatewayAddress?: string | null;
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

export type ExportLogsResult = {
  ok: boolean;
  path: string;
  fileName: string;
  count: number;
};

export type AppMeta = {
  name: string;
  version: string;
  platform: string;
};

export type InstallationState = {
  needsInstall: boolean;
  canUninstall?: boolean;
  platform: string;
};

export interface DesktopApi {
  listProfiles(): Promise<ProfileList>;
  importProfile(): Promise<ProfileList>;
  selectProfile(id: string): Promise<ProfileList>;
  renameProfile(id: string, name: string): Promise<ProfileList>;
  deleteProfile(id: string): Promise<ProfileList>;
  connect(options: ConnectOptions): Promise<CommandResult>;
  disconnect(): Promise<CommandResult>;
  status(): Promise<VpnStatus>;
  getSavedCredentials(): Promise<SavedCredentialsResult>;
  getLogs(): Promise<LogsResult>;
  clearLogs(): Promise<{ ok: boolean }>;
  exportLogs(rangeMinutes: 5 | 30 | 60): Promise<ExportLogsResult>;
  getAppMeta(): Promise<AppMeta>;
  getInstallationState(): Promise<InstallationState>;
  installToApplications(): Promise<void>;
  uninstall(): Promise<void>;
  getUiCopy(): Promise<unknown>;
  exit(): Promise<void>;
}

export type VpnProfile = {
  id: string;
  source: 'builtin' | 'imported';
  displayName: string;
  description: string;
  endpoints: { host: string; port: number; protocol: string }[];
  requiresAuth: boolean;
  revision: string;
  error: string | null;
};

export type ProfileList = {
  profiles: VpnProfile[];
  selectedProfileId: string | null;
  capabilities: {
    builtinProfile: { enabled: boolean; displayName: string; description: string };
    profileImport: { enabled: boolean };
  };
};
