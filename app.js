"use strict";

const euro = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

// ---------- Profile (wie bei Netflix: erst auswählen, wer man ist) ----------

const PROFILES = [
  { id: "mama", name: "Mama", emoji: "👩", color: "#b81c26" },
  { id: "papa", name: "Papa", emoji: "👨", color: "#175e36" },
  { id: "felix", name: "Felix", emoji: "🧒", color: "#1f5fa8" },
  { id: "lotti", name: "Lotti", emoji: "👧", color: "#c9861a" },
  { id: "jojo", name: "Jojo", emoji: "👶", color: "#7a3fa0" },
];
const LAST_PROFILE_KEY = "wunschzettel2026.lastProfile";
const SESSION_PROFILE_KEY = "wunschzettel2026.profile";
const FAMILY_CODE_KEY = "wunschzettel2026.familyCode";
const PENDING_IMPORT_KEY = "wunschzettel2026.pendingImport";

function profileById(id) {
  return PROFILES.find((p) => p.id === id) ?? null;
}

/** "Felix" → "Felix’", "Lotti" → "Lottis" */
function possessive(name) {
  return /[sßxz]$/i.test(name) ? name + "’" : name + "s";
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Speicher: Supabase, wenn in config.js eingetragen, sonst nur dieser Browser ----------

/** Ein Wunsch: { id, owner, name, details, bestPrice, image, sortOrder, createdAt } */

class StoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

class SupabaseStore {
  constructor(url, key) {
    this.url = url.replace(/\/+$/, "");
    this.key = key;
    this.code = "";
  }

  async rpc(fn, args = {}) {
    const headers = { "Content-Type": "application/json", apikey: this.key };
    // Alte anon-Schlüssel sind JWTs und gehören zusätzlich in den Authorization-Header
    if (this.key.startsWith("eyJ")) headers.Authorization = "Bearer " + this.key;
    let response;
    try {
      response = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
        method: "POST", headers, body: JSON.stringify({ code: this.code, ...args }),
      });
    } catch {
      throw new StoreError("offline", "Keine Verbindung zum Internet.");
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      if (data?.code === "28000") throw new StoreError("locked", "Falscher Familiencode.");
      if (response.status === 404 || data?.code === "PGRST202") {
        throw new StoreError("setup", "Die Datenbank ist noch nicht eingerichtet. Bitte supabase.sql im SQL-Editor ausführen.");
      }
      if (response.status === 401) throw new StoreError("setup", "Der Schlüssel in config.js stimmt nicht.");
      throw new StoreError("failed", data?.message || `Fehler ${response.status}`);
    }
    return data;
  }

  async check(code) {
    this.code = code;
    return (await this.rpc("wz_check")) === true;
  }

  async load(viewer) {
    const [rows, gifts, profiles] = await Promise.all([
      this.rpc("wz_wishes"),
      viewer ? this.rpc("wz_gifts", { viewer }) : [],
      // Ohne profil-emojis.sql gibt es die Funktion noch nicht, dann bleiben die Standard-Emojis
      this.rpc("wz_profiles").catch((error) => { if (error.kind === "setup") return []; throw error; }),
    ]);
    return {
      profiles: new Map(profiles.map((p) => [p.id, p.emoji])),
      wishes: rows.map((r) => ({
        id: r.id, owner: r.owner, name: r.name, details: r.details,
        bestPrice: r.best_price == null ? null : Number(r.best_price),
        image: r.image, sortOrder: r.sort_order, createdAt: Date.parse(r.created_at),
      })),
      gifts: new Map(gifts.map((g) => [g.wish_id, g.gifted_by])),
    };
  }

  saveWish(wish) {
    return this.rpc("wz_save_wish", { wish: {
      id: wish.id ?? null, owner: wish.owner, name: wish.name, details: wish.details,
      best_price: wish.bestPrice, image: wish.image,
    } });
  }

  deleteWish(id) { return this.rpc("wz_delete_wish", { wish_id: id }); }
  reorder(owner, ids) { return this.rpc("wz_reorder", { owner_id: owner, ids }); }
  setGift(wishId, viewer, give) { return this.rpc("wz_set_gift", { wish_id: wishId, viewer, give }); }

  async setEmoji(profileId, emoji) {
    try {
      await this.rpc("wz_set_emoji", { profile_id: profileId, emoji });
    } catch (error) {
      if (error.kind === "setup") throw new StoreError("failed", "Bitte zuerst profil-emojis.sql in Supabase ausführen.");
      throw error;
    }
  }
}

