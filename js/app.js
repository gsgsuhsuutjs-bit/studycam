// 공부캠: silent study camera with on-device AI focus analysis and shadow mode.
(() => {
  'use strict';

  const OUT_FPS = 30;
  const CARD_SECONDS = 3;
  const QUALITY = {
    '720':  { long: 1280, short: 720,  live: 1200000, lapse: 4000000 },
    '1080': { long: 1920, short: 1080, live: 2500000, lapse: 8000000 },
  };
  const INTERVALS = [1, 2, 5, 10];
  const MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
  const SANS = '"IBM Plex Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const DISPLAY = '"Do Hyeon", "IBM Plex Sans KR", "Apple SD Gothic Neo", sans-serif';
  const SHADOW = '#08080A';

  // Focus states: index = code stored per second.
  const STATES = [
    { key: 'focus', label: '집중', card: '#3DBA82' },
    { key: 'look',  label: '딴 데 봄', card: '#F0B43A' },
    { key: 'phone', label: '휴대폰', card: '#FF6B6F' },
    { key: 'away',  label: '자리 비움', card: '#8A94A6' },
    { key: 'app',   label: '앱 밖 (폰 사용)', card: '#9B80EC' },
  ];

  const AI = window.StudyAI;
  const $ = (id) => document.getElementById(id);
  const el = {};
  [
    'cam', 'canvas', 'viewfinder', 'flash', 'vfEmpty', 'vfTitle', 'vfBody', 'vfBtn', 'recChip', 'recLabel', 'aiChip', 'aiChipLabel',
    'elapsed', 'outInfo', 'recBtn', 'recCaption', 'pauseBtn', 'pauseLabel', 'flipBtn',
    'modeSeg', 'modeLapse', 'modeHint', 'lapseGroup', 'lapseChips', 'lapseHint', 'qualSeg', 'sizeHint',
    'optTimer', 'optClock', 'optMirror', 'optAnalysis', 'optShadow', 'optEyes', 'eyesRow', 'optVertical', 'optEndCard',
    'aiStatus', 'aiBar', 'aiBarFill', 'aiHint',
    'result', 'playback', 'resLen', 'resStudy', 'resSize', 'resFmt', 'resName', 'saveLink', 'shareBtn', 'shareHint', 'cardShareBtn', 'againBtn',
    'report', 'repPct', 'repMeta', 'repTimeline', 'repEnd', 'repLegend', 'toast',
  ].forEach((id) => { el[id] = $(id); });
  el.vf = el.viewfinder;
  const ctx = el.canvas.getContext('2d', { alpha: false });

  // ---------- settings (remembered in this browser only) ----------
  const settings = {
    mode: 'normal', interval: 2, quality: '720', showTimer: true, showClock: false, mirror: false,
    analysis: false, shadow: false, eyes: false, vertical: false, endCard: true,
  };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('studycam:v1') || '{}')); } catch (_) {}
  if (!['normal', 'lapse'].includes(settings.mode)) settings.mode = 'normal';
  if (!INTERVALS.includes(settings.interval)) settings.interval = 2;
  if (!QUALITY[settings.quality]) settings.quality = '720';
  const saveSettings = () => { try { localStorage.setItem('studycam:v1', JSON.stringify(settings)); } catch (_) {} };

  const lapseSupported = typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function' && typeof window.Mp4Muxer === 'object';
  if (!lapseSupported) {
    settings.mode = 'normal';
    el.modeLapse.dataset.unsupported = '1';
    el.modeLapse.disabled = true;
  }

  // ---------- state ----------
  const st = {
    phase: 'idle', stream: null, deviceId: null, cameras: [],
    activeMs: 0, segStart: 0, startedAt: null,
    recMode: 'normal', recInterval: 2, recVertical: false, bytes: 0, mime: '',
    recorder: null, recStream: null, chunks: [],
    encoder: null, muxer: null, encError: null, frames: 0, nextDue: 0, tickTimer: 0,
    card: null, result: null, saved: false, wakeLock: null, hiddenDuringRec: false,
    raf: 0, lastDraw: 0,
  };
  const isRec = () => st.phase === 'recording' || st.phase === 'paused';
  const activeMs = () => st.activeMs + (st.phase === 'recording' ? performance.now() - st.segStart : 0);

  // Latest AI results, shared by the shadow drawing and the focus analysis.
  const vis = { segAt: 0, maskAt: 0, coverage: 0, face: null, faceAt: 0, faceSeenAt: 0 };
  // Focus analysis for the current recording.
  const an = { on: false, sec: [], appRanges: [], hiddenAt: null, yaw: [], phone: false, phoneAt: -1e9, cur: 0, live: [0, 0, 0, 0, 0], timer: 0 };

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, '0');
  function fmtHMS(ms) {
    const s = Math.floor(ms / 1000);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }
  function fmtShort(sec) {
    const s = Math.round(sec);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  }
  function fmtKoDuration(sec) {
    const s = Math.round(sec);
    if (s < 60) return `${s}초`;
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${m}분 ${r}초` : `${m}분`;
  }
  function fmtBytes(b) {
    if (b < 1e6) return `${Math.max(0, Math.round(b / 1e3))} KB`;
    if (b < 1e9) return `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
    return `${(b / 1e9).toFixed(1)} GB`;
  }
  const DAYS = '일월화수목금토';
  const fmtClock = (d) => `${d.getMonth() + 1}.${pad(d.getDate())} (${DAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtDate = (d) => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${DAYS[d.getDay()]})`;
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4500);
  }

  // ---------- camera ----------
  const EMPTY = {
    loading:  ['카메라를 켜는 중이에요', '권한을 물어보면 "허용"을 눌러 주세요. 마이크는 쓰지 않아요.', null],
    denied:   ['카메라 권한이 꺼져 있어요', '주소창 옆의 카메라 아이콘이나 브라우저 설정에서 이 페이지의 카메라를 허용한 다음 다시 시도하세요.', '다시 시도'],
    notfound: ['카메라를 찾지 못했어요', '카메라가 연결돼 있는지 확인하고 다시 시도하세요.', '다시 시도'],
    busy:     ['카메라를 쓸 수 없어요', '줌이나 카메라 앱처럼 카메라를 쓰는 다른 앱을 닫고 다시 시도하세요.', '다시 시도'],
    insecure: ['여기서는 카메라를 켤 수 없어요', 'https로 시작하는 주소에서 열어 주세요.', null],
    lost:     ['카메라 연결이 끊겼어요', '카메라를 다시 연결한 다음 켜 주세요.', '카메라 켜기'],
    other:    ['카메라를 켜지 못했어요', '', '다시 시도'],
  };
  function showEmpty(kind, err) {
    const [title, body, btn] = EMPTY[kind] || EMPTY.other;
    el.vfTitle.textContent = title;
    el.vfBody.textContent = body || (err && err.message) || '잠시 후 다시 시도해 주세요.';
    el.vfBtn.textContent = btn || '';
    el.vfBtn.hidden = !btn;
    el.vfEmpty.hidden = false;
  }
  function kindOf(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError': return 'denied';
      case 'NotFoundError': case 'OverconstrainedError': return 'notfound';
      case 'NotReadableError': case 'AbortError': return 'busy';
      default: return 'other';
    }
  }
  function stopCamera() {
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    el.cam.srcObject = null;
  }
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showEmpty('insecure'); setPhase('idle'); return; }
    showEmpty('loading');
    stopCamera();
    const q = QUALITY[settings.quality];
    const video = { width: { ideal: q.long }, height: { ideal: q.short }, frameRate: { ideal: 30, max: 30 } };
    if (st.deviceId) video.deviceId = { exact: st.deviceId };
    else video.facingMode = 'user';
    let stream;
    try {
      // audio: false - the microphone is never requested, so the video has no sound at all.
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (st.deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) { st.deviceId = null; return startCamera(); }
      showEmpty(kindOf(e), e);
      setPhase('idle');
      return;
    }
    st.stream = stream;
    const track = stream.getVideoTracks()[0];
    const s = track && track.getSettings ? track.getSettings() : {};
    if (s.deviceId) st.deviceId = s.deviceId;
    if (track) track.addEventListener('ended', () => { if (st.stream === stream) onCameraLost(); });
    el.cam.srcObject = stream;
    try { await el.cam.play(); } catch (_) {}
    await new Promise((res) => {
      if (el.cam.videoWidth) return res();
      el.cam.addEventListener('loadedmetadata', res, { once: true });
      setTimeout(res, 3000);
    });
    sizeCanvas();
    el.vfEmpty.hidden = true;
    await listCameras();
    if (st.phase === 'idle' || st.phase === 'ready') setPhase('ready');
    startLoop();
  }
  async function listCameras() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      st.cameras = all.filter((d) => d.kind === 'videoinput' && d.deviceId);
    } catch (_) { st.cameras = []; }
    el.flipBtn.hidden = st.cameras.length < 2;
  }
  function onCameraLost() {
    if (isRec()) { toast('카메라 연결이 끊겨서 녹화를 끝냈어요.'); stopRecording(); }
    stopCamera();
    showEmpty('lost');
    if (st.phase === 'ready') setPhase('idle');
  }

  // ---------- canvas size: what you see is exactly what gets recorded ----------
  function sizeCanvas() {
    const vw = el.cam.videoWidth, vh = el.cam.videoHeight;
    if (!vw || !vh) return;
    const q = QUALITY[settings.quality];
    let w, h;
    if (settings.vertical) {
      w = q.short; h = q.long; // 9:16 for Shorts, Reels and TikTok
    } else {
      const landscape = vw >= vh;
      const s = Math.min(1, (landscape ? q.long : q.short) / vw, (landscape ? q.short : q.long) / vh);
      w = vw * s; h = vh * s;
    }
    w = Math.max(2, Math.round(w / 2) * 2);
    h = Math.max(2, Math.round(h / 2) * 2);
    if (el.canvas.width !== w || el.canvas.height !== h) { el.canvas.width = w; el.canvas.height = h; }
    el.vf.style.aspectRatio = `${w} / ${h}`;
  }
  el.cam.addEventListener('resize', () => { if (!isRec() && st.phase !== 'stopping') sizeCanvas(); });

  function videoRect(W, H) {
    const v = el.cam;
    const fit = settings.vertical ? Math.max : Math.min; // vertical crops to fill, otherwise fit whole frame
    const s = fit(W / v.videoWidth, H / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  // ---------- AI: shadow mask and eyes ----------
  const maskCanvas = document.createElement('canvas');
  const mctx = maskCanvas.getContext('2d');
  let maskImg = null;
  const MASK_W = 256;

  // Downsamples the person mask into a small black canvas with soft alpha, and measures how much of the frame is a person.
  function consumeMask(w, h, data) {
    const tw = Math.min(MASK_W, w);
    const th = Math.max(1, Math.round((h * tw) / w));
    if (maskCanvas.width !== tw || maskCanvas.height !== th || !maskImg) {
      maskCanvas.width = tw; maskCanvas.height = th;
      maskImg = mctx.createImageData(tw, th);
      const d0 = maskImg.data;
      for (let j = 0; j < d0.length; j += 4) { d0[j] = 8; d0[j + 1] = 8; d0[j + 2] = 10; }
    }
    const d = maskImg.data;
    let on = 0;
    for (let y = 0; y < th; y++) {
      const row = Math.min(h - 1, Math.floor(((y + 0.5) * h) / th)) * w;
      for (let x = 0; x < tw; x++) {
        const v = data[row + Math.min(w - 1, Math.floor(((x + 0.5) * w) / tw))];
        if (v > 0.5) on++;
        const a = (v - 0.12) * 3.6; // generous: anything that might be a person gets covered
        d[(y * tw + x) * 4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255) | 0;
      }
    }
    mctx.putImageData(maskImg, 0, 0);
    vis.coverage = on / (tw * th);
    vis.maskAt = performance.now();
  }

  function runShadowVision(force) {
    const now = performance.now();
    if (AI.seg && (force || now - vis.segAt >= 66)) {
      vis.segAt = now;
      AI.segment(el.cam, consumeMask);
    }
    if (settings.eyes && AI.face && (force || now - vis.faceAt >= 100)) {
      vis.faceAt = now;
      vis.face = AI.detectFace(el.cam);
      if (vis.face) vis.faceSeenAt = now;
    }
  }
  function drawMask(r) {
    const k = Math.max(1, (r.w / maskCanvas.width) * 1.2); // grow the shadow a little so edges don't leak
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(maskCanvas, r.x, r.y, r.w, r.h);
    ctx.drawImage(maskCanvas, r.x - k, r.y, r.w, r.h);
    ctx.drawImage(maskCanvas, r.x + k, r.y, r.w, r.h);
    ctx.drawImage(maskCanvas, r.x, r.y - k, r.w, r.h);
    ctx.drawImage(maskCanvas, r.x, r.y + k, r.w, r.h);
  }
  function drawEyes(r) {
    const f = vis.face;
    if (!f || performance.now() - vis.faceSeenAt > 700) return;
    ctx.fillStyle = '#FFFFFF';
    for (const [a, b] of [[33, 133], [362, 263]]) {
      const p = f[a], q = f[b];
      if (!p || !q) continue;
      const ax = r.x + p.x * r.w, ay = r.y + p.y * r.h;
      const bx = r.x + q.x * r.w, by = r.y + q.y * r.h;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 2) continue;
      ctx.save();
      ctx.translate((ax + bx) / 2, (ay + by) / 2);
      ctx.rotate(Math.atan2(by - ay, bx - ax));
      ctx.beginPath();
      ctx.ellipse(0, 0, len * 0.72, len * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------- drawing ----------
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function drawOverlay(W, H) {
    const rows = [];
    if (settings.showTimer) rows.push({ tag: '공부', text: fmtHMS(activeMs()) });
    if (settings.showClock) rows.push({ tag: null, text: fmtClock(new Date()) });
    if (!rows.length) return;
    const base = Math.min(W, H);
    const fs = Math.max(14, Math.round(base * 0.058));
    const tagFs = Math.round(fs * 0.64);
    const padX = Math.round(fs * 0.55), padY = Math.round(fs * 0.32), gap = Math.round(fs * 0.36);
    const margin = Math.round(base * 0.04);
    const bh = Math.round(fs * 1.2) + padY * 2;
    let y = H - margin;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      let tagW = 0;
      if (r.tag) { ctx.font = `600 ${tagFs}px ${SANS}`; tagW = ctx.measureText(r.tag).width + gap; }
      ctx.font = `600 ${fs}px ${MONO}`;
      const tw = ctx.measureText(r.text).width;
      const bw = Math.ceil(padX * 2 + tagW + tw);
      const bx = margin, by = y - bh, cy = by + bh / 2;
      ctx.fillStyle = 'rgba(8, 12, 18, 0.6)';
      roundRect(ctx, bx, by, bw, bh, Math.round(bh * 0.3));
      ctx.fill();
      let x = bx + padX;
      if (r.tag) {
        ctx.font = `600 ${tagFs}px ${SANS}`;
        ctx.fillStyle = '#FFE14D';
        ctx.fillText(r.tag, x, cy);
        x += tagW;
      }
      ctx.font = `600 ${fs}px ${MONO}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(r.text, x, cy + fs * 0.04);
      y = by - Math.round(fs * 0.28);
    }
  }
  function draw(force) {
    const W = el.canvas.width, H = el.canvas.height, v = el.cam;
    if (st.card) { drawCard(ctx, W, H, st.card); return; }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    if (st.stream && v.readyState >= 2 && v.videoWidth) {
      const r = videoRect(W, H);
      ctx.save();
      if (settings.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
      ctx.drawImage(v, r.x, r.y, r.w, r.h);
      if (settings.shadow) {
        runShadowVision(force);
        // Privacy first: with no recent mask, hide the whole picture instead of showing the person.
        if (vis.maskAt && performance.now() - vis.maskAt < 1500) drawMask(r);
        else { ctx.fillStyle = SHADOW; ctx.fillRect(r.x, r.y, r.w, r.h); }
        if (settings.eyes) drawEyes(r);
      }
      ctx.restore();
    }
    drawOverlay(W, H);
  }
  function startLoop() {
    if (st.raf) return;
    const step = (t) => {
      st.raf = requestAnimationFrame(step);
      if (t - st.lastDraw < 30) return; // about 30 fps
      st.lastDraw = t;
      if (st.stream || st.card) draw();
      updateHud();
    };
    st.raf = requestAnimationFrame(step);
  }

  // ---------- summary card (end of video, and as an image) ----------
  function drawTimeline(c, x, y, w, h, codes, colors, radius) {
    c.save();
    roundRect(c, x, y, w, h, radius == null ? h / 2 : radius);
    c.clip();
    c.fillStyle = colors[0];
    c.fillRect(x, y, w, h);
    const n = codes.length;
    if (n) {
      let i = 0;
      while (i < n) {
        let j = i;
        while (j < n && codes[j] === codes[i]) j++;
        if (codes[i] !== 0) {
          c.fillStyle = colors[codes[i]];
          const x0 = x + (i / n) * w, x1 = x + (j / n) * w;
          c.fillRect(x0, y, Math.max(1, x1 - x0), h);
        }
        i = j;
      }
    }
    c.restore();
  }
  function drawCard(c, W, H, d) {
    const u = Math.min(W, H) / 100;
    c.save();
    c.fillStyle = '#17243A';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    c.lineWidth = Math.max(1, u * 0.15);
    const g = 4 * u;
    c.beginPath();
    for (let x = g; x < W; x += g) { c.moveTo(x, 0); c.lineTo(x, H); }
    for (let y = g; y < H; y += g) { c.moveTo(0, y); c.lineTo(W, y); }
    c.stroke();

    const cx = W / 2;
    let y = H / 2 - (d.report ? 30 : 20) * u;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#FFE14D';
    c.font = `${7 * u}px ${DISPLAY}`;
    c.fillText('공부캠', cx, y);
    y += 7 * u;
    c.fillStyle = 'rgba(233, 238, 244, 0.7)';
    c.font = `500 ${3.6 * u}px ${SANS}`;
    c.fillText(fmtDate(d.date), cx, y);
    y += 13 * u;
    c.fillStyle = 'rgba(233, 238, 244, 0.88)';
    c.font = `600 ${4 * u}px ${SANS}`;
    c.fillText('오늘 공부한 시간', cx, y);
    y += 15 * u;
    const big = fmtHMS(d.studyMs);
    c.font = `600 ${14 * u}px ${MONO}`;
    const tw = c.measureText(big).width;
    c.fillStyle = 'rgba(255, 225, 77, 0.92)';
    c.fillRect(cx - tw / 2 - u, y - 4 * u, tw + 2 * u, 5 * u);
    c.fillStyle = '#FFFFFF';
    c.fillText(big, cx, y);
    if (d.report) {
      y += 14 * u;
      c.fillStyle = 'rgba(233, 238, 244, 0.88)';
      c.font = `600 ${4 * u}px ${SANS}`;
      c.fillText(`집중률 ${d.report.pct}%  ·  가장 길게 ${fmtShort(d.report.longest)}`, cx, y);
      y += 5 * u;
      const bw = Math.min(W - 16 * u, 84 * u), bh = 3.6 * u;
      drawTimeline(c, cx - bw / 2, y, bw, bh, d.report.codes, STATES.map((s) => s.card));
    }
    c.fillStyle = 'rgba(233, 238, 244, 0.45)';
    c.font = `500 ${2.8 * u}px ${SANS}`;
    c.fillText('소리 없이 찍은 공부 기록', cx, H - 6 * u);
    c.restore();
  }

  // ---------- HUD ----------
  let hudKey = '';
  function updateHud(force) {
    const ms = activeMs();
    const t = fmtHMS(ms);
    let info;
    if (st.phase === 'stopping') info = st.card ? '기록 카드 넣는 중…' : '영상 마무리하는 중…';
    else if (isRec()) {
      info = st.recMode === 'lapse'
        ? `사진 ${st.frames}장 · 영상 ${fmtShort(st.frames / OUT_FPS)} · ${fmtBytes(st.bytes)}`
        : `영상 ${fmtShort(ms / 1000)} · ${fmtBytes(st.bytes)}`;
    } else {
      info = settings.mode === 'lapse' ? `타임랩스 · ${settings.interval}초마다 한 장` : '보이는 그대로 녹화';
    }
    const chip = st.phase === 'paused' ? '일시정지' : (st.recMode === 'lapse' ? `타임랩스 · ${st.frames}장` : 'REC');
    let aiKey = '';
    let aiLabel = '';
    if (AI.status === 'loading' && aiNeeds().length) { aiKey = 'load'; aiLabel = `AI 준비 중 ${Math.round(AI.progress * 100)}%`; }
    else if (an.on && isRec()) {
      const total = an.live.reduce((a, b) => a + b, 0);
      const pct = total ? Math.round((an.live[0] / total) * 100) : 100;
      aiKey = STATES[an.cur].key;
      aiLabel = `${STATES[an.cur].label} · 집중 ${pct}%`;
    } else if (settings.shadow && AI.seg && st.stream) { aiKey = 'focus'; aiLabel = '그림자 모드'; }
    const key = `${t}|${info}|${chip}|${aiKey}|${aiLabel}`;
    if (!force && key === hudKey) return;
    hudKey = key;
    el.elapsed.textContent = t;
    el.outInfo.textContent = info;
    el.recLabel.textContent = chip;
    el.aiChip.hidden = !aiKey;
    el.aiChip.dataset.s = aiKey;
    el.aiChipLabel.textContent = aiLabel;
  }

  // ---------- phase ----------
  function setPhase(p) {
    st.phase = p;
    document.body.dataset.phase = p;
    const rec = isRec();
    const locked = rec || p === 'stopping' || p === 'done';
    const aiOk = aiReady();
    el.recBtn.disabled = !((p === 'ready' && aiOk) || rec);
    el.recBtn.setAttribute('aria-label', rec ? '녹화 끝내기' : '녹화 시작');
    el.recCaption.textContent = p === 'stopping' ? '저장 준비 중' : rec ? '끝내기' : (p === 'ready' && !aiOk) ? 'AI 준비 중' : '녹화';
    el.pauseBtn.disabled = !rec;
    el.pauseLabel.textContent = p === 'paused' ? '이어서' : '일시정지';
    el.flipBtn.disabled = locked || p === 'idle';
    document.querySelectorAll('[data-lock]').forEach((n) => { n.disabled = locked || n.dataset.unsupported === '1'; });
    el.recChip.hidden = !rec;
    updateHud(true);
  }

  // ---------- AI loading ----------
  function aiNeeds() {
    const n = new Set();
    if (settings.analysis) { n.add('seg'); n.add('face'); n.add('obj'); }
    if (settings.shadow) { n.add('seg'); if (settings.eyes) n.add('face'); }
    return [...n];
  }
  const aiReady = () => aiNeeds().every((k) => AI[k]);

  function renderAI() {
    const need = aiNeeds();
    const loading = AI.status === 'loading';
    el.aiBar.hidden = !loading;
    el.aiBarFill.style.width = `${Math.round(AI.progress * 100)}%`;
    el.aiStatus.dataset.s = need.length ? AI.status : 'off';
    let msg;
    if (loading) msg = `AI 준비 중… ${Math.round(AI.progress * 100)}% (처음 한 번만 받아요)`;
    else if (need.length && AI.status === 'error') msg = 'AI를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 켜 주세요.';
    else if (need.length && aiReady()) msg = 'AI 준비됨. 영상과 분석 내용은 폰 밖으로 나가지 않아요.';
    else {
      const mb = Math.round(AI.sizeFor(['seg', 'face', 'obj']) / 1e6);
      msg = mb ? `처음 켤 때 AI 파일(최대 약 ${mb}MB)을 한 번 받아요. 와이파이에서 켜는 걸 추천해요.` : '켜면 바로 쓸 수 있어요.';
    }
    el.aiHint.textContent = msg;
    el.eyesRow.hidden = !settings.shadow;
    setPhase(st.phase);
  }
  AI.onChange = renderAI;

  async function syncAI() {
    renderAI();
    const need = aiNeeds();
    if (!need.length || aiReady()) return;
    try {
      await AI.ensure(need);
      warmUpAI();
    } catch (_) {
      if (settings.analysis && !(AI.seg && AI.face && AI.obj)) settings.analysis = false;
      if (settings.shadow && !AI.seg) settings.shadow = false;
      if (settings.eyes && !AI.face) settings.eyes = false;
      saveSettings();
      renderControls();
      toast('AI를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 켜 주세요.');
    }
    renderAI();
  }

  // The first run of each model is slow; do it now so the first seconds of a recording aren't missed.
  function warmUpAI() {
    const v = el.cam;
    if (!st.stream || v.readyState < 2) return;
    if (AI.seg) AI.segment(v, consumeMask);
    if (AI.face) AI.detectFace(v);
    if (AI.obj) AI.seesPhone(v);
  }

  // ---------- recording: real-time ----------
  function pickMime() {
    const list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {} }
    return '';
  }
  function beginLive() {
    if (!window.MediaRecorder || !el.canvas.captureStream) throw new Error('이 브라우저는 동영상 녹화를 지원하지 않아요. 최신 Chrome이나 Safari에서 열어 주세요.');
    const mime = pickMime();
    st.recStream = el.canvas.captureStream(OUT_FPS);
    const opts = { videoBitsPerSecond: QUALITY[settings.quality].live };
    if (mime) opts.mimeType = mime;
    const rec = new MediaRecorder(st.recStream, opts);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) { st.chunks.push(e.data); st.bytes += e.data.size; } };
    rec.onerror = () => { toast('녹화 중 문제가 생겨서 지금까지 찍은 부분으로 끝냈어요.'); stopRecording(); };
    rec.start(1000);
    st.recorder = rec;
    st.mime = rec.mimeType || mime || 'video/webm';
  }

  // ---------- recording: timelapse (one frame every N seconds, played back at 30 fps) ----------
  async function pickLapseConfig(w, h) {
    const bitrate = QUALITY[settings.quality].lapse;
    const candidates = [
      { codec: 'avc1.640028', mux: 'avc' },
      { codec: 'avc1.4d0028', mux: 'avc' },
      { codec: 'avc1.420028', mux: 'avc' },
      { codec: 'avc1.42001f', mux: 'avc' },
      { codec: 'vp09.00.40.08', mux: 'vp9' },
      { codec: 'av01.0.08M.08', mux: 'av1' },
    ];
    for (const c of candidates) {
      const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: OUT_FPS };
      if (c.mux === 'avc') cfg.avc = { format: 'avc' };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) return { cfg, mux: c.mux };
      } catch (_) {}
    }
    return null;
  }
  async function beginLapse(W, H) {
    const pick = await pickLapseConfig(W, H);
    if (!pick) throw new Error('이 브라우저에서는 타임랩스 영상을 만들 수 없어요. "그대로" 방식으로 찍거나 최신 Chrome에서 열어 주세요.');
    st.muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: pick.mux, width: W, height: H, frameRate: OUT_FPS },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    st.encoder = new VideoEncoder({
      output: (chunk, meta) => { st.muxer.addVideoChunk(chunk, meta); st.bytes += chunk.byteLength; },
      error: (e) => { st.encError = e; },
    });
    st.encoder.configure(pick.cfg);
    st.mime = 'video/mp4';
    st.nextDue = 0;
  }
  function encodeCanvasFrame() {
    const frame = new VideoFrame(el.canvas, {
      timestamp: Math.round((st.frames * 1e6) / OUT_FPS),
      duration: Math.round(1e6 / OUT_FPS),
    });
    st.encoder.encode(frame, { keyFrame: st.frames % OUT_FPS === 0 });
    frame.close();
    st.frames++;
  }
  function captureFrame() {
    if (!st.encoder || st.encoder.state !== 'configured') return;
    draw(true);
    encodeCanvasFrame();
    el.flash.classList.remove('on');
    void el.flash.offsetWidth;
    el.flash.classList.add('on');
  }
  function lapseTick() {
    if (st.encError) { toast('타임랩스를 만드는 중 문제가 생겨서 녹화를 끝냈어요.'); stopRecording(); return; }
    if (st.phase !== 'recording') return;
    const now = activeMs();
    if (now < st.nextDue) return;
    captureFrame();
    const step = st.recInterval * 1000;
    st.nextDue += step;
    if (st.nextDue <= now) st.nextDue = now + step; // skip frames missed while the app was in the background
  }

  // ---------- focus analysis (sampled once a second while recording) ----------
  function yawOf(f) {
    const l = f[33], r = f[263], n = f[1];
    if (!l || !r || !n) return null;
    const d = Math.abs(r.x - l.x);
    if (d < 0.02) return null;
    return (n.x - (l.x + r.x) / 2) / d;
  }
  // "Looking away" is measured against the usual head direction, so a camera at the side still works.
  function lookingAway(f) {
    const y = yawOf(f);
    if (y == null) return false;
    an.yaw.push(y);
    if (an.yaw.length > 300) an.yaw.shift();
    if (an.yaw.length < 8) return false;
    const sorted = [...an.yaw].sort((a, b) => a - b);
    return Math.abs(y - sorted[sorted.length >> 1]) > 0.38;
  }
  function analyzeTick() {
    if (st.phase !== 'recording' || document.hidden || !st.stream) return;
    const v = el.cam;
    if (v.readyState < 2) return;
    const now = performance.now();
    if (now - vis.maskAt > 700) { vis.segAt = now; AI.segment(v, consumeMask); }
    let face = vis.face;
    if (now - vis.faceAt > 400) {
      vis.faceAt = now;
      face = AI.detectFace(v);
      vis.face = face;
      if (face) vis.faceSeenAt = now;
    }
    if (now - an.phoneAt >= 3000) {
      const p = AI.seesPhone(v);
      if (p !== null) an.phone = p;
      an.phoneAt = now;
    }
    const maskFresh = vis.maskAt && now - vis.maskAt < 2000;
    const present = (maskFresh && vis.coverage > 0.02) || !!face;
    let s = 0;
    if (!present) s = 3;
    else if (an.phone) s = 2;
    else if (face && lookingAway(face)) s = 1;
    an.sec[Math.floor(activeMs() / 1000)] = s;
    an.cur = s;
    an.live[s]++;
  }
  function startAnalysis() {
    Object.assign(an, { on: true, sec: [], appRanges: [], hiddenAt: null, yaw: [], phone: false, phoneAt: -1e9, cur: 0, live: [0, 0, 0, 0, 0] });
    clearInterval(an.timer);
    an.timer = setInterval(analyzeTick, 1000);
  }
  function stopAnalysis() {
    clearInterval(an.timer);
    an.timer = 0;
    if (an.hiddenAt != null) { an.appRanges.push([an.hiddenAt / 1000, st.activeMs / 1000]); an.hiddenAt = null; }
  }
  function buildReport() {
    const total = Math.floor(st.activeMs / 1000);
    if (!an.on || total < 1) return null;
    const codes = new Uint8Array(total);
    // Seconds before the first sample take the first sample's state.
    let prev = an.sec.find((c) => c !== undefined);
    if (prev === undefined) prev = 0;
    for (let i = 0; i < total; i++) {
      if (an.sec[i] !== undefined) prev = an.sec[i];
      codes[i] = prev;
    }
    for (const [a, b] of an.appRanges) {
      for (let i = Math.max(0, Math.floor(a)); i < Math.min(total, Math.ceil(b)); i++) codes[i] = 4;
    }
    // A glance shorter than 3 seconds is not a distraction.
    let i = 0;
    while (i < total) {
      let j = i;
      while (j < total && codes[j] === codes[i]) j++;
      if ((codes[i] === 1 || codes[i] === 2) && j - i < 3) codes.fill(0, i, j);
      i = j;
    }
    const counts = [0, 0, 0, 0, 0];
    let longest = 0, breaks = 0;
    i = 0;
    while (i < total) {
      let j = i;
      while (j < total && codes[j] === codes[i]) j++;
      counts[codes[i]] += j - i;
      if (codes[i] === 0) longest = Math.max(longest, j - i);
      else if (j - i >= 3) breaks++;
      i = j;
    }
    return { total, codes, counts, longest, breaks, pct: Math.round((counts[0] / total) * 100) };
  }

  // ---------- start / pause / stop ----------
  async function startRecording() {
    if (st.phase !== 'ready' || !st.stream) return;
    if (!aiReady()) { toast('AI를 준비하는 중이에요. 잠시만 기다려 주세요.'); return; }
    sizeCanvas();
    const W = el.canvas.width, H = el.canvas.height;
    st.recMode = settings.mode;
    st.recInterval = settings.interval;
    st.recVertical = settings.vertical;
    st.activeMs = 0; st.frames = 0; st.bytes = 0; st.chunks = []; st.encError = null; st.card = null;
    st.startedAt = new Date();
    an.on = false;
    el.recBtn.disabled = true;
    try {
      if (st.recMode === 'lapse') await beginLapse(W, H);
      else beginLive();
    } catch (e) {
      cleanupRecorders();
      toast(e.message || '녹화를 시작하지 못했어요.');
      setPhase('ready');
      return;
    }
    st.segStart = performance.now();
    if (settings.analysis) startAnalysis();
    setPhase('recording');
    lockScreen();
    if (st.recMode === 'lapse') { lapseTick(); st.tickTimer = setInterval(lapseTick, 200); }
  }
  function pauseRecording() {
    if (st.phase !== 'recording') return;
    st.activeMs += performance.now() - st.segStart;
    if (st.recorder && st.recorder.state === 'recording') st.recorder.pause();
    setPhase('paused');
  }
  function resumeRecording() {
    if (st.phase !== 'paused') return;
    st.segStart = performance.now();
    if (st.recorder && st.recorder.state === 'paused') st.recorder.resume();
    setPhase('recording');
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function stopRecording() {
    if (!isRec()) return;
    if (st.phase === 'recording') st.activeMs += performance.now() - st.segStart;
    setPhase('stopping');
    clearInterval(st.tickTimer);
    st.tickTimer = 0;
    stopAnalysis();
    const report = buildReport();
    releaseScreen();
    let blob = null, outSec = 0;
    try {
      if (settings.endCard) {
        try { await document.fonts.load(`${40}px ${DISPLAY}`); } catch (_) {}
        st.card = { date: st.startedAt, studyMs: st.activeMs, report };
      }
      if (st.recMode === 'lapse') {
        if (st.card && st.encoder && st.encoder.state === 'configured') {
          draw();
          for (let k = 0; k < CARD_SECONDS * OUT_FPS; k++) encodeCanvasFrame();
        }
        if (st.encoder && st.encoder.state === 'configured') await st.encoder.flush();
        if (st.encError) throw st.encError;
        st.muxer.finalize();
        blob = new Blob([st.muxer.target.buffer], { type: 'video/mp4' });
        outSec = st.frames / OUT_FPS;
      } else {
        const rec = st.recorder;
        if (st.card && rec && rec.state !== 'inactive') {
          if (rec.state === 'paused') rec.resume();
          draw();
          await wait(CARD_SECONDS * 1000); // the draw loop keeps painting the card while it records
        }
        if (rec && rec.state !== 'inactive') {
          await new Promise((res) => { rec.addEventListener('stop', res, { once: true }); rec.stop(); });
        }
        blob = new Blob(st.chunks, { type: (st.mime || 'video/webm').split(';')[0] });
        outSec = st.activeMs / 1000 + (st.card ? CARD_SECONDS : 0);
      }
    } catch (e) {
      toast('영상을 마무리하지 못했어요. ' + ((e && e.message) || ''));
    }
    st.card = null;
    cleanupRecorders();
    if (blob && blob.size) showResult(blob, outSec, report);
    else setPhase(st.stream ? 'ready' : 'idle');
  }
  function cleanupRecorders() {
    if (st.recStream) st.recStream.getTracks().forEach((t) => t.stop());
    st.recStream = null; st.recorder = null; st.chunks = [];
    if (st.encoder && st.encoder.state !== 'closed') { try { st.encoder.close(); } catch (_) {} }
    st.encoder = null; st.muxer = null;
  }

  // ---------- result ----------
  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    return STATES.map((s) => cs.getPropertyValue(`--s-${s.key}`).trim() || s.card);
  }
  function renderReport(rep) {
    el.report.hidden = !rep;
    if (!rep) return;
    el.repPct.textContent = String(rep.pct);
    el.repMeta.innerHTML = `가장 길게 집중 <b>${fmtShort(rep.longest)}</b><br>집중이 끊긴 횟수 <b>${rep.breaks}번</b>`;
    el.repEnd.textContent = fmtShort(rep.total);
    const cv = el.repTimeline;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = cv.clientWidth || 520;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(26 * dpr);
    drawTimeline(cv.getContext('2d'), 0, 0, cv.width, cv.height, rep.codes, themeColors(), 6 * dpr);
    el.repLegend.textContent = '';
    STATES.forEach((s, i) => {
      if (i !== 0 && !rep.counts[i]) return;
      const li = document.createElement('li');
      const sw = document.createElement('i');
      sw.style.background = `var(--s-${s.key})`;
      const name = document.createElement('span');
      name.textContent = s.label;
      const val = document.createElement('b');
      val.textContent = fmtShort(rep.counts[i]);
      li.append(sw, name, val);
      el.repLegend.append(li);
    });
  }

  function showResult(blob, outSec, report) {
    if (st.result) URL.revokeObjectURL(st.result.url);
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    // ASCII only: some browsers drop non-ASCII download names and save the file as "download".
    const name = `studycam_${st.recMode === 'lapse' ? 'timelapse_' : ''}${stamp(st.startedAt)}.${ext}`;
    const url = URL.createObjectURL(blob);
    st.result = { blob, url, name, file: null, report, date: st.startedAt, studyMs: st.activeMs };
    st.saved = false;
    el.playback.src = url;
    el.saveLink.href = url;
    el.saveLink.download = name;
    el.resStudy.textContent = fmtHMS(st.activeMs);
    el.resLen.textContent = fmtShort(outSec);
    el.resSize.textContent = fmtBytes(blob.size);
    el.resFmt.textContent = ext.toUpperCase() + (st.recVertical ? ' · 9:16' : '') + (st.recMode === 'lapse' ? ` · ${st.recInterval * OUT_FPS}배속` : '');
    el.resName.textContent = name;
    let canShare = false;
    try {
      const f = new File([blob], name, { type: blob.type });
      canShare = !!(navigator.canShare && navigator.canShare({ files: [f] }));
      st.result.file = f;
    } catch (_) {}
    el.shareBtn.hidden = !canShare;
    el.shareHint.textContent = canShare
      ? '브이로그 올리기를 누르고 유튜브, 인스타그램, 틱톡 중에 고르면 바로 올릴 수 있어요.'
      : '이 브라우저에서는 바로 올리기가 안 돼요. 영상을 저장한 다음 유튜브나 인스타그램 앱에서 올려 주세요.';
    disarm();
    el.result.hidden = false;
    renderReport(report);
    setPhase('done');
    el.saveLink.focus();
  }
  function closeResult() {
    el.result.hidden = true;
    el.playback.removeAttribute('src');
    el.playback.load();
    if (st.result) URL.revokeObjectURL(st.result.url);
    st.result = null;
    st.activeMs = 0; st.frames = 0; st.bytes = 0;
    an.on = false;
    setPhase(st.stream ? 'ready' : 'idle');
  }
  let armTimer = 0;
  function disarm() {
    clearTimeout(armTimer);
    delete el.againBtn.dataset.armed;
    el.againBtn.textContent = '새로 찍기';
  }
  el.saveLink.addEventListener('click', () => {
    st.saved = true;
    toast('저장을 시작했어요. 다운로드 폴더나 파일 앱을 확인하세요.');
  });
  el.shareBtn.addEventListener('click', async () => {
    if (!st.result || !st.result.file) return;
    try {
      await navigator.share({ files: [st.result.file], title: '공부 브이로그' });
      st.saved = true;
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('공유하지 못했어요. 영상 저장을 눌러 주세요.');
    }
  });
  el.cardShareBtn.addEventListener('click', async () => {
    if (!st.result) return;
    const c = document.createElement('canvas');
    c.width = 1080; c.height = 1920;
    try { await document.fonts.load(`40px ${DISPLAY}`); } catch (_) {}
    drawCard(c.getContext('2d'), c.width, c.height, { date: st.result.date, studyMs: st.result.studyMs, report: st.result.report });
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) { toast('기록 카드를 만들지 못했어요.'); return; }
    const name = `studycam_card_${stamp(st.result.date)}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '오늘의 공부 기록' });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('기록 카드 이미지를 저장했어요.');
  });
  el.againBtn.addEventListener('click', () => {
    if (!st.saved && !el.againBtn.dataset.armed) {
      el.againBtn.dataset.armed = '1';
      el.againBtn.textContent = '저장 안 했어요 · 한 번 더 누르면 지워져요';
      clearTimeout(armTimer);
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    closeResult();
  });

  // ---------- screen wake lock and leaving the app ----------
  async function lockScreen() {
    try { if ('wakeLock' in navigator) st.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  function releaseScreen() {
    try { if (st.wakeLock) st.wakeLock.release(); } catch (_) {}
    st.wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (st.phase === 'recording') {
        st.hiddenDuringRec = true;
        if (an.on && an.hiddenAt == null) an.hiddenAt = activeMs();
      }
      return;
    }
    if (an.on && an.hiddenAt != null) {
      an.appRanges.push([an.hiddenAt / 1000, activeMs() / 1000]);
      an.hiddenAt = null;
    }
    if (isRec()) {
      if (!st.wakeLock || st.wakeLock.released) lockScreen();
      if (st.hiddenDuringRec) toast('다른 앱에 가 있던 동안은 녹화가 멈췄을 수 있어요.');
    }
    st.hiddenDuringRec = false;
  });
  window.addEventListener('beforeunload', (e) => {
    if (isRec() || st.phase === 'stopping' || (st.phase === 'done' && !st.saved)) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- controls ----------
  function renderControls() {
    el.modeSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
    el.lapseChips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.interval) === settings.interval)));
    el.qualSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.quality === settings.quality)));
    el.lapseGroup.hidden = settings.mode !== 'lapse';
    el.optTimer.checked = settings.showTimer;
    el.optClock.checked = settings.showClock;
    el.optMirror.checked = settings.mirror;
    el.optAnalysis.checked = settings.analysis;
    el.optShadow.checked = settings.shadow;
    el.optEyes.checked = settings.eyes;
    el.optVertical.checked = settings.vertical;
    el.optEndCard.checked = settings.endCard;
    el.eyesRow.hidden = !settings.shadow;

    if (settings.mode === 'lapse') {
      el.modeHint.textContent = '몇 초마다 한 장씩 찍어서 빨리 감기 영상으로 만들어요. 오래 공부할 때 알맞아요.';
    } else {
      el.modeHint.textContent = '움직임까지 실시간으로 담아요. 한 시간 안쪽의 짧은 공부에 알맞아요.'
        + (lapseSupported ? '' : ' 타임랩스는 최신 Chrome, Edge, Safari에서 쓸 수 있어요.');
    }
    const outPerHour = 3600 / (settings.interval * OUT_FPS);
    el.lapseHint.innerHTML = `<b>1시간</b> 공부하면 <b>${fmtKoDuration(outPerHour)}</b>짜리 영상이 돼요.`;
    const q = QUALITY[settings.quality];
    const perHour = settings.mode === 'lapse' ? (q.lapse / 8) * outPerHour : (q.live / 8) * 3600;
    el.sizeHint.innerHTML = `1시간 찍으면 약 <b>${fmtBytes(perHour)}</b>`;
    updateHud(true);
  }

  el.modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.disabled) return;
    settings.mode = b.dataset.mode; saveSettings(); renderControls();
  });
  el.lapseChips.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-interval]');
    if (!b || b.disabled) return;
    settings.interval = Number(b.dataset.interval); saveSettings(); renderControls();
  });
  el.qualSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-quality]');
    if (!b || b.disabled || b.dataset.quality === settings.quality) return;
    settings.quality = b.dataset.quality; saveSettings(); renderControls();
    if (st.stream && st.phase === 'ready') startCamera();
  });
  el.optTimer.addEventListener('change', () => { settings.showTimer = el.optTimer.checked; saveSettings(); });
  el.optClock.addEventListener('change', () => { settings.showClock = el.optClock.checked; saveSettings(); });
  el.optMirror.addEventListener('change', () => { settings.mirror = el.optMirror.checked; saveSettings(); });
  el.optAnalysis.addEventListener('change', () => { settings.analysis = el.optAnalysis.checked; saveSettings(); syncAI(); });
  el.optShadow.addEventListener('change', () => {
    settings.shadow = el.optShadow.checked;
    vis.maskAt = 0; // start fully covered until the first fresh mask arrives
    saveSettings(); syncAI();
  });
  el.optEyes.addEventListener('change', () => { settings.eyes = el.optEyes.checked; saveSettings(); syncAI(); });
  el.optVertical.addEventListener('change', () => { settings.vertical = el.optVertical.checked; saveSettings(); sizeCanvas(); renderControls(); });
  el.optEndCard.addEventListener('change', () => { settings.endCard = el.optEndCard.checked; saveSettings(); });

  el.recBtn.addEventListener('click', () => {
    if (st.phase === 'ready') startRecording();
    else if (isRec()) stopRecording();
  });
  el.pauseBtn.addEventListener('click', () => {
    if (st.phase === 'recording') pauseRecording();
    else if (st.phase === 'paused') resumeRecording();
  });
  el.flipBtn.addEventListener('click', () => {
    if (st.cameras.length < 2 || st.phase !== 'ready') return;
    const i = st.cameras.findIndex((c) => c.deviceId === st.deviceId);
    st.deviceId = st.cameras[(i + 1) % st.cameras.length].deviceId;
    startCamera();
  });
  el.vfBtn.addEventListener('click', () => { st.deviceId = null; startCamera(); });

  // ---------- boot ----------
  try {
    if (document.fonts) {
      document.fonts.load(`600 40px ${MONO}`);
      document.fonts.load(`600 26px ${SANS}`);
      document.fonts.load(`40px ${DISPLAY}`);
    }
  } catch (_) {}
  renderControls();
  setPhase('idle');
  startLoop();
  startCamera();
  syncAI();

  // Offline support: after the first visit the app opens without internet.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  window.__studycam = { st, settings, an, vis }; // for debugging in the console
})();
