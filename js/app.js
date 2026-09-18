import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot,
  collection, addDoc, query, where, orderBy, serverTimestamp,
  runTransaction, Timestamp, deleteField
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// ---------------------------------------------------------------
// Firebase setup
// ---------------------------------------------------------------
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

let myUid = null;
let gameCode = null;
let isHost = false;

// Local cache of the latest snapshots, so the render loop and timer
// tick can read current state without re-fetching.
let gameData = null;
let myPlayerData = null;
let myRoleData = null;
let playersCache = {};      // uid -> player doc
let nightActionCache = null;

let hasHandledMurderPending = false;
let hasHandledRecruitPrompt = false;
let recruitCountdownInterval = null;
let pendingHostName = null; // name entered on the join screen, used once setup is submitted

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

function openOverlay(id) { $(id).classList.remove("hidden"); }
function closeOverlay(id) { $(id).classList.add("hidden"); }

function formatTime(msRemaining) {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function randomCode() {
  const letters = "BCDFGHJKLMNPQRSTVWXYZ"; // no vowels -> no accidental words, no ambiguity
  let out = "";
  for (let i = 0; i < 5; i++) out += letters[Math.floor(Math.random() * letters.length)];
  return out;
}

function gameRef(code) { return doc(db, "games", code); }
function playersCol(code) { return collection(db, "games", code, "players"); }
function playerRef(code, uid) { return doc(db, "games", code, "players", uid); }
function roleRef(code, uid) { return doc(db, "games", code, "playerRoles", uid); }
function rolesCol(code) { return collection(db, "games", code, "playerRoles"); }
function nightActionRef(code) { return doc(db, "games", code, "nightAction", "current"); }
function chatCol(code) { return collection(db, "games", code, "traitorChat"); }
function eliminatedCol(code) { return collection(db, "games", code, "eliminatedLog"); }

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------
function ensureSignedIn() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        myUid = user.uid;
        resolve(user);
      } else {
        signInAnonymously(auth).catch((err) => {
          console.error("Anonymous sign-in failed", err);
          $("join-error").textContent = "Could not connect. Check your internet connection and reload.";
        });
      }
    });
  });
}

// ---------------------------------------------------------------
// Join screen
// ---------------------------------------------------------------
let joinMode = "create";

$("join-mode-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  joinMode = btn.dataset.mode;
  document.querySelectorAll("#join-mode-toggle button").forEach(b => b.classList.toggle("active", b === btn));
  $("field-game-code").classList.toggle("hidden", joinMode === "create");
  $("btn-join-submit").textContent = joinMode === "create" ? "Continue" : "Enter the castle";
});

$("btn-join-submit").addEventListener("click", async () => {
  const name = $("input-name").value.trim();
  $("join-error").textContent = "";
  if (!name) { $("join-error").textContent = "Enter your name first."; return; }

  await ensureSignedIn();

  try {
    if (joinMode === "create") {
      // Settings come first, before any code exists — see btn-create-game below.
      pendingHostName = name;
      showView("view-host-setup");
    } else {
      const code = $("input-code").value.trim().toUpperCase();
      if (!code) { $("join-error").textContent = "Enter the game code."; return; }
      await joinGame(code, name);
    }
  } catch (err) {
    console.error(err);
    $("join-error").textContent = err.message || "Something went wrong. Try again.";
  }
});

// ---------------------------------------------------------------
// Host setup screen — collects settings BEFORE a game/code exists
// ---------------------------------------------------------------
let noResponseDefault = "decline";
$("toggle-noresponse").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-val]");
  if (!btn) return;
  noResponseDefault = btn.dataset.val;
  document.querySelectorAll("#toggle-noresponse button").forEach(b => b.classList.toggle("active", b === btn));
});

