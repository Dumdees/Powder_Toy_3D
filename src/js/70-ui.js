// The panels around the canvas. Plain DOM - no framework, no build step.

const TOOLS = [
  { id: TOOL.DRAW,  name: 'Draw',  key: 'Q', hint: 'Add the chosen material' },
  { id: TOOL.ERASE, name: 'Erase', key: 'W', hint: 'Take material away' },
  { id: TOOL.DRAG,  name: 'Drag',  key: 'E', hint: 'Grab hold and pull, like stirring' },
  { id: TOOL.PUSH,  name: 'Push',  key: 'R', hint: 'Blow outwards - hold Shift to suck in' },
  { id: TOOL.HEAT,  name: 'Heat',  key: 'T', hint: 'Warm things up - hold Shift to chill' },
];

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
  return n;
}

const syncers = [];

/** A labelled slider bound to a property on an object. */
function slider(obj, key, { label, min, max, step = 0.01, fmt = (v) => v.toFixed(2), onChange } = {}) {
  const out = el('b', { text: fmt(obj[key]) });
  const input = el('input', { type: 'range', min, max, step, value: obj[key] });
  input.addEventListener('input', () => {
    obj[key] = Number(input.value);
    out.textContent = fmt(obj[key]);
    if (onChange) onChange(obj[key]);
  });
  syncers.push(() => { input.value = String(obj[key]); out.textContent = fmt(obj[key]); });
  return el('div', { class: 'row slider' }, [
    el('div', { class: 'head' }, [el('label', { text: label }), out]),
    input,
  ]);
}

function toggle(obj, key, { label, onChange } = {}) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!obj[key];
  syncers.push(() => { input.checked = !!obj[key]; });
  input.addEventListener('change', () => { obj[key] = input.checked; if (onChange) onChange(obj[key]); });
  return el('div', { class: 'row' }, [el('label', { text: label }), input]);
}

function group(title, rows) {
  return el('div', { class: 'group' }, [el('h4', { text: title }), ...rows]);
}

