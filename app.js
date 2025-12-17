// ====== Utilities ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

// ====== Script parsing (custom format v1) ======
// Supported:
//   # comment
//   @title: ...
//   N: narration
//   D Speaker: dialogue
function parseScript(text){
  const lines = text.split(/\r?\n/);
  const events = [];
  let titleOverride = null;

  for (let raw of lines){
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;

    if (line.startsWith("@title:")){
      titleOverride = line.slice(7).trim();
      continue;
    }

    if (line.startsWith("N:")){
      events.push({ type: "narration", text: line.slice(2).trim() });
      continue;
    }

    if (line.startsWith("D ")){
      const idx = line.indexOf(":");
      if (idx > -1){
        const speaker = line.slice(2, idx).trim();
        const textPart = line.slice(idx + 1).trim();
        events.push({ type: "dialogue", speaker, text: textPart });
        continue;
      }
    }

    // Fallback: treat unknown as narration so writing stays frictionless
    events.push({ type: "narration", text: raw });
  }

  return { titleOverride, events };
}

// ====== DOM ======
const elLog   = document.getElementById("log");
const elTitle = document.getElementById("sceneTitle");
const elSelect= document.getElementById("sceneSelect");
const elPrev  = document.getElementById("prevBtn");
const elNext  = document.getElementById("nextBtn");
const elReset = document.getElementById("resetBtn");
const elStage = document.getElementById("stage");

// ====== State ======
let manifest = null;

let current = {
  treeId: null,
  limbId: null,
  leafId: null,
  sceneTitle: "",
  events: [],
  idx: 0
};

// Typewriter state that can be force-finished safely
let typing = {
  active: false,
  cancelToken: 0,
  node: null,
  fullText: ""
};

function clearLog(){
  elLog.innerHTML = "";
}