$("btn-create-game").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  const numTraitors = parseInt($("set-numTraitors").value, 10);
  const maxTraitors = parseInt($("set-maxTraitors").value, 10);
  const investigationMins = parseInt($("set-investigationMins").value, 10);
  const banishmentMins = parseInt($("set-banishmentMins").value, 10);
  const nightMins = parseInt($("set-nightMins").value, 10);
  const endgameThreshold = parseInt($("set-endgameThreshold").value, 10);

  if (numTraitors < 1) { $("setup-error").textContent = "You need at least 1 starting traitor."; return; }
  if (maxTraitors < numTraitors) { $("setup-error").textContent = "Max traitors can't be less than starting traitors."; return; }
  if (endgameThreshold < 2) { $("setup-error").textContent = "Endgame threshold must be at least 2."; return; }
  if (investigationMins < 1 || banishmentMins < 1 || nightMins < 1) {
    $("setup-error").textContent = "Phase lengths must be at least 1 minute."; return;
  }

  try {
    await createGame({
      numTraitors, maxTraitors, investigationMins, banishmentMins,
      nightMins, endgameThreshold, noResponseDefault
    });
  } catch (err) {
    console.error(err);
    $("setup-error").textContent = err.message || "Something went wrong. Try again.";
  }
});

async function createGame(settings) {
  const code = randomCode();
  await setDoc(gameRef(code), {
    status: "lobby",
    hostUid: myUid,
    roundNumber: 0,
    phaseEndsAt: null,
    activeTraitorCount: 0,
    activeFaithfulCount: 0,
    pendingRecruitment: null,
    nightResolved: false,
    settings,
    createdAt: serverTimestamp()
  });
  await setDoc(playerRef(code, myUid), {
    name: pendingHostName, alive: true, eliminatedInfo: null, joinedAt: serverTimestamp()
  });
  enterGame(code, true);
}

async function joinGame(code, name) {
  const snap = await getDoc(gameRef(code));
  if (!snap.exists()) throw new Error("No game found with that code.");
  if (snap.data().status !== "lobby") throw new Error("That game has already started.");
  await setDoc(playerRef(code, myUid), {
    name, alive: true, eliminatedInfo: null, joinedAt: serverTimestamp()
  });
  enterGame(code, snap.data().hostUid === myUid);
}

function enterGame(code, host) {
  gameCode = code;
  isHost = host;
  localStorage.setItem("traitors_last_code", code);
  attachListeners(code);
}

// ---------------------------------------------------------------
// Firestore listeners
// ---------------------------------------------------------------
function attachListeners(code) {
  onSnapshot(gameRef(code), (snap) => {
    if (!snap.exists()) return;
    gameData = snap.data();
    render();
  });

  onSnapshot(playersCol(code), (snap) => {
    playersCache = {};
    snap.forEach(d => { playersCache[d.id] = d.data(); });
    myPlayerData = playersCache[myUid] || null;
    renderPlayerLists();
    checkMyEliminationState();
  });

  onSnapshot(roleRef(code, myUid), (snap) => {
    myRoleData = snap.exists() ? snap.data() : null;
    render();
    maybeSubscribeChat();
  }, () => { /* not created yet before game starts - ignore */ });

  onSnapshot(nightActionRef(code), (snap) => {
    nightActionCache = snap.exists() ? snap.data() : null;
    renderNightVictimList();
  }, () => {});

  onSnapshot(query(eliminatedCol(code), orderBy("createdAt", "asc")), (snap) => {
    const items = [];
    snap.forEach(d => items.push(d.data()));
    renderEliminatedList(items);
  });

  startTicker();
}

let chatUnsub = null;
function maybeSubscribeChat() {
  if (myRoleData?.role === "traitor" && !chatUnsub) {
    chatUnsub = onSnapshot(
      query(chatCol(gameCode), orderBy("createdAt", "asc")),
      (snap) => {
        const msgs = [];
        snap.forEach(d => msgs.push(d.data()));
        renderChat(msgs);
      },
      (err) => {
        // Most likely cause: this client's playerRoles doc doesn't (yet, or
        // no longer) say role === "traitor" from the server's point of
        // view, so the security rules reject the read — e.g. stale local
        // state, or this really is a Faithful's browser.
        console.error("Traitor chat subscription failed:", err.code, err.message);
      }
    );
  }
}