/** Ohne Supabase: alles nur in diesem Browser, mit den gleichen Regeln wie die Datenbank */
class LocalStore {
  constructor() {
    this.migrate();
  }

  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }

  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      throw new StoreError("failed", "Speicher voll. Versuche es mit einem kleineren Bild.");
    }
  }

  // Ältere Versionen haben eine Liste pro Profil gespeichert (ganz alte: eine einzige für Felix)
  migrate() {
    try {
      if (localStorage.getItem("wunschzettel2026.wishes")) return;
      const wishes = [];
      const gifts = {};
      const legacy = localStorage.getItem("wunschzettel2026.items");
      for (const profile of PROFILES) {
        const raw = localStorage.getItem("wunschzettel2026.items." + profile.id) ?? (profile.id === "felix" ? legacy : null);
        for (const item of raw ? JSON.parse(raw) : []) {
          wishes.push({ id: item.id, owner: profile.id, name: item.name, details: item.details || "", bestPrice: item.bestPrice ?? null,
            image: item.image ?? null, sortOrder: item.sortOrder ?? 0, createdAt: item.createdAt ?? Date.now() });
          if (item.giftedBy) gifts[item.id] = item.giftedBy;
        }
      }
      if (!wishes.length) return;
      this.write("wunschzettel2026.wishes", wishes);
      this.write("wunschzettel2026.gifts", gifts);
      PROFILES.forEach((p) => localStorage.removeItem("wunschzettel2026.items." + p.id));
      localStorage.removeItem("wunschzettel2026.items");
    } catch {}
  }

  async check() { return true; }

  async load(viewer) {
    const wishes = this.read("wunschzettel2026.wishes", []);
    const owners = new Map(wishes.map((w) => [w.id, w.owner]));
    // Wie in der Datenbank: nie die Geschenke für eigene Wünsche herausgeben
    const gifts = new Map(Object.entries(this.read("wunschzettel2026.gifts", {}))
      .filter(([id]) => viewer && owners.has(id) && owners.get(id) !== viewer));
    return { wishes, gifts, profiles: new Map(Object.entries(this.read("wunschzettel2026.profiles", {}))) };
  }

  async setEmoji(profileId, emoji) {
    this.write("wunschzettel2026.profiles", { ...this.read("wunschzettel2026.profiles", {}), [profileId]: emoji });
  }

  async saveWish(wish) {
    const wishes = this.read("wunschzettel2026.wishes", []);
    const existing = wishes.find((w) => w.id === wish.id);
    if (existing) {
      Object.assign(existing, { name: wish.name, details: wish.details, bestPrice: wish.bestPrice, image: wish.image });
    } else {
      const nextOrder = wishes.filter((w) => w.owner === wish.owner).reduce((max, w) => Math.max(max, w.sortOrder), -1) + 1;
      wishes.push({ ...wish, id: newId(), createdAt: Date.now(), sortOrder: nextOrder });
    }
    this.write("wunschzettel2026.wishes", wishes);
  }

  async deleteWish(id) {
    this.write("wunschzettel2026.wishes", this.read("wunschzettel2026.wishes", []).filter((w) => w.id !== id));
    const gifts = this.read("wunschzettel2026.gifts", {});
    delete gifts[id];
    this.write("wunschzettel2026.gifts", gifts);
  }

  async reorder(owner, ids) {
    const wishes = this.read("wunschzettel2026.wishes", []);
    for (const w of wishes) if (w.owner === owner && ids.includes(w.id)) w.sortOrder = ids.indexOf(w.id);
    this.write("wunschzettel2026.wishes", wishes);
  }

  async setGift(wishId, viewer, give) {
    const wish = this.read("wunschzettel2026.wishes", []).find((w) => w.id === wishId);
    if (!wish) throw new StoreError("failed", "Diesen Wunsch gibt es nicht mehr");
    if (wish.owner === viewer) throw new StoreError("failed", "Eigene Wünsche kann man nicht abhaken");
    const gifts = this.read("wunschzettel2026.gifts", {});
    if (give) {
      if (gifts[wishId] && gifts[wishId] !== viewer) throw new StoreError("failed", "Das schenkt schon jemand anderes");
      gifts[wishId] = viewer;
    } else if (gifts[wishId] === viewer) {
      delete gifts[wishId];
    }
    this.write("wunschzettel2026.gifts", gifts);
  }
}

const config = window.WUNSCHZETTEL_CONFIG ?? {};
const useCloud = /^https:\/\/\S+/.test(config.supabaseUrl ?? "") && (config.supabaseKey ?? "").length > 20;
const store = useCloud ? new SupabaseStore(config.supabaseUrl, config.supabaseKey) : new LocalStore();

// ---------- Zustand ----------

/** "loading" | "locked" | "offline" | "ready" */
let status = "loading";
let statusMessage = "";
let wishes = [];
/** wishId → Profil, das ihn schenkt; enthält nie Geschenke für eigene Wünsche */
let gifts = new Map();
/** Profil → selbst ausgesuchtes Emoji (fehlt eins, gilt das Standard-Emoji) */
let profileEmojis = new Map();
let dragging = false;

// Das gewählte Profil gilt, bis der Tab geschlossen oder das Profil gewechselt wird
let currentProfile = profileById(sessionStorage.getItem(SESSION_PROFILE_KEY));

// createdAt als Fallback für Einträge ohne Position
function sortedItems(list) {
  return [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt - b.createdAt);
}

function wishesOf(profileId) {
  return sortedItems(wishes.filter((w) => w.owner === profileId));
}

function ownWishes() {
  return currentProfile ? wishesOf(currentProfile.id) : [];
}

function otherProfiles() {
  return PROFILES.filter((p) => p.id !== currentProfile?.id);
}

async function refresh() {
  try {
    const data = await store.load(currentProfile?.id);
    wishes = data.wishes;
    gifts = data.gifts;
    profileEmojis = data.profiles;
    status = "ready";
  } catch (error) {
    handleError(error);
  }
  if (!dragging) render();
}

