import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DesktopApi } from './types';

// Keep the view independent of the desktop transport and keep browser preview inert.
if (isTauri()) {
  const api: DesktopApi = {
    listProfiles: () => invoke('vpn_list_profiles'),
    importProfile: () => invoke('vpn_import_profile'),
    selectProfile: (id) => invoke('vpn_select_profile', { id }),
    renameProfile: (id, name) => invoke('vpn_rename_profile', { id, name }),
    deleteProfile: (id) => invoke('vpn_delete_profile', { id }),
    connect: (options) => invoke('vpn_connect', { options }),
    disconnect: () => invoke('vpn_disconnect'),
    status: () => invoke('vpn_status'),
    getSavedCredentials: () => invoke('vpn_get_saved_credentials'),
    getLogs: () => invoke('vpn_get_logs'),
    clearLogs: () => invoke('vpn_clear_logs'),
    exportLogs: (rangeMinutes) => invoke('vpn_export_logs', { rangeMinutes }),
    getAppMeta: () => invoke('app_get_meta'),
    getInstallationState: () => invoke('app_get_installation_state'),
    installToApplications: () => invoke('app_install_to_applications'),
    uninstall: () => invoke('app_uninstall'),
    getUiCopy: () => invoke('app_get_ui_copy'),
    exit: () => invoke('app_exit'),
  };
  window.vpn = api;
}