// ---------------------------------------------------------------
// Master render — decides which screen/panel to show
// ---------------------------------------------------------------
function render() {
  if (!gameData) return;

  if (gameData.status === "lobby") {
    renderLobby();
    showView("view-lobby");
    return;
  }

  showView("view-home");
  renderHomeHeader();
  renderPlayerLists(); // re-run on every game-state change, not just player-doc changes

  const panels = [
    "phase-body-investigation", "phase-body-banishment",
    "phase-body-night-faithful", "phase-body-night-traitor", "phase-body-endgame"
  ];
  panels.forEach(p => $(p).classList.add("hidden"));

  if (gameData.status === "investigation") {
    $("phase-body-investigation").classList.remove("hidden");
  } else if (gameData.status === "banishment") {
    $("phase-body-banishment").classList.remove("hidden");
  } else if (gameData.status === "night") {
    if (myRoleData?.role === "traitor" && myPlayerData?.alive) {
      $("phase-body-night-traitor").classList.remove("hidden");
      const lone = gameData.activeTraitorCount === 1;
      $("night-traitor-heading").textContent = lone ? "Choose who to recruit" : "Choose who to murder";
      $("night-traitor-sub").textContent = lone
        ? "You're the last Traitor. You must recruit a new partner tonight — tap a name below."
        : "Agree with your fellow traitors, then tap a name below. You can change your mind until the phase ends.";
      renderNightVictimList();
      refreshTraitorUidSet().then(() => {
        renderNightVictimList(); // re-render with the accurate traitor set once it's loaded
        const names = getFellowTraitorNames();
        $("night-fellow-traitors").textContent = lone
          ? "You're on your own tonight — recruit wisely."
          : (names.length ? `Fellow traitors: ${names.join(", ")}` : "");
      });
    } else {
      $("phase-body-night-faithful").classList.remove("hidden");
    }
  } else if (gameData.status === "endgame") {
    $("phase-body-endgame").classList.remove("hidden");
  }
}

function renderHomeHeader() {
  const names = { investigation: "Investigation", banishment: "Banishment", night: "Night phase", endgame: "Endgame" };
  $("home-phase-name").textContent = (names[gameData.status] || "").toUpperCase();
  let roundText = gameData.status === "endgame" ? "Final table" : `Round ${gameData.roundNumber}`;
  if (myPlayerData && myPlayerData.alive === false) roundText += " · You are eliminated, spectating";
  $("home-round").textContent = roundText;
  $("home-timer").classList.toggle("hidden", gameData.status === "endgame" || !gameData.phaseEndsAt);

  $("btn-open-banishment").classList.toggle("hidden", myPlayerData?.alive === false);
}

function renderLobby() {
  $("lobby-code").textContent = gameCode;
  const list = Object.entries(playersCache)
    .sort((a, b) => (a[1].joinedAt?.seconds || 0) - (b[1].joinedAt?.seconds || 0));
  $("lobby-player-count").textContent = list.length;
  $("lobby-player-list").innerHTML = list.map(([uid, p]) =>
    `<li><span class="name">${escapeHtml(p.name)}</span>${uid === gameData.hostUid ? '<span class="tag">Host</span>' : ""}</li>`
  ).join("");

  $("lobby-host-start").classList.toggle("hidden", !isHost);
  $("lobby-waiting-notice").classList.toggle("hidden", isHost);
}

function renderPlayerLists() {
  if (!gameData || gameData.status === "lobby") return;
  const alive = Object.entries(playersCache).filter(([, p]) => p.alive);
  $("active-list").innerHTML = alive.map(([, p]) =>
    `<li><span class="name">${escapeHtml(p.name)}</span></li>`
  ).join("") || `<li><span class="name">No one left.</span></li>`;
}

