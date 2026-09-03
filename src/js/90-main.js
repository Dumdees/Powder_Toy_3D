// Boot, the frame loop, and the wiring between the panels and the solver.

const APP = {
  playing: true,
  sceneId: 'dam',
  quality: 'medium',
  panelOpen: true,
  helpOpen: false,
  stepOnce: false,
  halt: false,
  safe: false,        // started small because the last run did not survive
  cursor: [0.5, 0.5],
};

/**
 * How much work one frame is allowed to be, from the most cautious rung to the most
 * lavish. The sandbox always starts on rung 0 and climbs only once it has watched a
 * few frames go by quickly, because the alternative is what this ladder exists to
 * prevent: asking an unknown graphics card for a full-detail frame, having it take
 * several seconds, and having Windows decide the driver has hung and reset it. That
 * reset takes the whole page down with it, which looks to the person sitting there
 * like the program crashed on startup - a black window and nothing else.
 *
 * So the first frame is deliberately cheap. A capable card climbs to the top in well
 * under a second and nobody notices; a weak one settles where it can actually keep up.
 */
const DETAIL = [
  { scale: 0.30, surfSteps: 48,  volSteps:  32, shadowSteps: 8,  photons: 64,  smoothing: 1, substeps: 1, iterations: 24 },
  { scale: 0.40, surfSteps: 72,  volSteps:  48, shadowSteps: 14, photons: 96,  smoothing: 2, substeps: 1, iterations: 26 },
  { scale: 0.50, surfSteps: 100, volSteps:  64, shadowSteps: 20, photons: 128, smoothing: 2, substeps: 2, iterations: 28 },
  { scale: 0.62, surfSteps: 128, volSteps:  80, shadowSteps: 28, photons: 160, smoothing: 3, substeps: 2, iterations: 32 },
  { scale: 0.75, surfSteps: 160, volSteps:  96, shadowSteps: 40, photons: 192, smoothing: 3, substeps: 2, iterations: 36 },
  { scale: 0.90, surfSteps: 200, volSteps: 112, shadowSteps: 48, photons: 224, smoothing: 3, substeps: 3, iterations: 48 },
  { scale: 1.00, surfSteps: 240, volSteps: 128, shadowSteps: 56, photons: 256, smoothing: 3, substeps: 3, iterations: 60 },
];

// Substeps are the exception to "cheap rungs cut everything": halving them is the
// single biggest saving there is, and also the one that changes the physics most,
// because dt appears in the term that decides how much of gravity the pressure solve
// just cancelled - which is what Coulomb friction is gated on. So a single substep is
// for the two emergency rungs only, and from rung 2 - where the Low preset rests, and
// where a slow machine is expected to settle - grains behave properly again.
//
// Note what does *not* fall away at the bottom. Measured on the slowest thing to hand,
// dropping the pressure solve from 24 sweeps to 14 saved 5% of a frame and cost a
// visible amount of physics: the solve is what decides how much of gravity a grain has
// had cancelled, which is the term Coulomb friction is gated on, so a heap of sand
// stands measurably shallower for almost nothing back. The savings worth having are
// the size of the picture and the number of substeps; the solver keeps its sweeps.

// Frame periods, in milliseconds. `fast` has to sit above the gap a screen refresh
// puts there - a machine with capacity to spare still reports 16.7 ms on a 60 Hz
// display and 20 ms on a 50 Hz one - or nothing would ever count as quick enough to
// earn a rung.
const PACE = { fast: 26, slow: 90, stall: 400, desperate: 700 };

/**
 * Where the sandbox remembers, between runs, that it did not survive the last one.
 * Written before the first frame and cleared once the loop has been up for a couple
 * of seconds, so a start that dies part way leaves the note behind for next time.
 * localStorage is refused for a file:// page in some browsers, which is why every
 * touch is wrapped: the ladder above still protects a double-clicked file, this only
 * adds the memory across runs that the installed program gets.
 */
const BOOT_KEY = 'powdertoy3d.boot';
const readBoot = () => { try { return localStorage.getItem(BOOT_KEY); } catch { return null; } };
const writeBoot = (v) => { try { if (v) localStorage.setItem(BOOT_KEY, v); else localStorage.removeItem(BOOT_KEY); } catch { /* private mode, or a file:// page */ } };

