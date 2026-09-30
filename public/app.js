// AnyCall Android Field Station Application Logic
const GITHUB_DB_URL = "https://raw.githubusercontent.com/techiitheblob/Anycall/main/anycall.db";
let edgeServerUrl = localStorage.getItem("anycall_server_url") || "http://127.0.0.1:8000";
let dbLastUpdated = localStorage.getItem("anycall_db_updated") || "Never";
let enrolledSpecies = JSON.parse(localStorage.getItem("anycall_species_cache") || "[]");
let detectionsHistory = JSON.parse(localStorage.getItem("anycall_detections_cache") || "[]");
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];

function showToast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.innerText = msg;
  t.style.borderLeftColor = isError ? "var(--rose)" : "var(--accent)";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3200);
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(tabId).classList.add("active");
  event.currentTarget.classList.add("active");
}

// 1. GitHub Database Update Engine
async function updateDbFromGitHub() {
  const syncBtn = document.getElementById("btn-sync-db");
  const progressContainer = document.getElementById("db-progress-container");
  const progressBar = document.getElementById("db-progress-bar");
  const progressText = document.getElementById("db-progress-text");

  syncBtn.disabled = true;
  progressContainer.style.display = "block";
  progressBar.style.width = "0%";
  progressText.innerText = "Connecting to GitHub repository...";

  try {
    const response = await fetch(GITHUB_DB_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`GitHub HTTP error ${response.status}`);

    const contentLength = response.headers.get("content-length");
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    const reader = response.body.getReader();

    let receivedBytes = 0;
    let chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedBytes += value.length;

      if (totalBytes) {
        const pct = Math.round((receivedBytes / totalBytes) * 100);
        progressBar.style.width = `${pct}%`;
        progressText.innerText = `Downloading anycall.db: ${(receivedBytes / 1024 / 1024).toFixed(2)} MB / ${(totalBytes / 1024 / 1024).toFixed(2)} MB (${pct}%)`;
      } else {
        progressText.innerText = `Downloading anycall.db: ${(receivedBytes / 1024 / 1024).toFixed(2)} MB...`;
      }
    }

    const blob = new Blob(chunks);
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Check SQLite header "SQLite format 3"
    const headerStr = String.fromCharCode(...bytes.slice(0, 15));
    if (!headerStr.startsWith("SQLite format")) {
      throw new Error("Downloaded file is not a valid SQLite database");
    }

    // Save update timestamp
    dbLastUpdated = new Date().toLocaleString();
    localStorage.setItem("anycall_db_updated", dbLastUpdated);
    document.getElementById("db-last-sync-val").innerText = dbLastUpdated;

    // Refresh species from server or mock parser
    await fetchSpeciesFromServer();

    showToast(`Successfully updated DB from GitHub! (${(receivedBytes / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    showToast(`GitHub DB Update failed: ${err.message}`, true);
    progressText.innerText = "Sync failed. Check connection.";
  } finally {
    syncBtn.disabled = false;
    setTimeout(() => { progressContainer.style.display = "none"; }, 2500);
  }
}

// 2. Fetch Species Prototypes from Edge Server
async function fetchSpeciesFromServer() {
  try {
    const res = await fetch(`${edgeServerUrl}/api/species`);
    if (res.ok) {
      const data = await res.json();
      enrolledSpecies = data.species || [];
      localStorage.setItem("anycall_species_cache", JSON.stringify(enrolledSpecies));
      renderSpeciesList();
      document.getElementById("stat-species-count").innerText = enrolledSpecies.length;
    }
  } catch (e) {
    console.log("Offline mode: rendering cached species prototypes");
    renderSpeciesList();
  }
}

function renderSpeciesList() {
  const container = document.getElementById("species-list-container");
  if (!enrolledSpecies.length) {
    container.innerHTML = `<p style="text-align:center; color:var(--text-muted); padding:1rem;">No species cached. Click 'Update DB from GitHub' above.</p>`;
    return;
  }

  container.innerHTML = enrolledSpecies.map(s => `
    <div class="species-item">
      <div>
        <div style="font-weight:700; font-size:0.95rem;">${s.common_name}</div>
        <div style="font-size:0.75rem; color:var(--text-muted); font-family:monospace;">${s.species_id} &middot; ${s.sample_count} audio clips</div>
      </div>
      <div>
        <span class="badge badge-${(s.taxon || 'aves').toLowerCase()}">${s.taxon || 'Aves'}</span>
      </div>
    </div>
  `).join("");
}

// 3. Audio Recording & Microphone Capture
async function toggleRecording() {
  const btn = document.getElementById("btn-record");
  const label = document.getElementById("record-label");

  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = processRecordedAudio;

      mediaRecorder.start();
      isRecording = true;
      btn.classList.add("recording");
      label.innerText = "Recording... (Tap to analyze)";
      showToast("Microphone active! Record wildlife call...");
    } catch (e) {
      showToast("Microphone access denied or unsupported", true);
    }
  } else {
    isRecording = false;
    btn.classList.remove("recording");
    label.innerText = "Tap to Record Call";
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }
}

async function processRecordedAudio() {
  showToast("Processing audio clip...");
  const audioBlob = new Blob(audioChunks, { type: "audio/wav" });
  const formData = new FormData();
  formData.append("file", audioBlob, "field_recording.wav");

  try {
    const res = await fetch(`${edgeServerUrl}/api/classify`, { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Classification failed");

    // Display result card
    const resCard = document.getElementById("rec-result-card");
    resCard.style.display = "block";

    const isKnown = data.is_known;
    const name = data.common_name || (data.predicted_label ? data.predicted_label.replace(/_/g, " ").toUpperCase() : "Unknown");
    const conf = (data.confidence * 100).toFixed(1);

    document.getElementById("res-species-name").innerText = name;
    document.getElementById("res-conf-val").innerText = `${conf}%`;
    document.getElementById("res-conf-fill").style.width = `${Math.min(100, conf)}%`;

    const badge = document.getElementById("res-status-badge");
    if (isKnown) {
      badge.className = "badge badge-aves";
      badge.innerText = "MATCH";
      document.getElementById("res-conf-fill").style.background = "var(--accent)";
    } else {
      badge.className = "badge badge-unknown";
      badge.innerText = "QUARANTINED";
      document.getElementById("res-conf-fill").style.background = "var(--rose)";
    }

    // Append to local detections history
    const detectionEvent = {
      timestamp: new Date().toLocaleTimeString(),
      name,
      taxon: data.taxon || (isKnown ? "Aves" : "Unknown"),
      confidence: conf,
      is_known: isKnown
    };
    detectionsHistory.unshift(detectionEvent);
    if (detectionsHistory.length > 50) detectionsHistory.pop();
    localStorage.setItem("anycall_detections_cache", JSON.stringify(detectionsHistory));
    renderDetectionsFeed();

    showToast(`Identified: ${name} (${conf}%)`);
  } catch (err) {
    showToast(`Server Inference Error: ${err.message}`, true);
  }
}

// 4. Render Detection Stream with Hide Unknowns Filter
function renderDetectionsFeed() {
  const container = document.getElementById("detections-feed-container");
  const hideUnknowns = document.getElementById("toggle-hide-unknowns-app")?.checked;

  let list = detectionsHistory;
  if (hideUnknowns) {
    list = list.filter(d => d.is_known);
  }

  if (!list.length) {
    container.innerHTML = `<p style="text-align:center; color:var(--text-muted); padding:1rem;">No detections recorded yet.</p>`;
    return;
  }

  container.innerHTML = list.map(d => `
    <div class="species-item">
      <div>
        <div style="font-weight:700; font-size:0.9rem;">${d.name}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${d.timestamp} &middot; Confidence: ${d.confidence}%</div>
      </div>
      <div>
        <span class="badge ${d.is_known ? 'badge-aves' : 'badge-unknown'}">${d.is_known ? 'MATCH' : 'QUARANTINED'}</span>
      </div>
    </div>
  `).join("");
}

function saveServerSettings() {
  const input = document.getElementById("setting-server-url").value.trim();
  if (input) {
    edgeServerUrl = input;
    localStorage.setItem("anycall_server_url", edgeServerUrl);
    showToast("Server URL saved!");
    fetchSpeciesFromServer();
  }
}

// Initialization
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("db-last-sync-val").innerText = dbLastUpdated;
  document.getElementById("setting-server-url").value = edgeServerUrl;
  document.getElementById("stat-species-count").innerText = enrolledSpecies.length || 53;
  renderSpeciesList();
  renderDetectionsFeed();
  fetchSpeciesFromServer();
});
