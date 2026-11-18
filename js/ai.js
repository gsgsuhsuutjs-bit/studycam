// 공부캠 on-device AI (MediaPipe Tasks Vision).
// Everything runs inside the browser on the phone: frames are never uploaded anywhere.
(function () {
  'use strict';

  const here = (p) => new URL(p, document.baseURI).href;
  const FILES = {
    bundle: here('lib/mediapipe/vision_bundle.js'),
    wasmDir: here('lib/mediapipe/wasm'),
    wasm: here('lib/mediapipe/wasm/vision_wasm_internal.wasm'),
    seg: here('models/selfie_segmenter.tflite'),
    face: here('models/face_landmarker.task'),
    obj: here('models/efficientdet_lite0.tflite'),
  };
  // Approximate sizes, used only for the progress bar.
  const SIZES = { wasm: 14603354, seg: 249537, face: 3758596, obj: 4602795 };

  const ai = {
    status: 'off', // off | loading | ready | error
    progress: 0,
    error: null,
    seg: null,
    face: null,
    obj: null,
    personIndex: 0,
    onChange: null,
    sizeFor(names) {
      return (fileset ? 0 : SIZES.wasm) + names.filter((n) => !ai[n]).reduce((s, n) => s + SIZES[n], 0);
    },
  };

  let Vision = null;
  let fileset = null;
  let loading = null;
  let lastTs = 0;
  const nextTs = () => { lastTs = Math.max(performance.now(), lastTs + 1); return lastTs; };

  function emit() { if (typeof ai.onChange === 'function') ai.onChange(ai); }
  function setStatus(s, p) { ai.status = s; if (p != null) ai.progress = p; emit(); }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('AI 프로그램 파일을 불러오지 못했어요.'));
      document.head.append(s);
    });
  }

  async function fetchBytes(url, onBytes) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`AI 파일을 받지 못했어요 (${res.status}).`);
    if (!res.body || !res.body.getReader) {
      const b = new Uint8Array(await res.arrayBuffer());
      onBytes(b.byteLength);
      return b;
    }
    const reader = res.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.byteLength;
      onBytes(value.byteLength);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
  }

  // Try the phone's GPU first, fall back to the CPU.
  async function create(factory) {
    try { return await factory('GPU'); } catch (_) { return factory('CPU'); }
  }

  const CREATE = {
    async seg(buf) {
      const task = await Vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      let labels = [];
      try { labels = task.getLabels() || []; } catch (_) {}
      let idx = labels.findIndex((l) => /person|human|selfie|foreground/i.test(l));
      if (idx < 0) idx = labels.length > 1 ? 1 : 0;
      ai.personIndex = idx;
      ai.labels = labels;
      return task;
    },
    face(buf) {
      return create((delegate) => Vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: buf, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      }));
    },
    obj(buf) {
      return create((delegate) => Vision.ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: buf, delegate },
        runningMode: 'VIDEO',
        scoreThreshold: 0.4,
        maxResults: 3,
        categoryAllowlist: ['cell phone'],
      }));
    },
  };

  /** Load the named models ('seg' | 'face' | 'obj'). Resolves when all are ready. */
  ai.ensure = async function ensure(names) {
    if (names.every((n) => ai[n])) { if (ai.status !== 'ready') setStatus('ready', 1); return; }
    if (loading) { try { await loading; } catch (_) {} return ensure(names); }
    const missing = names.filter((n) => !ai[n]);
    loading = (async () => {
      ai.error = null;
      setStatus('loading', 0);
      const total = ai.sizeFor(missing) || 1;
      let got = 0;
      const tick = (b) => { got += b; ai.progress = Math.min(0.99, got / total); emit(); };
      if (!window.Vision) await loadScript(FILES.bundle);
      Vision = window.Vision;
      if (!fileset) {
        // Download the big engine file once with progress; the library then reads it from cache.
        try { await fetchBytes(FILES.wasm, tick); } catch (_) {}
        fileset = await Vision.FilesetResolver.forVisionTasks(FILES.wasmDir);
      }
      for (const n of missing) {
        const buf = await fetchBytes(FILES[n], tick);
        ai[n] = await CREATE[n](buf);
      }
      setStatus('ready', 1);
    })();
    try {
      await loading;
    } catch (e) {
      ai.error = e;
      setStatus('error');
      throw e;
    } finally {
      loading = null;
    }
  };

  /**
   * Runs person segmentation on the current video frame and hands the mask to
   * `use(width, height, data)` where data[i] is 0..1 (1 = person). The data is only
   * valid during the call. Returns true when a mask was produced.
   */
  ai.segment = function segment(src, use) {
    if (!ai.seg) return false;
    let res;
    try { res = ai.seg.segmentForVideo(src, nextTs()); } catch (_) { return false; }
    try {
      const masks = (res && res.confidenceMasks) || [];
      if (!masks.length) return false;
      const m = masks[Math.min(ai.personIndex, masks.length - 1)];
      use(m.width, m.height, m.getAsFloat32Array());
      return true;
    } catch (_) {
      return false;
    } finally {
      try { res && res.close && res.close(); } catch (_) {}
    }
  };

  /** Face landmarks (normalized 0..1) for the first face, or null. */
  ai.detectFace = function detectFace(src) {
    if (!ai.face) return null;
    try {
      const r = ai.face.detectForVideo(src, nextTs());
      const lm = r && r.faceLandmarks && r.faceLandmarks[0];
      return lm ? lm.map((p) => ({ x: p.x, y: p.y })) : null;
    } catch (_) {
      return null;
    }
  };

  /** True when a phone is visible in the frame, false when not, null when unknown. */
  ai.seesPhone = function seesPhone(src) {
    if (!ai.obj) return null;
    try {
      const r = ai.obj.detectForVideo(src, nextTs());
      return (r.detections || []).some((d) => (d.categories || []).some((c) => c.categoryName === 'cell phone' && c.score >= 0.45));
    } catch (_) {
      return null;
    }
  };

  window.StudyAI = ai;
})();