/**
 * Put a message in place of the sandbox. `heading` and `advice` are what separate a
 * dead end from a pause: a driver that has reset and is being started again is not a
 * computer that cannot run this, and should not be told that it is.
 *
 * Note the filter. Element.append() turns a null into the text "null" rather than
 * skipping it, which is not what any of the callers mean by leaving a part out.
 */
function banner(heading, message, detail, advice) {
  const box = document.getElementById('boot');
  box.dataset.mode = 'fatal';
  box.hidden = false;
  box.innerHTML = '';
  box.append(...[
    el('h1', { text: heading }),
    el('p', { text: message }),
    detail ? el('p', { html: '<code>' + String(detail).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</code>' }) : null,
    advice ? el('p', { text: advice }) : null,
  ].filter(Boolean));
  document.getElementById('ui').hidden = true;
}

/**
 * Say what is happening, on the page and in the window title.
 *
 * The title is not decoration. Setting up the graphics means handing a driver a large
 * ray-marching shader and waiting, and if that goes badly the page has drawn nothing
 * yet - so the only thing anyone can see is the title bar, which the Windows program
 * mirrors from here. A window reading "Powder Toy 3D - preparing trace (21 of 29)" says
 * exactly where it stopped; a black one says nothing at all.
 */
function progress(message, detail) {
  document.title = detail ? `Powder Toy 3D - ${message} (${detail})` : `Powder Toy 3D - ${message}`;
  const box = document.getElementById('boot');
  if (box.dataset.mode === 'fatal') return;   // never talk over a real failure
  box.dataset.mode = 'progress';
  box.hidden = false;
  box.innerHTML = '';
  box.append(el('h1', { text: 'Powder Toy 3D' }),
             el('p', { text: detail ? `${message} (${detail})...` : `${message}...` }));
}

/** Take the message away once there is something to look at. */
function progressDone() {
  const box = document.getElementById('boot');
  if (box.dataset.mode === 'fatal') return;
  box.hidden = true;
  box.dataset.mode = '';
  document.title = 'Powder Toy 3D \u00b7 a physics sandbox';
}

function fatal(message, detail) {
  banner('Powder Toy 3D cannot start', message, detail,
    'It needs WebGL 2 with floating point render targets - any graphics card from the last ten years, '
    + 'in an up to date Chrome, Edge, Firefox or Safari.');
}

/**
 * Let the address bar choose the detail level and the opening scene:
 * "...html?quality=low&scene=volcano". The Windows program uses this to start small
 * on a machine with no graphics card, where the medium preset's float textures are
 * enough to lose the drawing context before anything can be turned down.
 */
function applyUrlOptions() {
  try {
    const params = new URLSearchParams(location.search);
    const quality = params.get('quality');
    if (quality && QUALITY[quality]) APP.quality = quality;
    const scene = params.get('scene');
    if (scene && SCENES.some((s) => s.id === scene)) APP.sceneId = scene;
    if (params.get('safe') === '1') APP.safe = true;
  } catch { /* a file:// URL with no query is perfectly normal */ }
}

/** One turn of the event loop with a repaint, so a message actually reaches the screen. */
const nextFrame = () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));

