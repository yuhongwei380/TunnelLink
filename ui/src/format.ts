export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${Math.max(0, bytes)} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(2)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

export function formatTime(seconds: number) {
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), Math.floor(seconds % 60)]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
