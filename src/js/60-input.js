// Mouse, touch and keyboard. Left button uses the tool, right button orbits,
// middle button slides the view - the same idea as OE-Cake, in three dimensions.

const brush = {
  material: 1,
  tool: TOOL.DRAW,
  radius: 6,
  rate: 55,
  depth: 0,            // pushes the brush along the view ray when nothing is under it
  pos: [0, 0, 0],
  prev: null,
  vel: [0, 0, 0],
  active: false,
  show: false,
  tint: [0.35, 0.75, 1.0],
  strength: 1,
  shift: false,
};

function attachInput(canvas, cam, hooks) {
  const pointers = new Map();
  let orbiting = false;
  let panning = false;
  let last = null;
  let pinch = 0;

  const uvOf = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    // Capture keeps a drag alive when the pointer wanders over a panel; not every
    // browser will grant it, and it is not worth losing the drag over.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* carry on without it */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    hooks.cursor(uvOf(e));
    if (pointers.size === 2) {
      // Two fingers: orbit and pinch, and stop whatever the first finger started.
      brush.active = false;
      orbiting = true;
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      last = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return;
    }
    last = { x: e.clientX, y: e.clientY };
    if (e.button === 2) { orbiting = true; canvas.classList.add('orbiting'); }
    else if (e.button === 1) { panning = true; canvas.classList.add('orbiting'); }
    else if (e.button === 0) { brush.active = true; brush.prev = null; hooks.brushDown(); }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    hooks.cursor(uvOf(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      cam.zoom((pinch - d) * 1.6);
      if (last) cam.orbit(mid.x - last.x, mid.y - last.y);
      pinch = d;
      last = mid;
      return;
    }
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    if (orbiting) cam.orbit(dx, dy);
    else if (panning) cam.pan(dx, dy);
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (pointers.size === 0) {
      orbiting = false;
      panning = false;
      brush.active = false;
      brush.prev = null;
      last = null;
      canvas.classList.remove('orbiting');
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { brush.show = false; });
  canvas.addEventListener('pointerenter', () => { brush.show = true; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey) hooks.setRadius(brush.radius * Math.exp(-e.deltaY * 0.0012));
    else if (e.ctrlKey || e.metaKey) brush.depth = clamp(brush.depth - e.deltaY * 0.05, -60, 60);
    else cam.zoom(e.deltaY);
  }, { passive: false });

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    brush.shift = e.shiftKey;
    const k = e.key.toLowerCase();
    if (k >= '0' && k <= '9') {
      const idx = k === '0' ? 9 : Number(k) - 1;
      if (PAINTABLE[idx]) hooks.setMaterial(PAINTABLE[idx].id);
    } else if (k === 'q') hooks.setTool(TOOL.DRAW);
    else if (k === 'w') hooks.setTool(TOOL.ERASE);
    else if (k === 'e') hooks.setTool(TOOL.DRAG);
    else if (k === 'r') hooks.setTool(TOOL.PUSH);
    else if (k === 't') hooks.setTool(TOOL.HEAT);
    else if (k === '[') hooks.setRadius(brush.radius - 1);
    else if (k === ']') hooks.setRadius(brush.radius + 1);
    else if (k === ' ') { e.preventDefault(); hooks.togglePlay(); }
    else if (k === '.') hooks.stepOnce();
    else if (k === 'h') hooks.toggleHelp();
    else if (k === 'tab') { e.preventDefault(); hooks.togglePanel(); }
    else if (k === 'backspace') { e.preventDefault(); hooks.empty(); }
    else if (k === 'escape') hooks.closeHelp();
  });
  addEventListener('keyup', (e) => { brush.shift = e.shiftKey; });
}
