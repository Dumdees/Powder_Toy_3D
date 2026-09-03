// Boot, the frame loop, and the wiring between the panels and the solver.

const APP = {
  playing: true,
  sceneId: 'dam',
  quality: 'medium',
  panelOpen: true,
  helpOpen: false,
  stepOnce: false,
  halt: false,
  cursor: [0.5, 0.5],
};

function fatal(message, detail) {
  const box = document.getElementById('boot');
  box.hidden = false;
  box.innerHTML = '';
  box.append(
    el('h1', { text: 'Powder Toy 3D cannot start' }),
    el('p', { text: message }),
    detail ? el('p', { html: '<code>' + String(detail).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</code>' }) : null,
    el('p', { text: 'It needs WebGL 2 with floating point render targets - any graphics card from the last ten years, in an up to date Chrome, Edge, Firefox or Safari.' }),
  );
  document.getElementById('ui').hidden = true;
}

function start() {
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
  let gpuBudget = 0;

  const build = () => {
    const Q = QUALITY[APP.quality];
    PHYSICS.iterations = Q.iterations;
    PHYSICS.substeps = Q.substeps;
    RENDER.scale = Q.scale;
    RENDER.photons = Q.photons;
    gfx.releaseAll();
    sim = new Sim(gfx, { grid: Q.grid, particles: Q.particles });
    renderer = new Renderer(gfx, sim);
    cam.setGrid([sim.n.nx, sim.n.ny, sim.n.nz]);
    sizeCanvas(true);
    loadScene(APP.sceneId, true);
    if (ui) {
      ui.setInfo(`${sim.n.nx}×${sim.n.ny}×${sim.n.nz} cells at ${(sim.dx * 100).toFixed(1)} cm · `
        + `up to ${(sim.capacity / 1000).toFixed(0)}k particles · ${gfx.renderer}`);
    }
  };

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
    setQuality(q) { if (QUALITY[q]) { APP.quality = q; ui.setQuality(q); build(); ui.refresh(); } },
    rescale() { sizeCanvas(true); renderer.reset(); },
    resetAccumulation() { renderer.reset(); },
    togglePlay() { APP.playing = !APP.playing; ui.playing(APP.playing); renderer.reset(); },
    stepOnce() { APP.stepOnce = true; APP.playing = false; ui.playing(false); },
    empty() { sim.clear(); renderer.reset(); },
    togglePanel() { APP.panelOpen = !APP.panelOpen; ui.panel(APP.panelOpen); },
    toggleHelp() { APP.helpOpen = !APP.helpOpen; ui.help(APP.helpOpen); },
    closeHelp() { APP.helpOpen = false; ui.help(false); },
    cursor(uv) { APP.cursor = uv; brush.show = true; },
    brushDown() { renderer.reset(); },
  };

  try {
    build();
  } catch (err) {
    fatal('The sandbox could not set up its simulation on this graphics card.', err && err.message);
    return;
  }
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
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fatal('The graphics driver reset while the sandbox was running. Reload the page to carry on.');
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
    const dtReal = Math.min(0.1, Math.max(1e-4, (now - lastTime) / 1000));
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
      // Give a struggling machine a smaller picture rather than a slideshow.
      if (fps < 24 && RENDER.scale > 0.4 && gpuBudget++ > 3) {
        RENDER.scale = Math.max(0.4, RENDER.scale - 0.1);
        sizeCanvas(true);
        ui.refresh();
        gpuBudget = 0;
      } else if (fps > 55) gpuBudget = 0;
    }
  }
  requestAnimationFrame(frame);

  // A small hatch for tests, and for anyone who wants to poke at the settings
  // from the browser console.
  window.PowderToy = {
    PHYSICS, RENDER, QUALITY, MATERIALS, SCENES, TOOLS, brush, app: APP, controls: ctx,
    get sim() { return sim; },
    get renderer() { return renderer; },
    get camera() { return cam; },
    get fps() { return fps; },
    advance, drawOnce,
  };
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start);
else start();