function renderEliminatedList(items) {
  $("eliminated-empty").classList.toggle("hidden", items.length > 0);
  $("eliminated-list").innerHTML = items.map(it => `
    <li class="eliminated">
      <span class="name">${escapeHtml(it.name)}</span>
      <span>
        <span class="tag ${it.method === "murdered" ? "tag-murdered" : "tag-banished"}">${it.method === "murdered" ? "Murdered" : "Banished"}</span>
        <span class="tag ${it.role === "traitor" ? "tag-traitor" : "tag-faithful"}">${it.role === "traitor" ? "Traitor" : "Faithful"}</span>
      </span>
    </li>`).join("");
}

function renderNightVictimList() {
  if (!gameData || gameData.status !== "night") return;
  if (myRoleData?.role !== "traitor" || !myPlayerData?.alive) return;

  const lone = gameData.activeTraitorCount === 1;
  const currentPick = lone
    ? gameData.pendingRecruitment?.targetUid
    : nightActionCache?.proposedVictimUid;

  const candidates = Object.entries(playersCache).filter(([uid, p]) => {
    if (!p.alive) return false;
    if (uid === myUid) return false; // never target yourself
    if (knownTraitorUids.has(uid)) return false; // murder and recruit both only target Faithfuls
    return true;
  });

  $("night-victim-list").innerHTML = candidates.map(([uid, p]) => `
    <button class="tap-item ${currentPick === uid ? "selected" : ""}" data-uid="${uid}">${escapeHtml(p.name)}</button>
  `).join("");

  $("night-victim-list").querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const uid = btn.dataset.uid;
      if (lone) proposeRecruit(uid);
      else proposeVictim(uid);
    });
  });
}

function renderChat(msgs) {
  const log = $("chat-log");
  log.innerHTML = msgs.map(m => `
    <div class="chat-bubble ${m.senderUid === myUid ? "mine" : ""}">
      <span class="sender">${escapeHtml(m.senderName)}</span>${escapeHtml(m.text)}
    </div>`).join("");
  log.scrollTop = log.scrollHeight;
}

// A traitor's client is allowed (by the security rules) to read every
// player's role, since it doesn't depend on which document is being read —
// only on the requester already being a traitor. Faithfuls never call this.
// Cached per night-phase/reveal entry and reused by both the victim/recruit
// picker (to exclude traitors) and the "fellow traitors" displays.
let knownTraitorUids = new Set();

async function refreshTraitorUidSet() {
  try {
    const snap = await getDocs(rolesCol(gameCode));
    const s = new Set();
    snap.forEach(d => { if (d.data().role === "traitor") s.add(d.id); });
    knownTraitorUids = s;
  } catch (err) {
    console.error("Could not load traitor roster", err);
  }
  return knownTraitorUids;
}

