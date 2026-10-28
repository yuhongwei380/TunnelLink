import type { DesktopApi } from './types';

declare global {
  interface Window {
    vpn?: DesktopApi;
  }
}
