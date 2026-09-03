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

test('the page and the window agree on how full screen is asked for', async () => {
  // These two have to meet in the middle, and the C# compiler cannot tell you when they
  // do not: a WinForms host cannot see accelerator keys pressed inside the web content,
  // so the page asks via the Fullscreen API and the window follows the resulting event.
  const main = await read('src/js/90-main.js');
  const input = await read('src/js/60-input.js');
  assert.match(input, /k === 'f11'/, 'nothing in the page reacts to F11');
  assert.match(main, /requestFullscreen/, 'the page never asks to go full screen');
  assert.match(mainForm, /ContainsFullScreenElementChanged/,
    'the window is not listening for the page going full screen');
  // Usage, not mention: the host comment explains this trap by name, and should keep doing so.
  assert.ok(!/\+=\s*\w*AcceleratorKey|CoreWebView2AcceleratorKeyPressedEventArgs/.test(mainForm),
    'AcceleratorKeyPressed lives on CoreWebView2Controller, which the WinForms wrapper does not '
    + 'expose - it compiles nowhere, and only fails once the Windows runner gets to it');
});

/**
 * Strip comments and string literals, so brace counting is not thrown off by the
 * JavaScript held inside the host's verbatim strings.
 */
function stripCsLiterals(cs) {
  return cs
    .replace(/@"(?:[^"]|"")*"/g, '""')   // verbatim strings, which may span lines
    .replace(/"(?:\\.|[^"\\])*"/g, '""') // ordinary strings
    .replace(/\/\/.*$/gm, '');           // line comments
}

/**
 * Find a local declared while another of the same name is still in scope. C# rejects
 * this, but two sibling blocks may each declare the same name, so scopes are tracked
 * with a stack rather than a flat set.
 */
function shadowedLocals(cs) {
  const found = [];
  const scopes = [new Map()];
  stripCsLiterals(cs).split('\n').forEach((line, i) => {
    const decl = line.match(/^\s+(?:var|string|bool|int|uint|long|float|double)\s+(\w+)\s*=/);
    if (decl) {
      const name = decl[1];
      for (const scope of scopes) {
        if (scope.has(name)) found.push(`'${name}' on line ${i + 1} is already in scope from line ${scope.get(name)}`);
      }
      scopes[scopes.length - 1].set(name, i + 1);
    }
    for (const ch of line.replace(/'.'/g, '')) {
      if (ch === '{') scopes.push(new Map());
      else if (ch === '}' && scopes.length > 1) scopes.pop();
    }
  });
  return found;
}

test('no local in the host hides another one - the C# compiler is five minutes away', () => {
  // There is no .NET SDK on the machine that writes this code, so a name clash would
  // otherwise be found by a Windows runner rather than by anything here.
  const clashes = shadowedLocals(mainForm);
  assert.deepEqual(clashes, [], `the host would not compile:\n  ${clashes.join('\n  ')}`);
  // ...and prove the check has teeth, on a snippet with a known clash.
  const broken = 'void M()\n{\n  var options = 1;\n  string options = "x";\n}\n';
  assert.equal(shadowedLocals(broken).length, 1, 'the shadowing check does not actually detect shadowing');
  // Two sibling loops may each use the same name; that is legal and must not be flagged.
  const fine = 'void M()\n{\n  for (int i = 0; ; ) { var t = 1; }\n  for (int j = 0; ; ) { var t = 2; }\n}\n';
  assert.deepEqual(shadowedLocals(fine), [], 'sibling scopes were wrongly reported as a clash');
});

test('the window can ask the page to start small, and the page listens', async () => {
  // On a machine with no graphics card the medium preset allocates enough float
  // texture to lose the drawing context before anything can be turned down, so the
  // host starts the page at the low preset by putting it in the address bar.
  const main = await read('src/js/90-main.js');
  assert.match(mainForm, /\?quality=low/, 'the host never asks for the small preset');
  assert.match(main, /URLSearchParams\(location\.search\)/, 'the page never reads its own address bar');
  assert.match(main, /params\.get\('quality'\)/, 'the page ignores a quality in the address bar');
  assert.match(main, /QUALITY\[quality\]/, 'the page does not check the quality against the real presets');
  const sim = await read('src/js/30-sim.js');
  assert.match(sim, /\blow:\s*\{/, 'there is no low preset for the host to ask for');
});

test('a crash reopens the sandbox smaller instead of closing the window', async () => {
  // The drawing process dying is nearly always the graphics driver being asked for more
  // than it could finish. Closing the program leaves the person with a window that never
  // opens, because the next run does exactly the same thing - so the host reloads in safe
  // mode, and the page has to understand what it is being asked for. Neither compiler
  // checks that these two agree.
  assert.match(mainForm, /ProcessFailed \+= OnProcessFailed/, 'the host does not handle the drawing process dying');
  assert.match(mainForm, /\?quality=low&safe=1/, 'the host never asks the page for safe mode');
  assert.match(mainForm, /if \(_smoke \|\| _safe\)/,
    'a second crash must give up; retrying for ever is worse than an honest failure');
  const main = await read('src/js/90-main.js');
  assert.match(main, /params\.get\('safe'\) === '1'/, 'the page ignores the safe mode the host asks for');
  assert.match(main, /if \(APP\.safe\) APP\.quality = 'low'/, 'safe mode does not actually reduce anything');
  // And the page must reach the same conclusion on its own, for a browser with no host.
  assert.match(main, /if \(readBoot\(\)\) APP\.safe = true/,
    'the page does not notice that its own last run failed to finish');
  assert.match(main, /webglcontextrestored/, 'a driver reset is never recovered from');
  assert.match(main, /gfx\.adoptContext\(\)/,
    'a restored context needs its extensions asked for again, or float targets stop working');
});

test('the host only subscribes to events that exist on CoreWebView2', () => {
  // A spelling check against the .NET surface. Anything not on this list is either a typo
  // or lives on another class; either way it costs a five-minute Windows build to find out.
  const known = new Set([
    'NavigationStarting', 'NavigationCompleted', 'NewWindowRequested', 'ProcessFailed',
    'DocumentTitleChanged', 'ContainsFullScreenElementChanged', 'WebMessageReceived',
    'PermissionRequested', 'SourceChanged', 'HistoryChanged', 'ContentLoading',
    'DOMContentLoaded', 'WebResourceRequested', 'WindowCloseRequested', 'ScriptDialogOpening',
    'FrameNavigationStarting', 'FrameNavigationCompleted', 'DownloadStarting',
  ]);
  const used = [...mainForm.matchAll(/\bcore\.(\w+)\s*\+=/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'the host subscribes to no WebView2 events at all');
  for (const name of used) assert.ok(known.has(name), `core.${name} is not an event on CoreWebView2`);
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