function handleError(error) {
  if (error.kind === "locked") {
    status = "locked";
  } else if ((error.kind === "offline" || error.kind === "setup") && status !== "ready") {
    status = "offline";
    statusMessage = error.message;
  } else {
    toast(error.message || "Das hat nicht geklappt.");
  }
}

/** Führt eine Änderung aus und lädt danach den aktuellen Stand */
async function mutate(action) {
  let ok = true;
  try {
    await action();
  } catch (error) {
    handleError(error);
    ok = false;
  }
  await refresh();
  return ok;
}

function selectProfile(profile) {
  currentProfile = profile;
  editMode = false;
  gifts = new Map();
  try {
    sessionStorage.setItem(SESSION_PROFILE_KEY, profile.id);
    localStorage.setItem(LAST_PROFILE_KEY, profile.id);
  } catch {}
  const pending = sessionStorage.getItem(PENDING_IMPORT_KEY);
  if (pending) {
    sessionStorage.removeItem(PENDING_IMPORT_KEY);
    decodeShare(pending).then(({ items }) => importShared(items)).catch(() => go("#/start"));
  } else {
    go("#/start");
    refresh();
  }
}

function switchProfile() {
  sessionStorage.removeItem(SESSION_PROFILE_KEY);
  currentProfile = null;
  gifts = new Map();
  go("#/");
}

function idealoSearchURL(query) {
  const url = new URL("https://www.idealo.de/preisvergleich/MainSearchProductCategory.html");
  url.searchParams.set("q", query);
  return url.toString();
}

/** Tage bis Heiligabend (nächster 24. Dezember) */
function daysUntilChristmasEve(date = new Date()) {
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let target = new Date(today.getFullYear(), 11, 24);
  if (target < today) target = new Date(today.getFullYear() + 1, 11, 24);
  return Math.round((target - today) / 86400000);
}

function countdownText() {
  const days = daysUntilChristmasEve();
  if (days === 0) return "Heute ist Heiligabend! 🎅";
  if (days === 1) return "Noch 1 Tag bis Heiligabend";
  return `Noch ${days} Tage bis Heiligabend`;
}

/** "12,99", "12.99" oder "1.299,00 €" → Zahl; leer → null */
function parsePrice(text) {
  let s = text.replace(/[€\s]/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const value = Number(s);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : NaN;
}

// ---------- Teilen per Link (Liste steckt komprimiert in der URL) ----------

function toBase64Url(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function streamBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Bilder passen nicht in einen Link, deshalb werden nur Texte und Preise geteilt (nie, was schon verschenkt wird)
async function encodeShare(list) {
  const payload = list.map((i) => [i.name, i.details || "", i.bestPrice ?? null]);
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, p: currentProfile?.id, i: payload }));
  if ("CompressionStream" in window) {
    return "z" + toBase64Url(await streamBytes(bytes, new CompressionStream("deflate-raw")));
  }
  return "j" + toBase64Url(bytes);
}

async function decodeShare(code) {
  let bytes = fromBase64Url(code.slice(1));
  if (code[0] === "z") bytes = await streamBytes(bytes, new DecompressionStream("deflate-raw"));
  const data = JSON.parse(new TextDecoder().decode(bytes));
  const items = data.i.map(([name, details, bestPrice], index) => ({
    id: "shared-" + index,
    name: String(name),
    details: String(details || ""),
    bestPrice: typeof bestPrice === "number" ? bestPrice : null,
    image: null,
    createdAt: index,
    sortOrder: index,
  }));
  return { profile: profileById(data.p), items };
}

async function shareList() {
  const own = ownWishes();
  if (!own.length) {
    toast("Füge zuerst einen Wunsch hinzu.");
    return;
  }
  const code = await encodeShare(own);
  const url = location.href.split("#")[0] + "#/geteilt/" + code;
  const note = own.some((i) => i.image) ? " (ohne Bilder)" : "";
  if (navigator.share) {
    try {
      await navigator.share({ title: `Wunschzettel von ${currentProfile.name} 🎄`, text: `Hier ist der Wunschzettel von ${currentProfile.name}:`, url });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link kopiert" + note);
  } catch {
    prompt("Diesen Link teilen:", url);
  }
}

// ---------- Bilder: verkleinern statt Originale zu speichern ----------

function compressedJPEG(file, maxPixelSize = 800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPixelSize / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src = url;
  });
}

// ---------- Hilfen fürs Rendern ----------

const app = document.getElementById("app");
const navBack = document.getElementById("navBack");
const navActions = document.getElementById("navActions");

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