function getFellowTraitorNames() {
  return [...knownTraitorUids]
    .filter(uid => uid !== myUid)
    .map(uid => playersCache[uid]?.name || "Unknown");
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------
// Waiting room: host starts the game once everyone's joined
// ---------------------------------------------------------------
$("btn-start-game").addEventListener("click", async () => {
  $("lobby-error").textContent = "";
  const { numTraitors, endgameThreshold, investigationMins } = gameData.settings;

  const playerUids = Object.keys(playersCache);
  if (playerUids.length < endgameThreshold + 1) {
    $("lobby-error").textContent = `You need more players than the endgame threshold (${endgameThreshold}).`;
    return;
  }
  if (numTraitors >= playerUids.length) {
    $("lobby-error").textContent = "Traitor count must be less than the number of players who've joined.";
    return;
  }

  const shuffled = [...playerUids].sort(() => Math.random() - 0.5);
  const traitorUids = new Set(shuffled.slice(0, numTraitors));

  await Promise.all(playerUids.map(uid =>
    setDoc(roleRef(gameCode, uid), { role: traitorUids.has(uid) ? "traitor" : "faithful" })
  ));

  await updateDoc(gameRef(gameCode), {
    status: "investigation",
    roundNumber: 1,
    phaseEndsAt: Timestamp.fromDate(new Date(Date.now() + investigationMins * 60000)),
    activeTraitorCount: numTraitors,
    activeFaithfulCount: playerUids.length - numTraitors,
    pendingRecruitment: null,
    nightResolved: false
  });
});

// ---------------------------------------------------------------
// Timer / phase transitions
// ---------------------------------------------------------------
function startTicker() {
  setInterval(tick, 500);
}

async function tick() {
  if (!gameData || !gameCode) return;
  const el = $("home-timer");

  if (gameData.phaseEndsAt && (gameData.status === "investigation" || gameData.status === "banishment" || gameData.status === "night")) {
    const endsAtMs = gameData.phaseEndsAt.toMillis ? gameData.phaseEndsAt.toMillis() : gameData.phaseEndsAt.seconds * 1000;
    const remaining = endsAtMs - Date.now();
    if (el && !el.classList.contains("hidden")) el.textContent = formatTime(remaining);

    if (remaining <= 0) {
      if (gameData.status === "investigation") {
        await advancePhase("investigation", "banishment", gameData.settings.banishmentMins);
      } else if (gameData.status === "night") {
        await resolveNightTimeout();
      }
      // banishment has no automatic timeout transition — it waits for a
      // player to record the result. The timer just runs out visually.
    }
  }
}

async function advancePhase(fromStatus, toStatus, durationMins) {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef(gameCode));
      const g = snap.data();
      if (g.status !== fromStatus) return; // someone else already advanced it
      tx.update(gameRef(gameCode), {
        status: toStatus,
        phaseEndsAt: durationMins != null
          ? Timestamp.fromDate(new Date(Date.now() + durationMins * 60000))
          : null
      });
    });
  } catch (err) { console.error("advancePhase failed", err); }
}

// ---------------------------------------------------------------
// Banishment
// ---------------------------------------------------------------
$("btn-open-banishment").addEventListener("click", () => {
  const alive = Object.entries(playersCache).filter(([, p]) => p.alive);
  $("banishment-list").innerHTML = alive.map(([uid, p]) =>
    `<button class="tap-item" data-uid="${uid}">${escapeHtml(p.name)}</button>`
  ).join("");
  $("banishment-list").querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => submitBanishment(btn.dataset.uid));
  });
  openOverlay("overlay-banishment");
});
$("close-banishment").addEventListener("click", () => closeOverlay("overlay-banishment"));

async function submitBanishment(targetUid) {
  closeOverlay("overlay-banishment");
  // Mark as pending; the banished player's own client finalizes the role
  // reveal (see checkMyEliminationState) since only they can read their
  // own secret role under the security rules.
  try {
    await updateDoc(playerRef(gameCode, targetUid), {
      alive: false,
      eliminatedInfo: { method: "banished", round: gameData.roundNumber, pending: true }
    });
  } catch (err) { console.error(err); }
}

// ---------------------------------------------------------------
// Night phase — traitor actions
// ---------------------------------------------------------------
async function proposeVictim(uid) {
  await setDoc(nightActionRef(gameCode), {
    proposedVictimUid: uid, updatedByUid: myUid, updatedAt: serverTimestamp()
  });
}

async function proposeRecruit(uid) {
  await updateDoc(gameRef(gameCode), {
    pendingRecruitment: {
      targetUid: uid,
      deadline: gameData.phaseEndsAt
    }
  });
}

$("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await addDoc(chatCol(gameCode), {
      senderUid: myUid,
      senderName: myPlayerData?.name || "Traitor",
      text,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.error("Sending chat message failed:", err.code, err.message);
    input.value = text; // give it back so it isn't silently lost
  }
});

