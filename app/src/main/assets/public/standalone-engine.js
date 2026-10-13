/**
 * AnyCall v2 — Standalone On-Device Backend Engine (Android TFLite + WebAudio DSP)
 * Allows the mobile app (APK or PWA) to run the complete AnyCall v2 backend locally
 * on the phone without requiring an external laptop/server, or optionally connect
 * to a remote Edge Station server.
 */
(function () {
  const STORAGE_KEYS = {
    DETECTIONS: "anycall_sa_detections_v2",
    REVIEWS: "anycall_sa_reviews_v2",
    NOVELTY: "anycall_sa_novelty_v2",
    CLUSTERS: "anycall_sa_clusters_v2",
    CUSTOM_SPECIES: "anycall_sa_custom_species_v2",
    MEM_VER: "anycall_sa_mem_ver_v2",
  };

  let bundleData = null;
  let bundleLoadingPromise = null;
  const clipBlobUrls = new Map(); // window_id -> Blob URL (for offline audio playback & spectrogram)
  let lastInferenceMs = 42.0;

  function loadJsonStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJsonStore(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (_) {}
  }

  async function ensureStandaloneBundle() {
    if (bundleData) return bundleData;
    if (bundleLoadingPromise) return bundleLoadingPromise;
    bundleLoadingPromise = (async () => {
      try {
        const res = await fetch("standalone_bundle.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bundleData = await res.json();
      } catch (e) {
        console.warn("Fallback to minimal standalone bundle:", e.message);
        bundleData = {
          version: "v2",
          species: window.OFFLINE_SPECIES_FALLBACK || [],
          scaler_mean: new Array(40).fill(0),
          scaler_scale: new Array(40).fill(1),
          grand_mean: new Array(1024).fill(0),
          proj_coef: Array.from({ length: 40 }, () => new Array(1024).fill(0)),
          proj_intercept: new Array(1024).fill(0),
          bank: {},
        };
      }
      // Merge any custom enrolled species from localStorage
      const customSp = loadJsonStore(STORAGE_KEYS.CUSTOM_SPECIES, []);
      for (const cs of customSp) {
        if (!bundleData.species.some((s) => s.species_id === cs.species_id)) {
          bundleData.species.push(cs.meta);
        }
        if (cs.bank) {
          bundleData.bank[cs.species_id] = cs.bank;
        }
      }
      return bundleData;
    })();
    return bundleLoadingPromise;
  }

  /* =========================================================================
     1. RADIX-2 FFT & 40-D ACOUSTIC DESCRIPTORS (Exact match to descriptors.py)
     ========================================================================= */
  function fftRadix2(re, im) {
    const n = re.length;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr;
        let ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) {
        j -= m;
        m >>= 1;
      }
      j += m;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = (-2 * Math.PI) / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1.0;
        let wIm = 0.0;
        for (let k = 0; k < half; k++) {
          const uRe = re[i + k];
          const uIm = im[i + k];
          const vRe = re[i + k + half] * wRe - im[i + k + half] * wIm;
          const vIm = re[i + k + half] * wIm + im[i + k + half] * wRe;
          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + half] = uRe - vRe;
          im[i + k + half] = uIm - vIm;
          const nextWRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextWRe;
        }
      }
    }
  }

  let melFilterCache = null;
  let dctMatrixCache = null;

  function getMelAndDct(sr, nFft, nMels, nMfcc) {
    if (melFilterCache && dctMatrixCache) return { melFilters: melFilterCache, dctMatrix: dctMatrixCache };
    const fMin = 50.0;
    const fMax = Math.min(15000.0, sr / 2.0);
    const hzToMel = (hz) => 2595.0 * Math.log10(1.0 + hz / 700.0);
    const melToHz = (mel) => 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0);
    const melMin = hzToMel(fMin);
    const melMax = hzToMel(fMax);
    const hzPoints = new Float32Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) {
      hzPoints[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
    }
    const nBins = (nFft >> 1) + 1;
    const fftFreqs = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) fftFreqs[i] = (i * sr) / nFft;

    melFilterCache = Array.from({ length: nMels }, (_, m) => {
      const left = hzPoints[m];
      const center = hzPoints[m + 1];
      const right = hzPoints[m + 2];
      const row = new Float32Array(nBins);
      for (let b = 0; b < nBins; b++) {
        const up = (fftFreqs[b] - left) / (center - left + 1e-12);
        const down = (right - fftFreqs[b]) / (right - center + 1e-12);
        row[b] = Math.max(0.0, Math.min(up, down));
      }
      return row;
    });

    dctMatrixCache = Array.from({ length: nMfcc }, (_, k) => {
      const row = new Float32Array(nMels);
      for (let n = 0; n < nMels; n++) {
        row[n] = Math.cos((Math.PI * k * (n + 0.5)) / nMels);
      }
      return row;
    });
    return { melFilters: melFilterCache, dctMatrix: dctMatrixCache };
  }

  function computeAcousticDescriptors40D(samples, sr = 48000) {
    if (!samples || !samples.length) return new Float32Array(40);
    const flow = 50.0;
    const fhigh = 15000.0;

    // Peak normalize to 0.5 as in api.py
    let pk = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > pk) pk = a;
    }
    const normSamples = new Float32Array(samples.length);
    const scaleFactor = pk > 1e-6 ? 0.5 / pk : 1.0;
    for (let i = 0; i < samples.length; i++) normSamples[i] = samples[i] * scaleFactor;

    const nFft = 1024;
    const hop = 512;
    const nBins = (nFft >> 1) + 1;
    const nFrames = Math.max(1, Math.floor((normSamples.length - nFft) / hop) + 1);

    const hann = new Float32Array(nFft);
    for (let i = 0; i < nFft; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (nFft - 1)));

    const avgMag = new Float32Array(nBins);
    const frameCentroids = new Float32Array(nFrames);
    const { melFilters, dctMatrix } = getMelAndDct(sr, nFft, 26, 13);
    const mfccFrames = Array.from({ length: 13 }, () => new Float32Array(nFrames));

    const re = new Float32Array(nFft);
    const im = new Float32Array(nFft);
    const powerSpec = new Float32Array(nBins);

    for (let f = 0; f < nFrames; f++) {
      const start = f * hop;
      for (let i = 0; i < nFft; i++) {
        re[i] = (normSamples[start + i] || 0) * hann[i];
        im[i] = 0;
      }
      fftRadix2(re, im);

      let sSum = 1e-12;
      let cSum = 0;
      for (let b = 0; b < nBins; b++) {
        const p = re[b] * re[b] + im[b] * im[b];
        const mag = Math.sqrt(p);
        powerSpec[b] = p;
        avgMag[b] += mag;
        const freq = (b * sr) / nFft;
        sSum += p;
        cSum += freq * p;
      }
      frameCentroids[f] = cSum / sSum;

      // Mel energies -> logMel -> 13 MFCCs
      const logMel = new Float32Array(26);
      for (let m = 0; m < 26; m++) {
        const filt = melFilters[m];
        let e = 0;
        for (let b = 0; b < nBins; b++) e += filt[b] * powerSpec[b];
        logMel[m] = Math.log(Math.max(e, 1e-12));
      }
      for (let k = 0; k < 13; k++) {
        const dctRow = dctMatrix[k];
        let val = 0;
        for (let m = 0; m < 26; m++) val += dctRow[m] * logMel[m];
        mfccFrames[k][f] = val;
      }
    }

    // 1. 7 Spectral shape features across [flow, fhigh]
    let totalPower = 1e-12;
    const subFreqs = [];
    const subMag = [];
    const subPow = [];
    for (let b = 0; b < nBins; b++) {
      const freq = (b * sr) / nFft;
      if (freq >= flow && freq <= fhigh) {
        const m = avgMag[b] / nFrames + 1e-12;
        const p = m * m;
        subFreqs.push(freq);
        subMag.push(m);
        subPow.push(p);
        totalPower += p;
      }
    }

    let centroid = 0;
    for (let i = 0; i < subFreqs.length; i++) centroid += (subFreqs[i] * subPow[i]) / totalPower;

    let bwSum = 0;
    let cumPow = 0;
    let rolloff = subFreqs[subFreqs.length - 1] || 1000;
    let rolloffFound = false;
    let logMagSum = 0;
    let magSum = 0;
    let maxMag = 0;
    let domFreq = 1000;

    for (let i = 0; i < subFreqs.length; i++) {
      const diff = subFreqs[i] - centroid;
      bwSum += diff * diff * subPow[i];
      cumPow += subPow[i];
      if (!rolloffFound && cumPow >= 0.85 * totalPower) {
        rolloff = subFreqs[i];
        rolloffFound = true;
      }
      logMagSum += Math.log(subMag[i]);
      magSum += subMag[i];
      if (subMag[i] > maxMag) {
        maxMag = subMag[i];
        domFreq = subFreqs[i];
      }
    }
    const bandwidth = Math.sqrt(bwSum / totalPower);
    const geomMean = Math.exp(logMagSum / Math.max(1, subMag.length));
    const arithMean = magSum / Math.max(1, subMag.length);
    const flatness = geomMean / (arithMean + 1e-12);

    // 2. 7 Temporal features (25ms frame, 10ms hop)
    const envFrame = Math.floor(0.025 * sr);
    const envHop = Math.floor(0.010 * sr);
    const nEnv = Math.max(1, Math.floor((normSamples.length - envFrame) / envHop) + 1);
    const frameRms = new Float32Array(nEnv);
    let rmsMax = 1e-12;
    let rmsMin = 1e9;
    let rmsMean = 0;
    for (let i = 0; i < nEnv; i++) {
      const st = i * envHop;
      let ssq = 0;
      for (let j = 0; j < envFrame; j++) {
        const v = normSamples[st + j] || 0;
        ssq += v * v;
      }
      const r = Math.sqrt(ssq / envFrame + 1e-12);
      frameRms[i] = r;
      if (r > rmsMax) rmsMax = r;
      if (r < rmsMin) rmsMin = r;
      rmsMean += r / nEnv;
    }

    let activeCnt = 0;
    let onsetCnt = 0;
    for (let i = 0; i < nEnv; i++) {
      if (frameRms[i] >= 0.1 * rmsMax) activeCnt++;
      if (i > 0 && Math.max(0, frameRms[i] - frameRms[i - 1]) > 0.05 * rmsMax) onsetCnt++;
    }
    const activeDurationFrac = activeCnt / nEnv;
    const onsetRate = onsetCnt / (normSamples.length / sr);

    const envFps = sr / envHop;
    const minLag = Math.max(1, Math.floor(envFps / 200.0));
    const maxLag = Math.min(nEnv - 1, Math.floor(envFps / 2.0));
    let bestLag = minLag;
    let bestCorr = -1e18;
    for (let lag = minLag; lag < maxLag; lag++) {
      let c = 0;
      for (let i = 0; i < nEnv - lag; i++) {
        c += (frameRms[i] - rmsMean) * (frameRms[i + lag] - rmsMean);
      }
      if (c > bestCorr) {
        bestCorr = c;
        bestLag = lag;
      }
    }
    const pulseRate = maxLag > minLag ? envFps / bestLag : 0.0;
    const amDepth = (rmsMax - rmsMin) / (rmsMax + rmsMin + 1e-12);

    let fmSlopeSum = 0;
    for (let f = 1; f < nFrames; f++) fmSlopeSum += Math.abs(frameCentroids[f] - frameCentroids[f - 1]);
    const fmSlope = nFrames > 1 ? fmSlopeSum / (nFrames - 1) : 0.0;
    const harmonicRatio = maxMag / (arithMean + 1e-12);

    let totalSq = 0;
    for (let i = 0; i < normSamples.length; i++) totalSq += normSamples[i] * normSamples[i];
    const totalRms = Math.sqrt(totalSq / normSamples.length + 1e-12);

    const out = new Float32Array(40);
    out[0] = Math.log1p(centroid);
    out[1] = Math.log1p(bandwidth);
    out[2] = Math.log1p(rolloff);
    out[3] = flatness;
    out[4] = Math.log1p(domFreq);
    out[5] = Math.log1p(flow);
    out[6] = Math.log1p(fhigh);

    out[7] = activeDurationFrac;
    out[8] = onsetRate;
    out[9] = pulseRate;
    out[10] = amDepth;
    out[11] = Math.log1p(fmSlope);
    out[12] = harmonicRatio;
    out[13] = totalRms;

    for (let k = 0; k < 13; k++) {
      const arr = mfccFrames[k];
      let mean = 0;
      for (let f = 0; f < nFrames; f++) mean += arr[f] / nFrames;
      let vSum = 0;
      for (let f = 0; f < nFrames; f++) {
        const d = arr[f] - mean;
        vSum += d * d;
      }
      out[14 + k] = mean;
      out[27 + k] = Math.sqrt(vSum / nFrames);
    }
    return out;
  }

  function scaleDescriptors(desc40, bundle) {
    const scaled = new Float32Array(40);
    const mean = bundle.scaler_mean || [];
    const scale = bundle.scaler_scale || [];
    for (let i = 0; i < 40; i++) {
      const m = mean[i] ?? 0.0;
      const s = scale[i] || 1.0;
      scaled[i] = (desc40[i] - m) / s;
    }
    return scaled;
  }

  /* =========================================================================
     2. 1024-D DEEP EMBEDDING EXTRACTION (Native Android TFLite + Projection)
     ========================================================================= */
  function float32ToBase64(float32Arr) {
    const bytes = new Uint8Array(float32Arr.buffer, float32Arr.byteOffset, float32Arr.byteLength);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function extractDeepEmbedding1024(windowSamples, descScaled, bundle) {
    // 1. Use Native Android BirdNET v2.4 TFLite Interpreter if running inside APK
    if (window.AndroidBridge && typeof window.AndroidBridge.hasNativeBirdNet === "function") {
      try {
        if (window.AndroidBridge.hasNativeBirdNet()) {
          const b64 = float32ToBase64(windowSamples);
          const jsonStr = window.AndroidBridge.extractBirdNetEmbedding(b64);
          const parsed = JSON.parse(jsonStr);
          if (Array.isArray(parsed) && parsed.length === 1024) {
            return new Float32Array(parsed);
          }
        }
      } catch (e) {
        console.warn("AndroidBridge TFLite fallback:", e);
      }
    }

    // 2. Pure Web/PWA Fallback: Ridge projection from 40-D scaled descriptors -> 1024-D BirdNET space
    const emb = new Float32Array(1024);
    const coef = bundle.proj_coef;
    const intercept = bundle.proj_intercept;
    if (coef && intercept && coef.length === 40) {
      let normSq = 1e-12;
      for (let j = 0; j < 1024; j++) {
        let sum = intercept[j] || 0;
        for (let i = 0; i < 40; i++) {
          sum += descScaled[i] * (coef[i][j] || 0);
        }
        emb[j] = sum;
        normSq += sum * sum;
      }
      const norm = Math.sqrt(normSq);
      for (let j = 0; j < 1024; j++) emb[j] /= norm;
    }
    return emb;
  }

  /* =========================================================================
     3. BAND-ENERGY DETECTOR & 3.0s WINDOW EXTRACTOR
     ========================================================================= */
  function extractActiveWindows(audioSamples, sr = 48000) {
    const winSamples = Math.floor(3.0 * sr);
    const hopSamples = Math.floor(1.5 * sr);
    const total = audioSamples.length;
    if (total === 0) return [];

    if (total <= winSamples) {
      const padded = new Float32Array(winSamples);
      for (let i = 0; i < winSamples; i++) {
        padded[i] = audioSamples[i % total];
      }
      return [{ t_start: 0.0, t_end: 3.0, samples: padded }];
    }

    // Compute 0.5s frame energies and select active windows
    const step = Math.floor(0.5 * sr);
    const frameRms = [];
    for (let st = 0; st + step <= total; st += step) {
      let ssq = 0;
      for (let i = 0; i < step; i++) ssq += audioSamples[st + i] * audioSamples[st + i];
      const r = Math.sqrt(ssq / step);
      if (r > 1e-5) frameRms.push(r);
    }
    if (!frameRms.length) return [];

    const sortedRms = [...frameRms].sort((a, b) => a - b);
    const floorRms = sortedRms[Math.floor(sortedRms.length * 0.2)] || 0.001;

    const windows = [];
    for (let st = 0; st + winSamples <= total; st += hopSamples) {
      const slice = audioSamples.subarray(st, st + winSamples);
      let ssq = 0;
      for (let i = 0; i < slice.length; i++) ssq += slice[i] * slice[i];
      const rms = Math.sqrt(ssq / slice.length);
      if (rms >= Math.max(0.002, floorRms * 1.15) || windows.length === 0) {
        windows.push({
          t_start: Number((st / sr).toFixed(2)),
          t_end: Number(((st + winSamples) / sr).toFixed(2)),
          samples: new Float32Array(slice),
        });
      }
      if (windows.length >= 12) break;
    }
    return windows;
  }

  /* =========================================================================
     4. TWO-VIEW CALIBRATED OPEN-SET GATE (Matches gate.py + Aves >= 90% rule)
     ========================================================================= */
  function evaluateStandaloneWindow(emb1024, descScaled40, bundle, hasNativeTflite) {
    const bank = bundle.bank || {};
    const speciesList = bundle.species || [];
    const taxaMap = {};
    const commonMap = {};
    for (const s of speciesList) {
      taxaMap[s.species_id] = (s.taxon || "aves").toLowerCase();
      commonMap[s.species_id] = s.common || s.common_name || s.species_id;
    }

    const candidates = [];
    for (const [sp, info] of Object.entries(bank)) {
      const repsDesc = info.reps_desc || [];
      const repsDeep = info.reps_deep || [];
      let minDescDist = 999.0;
      for (const rd of repsDesc) {
        let dsq = 0;
        for (let i = 0; i < 40; i++) {
          const diff = descScaled40[i] - (rd[i] || 0);
          dsq += diff * diff;
        }
        const d = Math.sqrt(dsq);
        if (d < minDescDist) minDescDist = d;
      }

      let minDeepDist = 999.0;
      let maxDeepCos = -1.0;
      for (const re of repsDeep) {
        let dsq = 0;
        let dot = 0;
        for (let i = 0; i < 1024; i++) {
          const diff = emb1024[i] - (re[i] || 0);
          dsq += diff * diff;
          dot += emb1024[i] * (re[i] || 0);
        }
        const d = Math.sqrt(dsq);
        if (d < minDeepDist) minDeepDist = d;
        if (dot > maxDeepCos) maxDeepCos = dot;
      }

      const rDeep = Math.max(0.15, info.r_deep || 0.65);
      const rDesc = Math.max(0.35, info.r_desc || 1.20);
      const rhoDeep = minDeepDist / rDeep;
      const rhoDesc = minDescDist / rDesc;

      const isBird = taxaMap[sp] === "aves";
      const wDeep = hasNativeTflite ? (isBird ? 0.85 : 0.65) : 0.45;
      const fusedRho = wDeep * rhoDeep + (1.0 - wDeep) * rhoDesc;
      const score = Math.exp(-0.65 * fusedRho);

      candidates.push({
        species: sp,
        common: commonMap[sp] || sp,
        taxon: (taxaMap[sp] || "aves").replace(/^\w/, (c) => c.toUpperCase()),
        rho_deep: rhoDeep,
        rho_desc: rhoDesc,
        score,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const top1 = candidates[0] || { species: "Unknown", common: "Unknown", taxon: "Aves", rho_deep: 2.0, rho_desc: 2.0, score: 0.0 };
    const top2 = candidates[1] || { score: 0.0 };

    // Normalize top candidates into calibrated confidence
    const margin = top1.score - top2.score;
    const confidence = Math.min(0.994, Math.max(0.15, top1.score * (1.0 + 0.35 * margin)));

    const isBird = (taxaMap[top1.species] || "aves") === "aves";
    const viewsAgreeRaw = isBird
      ? top1.rho_deep <= 1.05 && top1.rho_desc <= 1.35
      : top1.rho_deep <= 1.15 && top1.rho_desc <= 1.20;
    const isAvesHighConf = isBird && confidence >= 0.90 && top1.rho_deep <= 1.05;

    let decision = "REVIEW";
    let reviewSubtype = "BORDERLINE";
    if ((viewsAgreeRaw && confidence >= 0.55) || isAvesHighConf) {
      decision = "KNOWN";
      reviewSubtype = null;
    } else if (top1.rho_deep > 1.22 && top1.rho_desc > 1.35) {
      decision = "NOVEL";
      reviewSubtype = null;
    } else if (!viewsAgreeRaw) {
      decision = "REVIEW";
      reviewSubtype = "VIEW_DISAGREEMENT";
    }

    const twoViewsAgree = decision === "KNOWN" || decision === "KNOWN_MEMORY" || viewsAgreeRaw || isAvesHighConf;
    return {
      top_species: top1.species,
      common_name: top1.common,
      taxon: top1.taxon,
      decision,
      review_subtype: reviewSubtype,
      confidence,
      rho_deep: top1.rho_deep,
      rho_desc: top1.rho_desc,
      two_views_agree: twoViewsAgree,
      top3: candidates.slice(0, 3).map((c) => ({
        species: c.species,
        score: Number(Math.min(0.99, c.score).toFixed(3)),
      })),
    };
  }

  /* =========================================================================
     5. STANDALONE API ROUTER (/api/*)
     ========================================================================= */
  async function handleStandaloneClassify(formData) {
    const t0 = performance.now();
    const bundle = await ensureStandaloneBundle();
    const file = formData.get("file");
    if (!file) throw new Error("Missing audio file in classify request");

    const arrayBuf = await file.arrayBuffer();
    const AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext || window.AudioContext;
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
    } finally {
      try { await decodeCtx.close(); } catch (_) {}
    }

    // Resample to 48000 Hz mono if needed
    const targetSr = 48000;
    let mono48k;
    if (decoded.sampleRate === targetSr) {
      mono48k = decoded.getChannelData(0);
    } else {
      const lengthSamples = Math.ceil(decoded.duration * targetSr);
      const offCtx = new AudioCtx(1, lengthSamples, targetSr);
      const src = offCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(offCtx.destination);
      src.start(0);
      const rendered = await offCtx.startRendering();
      mono48k = rendered.getChannelData(0);
    }

    const windows = extractActiveWindows(mono48k, targetSr);
    if (!windows.length) {
      return {
        filename: file.name || "audio.wav",
        segments_analyzed: 0,
        is_known: false,
        decision: "NOISE",
        confidence: 0.0,
        segments: [],
      };
    }

    const hasNative = !!(window.AndroidBridge && typeof window.AndroidBridge.hasNativeBirdNet === "function" && window.AndroidBridge.hasNativeBirdNet());
    const detections = loadJsonStore(STORAGE_KEYS.DETECTIONS, []);
    const reviews = loadJsonStore(STORAGE_KEYS.REVIEWS, []);
    const novelty = loadJsonStore(STORAGE_KEYS.NOVELTY, []);

    const segmentsOut = [];
    const nowIso = new Date().toISOString();

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const desc40 = computeAcousticDescriptors40D(w.samples, targetSr);
      const descScaled = scaleDescriptors(desc40, bundle);
      const emb1024 = extractDeepEmbedding1024(w.samples, descScaled, bundle);
      const gate = evaluateStandaloneWindow(emb1024, descScaled, bundle, hasNative);

      const winId = `sa_${Date.now().toString(36)}_${i + 1}`;
      if (typeof window.encodePcmToWavBlob === "function") {
        const wavBlob = window.encodePcmToWavBlob(w.samples, targetSr);
        clipBlobUrls.set(winId, URL.createObjectURL(wavBlob));
      }

      const segRecord = {
        window_index: i,
        window_id: winId,
        timestamp: nowIso,
        t_start: w.t_start,
        t_end: w.t_end,
        species_id: gate.top_species,
        common_name: gate.common_name,
        detected_call: gate.decision === "NOVEL" ? `Unseen / Novel Call (nearest: ${gate.common_name})` : gate.common_name,
        taxon: gate.taxon,
        decision: gate.decision,
        review_subtype: gate.review_subtype,
        confidence: Number(gate.confidence.toFixed(4)),
        rho_deep: Number(gate.rho_deep.toFixed(3)),
        rho_desc: Number(gate.rho_desc.toFixed(3)),
        two_views_agree: gate.two_views_agree,
        top3: gate.top3,
        has_audio: clipBlobUrls.has(winId),
        desc_scaled: Array.from(descScaled),
      };
      segmentsOut.push(segRecord);

      detections.unshift(segRecord);
      if (gate.decision === "REVIEW") {
        reviews.unshift({
          window_id: winId,
          timestamp: nowIso,
          top_species: gate.top_species,
          p_top: gate.confidence,
          rho_deep: gate.rho_deep,
          rho_desc: gate.rho_desc,
          review_subtype: gate.review_subtype || "VIEW_DISAGREEMENT",
          priority: gate.confidence,
          desc_scaled: Array.from(descScaled),
        });
      }
    }

    // Determine recording-level decision
    const knownSegs = segmentsOut.filter((s) => s.decision === "KNOWN" || s.decision === "KNOWN_MEMORY");
    let bestSeg = segmentsOut[0];
    for (const s of segmentsOut) {
      if (s.confidence > bestSeg.confidence) bestSeg = s;
    }
    if (knownSegs.length > 0) {
      bestSeg = knownSegs.reduce((a, b) => (b.confidence > a.confidence ? b : a), knownSegs[0]);
    }

    if (bestSeg.decision === "NOVEL") {
      for (const s of segmentsOut) {
        if (s.decision === "NOVEL") {
          novelty.push({
            item_id: s.window_id,
            window_id: s.window_id,
            timestamp: nowIso,
            created_at: nowIso,
            clip_path: `${s.window_id}.wav`,
            desc_scaled: s.desc_scaled,
            status: "unassigned",
          });
        }
      }
    }

    saveJsonStore(STORAGE_KEYS.DETECTIONS, detections.slice(0, 150));
    saveJsonStore(STORAGE_KEYS.REVIEWS, reviews.slice(0, 100));
    saveJsonStore(STORAGE_KEYS.NOVELTY, novelty.slice(-200));

    // Probable species summary
    const spGroups = {};
    for (const s of knownSegs) {
      if (!spGroups[s.species_id]) {
        spGroups[s.species_id] = {
          species_id: s.species_id,
          common_name: s.common_name,
          taxon: s.taxon,
          window_count: 0,
          sum_conf: 0,
          max_confidence: 0,
        };
      }
      const g = spGroups[s.species_id];
      g.window_count++;
      g.sum_conf += s.confidence;
      if (s.confidence > g.max_confidence) g.max_confidence = s.confidence;
    }
    const probableSpecies = Object.values(spGroups).map((g) => ({
      species_id: g.species_id,
      common_name: g.common_name,
      taxon: g.taxon,
      window_count: g.window_count,
      avg_confidence: g.sum_conf / g.window_count,
      max_confidence: g.max_confidence,
    }));

    lastInferenceMs = Number(((performance.now() - t0) / Math.max(1, windows.length)).toFixed(1));

    return {
      filename: file.name || "audio.wav",
      segments_analyzed: segmentsOut.length,
      is_known: bestSeg.decision === "KNOWN" || bestSeg.decision === "KNOWN_MEMORY",
      decision: bestSeg.decision,
      top_species: bestSeg.species_id,
      predicted_label: bestSeg.species_id,
      common_name: bestSeg.common_name,
      taxon: bestSeg.taxon,
      confidence: bestSeg.confidence,
      two_views_agree: bestSeg.two_views_agree,
      probable_species: probableSpecies,
      segments: segmentsOut,
    };
  }

  window.getClipAudioUrl = function (windowId) {
    if (clipBlobUrls.has(windowId)) return clipBlobUrls.get(windowId);
    return window.apiUrl(`/api/audio/${windowId}.wav`);
  };

  window.standaloneApiFetch = async function (path, options = {}) {
    const bundle = await ensureStandaloneBundle();
    const urlObj = new URL(path, "http://localhost");
    const pathname = urlObj.pathname;
    const method = (options.method || "GET").toUpperCase();

    if (pathname === "/api/stats") {
      const dets = loadJsonStore(STORAGE_KEYS.DETECTIONS, []);
      const revs = loadJsonStore(STORAGE_KEYS.REVIEWS, []);
      const nov = loadJsonStore(STORAGE_KEYS.NOVELTY, []);
      const cls = loadJsonStore(STORAGE_KEYS.CLUSTERS, []).filter((c) => c.status === "open");
      const memVer = loadJsonStore(STORAGE_KEYS.MEM_VER, 1);
      return {
        total_windows: dets.length,
        pending_reviews: revs.length,
        quarantined_unknowns: nov.length,
        candidate_novel_clusters: cls.length,
        enrolled_species: (bundle.species || []).length,
        current_bundle: bundle.version || "v2",
        memory_version: memVer,
      };
    }

    if (pathname === "/api/species" && method === "GET") {
      return { species: bundle.species || [] };
    }

    if (pathname === "/api/detections" && method === "GET") {
      const decFilter = urlObj.searchParams.get("decision") || "";
      let dets = loadJsonStore(STORAGE_KEYS.DETECTIONS, []);
      dets = dets.map((d) => ({ ...d, has_audio: clipBlobUrls.has(d.window_id) }));
      if (decFilter) dets = dets.filter((d) => d.decision === decFilter);
      return { detections: dets };
    }

    if (pathname === "/api/detections/clear" && method === "POST") {
      saveJsonStore(STORAGE_KEYS.DETECTIONS, []);
      return { status: "cleared", message: "Standalone detection ledger cleared." };
    }

    if (pathname === "/api/classify" && method === "POST") {
      return await handleStandaloneClassify(options.body);
    }

    if (pathname === "/api/review" && method === "GET") {
      return { review_queue: loadJsonStore(STORAGE_KEYS.REVIEWS, []) };
    }

    if (pathname === "/api/review/clear" && method === "POST") {
      saveJsonStore(STORAGE_KEYS.REVIEWS, []);
      return { status: "cleared", message: "All pending standalone reviews cleared." };
    }

    if (pathname.startsWith("/api/review/") && method === "POST") {
      const winId = pathname.split("/").pop();
      const body = typeof options.body === "string" ? JSON.parse(options.body) : {};
      let revs = loadJsonStore(STORAGE_KEYS.REVIEWS, []);
      revs = revs.filter((r) => r.window_id !== winId);
      saveJsonStore(STORAGE_KEYS.REVIEWS, revs);

      let dets = loadJsonStore(STORAGE_KEYS.DETECTIONS, []);
      dets = dets.map((d) => {
        if (d.window_id === winId) {
          if (body.action === "confirm") {
            return { ...d, decision: "KNOWN_MEMORY", species_id: body.species_id || d.species_id, two_views_agree: true };
          } else if (body.action === "noise") {
            return { ...d, decision: "NOISE" };
          } else if (body.action === "unknown") {
            return { ...d, decision: "NOVEL" };
          }
        }
        return d;
      });
      saveJsonStore(STORAGE_KEYS.DETECTIONS, dets);
      saveJsonStore(STORAGE_KEYS.MEM_VER, loadJsonStore(STORAGE_KEYS.MEM_VER, 1) + 1);
      return { status: "resolved", action: body.action, window_id: winId, species_id: body.species_id };
    }

    if (pathname === "/api/discovery/clusters" && method === "GET") {
      const cls = loadJsonStore(STORAGE_KEYS.CLUSTERS, []).filter((c) => c.status === "open");
      return { clusters: cls };
    }

    if (pathname === "/api/discovery/clear" && method === "POST") {
      saveJsonStore(STORAGE_KEYS.CLUSTERS, []);
      saveJsonStore(STORAGE_KEYS.NOVELTY, []);
      let dets = loadJsonStore(STORAGE_KEYS.DETECTIONS, []).filter((d) => d.decision !== "NOVEL");
      saveJsonStore(STORAGE_KEYS.DETECTIONS, dets);
      return { status: "cleared", message: "All standalone discovery clusters and novel items cleared." };
    }

    if (pathname === "/api/discovery/run" && method === "POST") {
      const nov = loadJsonStore(STORAGE_KEYS.NOVELTY, []).filter((n) => n.status !== "noise");
      if (!nov.length) {
        return { status: "complete", clusters_found: 0, message: "No pooled novelty items to cluster." };
      }
      const nowIso = new Date().toISOString();
      const clusterId = `clust_sa_${Date.now().toString(36).slice(-4)}`;
      const newCluster = {
        cluster_id: clusterId,
        type: "candidate_novel",
        variant_of_species: null,
        size: nov.length,
        nights_seen: 1,
        priority: 0.85,
        status: "open",
        first_seen: nowIso,
        last_seen: nowIso,
        timestamp: nowIso,
        members: nov.map((n) => ({
          item_id: n.item_id,
          window_id: n.window_id,
          prob: 1.0,
          role: "member",
          clip_path: n.clip_path,
          timestamp: n.timestamp || nowIso,
        })),
      };
      saveJsonStore(STORAGE_KEYS.CLUSTERS, [newCluster]);
      return { status: "complete", clusters_found: 1 };
    }

    if (pathname.startsWith("/api/discovery/clusters/")) {
      const parts = pathname.split("/");
      const clusterId = parts[4];
      const subAction = parts[5];
      const cls = loadJsonStore(STORAGE_KEYS.CLUSTERS, []);
      const cIdx = cls.findIndex((c) => c.cluster_id === clusterId);
      if (cIdx === -1) throw new Error("Cluster not found");

      if (!subAction && method === "GET") {
        return cls[cIdx];
      }
      if (subAction === "remove-member" && method === "POST") {
        const body = JSON.parse(options.body || "{}");
        cls[cIdx].members = (cls[cIdx].members || []).filter((m) => m.item_id !== body.item_id);
        cls[cIdx].size = cls[cIdx].members.length;
        saveJsonStore(STORAGE_KEYS.CLUSTERS, cls);
        return { status: "ok", remaining_size: cls[cIdx].size };
      }
      if (subAction === "action" && method === "POST") {
        const body = JSON.parse(options.body || "{}");
        cls[cIdx].status = body.action === "noise" ? "dismissed" : "promoted";
        saveJsonStore(STORAGE_KEYS.CLUSTERS, cls);
        return { status: "ok", cluster_id: clusterId, action: body.action };
      }
    }

    if (pathname === "/api/species/enroll" && method === "POST") {
      const fd = options.body;
      const spId = (fd.get("species_id") || "").trim().toLowerCase();
      const common = (fd.get("common_name") || spId).trim();
      const taxon = (fd.get("taxon") || "Aves").trim();
      const files = fd.getAll("files");
      const repsDesc = [];
      const repsDeep = [];
      const targetSr = 48000;

      for (const f of files) {
        const buf = await f.arrayBuffer();
        const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
        let decoded;
        try { decoded = await decodeCtx.decodeAudioData(buf.slice(0)); } finally { try { await decodeCtx.close(); } catch (_) {} }
        const wins = extractActiveWindows(decoded.getChannelData(0), decoded.sampleRate);
        for (const w of wins.slice(0, 3)) {
          const d40 = computeAcousticDescriptors40D(w.samples, decoded.sampleRate);
          const dScaled = scaleDescriptors(d40, bundle);
          const e1024 = extractDeepEmbedding1024(w.samples, dScaled, bundle);
          repsDesc.push(Array.from(dScaled));
          repsDeep.push(Array.from(e1024));
        }
      }

      const meta = {
        species_id: spId,
        common: common,
        scientific: common,
        taxon: taxon,
        status: "active",
        recordings: files.length,
        exemplars: repsDesc.length,
        modes: 1,
        tau_c: 0.50,
        w_c: 0.75,
      };
      const bankEntry = { r_deep: 0.75, r_desc: 1.35, reps_desc: repsDesc, reps_deep: repsDeep };
      bundle.species.push(meta);
      bundle.bank[spId] = bankEntry;

      const customList = loadJsonStore(STORAGE_KEYS.CUSTOM_SPECIES, []);
      customList.push({ species_id: spId, meta, bank: bankEntry });
      saveJsonStore(STORAGE_KEYS.CUSTOM_SPECIES, customList);
      return { status: "enrolled", species_id: spId, exemplars: repsDesc.length };
    }

    if (pathname === "/api/system") {
      const hasNative = !!(window.AndroidBridge && typeof window.AndroidBridge.hasNativeBirdNet === "function" && window.AndroidBridge.hasNativeBirdNet());
      return {
        device: hasNative ? "Android On-Device TFLite + DSP" : "Standalone On-Device WebAudio Engine",
        real_time_factor: Number((lastInferenceMs / 3000.0).toFixed(3)),
        inference_ms: lastInferenceMs,
        active_bundle: bundle.version || "v2",
        memory_version: loadJsonStore(STORAGE_KEYS.MEM_VER, 1),
      };
    }

    if (pathname === "/api/models") {
      return { current: "v2", bundles: [{ version: "v2" }] };
    }

    if (pathname === "/api/mic/devices") {
      return {
        devices: [
          { index: "phone_mic", name: "📱 This Device / Phone Mic (Standalone WAV Buffer)", channels: 1, default_samplerate: 48000, is_default: true },
        ],
      };
    }

    if (pathname === "/api/mic/status") {
      return { is_running: false, gain: 3.0, uptime_seconds: 0, current_rms: 0.0, last_detection: null };
    }

    return {};
  };
})();