function icon(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (extraClass) svg.setAttribute("class", extraClass);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

let toastTimer;
function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

function setNav({ back = false, actions = [] }) {
  navBack.hidden = !back;
  navActions.replaceChildren(...actions);
}

function avatar(profile, extraClass = "") {
  return el("span", { class: "avatar " + extraClass, style: `--avatar:${profile.color}`, "aria-hidden": "true" },
    profileEmojis.get(profile.id) ?? profile.emoji);
}

// ---------- Profilbild (Emoji) selbst aussuchen ----------

const EMOJI_CHOICES = [
  "👩", "👨", "🧒", "👧", "👦", "👶", "🧑", "👱‍♀️", "👱", "🧔", "👵", "👴",
  "🧑‍🎄", "🎅", "🤶", "🦸", "🧙", "🧚", "🥷", "👸", "🤴", "🧜‍♀️", "🤠", "😎",
  "🐶", "🐱", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🦄",
  "🐧", "🦖", "🐳", "🦋", "🐢", "🐙", "🦌", "⛄", "🎄", "⭐", "❄️", "🎁",
  "🍪", "🧁", "🍕", "⚽", "🎮", "🎸", "🚀", "🌈", "💖", "🌻", "🦕", "🐞",
];

/** Erstes sichtbares Zeichen (auch zusammengesetzte Emojis wie 👱‍♀️ oder 🎅🏽) */
function firstEmoji(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if ("Segmenter" in Intl) return new Intl.Segmenter("de", { granularity: "grapheme" }).segment(trimmed)[Symbol.iterator]().next().value.segment;
  return Array.from(trimmed)[0];
}

function openEmojiPicker() {
  const profile = currentProfile;
  const current = profileEmojis.get(profile.id) ?? profile.emoji;
  const close = () => backdrop.remove();
  const choose = async (emoji) => {
    if (!emoji) return;
    close();
    // Sofort anzeigen, dann speichern
    profileEmojis.set(profile.id, emoji);
    render();
    if (await mutate(() => store.setEmoji(profile.id, emoji))) toast("Profilbild geändert");
  };
  const custom = el("input", { class: "code-input emoji-input", placeholder: "Anderes Emoji", "aria-label": "Anderes Emoji", maxlength: "16" });
  const backdrop = el("div", { class: "dialog-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } },
    el("div", { class: "action-sheet emoji-sheet", role: "dialog", "aria-label": "Profilbild aussuchen" },
      el("div", { class: "action-group emoji-panel" },
        el("p", { class: "action-title" }, `Profilbild für ${profile.name}`),
        el("div", { class: "emoji-grid" }, EMOJI_CHOICES.map((emoji) =>
          el("button", { class: "emoji-choice" + (emoji === current ? " selected" : ""), style: `--avatar:${profile.color}`,
            "aria-label": emoji, onclick: () => choose(emoji) }, emoji))),
        el("form", { class: "emoji-custom", onsubmit: (e) => { e.preventDefault(); choose(firstEmoji(custom.value)); } },
          custom, el("button", { class: "primary-button", type: "submit" }, "Nehmen"))),
      el("div", { class: "action-group" },
        el("button", { class: "action-button bold", onclick: close }, "Abbrechen"))));
  document.body.append(backdrop);
}

function profileButton() {
  return el("button", { class: "profile-button", "aria-label": `Profil wechseln (${currentProfile.name})`, title: "Profil wechseln", onclick: switchProfile },
    avatar(currentProfile, "small"));
}

function navButton(label, iconName, onClick) {
  return el("button", { class: iconName ? "icon-button" : "", "aria-label": label, title: label, onclick: onClick },
    iconName ? icon(iconName) : label);
}

navBack.addEventListener("click", () => {
  if (history.length > 1 && sessionStorage.getItem("wz-internal")) history.back();
  else location.hash = "#/start";
});

// ---------- Laden, Familiencode und Verbindungsfehler ----------

function renderLoading() {
  setNav({ actions: [] });
  app.replaceChildren(el("div", { class: "picker" }, el("p", { class: "picker-hint" }, "Wunschzettel wird geladen …")));
}

function renderOffline() {
  setNav({ actions: [] });
  app.replaceChildren(el("div", { class: "picker" },
    el("div", { class: "code-emoji" }, "☁️"),
    el("h1", { class: "picker-title" }, "Keine Verbindung"),
    el("p", { class: "picker-hint" }, statusMessage || "Der Wunschzettel konnte nicht geladen werden."),
    el("button", { class: "primary-button narrow", onclick: () => { status = "loading"; render(); start(); } }, "Nochmal versuchen")));
}

function renderCodeScreen() {
  document.title = "Familiencode · Wunschzettel";
  setNav({ actions: [] });
  const input = el("input", { class: "code-input", placeholder: "Familiencode", autocomplete: "off",
    autocapitalize: "none", spellcheck: "false", "aria-label": "Familiencode" });
  const error = el("p", { class: "form-error code-error", hidden: true }, "Der Code stimmt nicht.");
  const submit = async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    try {
      if (await store.check(code)) {
        try { localStorage.setItem(FAMILY_CODE_KEY, code); } catch {}
        await refresh();
      } else {
        error.hidden = false;
        input.select();
      }
    } catch (err) {
      handleError(err);
      render();
    }
  };
  app.replaceChildren(el("form", { class: "picker", onsubmit: submit },
    el("div", { class: "code-emoji" }, "🎄"),
    el("h1", { class: "picker-title" }, "Familiencode"),
    el("p", { class: "picker-hint" }, "Gib den Code ein, den du von der Familie bekommen hast."),
    input, error,
    el("button", { class: "primary-button narrow", type: "submit" }, "Weiter")));
  input.focus();
}

// ---------- Startbildschirm mit Zusammenfassung ----------

function statCard(title, value, iconName, tint) {
  const symbol = icon(iconName);
  symbol.style.color = tint;
  return el("div", { class: "card stat" }, symbol,
    el("div", { class: "stat-value" }, value),
    el("div", { class: "stat-title" }, title));
}

function renderHome() {
  document.title = `Wunschzettel von ${currentProfile.name}`;
  setNav({ actions: [navButton("Liste teilen", "share", shareList), profileButton()] });

  // Ob jemand einen eigenen Wunsch schenkt, bleibt hier unsichtbar
  const own = ownWishes();
  const recentItems = [...own].sort((a, b) => b.createdAt - a.createdAt);
  const myGifts = wishes.filter((w) => w.owner !== currentProfile.id && gifts.get(w.id) === currentProfile.id);
  const giftTotal = myGifts.reduce((sum, i) => sum + (i.bestPrice ?? 0), 0);

  app.replaceChildren(
    el("h1", { class: "large-title" }, `🎅 ${possessive(currentProfile.name)} Wunschzettel`),
    el("button", { class: "edit-avatar", onclick: openEmojiPicker }, avatar(currentProfile), el("span", {}, "Profilbild ändern")),
    el("div", { class: "stack" },
      el("div", { class: "countdown" }, el("span", { class: "emoji" }, "🎄"), el("span", {}, countdownText())),
      el("div", { class: "stat-row" },
        statCard("Meine Wünsche", String(own.length), "gift", "var(--christmas-red)"),
        statCard("Geschenke von mir", String(myGifts.length), "check", "var(--christmas-green)")),
      statCard("Wert der Geschenke, die ich schenken möchte", euro.format(giftTotal), "star", "var(--christmas-gold)"),
      recentItems.length > 0 && el("h2", { class: "section-title" }, "Zuletzt hinzugefügt"),
      recentItems.slice(0, 3).map((item) =>
        el("div", { class: "card recent-row", role: "button", tabindex: "0", onclick: () => openEditor(item) },
          el("span", {}, "🎁"),
          el("span", { class: "name" }, item.name),
          item.bestPrice != null && el("span", { class: "price" }, euro.format(item.bestPrice)))),
      el("button", { class: "primary-button", onclick: () => go("#/liste") }, icon("list", "icon"), "Meine Wunschliste"),
      el("button", { class: "primary-button red", onclick: () => go("#/andere") }, icon("gift", "icon"), "Wünsche der anderen"),
      !useCloud && el("p", { class: "local-note" }, "Die Wünsche sind nur in diesem Browser gespeichert."))
  );
}

// ---------- Eigene Liste mit Bearbeiten und Löschen (ohne Abhaken) ----------

let editMode = false;

/**
 * mode "own": eigene Wünsche, bearbeitbar, ohne Häkchen
 * mode "gift": Wünsche anderer, mit Häkchen fürs Schenken
 * mode "shared": geteilter Link, nur ansehen
 */
function wishRow(item, number, { mode = "own" } = {}) {
  const readOnly = mode !== "own";
  const giftedBy = mode === "gift" ? gifts.get(item.id) : null;
  const gifted = !!giftedBy;
  const mine = gifted && giftedBy === currentProfile.id;
  const row = el("li", { class: "row" + (mode === "gift" ? " gift-row" : "") + (gifted ? " purchased" : "") + (editMode && !readOnly ? " editing" : ""), "data-id": item.id });

  if (!readOnly) {
    row.append(el("button", { class: "delete-dot", "aria-label": "Löschen", onclick: (e) => {
      e.stopPropagation();
      confirmDelete(() => deleteItem(item));
    } }, icon("minus")));
  }

  row.append(el("span", { class: "row-number" }, number + "."));

  const giver = gifted ? profileById(giftedBy) : null;
  if (mode === "gift") {
    const check = el("button", {
      class: "check" + (mine ? " on" : gifted ? " taken" : ""),
      "aria-label": mine ? "Ich schenke das" : gifted ? `${giver?.name ?? "Jemand"} schenkt das` : "Das schenke ich",
      "aria-pressed": mine ? "true" : "false",
      onclick: (e) => {
        e.stopPropagation();
        toggleGift(item);
      },
    }, icon(gifted ? "check" : "circle"));
    // Was ein anderes Profil schenken will, kann nur dieses Profil wieder freigeben
    if (gifted && !mine) check.disabled = true;
    row.append(check);
  }

  if (item.image) row.append(el("img", { class: "thumb", src: item.image, alt: "", loading: "lazy" }));

  row.append(el("div", { class: "row-text" },
    el("span", { class: "row-name" }, item.name),
    item.details && el("span", { class: "row-details" + (mode === "gift" ? " full" : "") }, item.details),
    mode === "gift" && el("a", { class: "row-link", href: idealoSearchURL(item.name), target: "_blank", rel: "noopener",
      onclick: (e) => e.stopPropagation() }, icon("search", "icon"), "Bei Idealo suchen"),
    gifted && el("span", { class: "row-giver" }, mine ? "🎁 Das schenkst du" : `🎁 ${giver?.name ?? "Jemand"} schenkt das`)));

  // Bei den Wünschen der anderen steht der Preis unter dem Namen, damit die Beschreibung Platz hat
  if (item.bestPrice != null) {
    const price = el("span", { class: "row-price" }, euro.format(item.bestPrice));
    if (mode === "gift") row.querySelector(".row-name").after(price);
    else row.append(price);
  }

  if (!readOnly) {
    const grip = el("span", { class: "grip", "aria-label": "Verschieben" }, icon("grip"));
    grip.addEventListener("pointerdown", (e) => startDrag(e, row));
    row.append(grip);
    row.addEventListener("click", () => { if (!editMode) openEditor(item); });
  }
  return row;
}

function emptyState() {
  return el("div", { class: "empty" }, icon("gift"),
    el("h2", {}, "Noch keine Wünsche"),
    el("p", {}, "Tippe auf +, um einen Wunsch hinzuzufügen."));
}

function renderList() {
  document.title = "Meine Wunschliste";
  const own = ownWishes();
  if (!own.length) editMode = false;
  const actions = [];
  if (own.length) actions.push(navButton(editMode ? "Fertig" : "Bearbeiten", null, () => { editMode = !editMode; render(); }));
  if (editMode) actions.at(-1).style.fontWeight = "600";
  actions.push(navButton("Liste teilen", "share", shareList), navButton("Hinzufügen", "plus", () => openEditor(null)), profileButton());
  setNav({ back: true, actions });

  app.replaceChildren(
    el("h1", { class: "large-title" }, "🎁 Meine Wunschliste"),
    own.length ? el("ul", { class: "list", id: "wishList" }, own.map((item, i) => wishRow(item, i + 1))) : emptyState()
  );
}

function deleteItem(item) {
  wishes = wishes.filter((w) => w.id !== item.id);
  render();
  return mutate(() => store.deleteWish(item.id));
}

// Verschieben im Bearbeiten-Modus (Maus und Touch)
function startDrag(event, row) {
  event.preventDefault();
  const list = row.parentElement;
  row.classList.add("dragging");
  dragging = true;

  const move = (e) => {
    const siblings = [...list.children].filter((r) => r !== row);
    const target = siblings.find((r) => {
      const box = r.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (target) list.insertBefore(row, target);
    else list.append(row);
  };
  const end = () => {
    row.classList.remove("dragging");
    dragging = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    const ids = [...list.children].map((r) => r.dataset.id);
    // Sofort anzeigen, dann speichern
    for (const w of wishes) if (ids.includes(w.id)) w.sortOrder = ids.indexOf(w.id);
    render();
    mutate(() => store.reorder(currentProfile.id, ids));
  };
  // Auf dem Fenster lauschen, weil das Umsortieren die Zeile im DOM verschiebt
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

// ---------- Wünsche der anderen, nach Profil gruppiert, zum Abhaken fürs Schenken ----------

function toggleGift(item) {
  const giftedBy = gifts.get(item.id);
  if (giftedBy && giftedBy !== currentProfile.id) return;
  const give = !giftedBy;
  // Sofort anzeigen; schenkt es inzwischen jemand anderes, korrigiert das Neuladen danach die Anzeige
  if (give) gifts.set(item.id, currentProfile.id);
  else gifts.delete(item.id);
  render();
  mutate(() => store.setGift(item.id, currentProfile.id, give));
}

function renderOthers() {
  document.title = "Wünsche der anderen";
  setNav({ back: true, actions: [profileButton()] });
  app.replaceChildren(
    el("h1", { class: "large-title" }, "🎁 Wünsche der anderen"),
    el("p", { class: "page-hint" }, "Hake ab, was du schenken möchtest. Die anderen sehen dann, dass es schon vergeben ist. Wer sich das gewünscht hat, sieht es nie."),
    ...otherProfiles().map((profile) => {
      const list = wishesOf(profile.id);
      return el("section", { class: "group" },
        el("h2", { class: "group-header" }, avatar(profile, "small"), el("span", {}, profile.name),
          el("span", { class: "group-count" }, list.length === 1 ? "1 Wunsch" : `${list.length} Wünsche`)),
        list.length
          ? el("ul", { class: "list" }, list.map((item, i) => wishRow(item, i + 1, { mode: "gift" })))
          : el("div", { class: "card group-empty" }, `${profile.name} hat noch keine Wünsche eingetragen.`));
    }));
}

// ---------- Geteilte Liste (nur ansehen, optional übernehmen) ----------

async function renderShared(code) {
  document.title = "Geteilter Wunschzettel";
  setNav({ back: false, actions: [] });
  let shared, owner;
  try {
    ({ items: shared, profile: owner } = await decodeShare(code));
  } catch {
    app.replaceChildren(el("h1", { class: "large-title" }, "🎁 Wunschliste"),
      el("div", { class: "empty" }, icon("gift"), el("h2", {}, "Link ungültig"),
        el("p", {}, "Dieser Link enthält keine lesbare Wunschliste.")),
      el("button", { class: "primary-button", onclick: () => go(currentProfile ? "#/start" : "#/") }, "Zu meinem Wunschzettel"));
    return;
  }

  const total = shared.reduce((s, i) => s + (i.bestPrice ?? 0), 0);
  app.replaceChildren(
    el("h1", { class: "large-title shared-title" }, owner ? avatar(owner) : "🎁", owner ? `Wunschzettel von ${owner.name}` : "Geteilte Wunschliste"),
    el("div", { class: "countdown", style: "margin-bottom:16px" }, el("span", { class: "emoji" }, "🎄"), el("span", {}, countdownText())),
    el("div", { class: "card shared-banner" },
      el("strong", {}, `${shared.length} ${shared.length === 1 ? "Wunsch" : "Wünsche"} · zusammen ${euro.format(total)}`),
      `${owner ? owner.name + " hat" : "Jemand hat"} dir diesen Wunschzettel geschickt. Tippe auf einen Wunsch, um ihn bei Idealo zu suchen.`),
    shared.length ? el("ul", { class: "list" }, shared.map((item, i) => {
      const row = wishRow(item, i + 1, { mode: "shared" });
      row.addEventListener("click", () => window.open(idealoSearchURL(item.name), "_blank", "noopener"));
      return row;
    })) : emptyState(),
    el("div", { class: "list-actions" },
      el("button", { class: "primary-button", onclick: () => {
        if (currentProfile && status === "ready") return importShared(shared);
        // Erst auswählen, in wessen Liste die Wünsche kommen
        sessionStorage.setItem(PENDING_IMPORT_KEY, code);
        go("#/");
      } }, icon("plus", "icon"), "In meine Liste übernehmen"),
      el("button", { class: "secondary-button", onclick: () => go(currentProfile ? "#/start" : "#/") }, "Zu meinem Wunschzettel"))
  );
}

async function importShared(shared) {
  go("#/liste");
  const existing = new Set(ownWishes().map((i) => i.name.trim().toLowerCase()));
  const fresh = shared.filter((s) => !existing.has(s.name.trim().toLowerCase()));
  const ok = await mutate(async () => {
    for (const s of fresh) {
      await store.saveWish({ owner: currentProfile.id, name: s.name, details: s.details, bestPrice: s.bestPrice, image: null });
    }
  });
  if (ok) toast(fresh.length ? `${fresh.length} ${fresh.length === 1 ? "Wunsch" : "Wünsche"} übernommen` : "Alle Wünsche sind schon in deiner Liste");
}

// ---------- Formular zum Anlegen und Bearbeiten ----------

const sheet = document.getElementById("sheet");
const form = document.getElementById("editForm");
const nameInput = document.getElementById("nameInput");
const detailsInput = document.getElementById("detailsInput");
const priceInput = document.getElementById("priceInput");
const photoInput = document.getElementById("photoInput");
const previewImage = document.getElementById("previewImage");
const photoLabel = document.getElementById("photoLabel");
const photoError = document.getElementById("photoError");
const removePhoto = document.getElementById("removePhoto");
const saveButton = document.getElementById("saveEdit");
const idealoButton = document.getElementById("idealoButton");

/** `null` = neuer Wunsch */
let editingItem = null;
let draftImage = null;
let saving = false;

function updateFormState() {
  const hasName = nameInput.value.trim().length > 0;
  saveButton.disabled = !hasName || saving;
  idealoButton.disabled = !hasName;
  previewImage.hidden = !draftImage;
  if (draftImage) previewImage.src = draftImage;
  photoLabel.textContent = draftImage ? "Bild ändern" : "Bild hinzufügen";
  removePhoto.hidden = !draftImage;
}

function openEditor(item) {
  editingItem = item;
  draftImage = item?.image ?? null;
  document.getElementById("sheetTitle").textContent = item ? "Wunsch bearbeiten" : "Neuer Wunsch";
  document.getElementById("deleteSection").hidden = !item;
  nameInput.value = item?.name ?? "";
  detailsInput.value = item?.details ?? "";
  priceInput.value = item?.bestPrice != null ? euro.format(item.bestPrice) : "";
  photoError.hidden = true;
  photoInput.value = "";
  updateFormState();
  sheet.hidden = false;
  document.body.style.overflow = "hidden";
  if (!item) nameInput.focus();
}

function closeEditor() {
  sheet.hidden = true;
  document.body.style.overflow = "";
  editingItem = null;
  draftImage = null;
}

nameInput.addEventListener("input", updateFormState);
priceInput.addEventListener("blur", () => {
  const value = parsePrice(priceInput.value);
  if (value != null && !Number.isNaN(value)) priceInput.value = euro.format(value);
});

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) return;
  photoError.hidden = true;
  photoLabel.textContent = "Bild wird geladen …";
  try {
    draftImage = await compressedJPEG(file);
  } catch {
    photoError.hidden = false;
  }
  updateFormState();
});

removePhoto.addEventListener("click", () => { draftImage = null; updateFormState(); });

idealoButton.addEventListener("click", () => {
  window.open(idealoSearchURL(nameInput.value.trim()), "_blank", "noopener");
});

document.getElementById("cancelEdit").addEventListener("click", closeEditor);
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeEditor(); });

