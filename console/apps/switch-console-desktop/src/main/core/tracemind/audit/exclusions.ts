/** Common build outputs, environments, caches and private paths; not a complete secret detector. */
const directories = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-local-server',
  'dist-sidecar',
  'build',
  'out',
  'release',
  'coverage',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '__pypackages__',
  'site-packages',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.terraform',
  'target',
  'pods',
  'carthage',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.config/gcloud',
]);
const filenames = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  'credentials',
]);
const suffixes = ['.pem', '.key', '.p12', '.pfx', '.tfstate', '.tfstate.backup'];

export function isExcludedPathEntry(
  name: string,
  directory: boolean,
  relativePath = name
): boolean {
  const lower = name.toLowerCase();
  const relative = relativePath.toLowerCase();
  return (
    (directory && (directories.has(lower) || directories.has(relative))) ||
    filenames.has(lower) ||
    lower.startsWith('.env.') ||
    lower.startsWith('id_rsa') ||
    lower.startsWith('id_ed25519') ||
    lower.startsWith('id_ecdsa') ||
    suffixes.some((suffix) => lower.endsWith(suffix))
  );
}
