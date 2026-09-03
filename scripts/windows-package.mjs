// Windows packaging. Runs on a Windows machine (GitHub's windows runner in CI):
//   node scripts/windows-package.mjs --version v1.0.0 [--smoke-test] [--zip] [--no-installer]
// 1. builds the WebView2 host program (installer/host) with the .NET SDK,
// 2. assembles dist/Powder Toy 3D/ (program + the single-file app + read-me),
// 3. optionally runs the program's --smoke-test to prove the simulation really starts,
// 4. optionally zips the folder, and builds the Inno Setup installer.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);
const version = (opt('--version') || '0.0.0').replace(/^v/, '');

const APP = 'Powder Toy 3D';
const dist = path.join(root, 'dist', APP);
const hostOut = path.join(root, 'build', 'host');
const csproj = path.join(root, 'installer', 'host', 'PowderToy3D.csproj');

function run(cmd, cmdArgs, extra = {}) {
  console.log('>', cmd, cmdArgs.join(' '));
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...extra });
  if (r.status !== 0) { console.error(`${cmd} failed with exit code ${r.status}`); process.exit(r.status || 1); }
  return r;
}

// The build only skips assembly when asked to re-run a smoke test against an existing dist folder.
const assemble = !(has('--smoke-test') && !has('--version'));

if (assemble) {
  // 1. Build the host program.
  rmSync(hostOut, { recursive: true, force: true });
  run('dotnet', ['build', csproj, '-c', 'Release', '-o', hostOut, `-p:AppVersion=${version}`, '-nologo']);

  // 2. Assemble the folder that gets shipped.
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const f of [`${APP}.html`, 'READ ME FIRST.txt']) {
    const src = path.join(root, f);
    if (!existsSync(src)) { console.error('Missing file to ship:', src, '- run "npm run build" first'); process.exit(1); }
    cpSync(src, path.join(dist, f));
  }
  cpSync(hostOut, dist, { recursive: true });
  for (const f of readdirSync(dist)) if (/\.(pdb|xml)$/i.test(f) || /\.dll\.config$/i.test(f)) unlinkSync(path.join(dist, f));

  // The native helper must be present for every Windows architecture, in both layouts the
  // WebView2 SDK looks in (x64\ and runtimes\win-x64\native\), or the app fails with
  // "incorrect format" on machines whose architecture differs from the build machine's.
  const pkgVersion = readFileSync(csproj, 'utf8').match(/Microsoft\.Web\.WebView2" Version="([^"]+)"/)[1];
  const nuget = path.join(process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages'), 'microsoft.web.webview2', pkgVersion, 'runtimes');
  for (const arch of ['x86', 'x64', 'arm64']) {
    const src = path.join(nuget, `win-${arch}`, 'native', 'WebView2Loader.dll');
    if (!existsSync(src)) { console.error('Missing native helper in the package cache:', src); process.exit(1); }
    for (const dest of [path.join(dist, arch, 'WebView2Loader.dll'), path.join(dist, 'runtimes', `win-${arch}`, 'native', 'WebView2Loader.dll')]) {
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest);
    }
  }
  const rootLoader = path.join(dist, 'WebView2Loader.dll');
  if (existsSync(rootLoader)) unlinkSync(rootLoader); // never leave a single-architecture copy where it shadows the right one
  for (const arch of ['x86', 'x64', 'arm64']) for (const f of [path.join(dist, arch, 'WebView2Loader.dll'), path.join(dist, 'runtimes', `win-${arch}`, 'native', 'WebView2Loader.dll')]) {
    if (!existsSync(f)) { console.error('Native helper missing after assembly:', f); process.exit(1); }
  }
  console.log('Assembled', dist);
  for (const f of readdirSync(dist)) console.log('  ', f, statSync(path.join(dist, f)).isDirectory() ? '(folder)' : `${statSync(path.join(dist, f)).size} bytes`);
}

if (has('--smoke-test')) {
  // 3. Prove the packaged program really starts the simulation on this Windows machine.
  //
  //    Both ways round, and that is the point. The ordinary run reaches the GPU the way
  //    every Windows browser does - ANGLE translating the shaders into HLSL for Direct3D's
  //    compiler - which is where a ray marcher gets into trouble, and is the path a person
  //    installing this actually takes. The software run covers the machine with no usable
  //    driver, which is what the fallback shortcut is for. This test only forced software
  //    once, and a shader that crashed every real Windows machine passed it every time.
  const exe = path.join(dist, `${APP}.exe`);
  if (!existsSync(exe)) { console.error('Program not built:', exe); process.exit(1); }
  const note = path.join(process.env.LOCALAPPDATA || os.homedir(), APP, 'Data', 'smoke-test.txt');

  /** Run one mode, with a second attempt before calling it a failure. */
  const smoke = (label, extra) => {
    // Two attempts, because a build runner draws without a graphics card either way and
    // one has already refused an off-screen buffer on a build whose identical step had
    // passed minutes earlier. A real break fails the same way twice, and both attempts
    // are printed so nothing is swept away.
    let r = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      rmSync(note, { force: true }); // so a stale note cannot be read as this attempt's result
      r = spawnSync(exe, ['--smoke-test', ...extra], { stdio: 'inherit', timeout: 480000 });
      const status = existsSync(note) ? readFileSync(note, 'utf8').trim() : '(no note written)';
      console.log(`[${label}] attempt ${attempt} exit code:`, r.status);
      console.log(`[${label}] attempt ${attempt} says:`, status);
      if (r.status === 0) return;
      if (attempt === 1) console.log(`[${label}] trying once more before calling it a failure.`);
    }
    console.error(`[${label}] smoke test failed.`);
    process.exit(r.status || 1);
  };

  smoke('the ordinary way', []);
  smoke('without a graphics card', ['--software']);
}

if (has('--zip')) {
  const zip = path.join(root, 'Powder-Toy-3D-Windows.zip');
  rmSync(zip, { force: true });
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${dist}" -DestinationPath "${zip}"`]);
  console.log('Wrote', zip);
}

if (!has('--no-installer') && has('--version')) {
  // 4. Build the installer with Inno Setup (preinstalled on GitHub's Windows runners).
  const bootstrapper = path.join(root, 'installer', 'MicrosoftEdgeWebview2Setup.exe');
  if (!existsSync(bootstrapper)) {
    run('powershell', ['-NoProfile', '-Command', `Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile "${bootstrapper}"`]);
  }
  const iscc = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
    .map((p) => path.join(p, 'Inno Setup 6', 'ISCC.exe')).find(existsSync);
  if (!iscc) { console.error('Inno Setup 6 not found'); process.exit(1); }
  run(iscc, [`/DAppVersion=${version}`, path.join(root, 'installer', 'PowderToy3D.iss')]);
  for (const f of readdirSync(path.join(root, 'installer', 'Output'))) console.log('Installer:', f);
}
