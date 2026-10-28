import fs from 'node:fs';
import path from 'node:path';

// config/app-branding.json is the tracked default; the git-ignored
// private/app-branding.json is the quick-configuration overlay that customizes
// the app id, product/installer name and default locale without touching Git.
export function readBranding(rootDir) {
  const brandingPath = path.join(rootDir, 'config', 'app-branding.json');
  if (!fs.existsSync(brandingPath)) {
    throw new Error(`Branding file not found: ${brandingPath}`);
  }
  const branding = JSON.parse(fs.readFileSync(brandingPath, 'utf8'));
  const privatePath = path.join(rootDir, 'private', 'app-branding.json');
  if (fs.existsSync(privatePath)) {
    Object.assign(branding, JSON.parse(fs.readFileSync(privatePath, 'utf8')));
  }
  return branding;
}
