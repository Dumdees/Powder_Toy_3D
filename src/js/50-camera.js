// An orbiting camera, in the same cell units the shaders use.

class OrbitCamera {
  constructor(grid, { yaw = -0.45, pitch = 0.12, dist = 2.4 } = {}) {
    this.grid = grid;
    this.target = [grid[0] * 0.5, grid[1] * 0.42, grid[2] * 0.5];
    this.home = this.target.slice();
    this.yaw = yaw;
    this.pitch = pitch;
    this.dist = dist * grid[0];
    this.minDist = grid[0] * 0.35;
    this.maxDist = grid[0] * 7;
    this.moved = true;
  }

  /** Point at a box of a different size (after a change of detail level). */
  setGrid(grid) {
    this.grid = grid;
    this.home = [grid[0] * 0.5, grid[1] * 0.42, grid[2] * 0.5];
    this.target = this.home.slice();
    this.minDist = grid[0] * 0.35;
    this.maxDist = grid[0] * 7;
    this.moved = true;
  }

  apply({ yaw, pitch, dist }) {
    if (yaw != null) this.yaw = yaw;
    if (pitch != null) this.pitch = pitch;
    if (dist != null) this.dist = dist * this.grid[0];
    this.target = this.home.slice();
    this.moved = true;
  }

  get position() {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.dist * cp * Math.sin(this.yaw),
      this.target[1] + this.dist * Math.sin(this.pitch),
      this.target[2] + this.dist * cp * Math.cos(this.yaw),
    ];
  }

  orbit(dx, dy) {
    this.yaw -= dx * 0.006;
    this.pitch = clamp(this.pitch + dy * 0.006, -1.45, 1.45);
    this.moved = true;
  }

  zoom(delta) {
    this.dist = clamp(this.dist * Math.exp(delta * 0.0016), this.minDist, this.maxDist);
    this.moved = true;
  }

  /** Slide the point we are looking at, in the plane of the screen. */
  pan(dx, dy) {
    const fwd = v3norm(v3sub(this.target, this.position));
    let right = v3cross(fwd, [0, 1, 0]);
    if (v3len(right) < 1e-5) right = v3cross(fwd, [0, 0, 1]);
    right = v3norm(right);
    const up = v3cross(right, fwd);
    const k = this.dist * 0.0016;
    this.target = v3add(this.target, v3add(v3scale(right, -dx * k), v3scale(up, dy * k)));
    for (let i = 0; i < 3; i++) this.target[i] = clamp(this.target[i], -this.grid[i], this.grid[i] * 2);
    this.moved = true;
  }

  /** Basis for turning a screen position into a ray. */
  ray(uvx, uvy, aspect, fovDeg) {
    const fwd = v3norm(v3sub(this.target, this.position));
    let right = v3cross(fwd, [0, 1, 0]);
    if (v3len(right) < 1e-5) right = v3cross(fwd, [0, 0, 1]);
    right = v3norm(right);
    const up = v3cross(right, fwd);
    const tan = Math.tan(fovDeg * Math.PI / 360);
    return v3norm(v3add(fwd, v3add(
      v3scale(right, (uvx * 2 - 1) * tan * aspect),
      v3scale(up, (uvy * 2 - 1) * tan))));
  }
}
