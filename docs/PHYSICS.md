# What is actually being computed

Powder Toy 3D is a hybrid particle/grid solver with a ray-traced renderer, both
running entirely on the GPU through WebGL 2. This page describes the model, and —
just as importantly — where it departs from reality and why.

Units are SI throughout. The box is 2.56 m on a side by default, divided into a
grid of 48³ to 80³ cells depending on the detail level, so a cell is roughly 3–5 cm.

---

## 1. The state

**Particles** carry what a fluid element remembers: position, velocity, temperature,
which material it is, how much volume it occupies, how far through a change of state
it has got, and an affine velocity field (the APIC matrix **C**).

**The grid** carries what needs neighbours: mass, momentum, temperature, viscosity,
surface tension, the granular fraction with its friction and cohesion, pressure, and
the fill fraction. A 3D field of *n* cells is stored as *n* z-slices tiled into one
2D texture, which is how a WebGL 2 fragment shader can address a volume.

Everything is float16 on the grid and float32 for the particles. Masses are relative
to water (so a full cell of water weighs 1.0), which keeps the half-float grid well
inside its precision.

## 2. One step of the solver

Each frame runs two or three substeps of the following (the detail level decides),
at a fixed 1/60 s divided by the substep count. Fixing the timestep rather than
following the frame rate keeps the result the same on a fast machine and a slow one.

### 2.1 Particles to grid (P2G)

Every particle splats to the eight cells of its trilinear stencil, additively
blended. Momentum is transferred with the **APIC** affine term

&nbsp;&nbsp;&nbsp;&nbsp;`m·(v + C·(x_cell − x_particle))`

rather than plain velocity. That is what stops a vortex being flattened into an
average every time it passes through the grid.

The same pass accumulates rigid mass (which marks solid cells), mass-weighted
temperature, viscosity, surface tension, granular fraction, friction coefficient,
cohesion, and the fill fraction Σ *w·V*, which is 1.0 for a properly packed cell.

### 2.2 Body forces

Momentum is divided by mass to give a velocity. Gravity is applied, plus a small
drag. Cells that are more than half fixed material, and the outer ring of the box,
are marked solid and their velocity is set to zero.

### 2.3 Heat

Two Jacobi sweeps of the heat equation, plus a loss term to the room combining a
Newtonian part and a Stefan–Boltzmann *T*⁴ part, so a red hot plate cools the way a
red hot plate does.

### 2.4 Viscosity

Explicit diffusion of momentum with the cell's mass-weighted kinematic viscosity,
clamped to the stability limit *ν·Δt/Δx²* ≤ 1/6. Water's 10⁻⁶ m²/s is effectively
nothing at this scale, which is correct; honey's 7×10⁻³ is very visible.

### 2.5 Surface tension

The continuum surface force. The fill fraction *φ* is differentiated to give a
surface normal **n** = ∇*φ*/|∇*φ*|, its divergence gives the curvature *κ* = −∇·**n**,
and the force **f** = *σκ***n**|∇*φ*| is applied. This is what beads water into
droplets and gives mercury its extreme roundness (σ = 0.486 N/m against water's
0.073).

### 2.6 Incompressibility

The heart of it. Water is incompressible, and everything that makes water look like
water rather than like a cloud of dust follows from enforcing that.

We solve the variable-density Poisson equation

&nbsp;&nbsp;&nbsp;&nbsp;∇·(ρ⁻¹∇p) = ∇·**v**/Δt

with red-black Gauss–Seidel (24 to 64 sweeps, warm-started from the previous step),
free-surface cells held at *p* = 0, no-flux at solids, and *p* clamped to be
non-negative — liquids and grains push but never pull. Then **v** ← **v** − Δt·ρ⁻¹∇p.

The divergence source carries a small volume-error term, `−k·max(fill − 1, 0)`, which
is the standard fix for the slow volume drift and particle clumping that otherwise
creep into any FLIP solver.

