import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DesktopApi } from './types';

// Keep the view independent of the desktop transport and keep browser preview inert.
if (isTauri()) {
  const api: DesktopApi = {
    connect: (options) => invoke('vpn_connect', { options }),
    disconnect: () => invoke('vpn_disconnect'),
    status: () => invoke('vpn_status'),
    getSavedCredentials: () => invoke('vpn_get_saved_credentials'),
    getLogs: () => invoke('vpn_get_logs'),
    clearLogs: () => invoke('vpn_clear_logs'),
    getAppMeta: () => invoke('app_get_meta'),
    getUiCopy: () => invoke('app_get_ui_copy'),
    exit: () => invoke('app_exit'),
  };
  window.vpn = api;
}