async function start() {
  applyUrlOptions();
  progress('Starting');
  // Did the last run get as far as drawing steadily? If the note is still there it
  // did not, so come back deliberately small rather than repeating whatever killed
  // it. Someone whose card cannot manage the middle preset would otherwise meet the
  // same black window every time they opened the program.
  if (readBoot()) APP.safe = true;
  if (APP.safe) APP.quality = 'low';
  writeBoot('starting');
  const canvas = document.getElementById('view');
  let gfx;
  try {
    gfx = new Gfx(canvas);
  } catch (err) {
    fatal(err instanceof GLError ? err.message : 'Something went wrong setting up the graphics.', err && err.message);
    return;
  }

  let sim, renderer;
  const cam = new OrbitCamera([64, 64, 64]);
  let ui = null;
  let wasSettled = false;
  let lastMeasure = 0;
  let frames = 0;
  let fpsClock = performance.now();
  let fps = 60;
  let lastTime = performance.now();
  // The governor: which rung of DETAIL we are on, and the evidence for moving.
  const perf = { auto: true, rung: 0, fast: 0, slow: 0, settle: 0 };
  // The rung the very first frame was drawn at, kept so it can be checked later.
  let openedAtRung = 0;
  const startedAt = performance.now();
  let bootCleared = false;

  /** The highest rung this preset allows; a preset is a ceiling, not a setting. */
  const detailCeiling = () => Math.min(DETAIL.length - 1, QUALITY[APP.quality].detail);

  /**
   * Put a rung into effect. Everything here is per-frame effort, so it can change at
   * any moment without rebuilding anything - which is the point, as the alternative
   * to backing off quickly is a driver reset.
   */
  function applyDetail(rung, { resize = true } = {}) {
    perf.rung = clamp(Math.round(rung), 0, detailCeiling());
    const d = DETAIL[perf.rung];
    const before = RENDER.scale;
    RENDER.scale = d.scale;
    RENDER.surfSteps = d.surfSteps;
    RENDER.volSteps = d.volSteps;
    RENDER.shadowSteps = d.shadowSteps;
    RENDER.photons = d.photons;
    RENDER.smoothing = d.smoothing;
    PHYSICS.substeps = d.substeps;
    PHYSICS.iterations = d.iterations;
    if (renderer) {
      if (resize && before !== RENDER.scale) sizeCanvas(true);
      renderer.reset();
    }
    perf.settle = 2;  // the frame that changes size is slow for reasons of its own
    perf.fast = 0;
    perf.slow = 0;
    if (ui) ui.refresh();
  }

  /**
   * Rebuild everything. With `defer` the shaders are only queued and the caller takes
   * on the waiting - which for the first run means a frame at a time, with the window
   * saying what it is waiting for.
   */
  const build = (opts = {}) => {
    const Q = QUALITY[APP.quality];
    applyDetail(Math.min(perf.rung, Q.detail), { resize: false });
    gfx.releaseAll();
    sim = new Sim(gfx, { grid: Q.grid, particles: Q.particles });
    renderer = new Renderer(gfx, sim);
    if (!opts.defer) finishBuild();
  };

  /** Collect the shaders the constructors queued, then all that depends on them. */
  const finishBuild = () => {
    // Only say anything when there is something to wait for. A rebuild after the first
    // one usually has an empty queue, and a banner that flashes up saying "0 of 0" and
    // then stays there is worse than silence.
    gfx.finishPrograms(gfx.programsPending === 0 ? null : (done, total, name) =>
      progress('Preparing the picture', `${Math.min(done + 1, total)} of ${total}${name ? ' \u2013 ' + name : ''}`));
    cam.setGrid([sim.n.nx, sim.n.ny, sim.n.nz]);
    sizeCanvas(true);
    loadScene(APP.sceneId, true);
    if (ui) {
      ui.setInfo(`${sim.n.nx}×${sim.n.ny}×${sim.n.nz} cells at ${(sim.dx * 100).toFixed(1)} cm · `
        + `up to ${(sim.capacity / 1000).toFixed(0)}k particles · ${gfx.renderer}`);
    }
    // Whoever asked for the rebuild, there is something to look at now. Without this a
    // rebuild from the frame loop leaves its own progress message covering the sandbox.
    progressDone();
  };

  /**
   * Wait for the driver to finish the queued shaders without stopping the page.
   *
   * KHR_parallel_shader_compile is what makes this possible: it answers "is this one
   * done yet" without the driver having to finish it first. So the window can count them
   * off as they land, and if one is going to take a very long time - a large ray-marching
   * shader through ANGLE and Direct3D's compiler being the candidate - the window says
   * which one instead of going black.
   */
  async function settlePrograms() {
    if (!gfx.canPollCompile) return;   // no way to ask; finishBuild() waits the old way
    const total = gfx.programsPending;
    // Roughly a minute at a normal frame rate. Past that, stop counting and just wait,
    // rather than spinning for ever on a driver that answers oddly.
    for (let guard = 0; guard < 3600; guard++) {
      const done = gfx.compiledCount();
      progress('Preparing the picture', `${done} of ${total}`);
      if (done >= total) return;
      await nextFrame();
    }
  }

  const loadScene = (id, quiet) => {
    const scene = SCENES.find((s) => s.id === id) || SCENES[0];
    APP.sceneId = scene.id;
    brush.depth = 0;
    sim.load(scene);
    if (scene.camera) cam.apply(scene.camera);
    renderer.reset();
    if (ui && !quiet) ui.setScene(scene.id);
    else if (ui) ui.setScene(scene.id);
  };

  function sizeCanvas(force) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (force || canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      renderer.resize(canvas.clientWidth, canvas.clientHeight);
    }
  }

  // ---------------------------------------------------------------- the brush
  function updateBrush(dt, aspect) {
    const pick = renderer.pickResult;
    const dir = cam.ray(APP.cursor[0], APP.cursor[1], aspect, RENDER.fov);
    let pos;
    if (pick.hit) {
      pos = pick.pos.slice();
    } else {
      // Nothing under the pointer: hang the brush on a plane through the middle.
      const centre = [sim.n.nx * 0.5, sim.n.ny * 0.45, sim.n.nz * 0.5];
      const t = Math.max(v3dot(v3sub(centre, cam.position), dir), sim.n.nx * 0.2);
      pos = v3add(cam.position, v3scale(dir, t));
    }
    if (brush.depth) pos = v3add(pos, v3scale(dir, brush.depth));
    for (let i = 0; i < 3; i++) pos[i] = clamp(pos[i], 1.5, [sim.n.nx, sim.n.ny, sim.n.nz][i] - 1.5);
    brush.vel = brush.prev && dt > 1e-4
      ? v3scale(v3sub(pos, brush.prev), sim.dx / dt)
      : [0, 0, 0];
    // Ignore the jump when the brush snaps onto a new surface.
    if (v3len(brush.vel) > 40) brush.vel = [0, 0, 0];
    brush.prev = pos;
    brush.pos = pos;
  }

  function brushForSim() {
    if (!brush.active || brush.tool === TOOL.DRAW) return { active: false };
    const signed = (brush.tool === TOOL.PUSH || brush.tool === TOOL.HEAT) && brush.shift ? -1 : 1;
    return {
      active: true, tool: brush.tool, pos: brush.pos, vel: brush.vel,
      radius: brush.radius, strength: signed,
    };
  }

  function paint() {
    const m = MATERIALS[brush.material];
    const rigid = m.phase === PHASE.RIGID;
    const perCell = rigid ? 2 : (sim.perCell || 4);
    const volume = (4 / 3) * Math.PI * Math.pow(brush.radius, 3);
    const n = clamp(Math.round(volume * perCell * (brush.rate / 100) * (rigid ? 0.10 : 0.22)), 1, 6000);
    sim.spawn({ mat: brush.material, pos: brush.pos, radius: brush.radius, count: n, jitter: rigid ? 0 : 0.1 });
  }

  // ----------------------------------------------------------------- controls
  const ctx = {
    get sceneId() { return APP.sceneId; },
    get quality() { return APP.quality; },
    setMaterial(id) { brush.material = id; ui.setMaterial(id); if (brush.tool === TOOL.ERASE) ctx.setTool(TOOL.DRAW); },
    setTool(id) { brush.tool = id; brush.depth = 0; ui.setTool(id); },
    setRadius(r) { brush.radius = clamp(Number(r) || 1, 1, 24); ui.setRadius(brush.radius); },
    loadScene(id) { loadScene(id); },
    setQuality(q) {
      if (!QUALITY[q]) return;
      APP.quality = q;
      APP.safe = false;
      perf.auto = true;
      ui.setQuality(q);
      build();
      ui.refresh();
    },
    rescale() { sizeCanvas(true); renderer.reset(); },
    get autoDetail() { return perf.auto; },
    setAutoDetail(on) { perf.auto = !!on; perf.fast = 0; perf.slow = 0; perf.settle = 2; },
    /** A slider was moved by hand, so stop second-guessing it. */
    manualDetail() { perf.auto = false; if (ui) ui.autoDetail(false); },
    get safeMode() { return APP.safe; },
    get detailRung() { return perf.rung; },
    get detailCeiling() { return detailCeiling(); },
    get openedAtRung() { return openedAtRung; },
    // Two hatches for the tests, which drive the governor by hand rather than by
    // waiting on a clock: a software rasteriser cannot produce a fast frame to prove
    // the climbing half works.
    setDetailRung(r) { applyDetail(r); },
    feedFrameTime(ms) { perf.settle = 0; govern(ms); },
    resetAccumulation() { renderer.reset(); },
    togglePlay() { APP.playing = !APP.playing; ui.playing(APP.playing); renderer.reset(); },
    stepOnce() { APP.stepOnce = true; APP.playing = false; ui.playing(false); },
    empty() { sim.clear(); renderer.reset(); },
    togglePanel() { APP.panelOpen = !APP.panelOpen; ui.panel(APP.panelOpen); },
    toggleHelp() { APP.helpOpen = !APP.helpOpen; ui.help(APP.helpOpen); },
    closeHelp() { APP.helpOpen = false; ui.help(false); },
    /**
     * Standard Fullscreen API, which works in a browser and is also what the Windows
     * program watches for so it can drop its own window border to match.
     */
    toggleFullscreen() {
      try {
        if (document.fullscreenElement) {
          if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        } else {
          const el = document.documentElement;
          if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
        }
      } catch { /* some browsers refuse without a gesture; nothing to recover */ }
    },
    cursor(uv) { APP.cursor = uv; brush.show = true; },
    brushDown() { renderer.reset(); },
  };

  try {
    // Queue every shader without waiting on any of them, then let the driver get on
    // with it while the window shows what it is doing. Asking a driver for a large
    // ray-marching shader is the slowest and riskiest thing that happens here, and
    // until now it happened behind a black window with nothing to say for itself.
    progress('Setting up the graphics');
    await nextFrame();
    build({ defer: true });
    await settlePrograms();
    finishBuild();
  } catch (err) {
    fatal('The sandbox could not set up its simulation on this graphics card.', err && err.message);
    return;
  }
  progressDone();
  openedAtRung = perf.rung;
  document.getElementById('ui').hidden = false;
  ui = buildUI(ctx);
  ui.setMaterial(brush.material);
  ui.setTool(brush.tool);
  ui.setScene(APP.sceneId);
  ui.setRadius(brush.radius);
  ui.playing(APP.playing);
  ui.setInfo(`${sim.n.nx}×${sim.n.ny}×${sim.n.nz} cells at ${(sim.dx * 100).toFixed(1)} cm · `
    + `up to ${(sim.capacity / 1000).toFixed(0)}k particles · ${gfx.renderer}`);
  attachInput(canvas, cam, ctx);
  addEventListener('resize', () => sizeCanvas(false));
  // A lost context means the driver gave up and started again - usually because it
  // was asked for more than it could do in one go. Calling preventDefault() is what
  // lets the browser hand the context back, so the sandbox stops, remembers that this
  // run went badly, and rebuilds itself small when the context returns.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    APP.halt = true;
    APP.safe = true;
    writeBoot('lost');
    bootCleared = true;   // leave the note behind; the next run should open small
    banner('Just a moment', 'The graphics card had to reset. Starting the sandbox again with less detail...');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      // Everything built against the old context died with it, and the new one starts
      // with no extensions granted, so both halves have to be redone before anything
      // is rebuilt on top of them.
      gfx.forgetContext();
      gfx.adoptContext();
      APP.quality = 'low';
      perf.auto = true;
      applyDetail(0, { resize: false });
      build();
      document.getElementById('boot').hidden = true;
      document.getElementById('ui').hidden = false;
      if (ui) { ui.setQuality('low'); ui.refresh(); }
      APP.halt = false;
      lastTime = performance.now();
    } catch (err) {
      fatal('The graphics card had to reset and the sandbox could not start again.', err && err.message);
    }
  });

  /** Rebuild the fields, refresh the caustics, pick, and put a frame on screen. */
  function drawOnce(aspect, settled) {
    sim.buildRenderFields();
    renderer.updateCaustics(renderer.sceneUniforms());
    const scene = renderer.sceneUniforms();
    renderer.pickAt(scene, cam, aspect, APP.cursor);
    renderer.draw(scene, cam, aspect, brush, !!settled);
  }

  /** Advance the physics by `n` substeps without drawing anything. */
  function advance(n, dt) {
    const step = dt || (PHYSICS.timeScale / 60) / Math.max(1, Math.round(PHYSICS.substeps));
    for (let i = 0; i < n; i++) {
      sim.step(step, { active: false });
      sim.runEmitters(step);
    }
    renderer.reset();
  }

  // -------------------------------------------------------------- frame loop
  function frame(now) {
    requestAnimationFrame(frame);
    // Nothing to do while the window is in the background, or while halted.
    if (APP.halt || document.hidden) { lastTime = now; return; }
    // The real gap between frames, before it is clamped for the physics. When the
    // graphics card is the thing holding us up, this is where it shows.
    const periodMs = now - lastTime;
    const dtReal = Math.min(0.1, Math.max(1e-4, periodMs / 1000));
    lastTime = now;
    sizeCanvas(false);
    const aspect = Math.max(0.2, canvas.clientWidth / Math.max(1, canvas.clientHeight));

    updateBrush(dtReal, aspect);
    if (brush.active && brush.tool === TOOL.DRAW) paint();

    const running = APP.playing || APP.stepOnce;
    if (running) {
      const sub = Math.max(1, Math.round(PHYSICS.substeps));
      const frameDt = PHYSICS.timeScale / 60;
      const dt = frameDt / sub;
      const b = brushForSim();
      for (let i = 0; i < sub; i++) sim.step(dt, b);
      sim.runEmitters(frameDt);
      APP.stepOnce = false;
    } else if (brush.active && brush.tool !== TOOL.DRAW) {
      // Let the brush act even while paused, so you can shape things by hand.
      sim.step(1 / 600, brushForSim());
    }

    const settled = !running && !cam.moved && !brush.active;
    if (settled && !wasSettled) renderer.reset();
    wasSettled = settled;
    cam.moved = false;
    drawOnce(aspect, settled);
    govern(periodMs);

    // The loop has been up and drawing for a while, so this run counts as a good
    // one; drop the note that would otherwise start the next run in safe mode.
    if (!bootCleared && now - startedAt > 2500) { bootCleared = true; writeBoot(null); }

    // ------------------------------------------------------------- reporting
    frames++;
    if (now - fpsClock > 400) {
      fps = frames * 1000 / (now - fpsClock);
      frames = 0;
      fpsClock = now;
      if (now - lastMeasure > 900) { sim.measure(); lastMeasure = now; }
      const pct = Math.round(100 * sim.activeCount / sim.capacity);
      ui.readout(
        `<span><b>${fps.toFixed(0)}</b> fps</span>`
        + `<span class="opt"><b>${(sim.activeCount / 1000).toFixed(0)}k</b> specks (${pct}%)</span>`
        + `<span class="opt"><b>${sim.time.toFixed(1)}</b> s simulated</span>`
        + `<span class="opt">${sim.n.nx}³ grid</span>`);
    }
  }

  /**
   * Watch how long frames actually take and move up or down the ladder to suit.
   *
   * Coming down is deliberately far quicker than going up. A frame that overruns
   * badly is a frame that nearly became a driver reset, so that costs a rung at once
   * on the evidence of one frame; earning a rung back takes a run of quick ones.
   */
  function govern(periodMs) {
    if (!perf.auto) return;
    if (perf.settle > 0) { perf.settle--; return; }
    const ceiling = detailCeiling();
    if (periodMs > PACE.stall) {
      // Close to the edge. Give up two rungs without waiting to see it again.
      if (perf.rung > 0) { applyDetail(perf.rung - 2); return; }
      // Already at the bottom and still struggling: the grid itself is too big for
      // this machine, so drop to a smaller one. That means rebuilding the solver,
      // which reloads the scene - so it is only allowed during the opening seconds,
      // while there is nothing of anyone's to lose. After that a slow machine gets a
      // slow sandbox, which is a far better bargain than one that empties itself.
      if (!bootCleared && periodMs > PACE.desperate && APP.quality !== 'low') {
        APP.quality = 'low';
        APP.safe = true;
        build();
        if (ui) { ui.setQuality('low'); ui.refresh(); }
      }
      return;
    }
    if (periodMs > PACE.slow) {
      perf.fast = 0;
      if (++perf.slow >= 3 && perf.rung > 0) applyDetail(perf.rung - 1);
      return;
    }
    if (periodMs < PACE.fast) {
      perf.slow = 0;
      if (++perf.fast >= 18 && perf.rung < ceiling) applyDetail(perf.rung + 1);
      return;
    }
    // Comfortable: let both tallies decay so a single odd frame proves nothing.
    if (perf.fast > 0) perf.fast--;
    if (perf.slow > 0) perf.slow--;
  }
  // Start the clock here rather than at the top: everything between was shader
  // compilation, and charging the first frame with it would read as a stalled one.
  lastTime = performance.now();
  requestAnimationFrame(frame);

  // A window in the background gets no frames at all, so the first one after it comes
  // back would otherwise arrive minutes after the last and look like a driver about to
  // be reset. Restart the clock and let a couple of frames go by before judging again.
  addEventListener('visibilitychange', () => {
    lastTime = performance.now();
    perf.settle = 2;
  });

  // A small hatch for tests, and for anyone who wants to poke at the settings
  // from the browser console.
  window.PowderToy = {
    PHYSICS, RENDER, QUALITY, DETAIL, MATERIALS, SCENES, TOOLS, brush, app: APP, controls: ctx,
    get sim() { return sim; },
    get renderer() { return renderer; },
    get camera() { return cam; },
    get fps() { return fps; },
    advance, drawOnce,
  };
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start);
else start();