Density enters per cell, so a light fluid under a heavy one rises without any special
case: that is all buoyancy in the liquid scenes is.

### 2.7 Granular behaviour

Sand, snow and ash are not liquids. They are a **Drucker–Prager (Coulomb)** material:
they carry shear stress up to

&nbsp;&nbsp;&nbsp;&nbsp;*τ*_y = *μ*·*p* + *c*

and flow once that is exceeded. Two things implement this.

**A plastic stress field.** The deviatoric strain rate **D** is computed from the
grid velocity, and the stress is set to *τ* = *τ*_y·**D**/max(|**D**|, *ε*). That is
bounded by *τ*_y whatever happens, which keeps the explicit update stable, and it
behaves as a very stiff fluid below the yield and a perfectly plastic one above it.
A second pass applies the force ∇·*τ*.

**Per-grain friction.** Coulomb friction needs a normal force, and the honest local
measure of it is how much of gravity the pressure solve just cancelled for that
grain: something in free fall keeps the whole of *g* and is gripped by nothing, a
grain resting deep in a heap keeps none of it and is locked. On a slope it lands in
between — which is precisely why a heap stops at its angle of repose rather than
running away one grain at a time.

Dry sand (*μ* = 0.675, i.e. 34°) heaps up with flanks measured at 26–32° in our own
tests. Snow adds cohesion and so stands steeper; ash has less friction and spreads.

### 2.8 Grid to particles (G2P)

