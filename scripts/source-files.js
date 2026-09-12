import fs from 'node:fs';
import path from 'node:path';

// Deterministic current-file inventory; validation never executes Git or follows links.
export function sourceFiles(root, relative = '') {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const child = path.join(relative, entry.name);
    // Audit evidence is private local output, excluded from the distributable package.
    if (child === path.join('docs', 'audits')) continue;
    if (entry.isDirectory()) output.push(...sourceFiles(root, child));
    else output.push(child);
  }
  return output.sort();
}