// ---------------------------------------------------------------
// Night phase — generic timeout (no victim chosen / nothing to resolve)
// ---------------------------------------------------------------
async function resolveNightTimeout() {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef(gameCode));
      const g = snap.data();
      if (g.status !== "night") return;

      const lone = g.activeTraitorCount === 1;

      if (lone) {
        // If a recruit target was chosen, that target's own client handles
        // resolution (accept/decline). If nobody was ever chosen, just
        // move the game on — the round is wasted, nobody is eliminated.
        if (g.pendingRecruitment) return;
        tx.update(gameRef(gameCode), {
          status: "investigation",
          roundNumber: g.roundNumber + 1,
          phaseEndsAt: Timestamp.fromDate(new Date(Date.now() + g.settings.investigationMins * 60000))
        });
        return;
      }

      // Two or more traitors: if a victim was chosen, mark them pending —
      // their own client will finalize the reveal and advance the game.
      const victimUid = nightActionCache?.proposedVictimUid;
      if (!victimUid) {
        tx.update(gameRef(gameCode), {
          status: "investigation",
          roundNumber: g.roundNumber + 1,
          phaseEndsAt: Timestamp.fromDate(new Date(Date.now() + g.settings.investigationMins * 60000))
        });
        return;
      }
      const victimSnap = await tx.get(playerRef(gameCode, victimUid));
      if (!victimSnap.exists() || victimSnap.data().alive === false) return; // already handled
      tx.update(playerRef(gameCode, victimUid), {
        alive: false,
        eliminatedInfo: { method: "murdered", round: g.roundNumber, pending: true }
      });
    });
  } catch (err) { console.error("resolveNightTimeout failed", err); }
}

// ---------------------------------------------------------------
// Self-elimination handling: reveal my own role, log it, advance game.
// This runs on the eliminated player's own device (banished OR murdered),
// because only they (or a fellow traitor) can read their secret role.
// ---------------------------------------------------------------
function checkMyEliminationState() {
  if (!myPlayerData) return;
  if (myPlayerData.alive === false && myPlayerData.eliminatedInfo?.pending && !hasHandledMurderPending) {
    hasHandledMurderPending = true;
    finalizeMyElimination(myPlayerData.eliminatedInfo.method);
  }
  if (myPlayerData.alive === false && myPlayerData.eliminatedInfo?.pending === false) {
    if (myPlayerData.eliminatedInfo.method === "murdered") {
      $("reveal-murdered").classList.remove("hidden");
    }
  }
}

async function finalizeMyElimination(method) {
  await ensureSignedIn();
  const roleSnap = await getDoc(roleRef(gameCode, myUid));
  const role = roleSnap.exists() ? roleSnap.data().role : "faithful";

  // Guard against a duplicate log entry if this device retries after a
  // refresh that happened mid-way through finalizing (e.g. the log entry
  // was written but the tab closed before pending was cleared).
  const existing = await getDocs(query(eliminatedCol(gameCode), where("uid", "==", myUid)));
  if (existing.empty) {
    await addDoc(eliminatedCol(gameCode), {
      uid: myUid, name: myPlayerData.name, role, method,
      round: myPlayerData.eliminatedInfo.round, createdAt: serverTimestamp()
    });
  }

  await updateDoc(playerRef(gameCode, myUid), {
    eliminatedInfo: { method, round: myPlayerData.eliminatedInfo.round, pending: false }
  });

  if (method === "murdered") {
    $("reveal-murdered").classList.remove("hidden");
  }

  // Advance the shared game state now that we know the outcome.
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef(gameCode));
      const g = snap.data();
      const nextTraitors = role === "traitor" ? g.activeTraitorCount - 1 : g.activeTraitorCount;
      const nextFaithfuls = role === "faithful" ? g.activeFaithfulCount - 1 : g.activeFaithfulCount;
      const totalAlive = nextTraitors + nextFaithfuls;

      const isBanishment = method === "banished";
      const update = { activeTraitorCount: nextTraitors, activeFaithfulCount: nextFaithfuls };

      if (totalAlive <= g.settings.endgameThreshold) {
        update.status = "endgame";
        update.phaseEndsAt = null;
        update.pendingRecruitment = null;
      } else if (isBanishment) {
        update.status = "night";
        update.phaseEndsAt = Timestamp.fromDate(new Date(Date.now() + g.settings.nightMins * 60000));
        update.pendingRecruitment = null;
      } else {
        update.status = "investigation";
        update.roundNumber = g.roundNumber + 1;
        update.phaseEndsAt = Timestamp.fromDate(new Date(Date.now() + g.settings.investigationMins * 60000));
        update.pendingRecruitment = null;
      }
      tx.update(gameRef(gameCode), update);
    });
  } catch (err) { console.error("advance-after-elimination failed", err); }
}

