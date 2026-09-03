// The Windows installer can only be built on Windows, so these tests check the parts that
// have to agree with each other before the Windows runner ever sees them. Every failure here
// is one that would otherwise show up as a broken installer, or a program that starts and
// then cannot find its own app file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.js';

const read = (p) => readFile(path.join(ROOT, p), 'utf8');
const exists = (p) => stat(path.join(ROOT, p)).then(() => true, () => false);

const APP = 'Powder Toy 3D';
const iss = await read('installer/PowderToy3D.iss');
const csproj = await read('installer/host/PowderToy3D.csproj');
const mainForm = await read('installer/host/MainForm.cs');
const program = await read('installer/host/Program.cs');
const pkg = JSON.parse(await read('package.json'));

test('every file the installer machinery names is actually present', async () => {
  for (const p of [
    'installer/PowderToy3D.iss', 'installer/icon.ico', 'installer/icon-256.png',
    'installer/host/PowderToy3D.csproj', 'installer/host/Program.cs',
    'installer/host/MainForm.cs', 'installer/host/app.manifest',
    'scripts/windows-package.mjs', 'scripts/make-icon.mjs',
    `${APP}.html`, 'READ ME FIRST.txt',
  ]) {
    assert.ok(await exists(p), `${p} is missing`);
  }
});

test('the program name the installer runs is the one the host builds', () => {
  const assembly = csproj.match(/<AssemblyName>([^<]+)<\/AssemblyName>/)[1];
  assert.equal(assembly, APP);
  const exe = iss.match(/#define AppExe "([^"]+)"/)[1];
  assert.equal(exe, `${APP}.exe`, 'the installer would create a shortcut to a program that does not exist');
});

test('the host looks for the file the build actually produces', () => {
  const wanted = mainForm.match(/AppFileName = "([^"]+)"/)[1];
  assert.equal(wanted, `${APP}.html`);
});

test('the installer and the program agree on the running-app marker', () => {
  // Inno Setup uses AppMutex to notice the app is open and offer to close it before upgrading.
  // If these drift apart, an upgrade silently fails to replace files that are in use.
  const fromIss = iss.match(/AppMutex=(\S+)/)[1];
  const fromCode = program.match(/new System\.Threading\.Mutex\(false, "([^"]+)"\)/)[1];
  assert.equal(fromIss, fromCode);
});

test('the installer ships the folder the packaging script assembles', async () => {
  const distFolder = iss.match(/#define DistFolder "([^"]+)"/)[1];
  assert.equal(distFolder, `..\\dist\\${APP}`, 'the .iss must point at the folder the script builds');
  const script = await read('scripts/windows-package.mjs');
  const dist = script.match(/const dist = path\.join\(root, '([^']+)', APP\)/)[1];
  assert.equal(dist, 'dist');
  assert.match(script, /const APP = 'Powder Toy 3D'/, 'the script and the .iss must name the same app');
  // The script must copy exactly the two files the shipped folder needs.
  assert.match(script, /\[`\$\{APP\}\.html`, 'READ ME FIRST\.txt'\]/);
});

test('nothing here asks for administrator rights', async () => {
  assert.match(iss, /PrivilegesRequired=lowest/);
  assert.match(iss, /DefaultDirName=\{localappdata\}/, 'a per-user install must not write to Program Files');
  const manifest = await read('installer/host/app.manifest');
  assert.match(manifest, /level="asInvoker"/, 'the program must not trigger a UAC prompt');
  assert.ok(!/RunAsAdmin|requireAdministrator|highestAvailable/.test(manifest + iss));
});

test('the version flows from one place into the program and the installer', () => {
  assert.match(csproj, /<Version>\$\(AppVersion\)<\/Version>/);
  assert.match(iss, /AppVersion=\{#AppVersion\}/);
  assert.match(iss, /OutputBaseFilename=Powder-Toy-3D-Setup-\{#AppVersion\}/);
});

test('the icon is a valid multi-size ICO Windows will accept', async () => {
  const ico = await readFile(path.join(ROOT, 'installer', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type must be 1 (icon)');
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 4, `only ${count} sizes in the icon`);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = ico.readUInt8(o) || 256;
    sizes.push(w);
    const len = ico.readUInt32LE(o + 8);
    const off = ico.readUInt32LE(o + 12);
    assert.ok(off + len <= ico.length, `entry ${i} points past the end of the file`);
    assert.equal(ico.readUInt32LE(off), 40, `entry ${i} is not an uncompressed BMP entry`);
  }
  // Windows picks from these for the taskbar, Explorer and the Start menu.
  for (const want of [16, 32, 48, 256]) assert.ok(sizes.includes(want), `no ${want}px icon`);
});

test('the shipped read-me uses Windows line endings and covers the basics', async () => {
  const txt = await readFile(path.join(ROOT, 'READ ME FIRST.txt'), 'latin1');
  assert.ok(txt.includes('\r\n'), 'Notepad shows LF-only text as one long line');
  for (const phrase of ['Right drag', 'F11', 'WebGL 2', 'Low']) {
    assert.ok(txt.includes(phrase), `the read-me never mentions ${phrase}`);
  }
});

test('npm exposes the packaging entry points', () => {
  assert.equal(pkg.scripts['package:windows'], 'node scripts/windows-package.mjs');
  assert.equal(pkg.scripts.icon, 'node scripts/make-icon.mjs');
});

test('both workflows point at files that exist', async () => {
  const release = await read('.github/workflows/release.yml');
  const ci = await read('.github/workflows/ci.yml');
  assert.match(release, /runs-on: windows-latest/, 'Inno Setup and the .NET host need Windows');
  assert.match(release, /windows-package\.mjs/);
  assert.match(release, /installer\/Output\/\*\.exe/);
  assert.match(release, /Powder-Toy-3D-Windows\.zip/, 'the zip named in the release must be the one the script writes');
  const zipName = (await read('scripts/windows-package.mjs')).match(/'(Powder-Toy-3D-Windows\.zip)'/)[1];
  assert.ok(release.includes(zipName));
  assert.match(ci, /windows-app:/, 'a broken installer should fail CI, not the release');
  assert.match(ci, /windows-package\.mjs/);
});

test('build products are not committed by accident', async () => {
  const ignore = await read('.gitignore');
  for (const entry of ['dist/', 'build/', 'installer/Output/', 'installer/MicrosoftEdgeWebview2Setup.exe']) {
    assert.ok(ignore.includes(entry), `.gitignore is missing ${entry}`);
  }
});