document.getElementById("deleteButton").addEventListener("click", () => {
  const item = editingItem;
  confirmDelete(() => { closeEditor(); deleteItem(item); });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name || saving) return;
  const price = parsePrice(priceInput.value);
  if (Number.isNaN(price)) {
    toast("Bitte einen gültigen Preis eingeben, z. B. 19,99");
    priceInput.focus();
    return;
  }
  saving = true;
  saveButton.textContent = "Sichern …";
  updateFormState();
  // Ein neuer Wunsch kommt ans Ende der Liste, die Position vergibt der Speicher
  const wish = { id: editingItem?.id, owner: currentProfile.id, name, details: detailsInput.value, image: draftImage, bestPrice: price };
  const ok = await mutate(() => store.saveWish(wish));
  saving = false;
  saveButton.textContent = "Sichern";
  updateFormState();
  if (ok) closeEditor();
});

// Bestätigungsdialog „Diesen Wunsch löschen?“
const confirmBox = document.getElementById("confirm");
let confirmAction = null;
function confirmDelete(action) {
  confirmAction = action;
  confirmBox.hidden = false;
}
document.getElementById("confirmYes").addEventListener("click", () => {
  confirmBox.hidden = true;
  const action = confirmAction;
  confirmAction = null;
  action?.();
});
document.getElementById("confirmNo").addEventListener("click", () => { confirmBox.hidden = true; confirmAction = null; });
confirmBox.addEventListener("click", (e) => { if (e.target === confirmBox) confirmBox.hidden = true; });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!confirmBox.hidden) confirmBox.hidden = true;
  else if (!sheet.hidden) closeEditor();
});