// ---------------------------------------------------------------
// Recruitment prompt (target's own device)
// ---------------------------------------------------------------
function checkRecruitmentPrompt() {
  if (!gameData || gameData.status !== "night") return;
  const rec = gameData.pendingRecruitment;
  if (rec && rec.targetUid === myUid && myPlayerData?.alive && !hasHandledRecruitPrompt) {
    hasHandledRecruitPrompt = true;
    openRecruitPrompt(rec);
  }
  if ((!rec || rec.targetUid !== myUid) && hasHandledRecruitPrompt) {
    hasHandledRecruitPrompt = false;
  }
}

function openRecruitPrompt(rec) {
  $("reveal-recruit").classList.remove("hidden");
  const deadlineMs = rec.deadline.toMillis ? rec.deadline.toMillis() : rec.deadline.seconds * 1000;

  if (recruitCountdownInterval) clearInterval(recruitCountdownInterval);
  recruitCountdownInterval = setInterval(() => {
    const remaining = deadlineMs - Date.now();
    $("recruit-timer").textContent = formatTime(remaining);
    if (remaining <= 0) {
      clearInterval(recruitCountdownInterval);
      $("reveal-recruit").classList.add("hidden");
      const applyDefault = gameData.settings.noResponseDefault;
      handleRecruitResponse(applyDefault === "accept");
    }
  }, 250);
}

$("btn-recruit-accept").addEventListener("click", () => {
  clearInterval(recruitCountdownInterval);
  $("reveal-recruit").classList.add("hidden");
  handleRecruitResponse(true);
});
$("btn-recruit-decline").addEventListener("click", () => {
  clearInterval(recruitCountdownInterval);
  $("reveal-recruit").classList.add("hidden");
  handleRecruitResponse(false);
});

async function handleRecruitResponse(accept) {
  if (accept) {
    await updateDoc(roleRef(gameCode, myUid), { role: "traitor" });
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(gameRef(gameCode));
        const g = snap.data();
        if (g.status !== "night") return;
        const nextTraitors = g.activeTraitorCount + 1;
        const totalAlive = nextTraitors + g.activeFaithfulCount;
        const update = { activeTraitorCount: nextTraitors, pendingRecruitment: null };
        if (totalAlive <= g.settings.endgameThreshold) {
          update.status = "endgame";
          update.phaseEndsAt = null;
        } else {
          update.status = "investigation";
          update.roundNumber = g.roundNumber + 1;
          update.phaseEndsAt = Timestamp.fromDate(new Date(Date.now() + g.settings.investigationMins * 60000));
        }
        tx.update(gameRef(gameCode), update);
      });
    } catch (err) { console.error(err); }
  } else {
    // Declining counts as an ordinary murder — identical in the log to
    // any other murder, no trace of the recruitment attempt.
    await updateDoc(playerRef(gameCode, myUid), {
      alive: false,
      eliminatedInfo: { method: "murdered", round: gameData.roundNumber, pending: true }
    });
    await updateDoc(gameRef(gameCode), { pendingRecruitment: null });
  }
}

// ---------------------------------------------------------------
// Modals: active / eliminated
// ---------------------------------------------------------------
$("btn-show-active").addEventListener("click", () => openOverlay("overlay-active"));
$("close-active").addEventListener("click", () => closeOverlay("overlay-active"));
$("btn-show-eliminated").addEventListener("click", () => openOverlay("overlay-eliminated"));
$("close-eliminated").addEventListener("click", () => closeOverlay("overlay-eliminated"));

