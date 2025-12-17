// ====== Utilities ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

// ====== Script parsing ======
function parseScript(text){
  const lines = text.split(/\r?\n/);
  const events = [];
  let titleOverride = null;

  for (let raw of lines){
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;

    // Directives
    if (line.startsWith("@title:")){
      titleOverride = line.slice(7).trim();
      continue;
    }
    // Narration: N: ...
    if (line.startsWith("N:")){
      events.push({ type: "narration", text: line.slice(2).trim() });
      continue;
    }

    // Dialogue: D Name: ...
    if (line.startsWith("D ")){
      // Find first ":" which separates speaker and text
      const idx = line.indexOf(":");
      if (idx > -1){
        const left = line.slice(2, idx).trim(); // after "D "
        const textPart = line.slice(idx + 1).trim();
        events.push({ type: "dialogue", speaker: left, text: textPart });
        continue;
      }
    }

    // Fallback: treat unknown as narration (keeps you writing fast)
    events.push({ type: "narration", text: raw });
  }

  return { titleOverride, events };
}

// ====== Rendering + state ======
const elLog = document.getElementById("log");
const elTitle = document.getElementById("sceneTitle");
const elSelect = document.getElementById("sceneSelect");
const elPrev = document.getElementById("prevBtn");
const elNext = document.getElementById("nextBtn");
const elReset = document.getElementById("resetBtn");
const elStage = document.getElementById("stage");

let manifest = null;
let current = {
  storyId: null,
  arcId: null,
  sceneId: null,
  sceneTitle: "",
  events: [],
  idx: 0
};

let typing = {
  active: false,
  cancelToken: 0,
  node: null,
  fullText: ""
};

function clearLog(){
  elLog.innerHTML = "";
}

function appendLineSkeleton(ev){
  const div = document.createElement("div");
  div.className = `line ${ev.type}`;

  if (ev.type === "dialogue"){
    const speaker = document.createElement("span");
    speaker.className = "speaker";
    speaker.textContent = ev.speaker;

    const colon = document.createElement("span");
    colon.className = "colon";
    colon.textContent = ": ";

    const content = document.createElement("span");
    content.className = "content";
    content.textContent = "";

    div.appendChild(speaker);
    div.appendChild(colon);
    div.appendChild(content);
  } else {
    const content = document.createElement("span");
    content.className = "content";
    content.textContent = "";
    div.appendChild(content);
  }

  elLog.appendChild(div);
  return div;
}

