/* ==========================================================================
   jordansboxofxyz — hero background
   A slow drift of amber embers over the slate. Cheap on purpose:
   - capped particle count
   - capped pixel ratio
   - pauses when the tab is hidden
   - skipped entirely for prefers-reduced-motion or no WebGL
   ========================================================================== */
(function () {
  var canvas = document.getElementById('hero-canvas');
  if (!canvas) return;

  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion || typeof THREE === 'undefined') return;

  var wrap = canvas.parentElement;
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
  } catch (e) {
    return; // no WebGL, just show the static gradient behind it
  }

  var DPR_CAP = 1.5;
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
  camera.position.set(0, 0, 10);

  var COUNT = window.innerWidth < 640 ? 90 : 180;
  var positions = new Float32Array(COUNT * 3);
  var speeds = new Float32Array(COUNT);
  for (var i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 22;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 12;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
    speeds[i] = 0.15 + Math.random() * 0.35;
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  var mat = new THREE.PointsMaterial({
    color: 0xc99b6b,
    size: 0.06,
    transparent: true,
    opacity: 0.75,
    sizeAttenuation: true
  });
  var points = new THREE.Points(geo, mat);
  scene.add(points);

  function resize() {
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  var running = true;
  document.addEventListener('visibilitychange', function () {
    running = !document.hidden;
  });

  var clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    if (!running) return;
    var dt = clock.getDelta();
    var pos = geo.attributes.position;
    for (var i = 0; i < COUNT; i++) {
      var y = pos.getY(i) + speeds[i] * dt * 0.6;
      if (y > 6) y = -6;
      pos.setY(i, y);
      var x = pos.getX(i) + Math.sin((y + i) * 0.5) * dt * 0.05;
      pos.setX(i, x);
    }
    pos.needsUpdate = true;
    points.rotation.y += dt * 0.02;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);
})();

/* mobile nav (only used if a page includes a .nav-toggle button) */
(function () {
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.site-nav');
  if (!toggle || !nav) return;
  toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
})();
