import fs from 'node:fs';
import path from 'node:path';

// This directory belongs exclusively to Vite. Retire old bundles only after a
// successful write, so previous demo data cannot remain at a public hashed URL.
export function cleanStaleBundles() {
  return {
    name: 'clean-stale-bundles',
    writeBundle(options, bundle) {
      const output = path.resolve(options.dir);
      const directory = path.resolve(output, 'bundle');
      if (path.dirname(directory) !== output) throw new Error('Invalid bundle directory');
      const current = new Set(Object.keys(bundle).map(name => path.resolve(output, name)));
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.isDirectory()) throw new Error('Unexpected entry in generated bundle directory');
        const file = path.join(directory, entry.name);
        if (!current.has(file)) fs.unlinkSync(file);
      }
    },
  };
}