function scrollToBottom(){
  // Smooth-ish without fighting user too hard
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

async function typeInto(node, text, speedMs, token){
  typing.active = true;
  const content = node.querySelector(".content");
  content.textContent = "";

  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "█";
  node.appendChild(caret);

  for (let i = 0; i < text.length; i++){
    if (typing.cancelToken !== token){
      // cancelled: clean up and let caller decide what to do
      if (caret && caret.isConnected) caret.remove();
      typing.active = false;
      return;
    }
    content.textContent += text[i];
    await sleep(speedMs);
  }

  caret.remove();
  typing.active = false;
}

function finishCurrentLine(){
  if (!typing.active || !typing.node) return false;
  // Stop the typewriter loop
  typing.cancelToken++;

  const content = typing.node.querySelector(".content");
  if (content) content.textContent = typing.fullText;
  const caret = typing.node.querySelector(".caret");
  if (caret) caret.remove();

  typing.active = false;
  return true;
}


async function maybeLoadNextScene(){
  if (!manifest || !current.storyId) return;

  // Flatten scenes for the current story (tree), in manifest order.
  const story = manifest.trees.find(t => t.id === current.storyId);
  if (!story) return;

  const scenes = [];
  for (const limb of story.limbs){
    for (const leaf of limb.leaves){
      scenes.push({ storyId: story.id, arcId: limb.id, sceneId: leaf.id });
    }
  }

  const here = scenes.findIndex(s => s.storyId === current.storyId && s.arcId === current.arcId && s.sceneId === current.sceneId);
  if (here < 0) return;

  const next = scenes[here + 1];
  if (!next){
    // End of story: do not auto-load the next story.
    return;
  }

  const value = `${next.storyId}::${next.arcId}::${next.sceneId}`;
  const opt = [...elSelect.options].find(o => o.value === value);
  if (opt) elSelect.value = value;

  await loadScene(next.storyId, next.arcId, next.sceneId);
}

function getFlatScenes(man){
  const out = [];
  for (const tree of man.trees){
    for (const limb of tree.limbs){
      for (const leaf of limb.leaves){
        out.push({
          storyId: tree.id,
          storyTitle: tree.title,
          arcId: limb.id,
          arcTitle: limb.title,
          sceneId: leaf.id,
          sceneTitle: leaf.title,
          file: leaf.file
        });
      }
    }
  }
  return out;
}

function buildSceneSelect(man){
  const flat = getFlatScenes(man);
  elSelect.innerHTML = "";
  for (const s of flat){
    const opt = document.createElement("option");
    opt.value = `${s.storyId}::${s.arcId}::${s.sceneId}`;
    opt.textContent = `${s.storyTitle} / ${s.arcTitle} / ${s.sceneTitle}`;
    opt.dataset.file = s.file;
    elSelect.appendChild(opt);
  }
}

function findSceneMeta(man, storyId, arcId, sceneId){
  for (const tree of man.trees){
    if (tree.id !== storyId) continue;
    for (const limb of tree.limbs){
      if (limb.id !== arcId) continue;
      for (const leaf of limb.leaves){
        if (leaf.id !== sceneId) continue;
        return { tree, limb, leaf };
      }
    }
  }
  return null;
}

async function loadScene(storyId, arcId, sceneId){
  const meta = findSceneMeta(manifest, storyId, arcId, sceneId);
  if (!meta) throw new Error("Scene not found in manifest.");

  const res = await fetch(meta.leaf.file, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load leaf file: ${meta.leaf.file}`);
  const scriptText = await res.text();

  const parsed = parseScript(scriptText);

  current.storyId = storyId;
  current.arcId = arcId;
  current.sceneId = sceneId;
  current.sceneTitle = parsed.titleOverride || meta.leaf.title;
  current.events = parsed.events;
  current.idx = 0;

  elTitle.textContent = current.sceneTitle;
  clearLog();

  saveProgress();
  await renderUpToIndex(current.idx);
}

async function renderUpToIndex(targetIdx){
  // Render events [0..targetIdx-1] instantly, then stop (idx points to next event)
  clearLog();
  for (let i = 0; i < targetIdx; i++){
    const ev = current.events[i];
    if (!ev) break;

    const node = appendLineSkeleton(ev);
    const content = node.querySelector(".content");
    content.textContent = (ev.type === "dialogue") ? ev.text : ev.text;
  }
  scrollToBottom();
}

async function advance(){
  // If typing, complete current line instantly
  if (typing.active){
    finishCurrentLine();
    return;
  }

  if (current.idx >= current.events.length){
    await maybeLoadNextScene();
    return;
  }

  const ev = current.events[current.idx];
  current.idx++;

  const node = appendLineSkeleton(ev);
  scrollToBottom();

  const token = ++typing.cancelToken;
  const speed = 18; // ms per char; tweak later or make configurable

  // Track the in-progress line so we can instantly complete it on input
  typing.node = node;
  typing.fullText = (ev.type === \"dialogue\") ? ev.text : ev.text;

  // If user cancels typing mid-way, we want to instantly finish the line
  let cancelled = false;
  const cancelWatcher = setInterval(() => {
    if (typing.cancelToken !== token){
      cancelled = true;
      clearInterval(cancelWatcher);
    }
  }, 10);

  await typeInto(node, (ev.type === "dialogue") ? ev.text : ev.text, speed, token);
  clearInterval(cancelWatcher);

  if (cancelled){
    // Force complete content
    const content = node.querySelector(".content");
    content.textContent = (ev.type === "dialogue") ? ev.text : ev.text;
    const caret = node.querySelector(".caret");
    if (caret) caret.remove();
    typing.active = false;
  }

  saveProgress();
}

async function back(){
  if (typing.active){
    // If mid-type, treat back as "complete typing" rather than going back
    finishCurrentLine();
    return;
  }
  current.idx = clamp(current.idx - 1, 0, current.events.length);
  saveProgress();
  await renderUpToIndex(current.idx);
}

async function restartScene(){
  typing.cancelToken++;
  current.idx = 0;
  saveProgress();
  await renderUpToIndex(current.idx);
}

function saveProgress(){
  const key = "textvn_progress_v1";
  const payload = {
    storyId: current.storyId,
    arcId: current.arcId,
    sceneId: current.sceneId,
    idx: current.idx
  };
  localStorage.setItem(key, JSON.stringify(payload));
}

function loadProgress(){
  const key = "textvn_progress_v1";
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !p.storyId || !p.arcId || !p.sceneId) return null;
    return p;
  } catch {
    return null;
  }
}

// ====== Input wiring ======
function sceneValueToIds(v){
  const [storyId, arcId, sceneId] = v.split("::");
  return { storyId, arcId, sceneId };
}

elStage.addEventListener("click", async () => {
  // If typing, cancel token so render completes quickly
  if (typing.active){
    finishCurrentLine();
    return;
  }
  await advance();
});

elPrev.addEventListener("click", back);
elNext.addEventListener("click", async () => {
  if (typing.active){
    finishCurrentLine();
    return;
  }
  await advance();
});
elReset.addEventListener("click", restartScene);

document.addEventListener("keydown", async (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); await back(); }
  if (e.key === "ArrowRight") { e.preventDefault(); if (typing.active){ typing.cancelToken++; } else { await advance(); } }
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (typing.active){ typing.cancelToken++; } else { await advance(); } }
  if (e.key.toLowerCase() === "r") { e.preventDefault(); await restartScene(); }
});

elSelect.addEventListener("change", async () => {
  const ids = sceneValueToIds(elSelect.value);
  await loadScene(ids.storyId, ids.arcId, ids.sceneId);
});

// ====== Boot ======
(async function init(){
  const res = await fetch("forest/manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load forest/manifest.json");
  manifest = await res.json();

  buildSceneSelect(manifest);

  const saved = loadProgress();
  if (saved){
    // Try to select saved scene
    const value = `${saved.storyId}::${saved.arcId}::${saved.sceneId}`;
    const opt = [...elSelect.options].find(o => o.value === value);
    if (opt){
      elSelect.value = value;
      await loadScene(saved.storyId, saved.arcId, saved.sceneId);
      // Re-render to saved idx
      current.idx = clamp(saved.idx ?? 0, 0, current.events.length);
      await renderUpToIndex(current.idx);
      return;
    }
  }

  // Default to first scene
  const first = elSelect.options[0];
  if (first){
    const ids = sceneValueToIds(first.value);
    await loadScene(ids.storyId, ids.arcId, ids.sceneId);
  }
})();

