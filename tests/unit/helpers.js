// Loads the pure-logic chunks (no DOM, no WebGL) into a plain function scope so
// they can be unit tested the same way the browser sees them.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const JS_DIR = path.join(ROOT, 'src', 'js');

/** Concatenate the named chunks and hand back the values listed in `exports`. */
export async function load(chunks, exports) {
  let src = '';
  for (const name of chunks) src += await readFile(path.join(JS_DIR, name), 'utf8') + '\n';
  return new Function(`${src}\nreturn { ${exports.join(', ')} };`)();
}

export const PURE = ['01-math.js', '02-materials.js', '03-scenes.js'];