function scrollToBottom(){
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
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

async function typeInto(node, text, speedMs, token){
  typing.active = true;
  typing.node = node;
  typing.fullText = text;

  const content = node.querySelector(".content");
  content.textContent = "";

  // caret
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "█";
  node.appendChild(caret);

  for (let i = 0; i < text.length; i++){
    if (typing.cancelToken !== token) return; // cancelled
    content.textContent += text[i];
    await sleep(speedMs);
  }

  // finished normally
  caret.remove();
  typing.active = false;
  typing.node = null;
  typing.fullText = "";
}

function finishTypingIfActive(){
  if (!typing.active) return false;

  // cancel the running loop
  typing.cancelToken++;

  // force-complete current line
  const node = typing.node;
  if (node){
    const content = node.querySelector(".content");
    if (content) content.textContent = typing.fullText;

    const caret = node.querySelector(".caret");
    if (caret) caret.remove();
  }

  typing.active = false;
  typing.node = null;
  typing.fullText = "";
  return true;
}

// ====== Manifest helpers (trees/limbs/leaves) ======
function getFlatLeaves(man){
  const out = [];
  for (const tree of (man.trees ?? [])){
    for (const limb of (tree.limbs ?? [])){
      for (const leaf of (limb.leaves ?? [])){
        out.push({
          treeId: tree.id,
          treeTitle: tree.title,
          limbId: limb.id,
          limbTitle: limb.title,
          leafId: leaf.id,
          sceneTitle: leaf.title,
          file: leaf.file
        });
      }
    }
  }
  return out;
}

function buildLeafSelect(man){
  const flat = getFlatLeaves(man);
  elSelect.innerHTML = "";
  for (const s of flat){
    const opt = document.createElement("option");
    opt.value = `${s.treeId}::${s.limbId}::${s.leafId}`;
    opt.textContent = `${s.treeTitle} / ${s.limbTitle} / ${s.sceneTitle}`;
    opt.dataset.file = s.file;
    elSelect.appendChild(opt);
  }
}

function findLeafMeta(man, treeId, limbId, leafId){
  for (const tree of (man.trees ?? [])){
    if (tree.id !== treeId) continue;
    for (const limb of (tree.limbs ?? [])){
      if (limb.id !== limbId) continue;
      for (const leaf of (limb.leaves ?? [])){
        if (leaf.id !== leafId) continue;
        return { tree, limb, leaf };
      }
    }
  }
  return null;
}

function getNextLeafIdsWithinTree(man, treeId, limbId, leafId){
  // Flatten leaves for this tree only, in manifest order
  const flat = [];
  const tree = (man.trees ?? []).find(t => t.id === treeId);
  if (!tree) return null;

  for (const limb of (tree.limbs ?? [])){
    for (const leaf of (limb.leaves ?? [])){
      flat.push({ limbId: limb.id, leafId: leaf.id });
    }
  }

  const idx = flat.findIndex(x => x.limbId === limbId && x.leafId === leafId);
  if (idx < 0) return null;

  const next = flat[idx + 1];
  if (!next) return null;

  return { treeId, limbId: next.limbId, leafId: next.leafId };
}

// ====== Scene/leaf loading ======
async function loadScene(treeId, limbId, leafId){
  const meta = findLeafMeta(manifest, treeId, limbId, leafId);
  if (!meta) throw new Error("Leaf not found in manifest.");

  const res = await fetch(meta.leaf.file, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load leaf file: ${meta.leaf.file}`);
  const scriptText = await res.text();

  const parsed = parseScript(scriptText);

  current.treeId = treeId;
  current.limbId = limbId;
  current.leafId = leafId;
  current.sceneTitle = parsed.titleOverride || meta.leaf.title;
  current.events = parsed.events;
  current.idx = 0;

  elTitle.textContent = current.sceneTitle;
  clearLog();

  saveProgress();
  await renderUpToIndex(current.idx);
}

async function renderUpToIndex(targetIdx){
  clearLog();
  for (let i = 0; i < targetIdx; i++){
    const ev = current.events[i];
    if (!ev) break;

    const node = appendLineSkeleton(ev);
    const content = node.querySelector(".content");
    content.textContent = ev.text;
  }
  scrollToBottom();
}

// ====== Progress persistence ======
function saveProgress(){
  const key = "blackpages_progress_v1";
  const payload = {
    treeId: current.treeId,
    limbId: current.limbId,
    leafId: current.leafId,
    idx: current.idx
  };
  localStorage.setItem(key, JSON.stringify(payload));
}

function loadProgress(){
  const key = "blackpages_progress_v1";
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !p.treeId || !p.limbId || !p.leafId) return null;
    return p;
  } catch {
    return null;
  }
}

// ====== Navigation actions ======
async function advance(){
  // If mid-type, finish instantly (do not advance to next event in same press)
  if (finishTypingIfActive()) return;

  // End of leaf: auto-load next leaf in same tree (if any)
  if (current.idx >= current.events.length){
    const nextIds = getNextLeafIdsWithinTree(manifest, current.treeId, current.limbId, current.leafId);
    if (!nextIds) return; // stop at end of tree
    const value = `${nextIds.treeId}::${nextIds.limbId}::${nextIds.leafId}`;
    const opt = [...elSelect.options].find(o => o.value === value);
    if (opt) elSelect.value = value;
    await loadScene(nextIds.treeId, nextIds.limbId, nextIds.leafId);
    return;
  }

  const ev = current.events[current.idx];
  current.idx++;

  const node = appendLineSkeleton(ev);
  scrollToBottom();

  const token = ++typing.cancelToken;
  const speed = 18;

  await typeInto(node, ev.text, speed, token);

  // If typing was cancelled, typeInto returned early; force-complete already handled by finishTypingIfActive
  // But in case of ultra-fast double events, ensure we don't remain active.
  typing.active = false;

  saveProgress();
}

async function back(){
  // If mid-type, finish (consistent with advance)
  if (finishTypingIfActive()) return;

  current.idx = clamp(current.idx - 1, 0, current.events.length);
  saveProgress();
  await renderUpToIndex(current.idx);
}

async function restartScene(){
  finishTypingIfActive();
  current.idx = 0;
  saveProgress();
  await renderUpToIndex(current.idx);
}

// ====== Input wiring ======
function valueToIds(v){
  const [treeId, limbId, leafId] = v.split("::");
  return { treeId, limbId, leafId };
}

elStage.addEventListener("click", advance);

elPrev.addEventListener("click", back);
elNext.addEventListener("click", advance);
elReset.addEventListener("click", restartScene);

document.addEventListener("keydown", async (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); await back(); }
  if (e.key === "ArrowRight") { e.preventDefault(); await advance(); }
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); await advance(); }
  if (e.key.toLowerCase() === "r") { e.preventDefault(); await restartScene(); }
});

elSelect.addEventListener("change", async () => {
  finishTypingIfActive();
  const ids = valueToIds(elSelect.value);
  await loadScene(ids.treeId, ids.limbId, ids.leafId);
});

// ====== Boot ======
(async function init(){
  const res = await fetch("forest/manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load forest/manifest.json");
  manifest = await res.json();

  buildLeafSelect(manifest);

  const saved = loadProgress();
  if (saved){
    const value = `${saved.treeId}::${saved.limbId}::${saved.leafId}`;
    const opt = [...elSelect.options].find(o => o.value === value);
    if (opt){
      elSelect.value = value;
      await loadScene(saved.treeId, saved.limbId, saved.leafId);
      current.idx = clamp(saved.idx ?? 0, 0, current.events.length);
      await renderUpToIndex(current.idx);
      return;
    }
  }

  const first = elSelect.options[0];
  if (first){
    const ids = valueToIds(first.value);
    await loadScene(ids.treeId, ids.limbId, ids.leafId);
  }
})().catch(err => {
  console.error(err);
  // Render a minimal error line so the page doesn't look "blank"
  const div = document.createElement("div");
  div.className = "line narration";
  div.textContent = "ERROR: " + (err?.message || String(err));
  elLog.appendChild(div);
});