// ---------- Profilauswahl ----------

function renderProfilePicker() {
  document.title = "Wer bist du? · Wunschzettel";
  setNav({ actions: [] });
  const last = localStorage.getItem(LAST_PROFILE_KEY);
  const importing = !!sessionStorage.getItem(PENDING_IMPORT_KEY);
  app.replaceChildren(el("div", { class: "picker" },
    el("h1", { class: "picker-title" }, "Wer bist du?"),
    importing && el("p", { class: "picker-hint" }, "Wähle aus, in wessen Liste die Wünsche kommen."),
    el("div", { class: "profile-grid" }, PROFILES.map((profile) =>
      el("button", { class: "profile" + (profile.id === last ? " last" : ""), onclick: () => selectProfile(profile) },
        avatar(profile, "large"),
        el("span", { class: "profile-name" }, profile.name)))),
    // Damit man sofort sieht, wenn config.js leer ist und nichts online gespeichert wird
    !useCloud && el("p", { class: "local-note picker-note" }, "Offline-Modus: In config.js ist kein Supabase eingetragen, die Wünsche bleiben nur in diesem Browser.")));
}

// ---------- Navigation ----------

function go(hash) {
  sessionStorage.setItem("wz-internal", "1");
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render() {
  const hash = location.hash;
  if (hash.startsWith("#/geteilt/")) {
    document.body.classList.remove("picking");
    return renderShared(hash.slice("#/geteilt/".length));
  }
  const fullScreen = status !== "ready" || !currentProfile || hash === "" || hash === "#/";
  document.body.classList.toggle("picking", fullScreen);
  if (status === "loading") return renderLoading();
  if (status === "locked") return renderCodeScreen();
  if (status === "offline") return renderOffline();
  if (fullScreen) return renderProfilePicker();
  if (hash === "#/liste") renderList();
  else if (hash === "#/andere") renderOthers();
  else { editMode = false; renderHome(); }
}

async function start() {
  try {
    // Ist in Supabase kein Familiencode eingestellt, klappt es auch mit leerem Code
    if (!(await store.check(localStorage.getItem(FAMILY_CODE_KEY) ?? ""))) {
      status = "locked";
      return render();
    }
  } catch (error) {
    handleError(error);
    return render();
  }
  await refresh();
}

window.addEventListener("hashchange", () => { window.scrollTo(0, 0); render(); });
window.addEventListener("scroll", () => {
  document.querySelector(".navbar").classList.toggle("scrolled", window.scrollY > 8);
}, { passive: true });

// Änderungen der anderen regelmäßig und beim Zurückkehren in den Tab holen
function refreshIfIdle() {
  if (document.visibilityState === "visible" && status === "ready" && !dragging && sheet.hidden && !saving) refresh();
}
document.addEventListener("visibilitychange", refreshIfIdle);
setInterval(refreshIfIdle, 20000);
window.addEventListener("storage", (e) => {
  if (!useCloud && e.key?.startsWith("wunschzettel2026.")) refreshIfIdle();
});

render();
start();

// ---------- Langsam fallende Schneeflocken (rein dekorativ) ----------

(function snowfall() {
  const canvas = document.getElementById("snow");
  const ctx = canvas.getContext("2d");
  const flakeCount = 45;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0, height = 0, last = 0;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = dark.matches ? "rgba(255,255,255,0.7)" : "rgba(179,204,230,0.7)";
    for (let index = 0; index < flakeCount; index++) {
      // Feste, pseudozufällige Werte pro Flocke
      const seed = index;
      const radius = 1.5 + (Math.sin(seed * 12.9898) * 0.5 + 0.5) * 2.5;
      const speed = 0.02 + (Math.sin(seed * 78.233) * 0.5 + 0.5) * 0.03;
      const baseX = (Math.sin(seed * 43.758) * 0.5 + 0.5) * width;
      const sway = Math.sin(time * 0.5 + seed) * 12;
      const progress = ((time * speed + seed * 0.137) % 1 + 1) % 1;
      ctx.beginPath();
      ctx.arc(baseX + sway, progress * (height + 20) - 10, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 30 statt 60 Bilder pro Sekunde reicht für Schnee
  function frame(now) {
    if (now - last >= 1000 / 30) {
      last = now;
      draw(Date.now() / 1000);
    }
    if (!reduceMotion.matches) requestAnimationFrame(frame);
  }

  window.addEventListener("resize", () => { resize(); draw(Date.now() / 1000); });
  resize();
  draw(Date.now() / 1000);
  if (!reduceMotion.matches) requestAnimationFrame(frame);
})();
