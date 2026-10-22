import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

// Git may list editor symlinks and untracked files alongside project source.
// Never follow those entries into installed credentials or another checkout.
export function copyVerificationSource(root, destination, files) {
  const copied = [];
  for (const file of new Set(files)) {
    const parts = file.split('/');
    if (isAbsolute(file) || parts.some((part) => !part || part === '.' || part === '..')) continue;
    if (
      /^(?:\.git|\.tmp|\.watchtower|\.unspammed|\.wrangler|\.vercel(?:-static|-runtime)?|node_modules|dist|coverage|\.agents|\.claude|\.codex|\.cursor|\.idea|\.vscode)(?:\/|$)/.test(
        file,
      )
    )
      continue;
    const name = parts.at(-1);
    if (
      (/^(?:\.env|\.dev.vars|app\.env)(?:$|\.)/.test(name) && !name.endsWith('.example')) ||
      /^wrangler\.(?:production|generated)\.jsonc$/.test(name)
    )
      continue;
    let source = root;
    let regular = true;
    for (let index = 0; index < parts.length; index++) {
      source = join(source, parts[index]);
      const entry = lstatSync(source, { throwIfNoEntry: false });
      if (!entry || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
        regular = false;
        break;
      }
    }
    if (!regular) continue;
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied.push(file);
  }
  return copied;
}