$("btn-ack-safe").addEventListener("click", () => $("reveal-safe").classList.add("hidden"));

$("btn-new-game").addEventListener("click", () => {
  // Full reload is the simplest reliable way to clear all in-memory state
  // and every one-time-reveal flag, not just the stored game code.
  if (gameCode) localStorage.removeItem(`traitors_role_seen_${gameCode}`);
  localStorage.removeItem("traitors_last_code");
  location.reload();
});

// ---------------------------------------------------------------
// Initial role reveal — the moment a player first learns their role,
// right as round 1 begins. Traitors also get told who their fellow
// traitors are, since they'd otherwise have no way to know.
// ---------------------------------------------------------------
function maybeShowInitialRoleReveal() {
  if (!gameData || gameData.status === "lobby") return;
  if (!myRoleData) return; // role not loaded yet
  if (myPlayerData && myPlayerData.alive === false) return; // already out — don't resurface this on reconnect

  // Persisted (not just an in-memory flag) so a page refresh mid-game
  // can't cause this to fire a second time on top of other screens.
  const seenKey = `traitors_role_seen_${gameCode}`;
  if (localStorage.getItem(seenKey)) return;
  localStorage.setItem(seenKey, "1");

  if (myRoleData.role === "traitor") {
    $("role-reveal-icon").textContent = "🗡️";
    $("role-reveal-heading").textContent = "You are a Traitor";
    $("role-reveal-sub").textContent = "Murder by night, blend in by day. Keep it secret.";
    $("role-reveal-fellows").classList.remove("hidden");
    $("role-reveal-fellows").textContent = "Loading your fellow traitors…";
    refreshTraitorUidSet().then(() => {
      const names = getFellowTraitorNames();
      $("role-reveal-fellows").textContent = names.length
        ? `Your fellow traitors: ${names.join(", ")}`
        : "You're the only Traitor — for now.";
    });
  } else {
    $("role-reveal-icon").textContent = "🕊️";
    $("role-reveal-heading").textContent = "You are Faithful";
    $("role-reveal-sub").textContent = "Trust carefully. You don't know who among you is a Traitor.";
    $("role-reveal-fellows").classList.add("hidden");
    $("role-reveal-fellows").textContent = "";
  }

  $("reveal-role").classList.remove("hidden");
}

$("btn-ack-role").addEventListener("click", () => $("reveal-role").classList.add("hidden"));

// ---------------------------------------------------------------
// Private "safe" reveal at the moment night ends, for survivors
// ---------------------------------------------------------------
let lastAnnouncedStatus = null;
function watchForSafeReveal() {
  if (!gameData) return;
  if (lastAnnouncedStatus === "night" && gameData.status === "investigation" &&
      myPlayerData?.alive && myRoleData) {
    $("reveal-safe").classList.remove("hidden");
  }
  lastAnnouncedStatus = gameData.status;
}

// Hook extra checks into the render pipeline
const _originalRender = render;
render = function () {
  _originalRender();
  watchForSafeReveal();
  checkRecruitmentPrompt();
  maybeShowInitialRoleReveal();
};

// ---------------------------------------------------------------
// Boot — silently rejoin an in-progress game if this device already has
// a seat in one (same browser = same anonymous auth uid, persisted by
// Firebase across reloads). Falls back to the join screen otherwise.
// ---------------------------------------------------------------
(async function boot() {
  await ensureSignedIn();
  const last = localStorage.getItem("traitors_last_code");

  if (last) {
    $("input-code").value = last;
    try {
      const gameSnap = await getDoc(gameRef(last));
      if (gameSnap.exists()) {
        const playerSnap = await getDoc(playerRef(last, myUid));
        if (playerSnap.exists()) {
          enterGame(last, gameSnap.data().hostUid === myUid);
          return; // view-loading stays up until the first snapshot renders
        }
      }
    } catch (err) {
      console.error("Rejoin check failed", err);
    }
  }

  showView("view-join");
})();
