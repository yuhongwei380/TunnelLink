import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const projectPath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: projectPath('./'),
  cacheDir: projectPath('../.cache/vite'),
  base: './',
  build: {
    target: ['chrome111', 'safari16.4'],
    outDir: projectPath('../.cache/frontend'),
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  server: {
    strictPort: true,
    fs: { allow: [projectPath('../')] },
    // Native builds and installer files are not frontend source. Watching them
    // on Windows can fail with EBUSY while NSIS is writing an installer.
    watch: {
      ignored: ['**/.cache/**', '**/build_dist/**', '**/src-tauri/gen/**'],
    },
    hmr: process.env.DISABLE_HMR !== 'true',
  },
});
