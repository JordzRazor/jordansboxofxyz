/* ==========================================================================
   Ember (残り火 — "embers left over from a fire")
   A drifting bed of coals. Tries WebGPU first (raw API, no library);
   if the browser/device can't do WebGPU it quietly falls back to an
   equivalent WebGL2 shader and says so once, softly.
   Both paths draw a single fullscreen triangle — no vertex buffers,
   no geometry, just a fragment shader doing fbm noise. Cheap to run.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('demo-canvas');
  var fallbackNote = document.getElementById('fallback-note');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DPR_CAP = 1.5;

  function announce(text) {
    if (!fallbackNote) return;
    fallbackNote.textContent = text;
    fallbackNote.classList.add('show');
  }

  function sizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var w = Math.floor(window.innerWidth * dpr);
    var h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return { w: w, h: h };
  }

  var running = true;
  document.addEventListener('visibilitychange', function () { running = !document.hidden; });

  var WGSL = ''
    + 'struct Uniforms { time: f32, resX: f32, resY: f32, pad: f32 };\n'
    + '@group(0) @binding(0) var<uniform> u: Uniforms;\n'
    + 'fn hash(p: vec2<f32>) -> f32 {\n'
    + '  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);\n'
    + '  p3 = p3 + dot(p3, p3.yzx + 33.33);\n'
    + '  return fract((p3.x + p3.y) * p3.z);\n'
    + '}\n'
    + 'fn noise(p: vec2<f32>) -> f32 {\n'
    + '  let i = floor(p); let f = fract(p);\n'
    + '  let a = hash(i); let b = hash(i + vec2<f32>(1.0, 0.0));\n'
    + '  let c = hash(i + vec2<f32>(0.0, 1.0)); let d = hash(i + vec2<f32>(1.0, 1.0));\n'
    + '  let u2 = f * f * (3.0 - 2.0 * f);\n'
    + '  return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);\n'
    + '}\n'
    + 'fn fbm(p: vec2<f32>) -> f32 {\n'
    + '  var v = 0.0; var amp = 0.55; var pp = p;\n'
    + '  for (var i = 0; i < 5; i = i + 1) { v = v + amp * noise(pp); pp = pp * 2.02; amp = amp * 0.55; }\n'
    + '  return v;\n'
    + '}\n'
    + '@vertex\n'
    + 'fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {\n'
    + '  var pos = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));\n'
    + '  return vec4<f32>(pos[vi], 0.0, 1.0);\n'
    + '}\n'
    + '@fragment\n'
    + 'fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n'
    + '  let res = vec2<f32>(u.resX, u.resY);\n'
    + '  var uv = fragCoord.xy / res;\n'
    + '  uv.x = uv.x * (res.x / res.y);\n'
    + '  let t = u.time * 0.12;\n'
    + '  var p = uv * 3.0;\n'
    + '  p.y = p.y - t * 1.4;\n'
    + '  let n = fbm(p + fbm(p * 1.6 - t));\n'
    + '  let glow = smoothstep(0.35, 0.95, n);\n'
    + '  let heat = smoothstep(0.55, 1.0, n);\n'
    + '  let dark = vec3<f32>(0.043, 0.051, 0.055);\n'
    + '  let wood = vec3<f32>(0.216, 0.157, 0.098);\n'
    + '  let coal = vec3<f32>(0.35, 0.13, 0.08);\n'
    + '  let ember = vec3<f32>(0.86, 0.42, 0.18);\n'
    + '  var col = mix(dark, wood, glow * 0.8);\n'
    + '  col = mix(col, coal, heat);\n'
    + '  col = mix(col, ember, smoothstep(0.75, 1.0, n) * 0.9);\n'
    + '  let dd = distance(uv, vec2<f32>(res.x / res.y * 0.5, 0.5));\n'
    + '  col = col * (1.0 - smoothstep(0.5, 1.05, dd) * 0.55);\n'
    + '  return vec4<f32>(col, 1.0);\n'
    + '}\n';

  async function tryWebGPU() {
    if (!('gpu' in navigator)) return false;
    var adapter;
    try { adapter = await navigator.gpu.requestAdapter(); } catch (e) { adapter = null; }
    if (!adapter) return false;
    var device;
    try { device = await adapter.requestDevice(); } catch (e) { return false; }

    var context = canvas.getContext('webgpu');
    if (!context) return false;
    var format = navigator.gpu.getPreferredCanvasFormat();

    var dims = sizeCanvas();
    context.configure({ device: device, format: format, alphaMode: 'opaque' });

    device.pushErrorScope('validation');
    var module = device.createShaderModule({ code: WGSL });
    var pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: module, entryPoint: 'vs_main' },
      fragment: { module: module, entryPoint: 'fs_main', targets: [{ format: format }] },
      primitive: { topology: 'triangle-list' }
    });

    var uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    var bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
    });

    // Shader/pipeline problems surface asynchronously in WebGPU rather than
    // throwing synchronously — check the error scope before committing to
    // this path, otherwise we'd "succeed" into a blank canvas.
    var scopeError = await device.popErrorScope();
    if (scopeError) {
      console.warn('WebGPU pipeline validation error, falling back to WebGL:', scopeError.message);
      return false;
    }

    device.addEventListener('uncapturederror', function (event) {
      console.warn('WebGPU runtime error:', event.error && event.error.message);
    });

    window.addEventListener('resize', function () {
      dims = sizeCanvas();
      try { context.configure({ device: device, format: format, alphaMode: 'opaque' }); } catch (e) {}
    });

    var start = performance.now();
    var simTime = 0;
    var last = start;
    function frame(now) {
      requestAnimationFrame(frame);
      if (!running) return;
      var dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      simTime += reduceMotion ? dt * 0.15 : dt;

      var data = new Float32Array([simTime, dims.w, dims.h, 0]);
      device.queue.writeBuffer(uniformBuffer, 0, data.buffer, data.byteOffset, data.byteLength);

      var encoder = device.createCommandEncoder();
      var pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.04, g: 0.05, b: 0.055, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    requestAnimationFrame(frame);
    return true;
  }

  function runWebGL() {
    var gl = canvas.getContext('webgl2');
    if (!gl) {
      announce("This browser can't draw either WebGPU or WebGL2 here — try a recent Chrome, Edge, or Firefox.");
      return;
    }

    var VERT = '#version 300 es\n'
      + 'void main(){\n'
      + '  vec2 pos[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));\n'
      + '  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);\n'
      + '}\n';

    var FRAG = '#version 300 es\n'
      + 'precision highp float;\n'
      + 'uniform float uTime; uniform vec2 uRes; out vec4 fragColor;\n'
      + 'float hash(vec2 p){ vec3 p3 = fract(vec3(p.x,p.y,p.x) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }\n'
      + 'float noise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); float a=hash(i); float b=hash(i+vec2(1.0,0.0)); float c=hash(i+vec2(0.0,1.0)); float d=hash(i+vec2(1.0,1.0)); vec2 u=f*f*(3.0-2.0*f); return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }\n'
      + 'float fbm(vec2 p){ float v=0.0; float amp=0.55; vec2 pp=p; for(int i=0;i<5;i++){ v+=amp*noise(pp); pp*=2.02; amp*=0.55; } return v; }\n'
      + 'void main(){\n'
      + '  vec2 res = uRes;\n'
      + '  vec2 uv = gl_FragCoord.xy / res;\n'
      + '  uv.x *= res.x/res.y;\n'
      + '  float t = uTime * 0.12;\n'
      + '  vec2 p = uv * 3.0; p.y -= t*1.4;\n'
      + '  float n = fbm(p + fbm(p*1.6 - t));\n'
      + '  float glow = smoothstep(0.35,0.95,n);\n'
      + '  float heat = smoothstep(0.55,1.0,n);\n'
      + '  vec3 dark = vec3(0.043,0.051,0.055);\n'
      + '  vec3 wood = vec3(0.216,0.157,0.098);\n'
      + '  vec3 coal = vec3(0.35,0.13,0.08);\n'
      + '  vec3 ember = vec3(0.86,0.42,0.18);\n'
      + '  vec3 col = mix(dark, wood, glow*0.8);\n'
      + '  col = mix(col, coal, heat);\n'
      + '  col = mix(col, ember, smoothstep(0.75,1.0,n)*0.9);\n'
      + '  float d = distance(uv, vec2(res.x/res.y*0.5, 0.5));\n'
      + '  col *= (1.0 - smoothstep(0.5,1.05,d)*0.55);\n'
      + '  fragColor = vec4(col,1.0);\n'
      + '}\n';

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    }
    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, FRAG);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
      announce("Something went wrong drawing this one — try reloading, or a different browser.");
      return;
    }
    gl.useProgram(prog);
    var uTimeLoc = gl.getUniformLocation(prog, 'uTime');
    var uResLoc = gl.getUniformLocation(prog, 'uRes');

    var dims = sizeCanvas();
    gl.viewport(0, 0, dims.w, dims.h);
    window.addEventListener('resize', function () {
      dims = sizeCanvas();
      gl.viewport(0, 0, dims.w, dims.h);
    });

    announce('Your browser doesn’t support WebGPU yet, so this is the WebGL version — same embers, older road.');

    var simTime = 0, last = performance.now();
    function frame(now) {
      requestAnimationFrame(frame);
      if (!running) return;
      var dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      simTime += reduceMotion ? dt * 0.15 : dt;
      gl.uniform1f(uTimeLoc, simTime);
      gl.uniform2f(uResLoc, dims.w, dims.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(frame);
  }

  tryWebGPU().then(function (ok) {
    if (!ok) runWebGL();
  }).catch(function () {
    runWebGL();
  });
})();
