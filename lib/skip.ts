// Skip rules shared by the server (folder paths) and the browser (dropped folders).
// Keep this file free of Node imports so both sides can use it.

export const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "__pycache__", ".venv", "venv",
  ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build", "out", ".next",
  ".nuxt", ".svelte-kit", ".turbo", ".vercel", ".cache", ".parcel-cache", "coverage",
  "target", ".gradle", ".idea", "Pods", "DerivedData", ".expo", ".terraform", "vendor",
  "DO_NOT_TOUCH",
]);

// Never read these, even if asked: they usually hold secrets.
const SECRET_NAMES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  ".htpasswd",
]);
const SECRET_EXTS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx"]);
const ENV_ALLOWED = new Set([".env.example", ".env.sample", ".env.template", ".env.defaults"]);

// Readable, but left unticked by default because they're huge and rarely useful.
const NOISY_NAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "poetry.lock",
  "Gemfile.lock", "composer.lock", "Pipfile.lock", "uv.lock",
]);

const BINARY_EXTS = new Set([
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".tif", ".tiff", ".heic",
  ".heif", ".avif", ".psd", ".ai", ".sketch", ".fig", ".raw", ".cr2", ".nef",
  // audio / video
  ".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".wmv", ".flv", ".m4v",
  // archives / packages
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".dmg", ".pkg", ".iso", ".jar",
  ".war", ".apk", ".ipa", ".deb", ".rpm", ".whl", ".egg",
  // binaries / compiled
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib", ".bin", ".class", ".pyc", ".pyo",
  ".wasm", ".node", ".dat", ".db", ".sqlite", ".sqlite3", ".mdb",
  // fonts
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // documents that need special extraction (handled separately when uploaded directly)
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".key", ".numbers", ".pages",
  // ML / data blobs
  ".pt", ".pth", ".onnx", ".h5", ".pkl", ".pickle", ".npy", ".npz", ".parquet", ".safetensors",
  ".ckpt", ".tflite", ".mlmodel",
]);

// The last part of a path, whether it uses / (macOS, relative paths) or \ (Windows).
const lastPart = (p: string) => p.split(/[\\/]/).pop() ?? p;

function ext(name: string): string {
  const base = lastPart(name);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

export function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

export function isSecretFile(name: string): boolean {
  const base = lastPart(name).toLowerCase();
  if (base === ".env" || (base.startsWith(".env.") && !ENV_ALLOWED.has(base))) return true;
  if (base.endsWith(".env") && base !== ".env") return true; // e.g. production.env
  if (SECRET_NAMES.has(base) || SECRET_NAMES.has(base.replace(/\.pub$/, ""))) return true;
  return SECRET_EXTS.has(ext(base));
}

export function isBinaryName(name: string): boolean {
  const base = lastPart(name);
  return base === ".DS_Store" || base === "Thumbs.db" || base === ".coverage" || BINARY_EXTS.has(ext(name));
}

export function isNoisyFile(name: string): boolean {
  const base = lastPart(name);
  return NOISY_NAMES.has(base) || /\.min\.(js|css)$/.test(base) || base.endsWith(".map");
}

// Returns a reason the file shouldn't be attached, or null if it's fine.
export function skipReason(path: string, size: number): string | null {
  if (path.split(/[\\/]/).some((part) => SKIP_DIRS.has(part))) return "ignored folder";
  if (isSecretFile(path)) return "may contain secrets";
  if (isBinaryName(path)) return "not a text file";
  if (isNoisyFile(path)) return "generated / lock file";
  if (size > 2_000_000) return "too large";
  return null;
}

// Wrap a file the same way chat.py does, so the model sees clear boundaries.
export function fileBlock(path: string, content: string): string {
  return `=== FILE: ${path} ===\n${content}\n=== END FILE ===`;
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + `\n... [cut off: file is ${text.length.toLocaleString()} characters, showing the first ${maxChars.toLocaleString()}]`,
    truncated: true,
  };
}
