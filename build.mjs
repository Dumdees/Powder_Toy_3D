// Builds Powder Toy 3D into ONE self-contained HTML file that runs offline by
// double-clicking it. Output: "Powder Toy 3D.html".
//
// There is no bundler here on purpose: the app is plain ES2020 script chunks plus
// GLSL held in template literals, so the build is "concatenate in filename order,
// wrap in one function, inline into the page template".
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = path.join(ROOT, 'src');
export const OUT_FILE = path.join(ROOT, 'Powder Toy 3D.html');

/** Read every chunk in src/js, in filename order (they are numbered). */
export async function readChunks() {
  const names = (await readdir(path.join(SRC_DIR, 'js'))).filter((n) => n.endsWith('.js')).sort();
  return Promise.all(names.map(async (name) => ({
    name, code: await readFile(path.join(SRC_DIR, 'js', name), 'utf8'),
  })));
}

/** Drop whole-line `//` comments and blank lines, leaving GLSL template literals alone. */
export function squeeze(code) {
  const out = [];
  let inTemplate = false;
  for (const line of code.split('\n')) {
    const ticks = (line.match(/(^|[^\\])`/g) || []).length;
    const trimmed = line.trim();
    if (!inTemplate && (trimmed === '' || trimmed.startsWith('//'))) {
      if (ticks % 2) inTemplate = !inTemplate;
      continue;
    }
    out.push(line);
    if (ticks % 2) inTemplate = !inTemplate;
  }
  return out.join('\n');
}

export async function bundle({ dev = false } = {}) {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const chunks = await readChunks();
  const body = chunks
    .map(({ name, code }) => `\n/* ---- ${name} ---- */\n` + (dev ? code : squeeze(code)))
    .join('\n');
  const js = `(function(){'use strict';\n${body}\n})();`;
  const css = await readFile(path.join(SRC_DIR, 'styles.css'), 'utf8');
  const template = await readFile(path.join(SRC_DIR, 'index.html'), 'utf8');
  return template
    .replace('<!--%CSS%-->', () => (dev ? css : css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n{2,}/g, '\n')))
    .replace('<!--%JS%-->', () => js.replace(/<\/script/gi, '<\\/script'))
    .replace(/%VERSION%/g, pkg.version);
}

// Only write the file when run directly, so tests can import bundle() cheaply.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dev = process.argv.includes('--dev');
  const html = await bundle({ dev });
  await writeFile(OUT_FILE, html, 'utf8');
  const kb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
  console.log(`Built ${path.basename(OUT_FILE)} (${kb} KB${dev ? ', dev build' : ''})`);
}
