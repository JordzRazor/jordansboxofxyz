/* ==========================================================================
   Kessho (結晶 — "crystallization")
   A small cluster of faceted shards, lit warm, turning slowly.
   Plain WebGL via three.js. Drag to rotate, wheel/pinch to zoom,
   auto-rotates when left alone. Kept light: modest geometry + particle
   counts, capped pixel ratio, pauses when the tab is hidden.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('demo-canvas');
  var fallback = document.getElementById('fallback-note');
  var hint = document.getElementById('hint');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isSmall = window.innerWidth < 700;

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  } catch (e) {
    renderer = null;
  }
  if (!renderer || !renderer.getContext()) {
    if (fallback) fallback.classList.add('show');
    return;
  }

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 100);
  var camDist = isSmall ? 9 : 7.2;
  camera.position.set(0, 0.6, camDist);

  var DPR_CAP = 1.75;
  function resize() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  /* ---- lighting: warm lantern-light feel ---- */
  var hemi = new THREE.HemisphereLight(0xcfa876, 0x1a1210, 0.65);
  scene.add(hemi);

  var key = new THREE.PointLight(0xe0b27a, 1.4, 20, 2);
  key.position.set(3.5, 3, 4);
  scene.add(key);

  var rim = new THREE.PointLight(0x8a5a34, 0.9, 20, 2);
  rim.position.set(-4, -2, -3);
  scene.add(rim);

  /* ---- the crystal cluster ---- */
  var cluster = new THREE.Group();
  scene.add(cluster);

  var shardCount = isSmall ? 6 : 9;
  var palette = [0xc99b6b, 0xa97445, 0xe0bd8c, 0x8a5a34];
  for (var i = 0; i < shardCount; i++) {
    var detail = 0; // faceted / low-poly look
    var geo = new THREE.IcosahedronGeometry(0.55 + Math.random() * 0.55, detail);
    var mat = new THREE.MeshStandardMaterial({
      color: palette[i % palette.length],
      flatShading: true,
      roughness: 0.35,
      metalness: 0.15,
      emissive: 0x2c1c12,
      emissiveIntensity: 0.35
    });
    var mesh = new THREE.Mesh(geo, mat);
    var radius = Math.random() * 0.9;
    var angle = (i / shardCount) * Math.PI * 2;
    mesh.position.set(
      Math.cos(angle) * radius,
      (Math.random() - 0.5) * 1.2,
      Math.sin(angle) * radius
    );
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.userData.spin = (Math.random() - 0.5) * 0.15;
    cluster.add(mesh);
  }

  /* thin wireframe shell for a bit of glint */
  var shellGeo = new THREE.IcosahedronGeometry(1.9, 1);
  var shellMat = new THREE.MeshBasicMaterial({ color: 0xc99b6b, wireframe: true, transparent: true, opacity: 0.06 });
  var shell = new THREE.Mesh(shellGeo, shellMat);
  cluster.add(shell);

  /* ---- drifting dust ---- */
  var DUST = isSmall ? 70 : 130;
  var dustPos = new Float32Array(DUST * 3);
  for (var d = 0; d < DUST; d++) {
    dustPos[d * 3] = (Math.random() - 0.5) * 10;
    dustPos[d * 3 + 1] = (Math.random() - 0.5) * 6;
    dustPos[d * 3 + 2] = (Math.random() - 0.5) * 8;
  }
  var dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  var dustMat = new THREE.PointsMaterial({ color: 0xe0bd8c, size: 0.03, transparent: true, opacity: 0.5 });
  var dust = new THREE.Points(dustGeo, dustMat);
  scene.add(dust);

  /* ---- interaction: drag to rotate, wheel to zoom, idle auto-rotate ---- */
  var dragging = false;
  var lastX = 0, lastY = 0;
  var velX = 0, velY = 0;
  var idleTimer = 0;
  var IDLE_AFTER = 2.2;

  function pointerDown(e) {
    dragging = true;
    idleTimer = 0;
    lastX = e.clientX; lastY = e.clientY;
    if (hint) hint.style.opacity = '0';
  }
  function pointerMove(e) {
    if (!dragging) return;
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    velY = dx * 0.005;
    velX = dy * 0.005;
    cluster.rotation.y += velY;
    cluster.rotation.x = Math.max(-0.8, Math.min(0.8, cluster.rotation.x + velX));
  }
  function pointerUp() { dragging = false; }

  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', pointerDown);
  window.addEventListener('pointermove', pointerMove);
  window.addEventListener('pointerup', pointerUp);

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    idleTimer = 0;
    camDist = Math.max(4, Math.min(14, camDist + e.deltaY * 0.01));
  }, { passive: false });

  var running = true;
  document.addEventListener('visibilitychange', function () { running = !document.hidden; });

  resize();

  var clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    if (!running) return;
    var dt = Math.min(clock.getDelta(), 0.05);

    if (!dragging) {
      idleTimer += dt;
      velY *= 0.92; velX *= 0.92;
      cluster.rotation.y += velY;
      cluster.rotation.x += velX;
      if (idleTimer > IDLE_AFTER && !reduceMotion) {
        cluster.rotation.y += dt * 0.12;
      }
    }

    if (!reduceMotion) {
      for (var i = 0; i < cluster.children.length; i++) {
        var c = cluster.children[i];
        if (c.userData.spin) c.rotation.y += c.userData.spin * dt;
      }
      dust.rotation.y += dt * 0.01;
    }

    camera.position.set(0, 0.6, camDist);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);
})();
