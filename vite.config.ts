import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: ['chrome111', 'safari16.4'] },
  plugins: [react(), tailwindcss()],
  server: {
    strictPort: true,
    // Native builds and installer files are not frontend source. Watching them
    // on Windows can fail with EBUSY while NSIS is writing an installer.
    watch: {
      ignored: [
        '**/.cache/**',
        '**/src-tauri/target/**',
        '**/src-tauri/gen/**',
        '**/make/dist/**',
        '**/dist/**',
      ],
    },
    hmr: process.env.DISABLE_HMR !== 'true',
  },
});