function buildUI(ctx) {
  const $ = (id) => document.getElementById(id);

  // ---- materials
  const palette = $('palette');
  const matButtons = new Map();
  PAINTABLE.forEach((m, i) => {
    const key = i < 10 ? String((i + 1) % 10) : '';
    const b = el('button', { class: 'mat', type: 'button', title: m.blurb || m.name, onclick: () => ctx.setMaterial(m.id) }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'nm', text: m.name }),
      el('span', { class: 'key', text: key }),
    ]);
    b.querySelector('.dot').style.background = swatchOf(m);
    palette.appendChild(b);
    matButtons.set(m.id, b);
  });

  // ---- tools
  const tools = $('tools');
  const toolButtons = new Map();
  for (const t of TOOLS) {
    const b = el('button', { class: 'btn tool', type: 'button', title: t.hint, onclick: () => ctx.setTool(t.id) },
      [el('span', { text: t.name }), el('small', { text: t.key })]);
    tools.appendChild(b);
    toolButtons.set(t.id, b);
  }

  // ---- scenes
  const scenes = $('scenes');
  const sceneButtons = new Map();
  for (const s of SCENES) {
    const b = el('button', { class: 'btn scene', type: 'button', onclick: () => ctx.loadScene(s.id) },
      [el('b', { text: s.name }), el('span', { text: s.blurb })]);
    scenes.appendChild(b);
    sceneButtons.set(s.id, b);
  }

  // ---- physics
  $('page-physics').append(
    group('Forces', [
      slider(PHYSICS, 'gravity', { label: 'Gravity', min: 0, max: 25, step: 0.1, fmt: (v) => v.toFixed(1) + ' m/s²' }),
      slider(PHYSICS, 'buoyancy', { label: 'Buoyancy', min: 0, max: 1.5 }),
      slider(PHYSICS, 'tension', { label: 'Surface tension', min: 0, max: 3 }),
      slider(PHYSICS, 'viscScale', { label: 'Thickness', min: 0, max: 4 }),
      slider(PHYSICS, 'granular', { label: 'Grain friction', min: 0, max: 3 }),
      slider(PHYSICS, 'cohesion', { label: 'Grain stickiness', min: 0, max: 20, step: 0.1, fmt: (v) => v.toFixed(1) }),
      slider(PHYSICS, 'yieldFloor', { label: 'Grain stiffness', min: 0.1, max: 8 }),
      slider(PHYSICS, 'fricCap', { label: 'Grain grip limit', min: 0, max: 200, step: 1, fmt: (v) => v.toFixed(0) }),
    ]),
    group('Heat', [
      slider(PHYSICS, 'heatScale', { label: 'How fast heat spreads', min: 0, max: 4000, step: 10, fmt: (v) => String(Math.round(v)) }),
      slider(PHYSICS, 'latent', { label: 'Latent heat', min: 0.05, max: 3, fmt: (v) => v.toFixed(2) + ' s' }),
      slider(PHYSICS, 'ambient', { label: 'Room temperature', min: -30, max: 80, step: 1, fmt: (v) => Math.round(v) + ' °C' }),
      slider(PHYSICS, 'radiate', { label: 'Cooling to the room', min: 0, max: 4 }),
    ]),
    group('Solver', [
      slider(PHYSICS, 'timeScale', { label: 'Speed', min: 0, max: 2 }),
      slider(PHYSICS, 'substeps', { label: 'Steps per frame', min: 1, max: 4, step: 1, fmt: (v) => String(v) }),
      slider(PHYSICS, 'iterations', { label: 'Pressure sweeps', min: 8, max: 80, step: 1, fmt: (v) => String(v) }),
      slider(PHYSICS, 'flip', { label: 'Liveliness (FLIP)', min: 0, max: 1 }),
      slider(PHYSICS, 'pack', { label: 'Anti-clumping', min: 0, max: 4 }),
      slider(PHYSICS, 'packLimit', { label: 'Crowding limit', min: 1, max: 2.5 }),
      slider(PHYSICS, 'restitution', { label: 'Bounce', min: 0, max: 0.7 }),
      slider(PHYSICS, 'wallFriction', { label: 'Wall grip', min: 0.4, max: 1 }),
    ]),
    el('p', { class: 'note', text: 'Water is held incompressible by a pressure solve; grains yield by Coulomb friction; steam and smoke rise by the Boussinesq term.' }),
  );

  // ---- light
  const dirty = () => ctx.resetAccumulation();
  $('page-light').append(
    group('Sun and sky', [
      slider(RENDER, 'sunElevation', { label: 'Sun height', min: 2, max: 88, step: 0.5, fmt: (v) => v.toFixed(0) + '°', onChange: dirty }),
      slider(RENDER, 'sunAzimuth', { label: 'Sun direction', min: 0, max: 360, step: 1, fmt: (v) => v.toFixed(0) + '°', onChange: dirty }),
      slider(RENDER, 'sunIntensity', { label: 'Sun strength', min: 0, max: 8, onChange: dirty }),
      slider(RENDER, 'skyGain', { label: 'Sky brightness', min: 0, max: 2.5, onChange: dirty }),
      slider(RENDER, 'turbidity', { label: 'Haze', min: 0, max: 1, onChange: dirty }),
    ]),
    group('Ray tracing', [
      toggle(RENDER, 'shadows', { label: 'Shadows', onChange: dirty }),
      toggle(RENDER, 'reflections', { label: 'Reflections', onChange: dirty }),
      toggle(RENDER, 'refraction', { label: 'Refraction through water', onChange: dirty }),
      toggle(RENDER, 'caustics', { label: 'Caustics', onChange: dirty }),
      toggle(RENDER, 'gas', { label: 'Steam, smoke and flame', onChange: dirty }),
      slider(RENDER, 'clarity', { label: 'Water depth of colour', min: 0, max: 8, onChange: dirty }),
      slider(RENDER, 'shadowSigma', { label: 'Shadow density', min: 0.2, max: 8, onChange: dirty }),
      slider(RENDER, 'glowGain', { label: 'Glow from heat', min: 0, max: 1.5, onChange: dirty }),
    ]),
    group('Picture', [
      slider(RENDER, 'exposure', { label: 'Exposure', min: 0.1, max: 3 }),
      slider(RENDER, 'bloom', { label: 'Bloom', min: 0, max: 1.5 }),
      slider(RENDER, 'vignette', { label: 'Vignette', min: 0, max: 1 }),
      slider(RENDER, 'fov', { label: 'Lens', min: 18, max: 80, step: 1, fmt: (v) => v.toFixed(0) + '°', onChange: dirty }),
      toggle(RENDER, 'accumulate', { label: 'Settle the image when still', onChange: dirty }),
    ]),
  );

  // ---- quality
  const presetSel = el('select', { onchange: (e) => ctx.setQuality(e.target.value) },
    Object.keys(QUALITY).map((k) => el('option', { value: k, text: k[0].toUpperCase() + k.slice(1) })));
  presetSel.value = ctx.quality;
  const viewSel = el('select', { onchange: (e) => { RENDER.view = Number(e.target.value); ctx.resetAccumulation(); } },
    VIEWS.map((name, i) => el('option', { value: i, text: name })));
  const info = el('p', { class: 'note' });
  $('page-quality').append(
    group('Detail', [
      el('div', { class: 'row' }, [el('label', { text: 'Preset' }), presetSel]),
      el('div', { class: 'row' }, [el('label', { text: 'Show' }), viewSel]),
      slider(RENDER, 'scale', { label: 'Render resolution', min: 0.3, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', onChange: () => ctx.rescale() }),
      slider(RENDER, 'surfSteps', { label: 'Ray steps', min: 40, max: 400, step: 10, fmt: (v) => String(v), onChange: dirty }),
      slider(RENDER, 'shadowSteps', { label: 'Shadow steps', min: 4, max: 128, step: 4, fmt: (v) => String(v), onChange: dirty }),
      slider(RENDER, 'surfStep', { label: 'Step length', min: 0.2, max: 1.2, fmt: (v) => v.toFixed(2) + ' cells', onChange: dirty }),
      slider(RENDER, 'photons', { label: 'Caustic photons', min: 64, max: 384, step: 32, fmt: (v) => (v * v / 1000).toFixed(0) + 'k', onChange: dirty }),
      slider(RENDER, 'smoothing', { label: 'Surface smoothing', min: 1, max: 4, step: 1, fmt: (v) => String(v), onChange: dirty }),
    ]),
    info,
  );

  // ---- transport
  $('btn-play').addEventListener('click', ctx.togglePlay);
  $('btn-step').addEventListener('click', ctx.stepOnce);
  $('btn-clear').addEventListener('click', ctx.empty);
  $('btn-reset').addEventListener('click', () => ctx.loadScene(ctx.sceneId));
  $('btn-help').addEventListener('click', ctx.toggleHelp);
  $('btn-panel').addEventListener('click', ctx.togglePanel);
  $('help-close').addEventListener('click', ctx.closeHelp);
  $('help').addEventListener('click', (e) => { if (e.target.id === 'help') ctx.closeHelp(); });

  for (const tab of $('panel-tabs').children) {
    tab.addEventListener('click', () => {
      for (const t of $('panel-tabs').children) t.classList.toggle('is-on', t === tab);
      for (const page of document.querySelectorAll('.tab-page')) {
        page.classList.toggle('is-on', page.dataset.page === tab.dataset.tab);
      }
    });
  }

  const sizeInput = $('brush-size');
  const sizeOut = $('brush-size-out');
  sizeInput.addEventListener('input', () => ctx.setRadius(Number(sizeInput.value)));
  const rateInput = $('brush-rate');
  const rateOut = $('brush-rate-out');
  rateInput.addEventListener('input', () => { brush.rate = Number(rateInput.value); rateOut.textContent = rateInput.value; });

  $('help-physics').textContent =
    'Particles carry the material, the temperature and the momentum; a background grid handles everything that needs '
    + 'neighbours. Each step scatters the particles onto that grid (FLIP with an APIC affine term), adds weight and '
    + 'buoyancy, spreads heat and momentum, applies surface tension, then solves a variable-density Poisson equation '
    + 'so the velocity field carries no divergence - that is what makes water behave like water. Grains yield under '
    + 'Coulomb friction, which is why sand piles at its angle of repose. The picture is made by marching rays through '
    + 'the same fields: Cook-Torrance GGX shading, Fresnel and Snell for the water surface, Beer-Lambert absorption '
    + 'for its colour, ray-traced shadows, reflections and photon caustics, and Planck’s law for anything hot enough to glow.';

  return {
    setMaterial(id) {
      for (const [mid, b] of matButtons) b.classList.toggle('is-on', mid === id);
      const m = MATERIALS[id];
      brush.tint = m.albedo.map((c) => Math.min(1, 0.25 + c * 1.4));
    },
    setTool(id) { for (const [tid, b] of toolButtons) b.classList.toggle('is-on', tid === id); },
    setScene(id) { for (const [sid, b] of sceneButtons) b.classList.toggle('is-on', sid === id); },
    setRadius(r) { sizeInput.value = String(r); sizeOut.textContent = r.toFixed(r < 10 ? 1 : 0); },
    setQuality(q) { presetSel.value = q; },
    refresh() { for (const sync of syncers) sync(); },
    setInfo(text) { info.textContent = text; },
    rescaleSlider() { /* value already lives in RENDER */ },
    readout(html) { $('readout').innerHTML = html; },
    playing(on) { $('btn-play').classList.toggle('is-paused', !on); $('btn-play').querySelector('.lbl').textContent = on ? 'Pause' : 'Play'; },
    panel(on) { $('panel').hidden = !on; },
    help(on) { $('help').hidden = !on; },
  };
}