Velocity is gathered back as a blend of **PIC** (take the grid's velocity) and
**FLIP** (take the grid's *change* in velocity). Pure FLIP is lively but noisy, pure
PIC is stable but syrupy; the blend is 0.95 FLIP for water, and drops towards PIC in
proportion to a material's viscosity, which is where honey and lava get their
thickness.

Then: Boussinesq buoyancy for anything hotter than the room (with a gas's full
1/*T* expansion coefficient, so flame really does shoot upward), the brush, RK2
advection with the step clamped to one cell per substep (the CFL condition, which
also caps the top speed at about 5 m/s), collision against
the walls and any fixed material, a nudge down the density gradient wherever specks
have crowded, heat exchange with the cell, and finally changes of state.

### 2.9 Changes of state

Each material declares up to four transitions — melt, freeze, boil, burn — with a
threshold and what it becomes. A particle must sit past the threshold for a dwell
time before it changes, which stands in for latent heat and stops anything flickering
between two states. Thresholds are separated in both directions (ice melts at +0.5 °C,
water freezes at −0.5 °C) so no pair can oscillate.

Fire sustains its own temperature while it burns and then becomes smoke; smoke fades.
Lava carries an enormous heat store and cools slowly to stone.

---

## 3. The renderer

### 3.1 Fields

Once per frame the particles are splatted again, this time weighted by volume rather
than mass, into four fields: albedo, roughness/metallic/transmission/IOR, absorption
and glow, and the phase fractions with temperature. Three rounds of a separable [1 2 1] blur
smooth them into something with a surface. A 4× coarse "is there anything here"
volume is built alongside, so empty space costs almost nothing to cross.

### 3.2 Rays

The surface is the *φ* = 0.5 isosurface of the condensed fill fraction. Primary rays
skip empty blocks analytically, step 0.55 cells through occupied ones, and bisect six
times onto the crossing. Normals come from a four-tap tetrahedral gradient.

### 3.3 Shading

**Cook-Torrance GGX**: Trowbridge-Reitz distribution, height-correlated Smith
visibility, Schlick Fresnel, metallic-roughness parameters, energy conserving. The
sun is widened to its true angular size (about half a degree) and the specular lobe
is renormalised, which is what stops a near-mirror water surface turning into a field
of white sparks.

**Water** gets the exact unpolarised dielectric Fresnel at IOR 1.333, Snell refraction
in and out again, total internal reflection handled properly, and Beer–Lambert
absorption over the distance actually travelled through the liquid using water's real
coefficients (0.45, 0.09, 0.02 per metre). Its colour is not painted on: it is what
survives the journey.

**Shadows** are ray-marched, and they are per-colour. Opaque material blocks; clear
material absorbs by Beer–Lambert. That is why the floor under a pool is lit
blue-green rather than being in pitch darkness.

**Caustics** are real. Photons are launched from the sun on a jittered lattice,
refracted through every water surface they meet, and deposited where they land. The
volume that builds up is then blurred and accumulated across frames.

**Anything hot glows by Planck's law**: the colour comes from the Planckian locus at
that temperature and the brightness from Stefan–Boltzmann's *T*⁴. Lava at 1150 °C, a
steel plate at 1150 °C and a flame at 950 °C therefore glow the same colour as each
other, and the right one.

**Steam, smoke and flame** are gathered along the ray as participating media, lit by
the sun through the same shadow march.

### 3.4 Picture

Reflections take one bounce. The sky is an analytic Rayleigh/Mie single-scattering
model. The frame is accumulated over time — gently while things are moving, and
hard once everything is still, so a paused scene keeps getting cleaner. Then bloom,
the ACES filmic curve, and sRGB.

---

## 4. Where this is not reality

Everything below is a deliberate, documented compromise.

- **Density ratios are clamped** to between 0.04 and 8 times water. A true 1660:1
  air/water ratio makes the Poisson system far too stiff for the handful of sweeps
  that fit in a frame. Buoyancy stays correct in sign and roughly in size; a gas rises
  through a liquid about as fast as it should, not exactly.
- **Heat is scaled.** Conduction across a 2.5 m box takes hours in reality. The
  diffusivity is multiplied by an adjustable "how fast heat spreads" factor to bring
  it onto the timescale of a person watching.
- **Lava is far runnier than lava.** Basalt is 10²–10⁴ m²/s. At that value it would
  not move at all on screen.
- **Fixed materials are fixed.** Stone, ice, steel, glass and wood do not fall, tip
  or break. There is no rigid-body dynamics here; they are boundary conditions that
  can melt.
- **The grid is collocated, not staggered.** The divergence and gradient use the wide
  central stencil while the Laplacian is the compact seven-point one — the classic
  arrangement from Stam's stable fluids. It is not formally consistent, and it costs a
  little smoothing, but it is well behaved and it is a third of the work of a MAC grid.
- **The pressure solve is not run to convergence.** 24 to 64 Gauss–Seidel sweeps is
  enough to look right and nowhere near enough to be exact. Warm-starting from the
  previous step helps a great deal.
- **Granular friction is not Galilean-invariant.** The per-grain Coulomb drag is
  measured against the container, which is the natural rest frame here but would be
  wrong in an accelerating box. The free-fall gate described above is what keeps it
  honest in the cases that matter.
- **Latent heat is a dwell time**, not an enthalpy budget. Melting a block of ice
  does not draw the correct number of joules out of the plate underneath it.
- **Caustics are at grid resolution** and smoothed over several frames, so they are
  soft where reality would be sharp.
- **Reflections take one bounce** and the sky is analytic rather than measured.
- **Materials do not mix or dissolve.** There is no chemistry beyond the transitions
  listed in the table, no salt dissolving in water, no alloys.

## 5. References

The models here are standard, and the papers are worth reading if you want the real
thing rather than the real-time thing.

- Zhu & Bridson, *Animating sand as a fluid* (2005) — the FLIP fluid this descends from.
- Jiang et al., *The affine particle-in-cell method* (2015) — the APIC transfer.
- Klár et al., *Drucker-Prager elastoplasticity for sand animation* (2016) — the
  granular constitutive model.
- Brackbill, Kothe & Zemach, *A continuum method for modeling surface tension* (1992).
- Bridson, *Fluid Simulation for Computer Graphics* — the pressure solve and boundaries.
- Karis, *Real Shading in Unreal Engine 4* (2013) — the GGX/Smith/Schlick formulation
  and the sun-as-a-sphere approximation.
