(() => {
  "use strict";

  // ---------- constants ----------
  const CDNS = [
    "https://cdn.cloudflare.steamstatic.com",
    "https://cdn.akamai.steamstatic.com",
    "https://cdn.steamstatic.com",
  ];
  const API = "https://api.opendota.com/api";
  const LS = {
    draft: "msu.draft.v1",
    team: "msu.team.v2",
    teamOld: "msu.team.v1",
    weights: "msu.weights.v1",
    stats: "msu.stats.v1",
    mu: "msu.mu.v1.",
    items: "msu.items.v1.",
  };
  const DAY = 24 * 3600 * 1000;
  const POS_NAMES = { 1: "Керри", 2: "Мид", 3: "Оффлейн", 4: "Четвёрка", 5: "Пятёрка" };
  const ATTR_RU = { str: "Сила", agi: "Ловкость", int: "Интеллект", all: "Универсал" };

  // ---------- storage helpers ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { } },
  };

  // ---------- hero data ----------
  const HEROES = window.HEROES;
  const byId = new Map(HEROES.map(h => [h.id, h]));
  const bySlug = new Map(HEROES.map(h => [h.slug, h]));
  for (const h of HEROES) {
    const raw = (window.HERO_META[h.slug] || "1,2,3,4,5|3||").split("|");
    h.pos = raw[0].split(",").map(Number);
    h.tier = Number(raw[1]) || 3;
    h.tags = raw[2] || "";
    h.aliases = (raw[3] || "").toLowerCase();
    h.search = [h.name.toLowerCase(), h.slug.replace(/_/g, " "), h.aliases].join(" ");
    h.counteredBy = new Set((window.HERO_COUNTERS[h.slug] || "").split(" ").filter(Boolean).map(s => bySlug.get(s)?.id).filter(Boolean));
    h.synergy = new Set();
  }
  for (const pair of window.HERO_SYNERGY) {
    const [a, b] = pair.split(" ").map(s => bySlug.get(s));
    if (a && b) { a.synergy.add(b.id); b.synergy.add(a.id); }
  }
  const sortedHeroes = [...HEROES].sort((a, b) => a.name.localeCompare(b.name));

  // ---------- state ----------
  const defaultTeam = () => window.DEFAULT_TEAM.map(t => ({ ...t, pool: t.pool.map(s => bySlug.get(s)?.id).filter(Boolean) }));
  let team = store.get(LS.team, null);
  if (!team) {
    // v1 -> v2: 4th position changed from Саня to Лёва; keep the rest of saved edits
    const old = store.get(LS.teamOld, null);
    team = defaultTeam();
    if (old) team = old.map(t => t.pos === 4 ? team.find(x => x.pos === 4) : t);
    store.set(LS.team, team);
  }
  let weights = Object.assign({ comfort: 6, meta: 1, counter: 1, synergy: 1 }, store.get(LS.weights, {}));
  const emptyDraft = () => ({ ally: {}, enemy: [], ourBans: [], enemyBans: [] });
  let draft = Object.assign(emptyDraft(), store.get(LS.draft, {}));
  if (Array.isArray(draft.bans)) { draft.enemyBans.push(...draft.bans); delete draft.bans; } // old format
  let activePos = null;
  let onlyPool = false;

  let stats = null;            // Map heroId -> {wr, presence, games}
  const matchups = new Map();  // enemyHeroId -> Map(heroId -> {g, w}) (w = enemy wins)
  let dataMode = "loading";

  const saveDraft = () => store.set(LS.draft, draft);
  const saveTeam = () => store.set(LS.team, team);
  const takenIds = () => new Set([...Object.values(draft.ally), ...draft.enemy, ...draft.ourBans, ...draft.enemyBans]);
  const playerFor = pos => team.find(t => t.pos === pos);

  // ---------- DOM helpers ----------
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function heroImg(h) {
    const img = new Image();
    img.className = "hero-img";
    img.alt = h.name;
    img.loading = "lazy";
    img.decoding = "async";
    let i = 0;
    img.src = CDNS[0] + h.img;
    img.onerror = () => {
      i++;
      if (i < CDNS.length) img.src = CDNS[i] + h.img;
      else img.replaceWith(el("div", { class: "hero-fallback" }, h.name.split(/[\s-]/).map(w => w[0]).join("").slice(0, 3)));
    };
    return img;
  }
  const thumb = (h, cls = "thumb") => el("div", { class: cls }, h ? heroImg(h) : "+");

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2400);
  }

  // Warm the browser cache so icons appear instantly in the picker.
  function preloadImages() {
    const go = () => HEROES.forEach(h => { const i = new Image(); i.src = CDNS[0] + h.img; });
    ("requestIdleCallback" in window) ? requestIdleCallback(go) : setTimeout(go, 300);
  }

  // ---------- OpenDota ----------
  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  async function loadStats(force) {
    const cached = store.get(LS.stats, null);
    if (!force && cached && Date.now() - cached.t < DAY / 2) { applyStats(cached.d); setStatus("live", cached.t); return; }
    try {
      const d = await fetchJSON(API + "/heroStats");
      const slim = d.map(x => [x.id, (x["7_pick"] || 0) + (x["8_pick"] || 0), (x["7_win"] || 0) + (x["8_win"] || 0), x.pro_pick || 0, x.pro_ban || 0, x.pro_win || 0]);
      store.set(LS.stats, { t: Date.now(), d: slim });
      applyStats(slim);
      setStatus("live", Date.now());
    } catch (e) {
      if (cached) { applyStats(cached.d); setStatus("live", cached.t); }
      else setStatus("offline");
    }
    render();
  }

  function applyStats(rows) {
    const maxPres = Math.max(1, ...rows.map(r => r[3] + r[4]));
    stats = new Map(rows.map(([id, g, w, pp, pb, pw]) => {
      const wr = (w + 50) / (g + 100); // light shrinkage
      return [id, { wr, games: g, presence: (pp + pb) / maxPres, proPick: pp, proBan: pb, proWr: pp ? pw / pp : null }];
    }));
  }

  function setStatus(mode, t) {
    dataMode = mode;
    const b = $("#dataStatus");
    const dot = b.querySelector(".dot");
    dot.className = "dot " + (mode === "live" ? "live" : mode === "offline" ? "off" : "");
    const lbl = b.querySelector(".label");
    if (mode === "live") {
      const mins = Math.round((Date.now() - t) / 60000);
      lbl.textContent = "Мета: OpenDota" + (mins > 5 ? ` · ${mins < 60 ? mins + " мин" : Math.round(mins / 60) + " ч"} назад` : "");
    } else if (mode === "offline") lbl.textContent = "Оффлайн-база (нет сети)";
    else lbl.textContent = "Загрузка меты…";
  }

  async function loadMatchups(heroId) {
    if (matchups.has(heroId)) return;
    const key = LS.mu + heroId;
    const cached = store.get(key, null);
    if (cached && Date.now() - cached.t < DAY) { matchups.set(heroId, new Map(cached.d.map(([id, g, w]) => [id, { g, w }]))); return; }
    try {
      const d = await fetchJSON(`${API}/heroes/${heroId}/matchups`);
      const slim = d.map(x => [x.hero_id, x.games_played, x.wins]);
      store.set(key, { t: Date.now(), d: slim });
      matchups.set(heroId, new Map(slim.map(([id, g, w]) => [id, { g, w }])));
    } catch (e) {
      if (cached) matchups.set(heroId, new Map(cached.d.map(([id, g, w]) => [id, { g, w }])));
    }
  }
  async function ensureMatchups() {
    const need = [...draft.enemy, ...Object.values(draft.ally)].filter(id => !matchups.has(id));
    const needItems = Object.values(draft.ally).filter(id => !itemPop.has(id));
    if (!need.length && !needItems.length) return;
    await Promise.all([...need.map(loadMatchups), ...needItems.map(loadItemPop)]);
    render();
  }

  // ---------- items ----------
  const ITEMS = window.ITEMS;
  const itemById = new Map(Object.entries(ITEMS).map(([k, v]) => [v[0], k]));
  const BOOTS = new Set("power_treads phase_boots arcane_boots tranquil_boots travel_boots boots_of_bearing guardian_greaves".split(" "));
  const NOT_CORE = new Set(("platemail ultimate_orb mystic_staff reaver eagle relic hyperstone demon_edge point_booster talisman_of_evasion " +
    "claymore mithril_hammer cornucopia tiara_of_selemene soul_booster ring_of_tarrasque pers aghanims_shard_roshan ultimate_scepter_roshan " +
    "cheese refresher_shard pocket_roshan oblivion_staff vitality_booster ogre_axe staff_of_wizardry blade_of_alacrity essence_distiller " +
    "necronomicon_2 necronomicon_3 dagon_2 dagon_3 dagon_4 dagon_5 diffusal_blade_2 travel_boots_2 lesser_crit sange yasha").split(" "));
  const MELEE_ONLY = new Set(["bfury", "abyssal_blade"]);
  const itemPop = new Map(); // heroId -> [itemKey...] (live core)
  const groups = Object.fromEntries(Object.entries(window.ENEMY_GROUPS).map(([g, list]) => [g, new Set(list.split(" ").map(s => bySlug.get(s)?.id).filter(Boolean))]));

  function itemIcon(key, cls = "item", title) {
    const it = ITEMS[key];
    if (!it) return null;
    const box = el("span", { class: cls, title: title || it[1] });
    const img = new Image();
    img.alt = it[1]; img.loading = "lazy"; img.decoding = "async";
    let i = 0;
    img.src = CDNS[0] + it[3];
    img.onerror = () => { i++; if (i < CDNS.length) img.src = CDNS[i] + it[3]; else img.replaceWith(el("b", {}, it[1].split(/\s/).map(w => w[0]).join("").slice(0, 3))); };
    box.append(img);
    return box;
  }

  async function loadItemPop(heroId) {
    if (itemPop.has(heroId)) return;
    const key = LS.items + heroId;
    const cached = store.get(key, null);
    const parse = d => {
      const counts = {};
      for (const phase of ["early_game_items", "mid_game_items"]) for (const [id, n] of Object.entries(d[phase] || {})) {
        const k = itemById.get(Number(id));
        if (!k || NOT_CORE.has(k)) continue;
        if (!BOOTS.has(k) && (ITEMS[k][2] || 0) < 1400) continue;
        counts[k] = (counts[k] || 0) + n;
      }
      const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k);
      const boot = ranked.find(k => BOOTS.has(k));
      const rest = ranked.filter(k => !BOOTS.has(k)).slice(0, boot ? 3 : 4);
      return boot ? [boot, ...rest] : rest;
    };
    if (cached && Date.now() - cached.t < DAY) { itemPop.set(heroId, cached.d); return; }
    try {
      const d = await fetchJSON(`${API}/heroes/${heroId}/itemPopularity`);
      const core = parse(d);
      if (core.length >= 3) { store.set(key, { t: Date.now(), d: core }); itemPop.set(heroId, core); }
    } catch (e) { if (cached) itemPop.set(heroId, cached.d); }
  }

  function buildFor(h, pos) {
    const live = itemPop.get(h.id);
    const core = live || (window.CORE_BUILDS[h.slug] || window.CORE_BY_POS[pos]).split(" ");
    const enemies = draft.enemy.map(id => byId.get(id));
    const sit = new Map(); // item -> {w, reasons[]}
    for (const r of window.ITEM_RULES) {
      const key = r.items[pos];
      if (!key || !ITEMS[key]) continue;
      if (MELEE_ONLY.has(key) && h.atk !== "Melee") continue;
      const hits = r.group === "magic"
        ? enemies.filter(e => e.tags.includes("M"))
        : enemies.filter(e => groups[r.group].has(e.id));
      if (hits.length < r.min) continue;
      if (core.includes(key)) continue;
      const cur = sit.get(key) || { w: 0, reasons: [] };
      cur.w += hits.length;
      cur.reasons.push(`${r.why}: ${hits.map(e => e.name).join(", ")}`);
      sit.set(key, cur);
    }
    const situational = [...sit.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, 4).map(([key, v]) => ({ key, reasons: v.reasons }));
    return { core, situational, live: !!live };
  }

  function renderItems() {
    const box = $("#itemsList");
    box.replaceChildren();
    const picked = [...team].sort((a, b) => a.pos - b.pos).filter(t => draft.ally[t.pos]);
    if (!picked.length) { box.append(el("div", { class: "empty-note" }, "Выбери героев для нашей команды — здесь появятся предметы под драфт соперника.")); return; }
    for (const t of picked) {
      const h = byId.get(draft.ally[t.pos]);
      const b = buildFor(h, t.pos);
      box.append(el("div", { class: "build" },
        el("div", { class: "build-head" }, thumb(h), el("div", {},
          el("div", { class: "t1" }, el("span", { class: "posbadge" }, "P" + t.pos), h.name),
          el("div", { class: "t2 muted small" }, t.player + (b.live ? " · сборка по OpenDota" : " · базовая сборка")))),
        el("div", { class: "build-row" }, el("span", { class: "row-label" }, "Основа"),
          el("div", { class: "items" }, b.core.map(k => itemIcon(k)))),
        el("div", { class: "build-row" }, el("span", { class: "row-label" }, "Против них"),
          b.situational.length
            ? el("div", { class: "sit-list" }, b.situational.map(s => el("div", { class: "sit" }, itemIcon(s.key, "item sit-item"),
                el("div", {}, el("div", { class: "sit-name" }, ITEMS[s.key][1]), el("div", { class: "muted small" }, s.reasons.join("; "))))))
            : el("div", { class: "muted small" }, draft.enemy.length ? "ничего особенного не нужно" : "добавь пики соперника"))
      ));
    }
  }

  // ---------- scoring ----------
  function metaScore(h) {
    const s = stats?.get(h.id);
    if (!s || s.games < 50) return { v: (h.tier - 3) * 1.6, wr: null, pres: null };
    const v = (s.wr - 0.5) * 100 * 0.9 + s.presence * 4;
    return { v, wr: s.wr, pres: s.presence };
  }

  // Advantage (in % winrate points) of hero `a` against hero `b`.
  function advantage(a, b) {
    const mu = matchups.get(b.id);
    let stat = null, n = 0;
    if (mu) {
      // baseline: how much b wins overall in this sample
      if (!mu._base) { let G = 0, W = 0; mu.forEach(x => { G += x.g; W += x.w; }); mu._base = G ? W / G : 0.5; }
      const x = mu.get(a.id);
      if (x && x.g) {
        const k = 25;
        const aWr = (x.g - x.w + k * (1 - mu._base)) / (x.g + k);
        stat = (aWr - (1 - mu._base)) * 100;
        n = x.g;
      }
    }
    let curated = 0;
    if (b.counteredBy.has(a.id)) curated += 2.5;
    if (a.counteredBy.has(b.id)) curated -= 2.5;
    const v = stat == null ? curated : stat * 0.75 + curated * 0.6;
    return { v, stat, n, curated };
  }

  function teamTags(ids) {
    const t = ids.map(id => byId.get(id).tags).join("");
    const count = c => (t.match(new RegExp(c, "g")) || []).length;
    return { I: count("I"), S: count("S"), V: count("V"), M: count("M"), P: count("P"), W: count("W"), H: count("H") };
  }

  function scoreHero(h, pos) {
    const reasons = [];
    const flags = [];
    const p = playerFor(pos);
    const inPool = p?.pool.includes(h.id);

    // position fit
    const idx = h.pos.indexOf(pos);
    const posPen = idx === 0 ? 0 : idx > 0 ? -1.2 * idx : null;

    // comfort
    const comfort = inPool ? weights.comfort : 0;
    if (inPool) flags.push(["pool", "пул " + p.player]);

    // meta
    const m = metaScore(h);
    if (m.wr != null) {
      reasons.push(`WR <b>${(m.wr * 100).toFixed(1)}%</b> в Divine+`);
      if (m.pres > 0.35) reasons.push(`часто в про-драфтах`);
    }
    if (m.v >= 3) flags.push(["meta", "мета"]);

    // counters
    let counter = 0;
    const good = [], bad = [];
    for (const eid of draft.enemy) {
      const e = byId.get(eid);
      const a = advantage(h, e);
      counter += a.v;
      if (a.v >= 1.5) good.push(e.name + (a.stat != null ? ` +${a.stat.toFixed(1)}%` : ""));
      if (a.v <= -1.5) bad.push(e.name + (a.stat != null ? ` ${a.stat.toFixed(1)}%` : ""));
    }
    if (good.length) { reasons.push("силён против " + good.map(esc).map(s => `<b>${s}</b>`).join(", ")); flags.push(["counter", "контрпик"]); }
    if (bad.length) { reasons.push("слаб против " + bad.map(esc).join(", ")); flags.push(["risk", "риск"]); }

    // synergy & composition
    let syn = 0;
    const allyIds = Object.values(draft.ally);
    const synWith = allyIds.filter(id => h.synergy.has(id)).map(id => byId.get(id).name);
    if (synWith.length) { syn += 2 * synWith.length; reasons.push("связка с " + synWith.map(n => `<b>${esc(n)}</b>`).join(", ")); }
    // stat-based synergy proxy: allies' matchups don't give "with" data, so use composition needs
    const tt = teamTags(allyIds);
    const left = 5 - allyIds.length;
    if (left <= 3) {
      if (!tt.I && h.tags.includes("I")) { syn += 1.5; reasons.push("даёт инициацию"); }
      if (tt.S < 2 && h.tags.includes("S")) { syn += 1; }
      if (!tt.V && h.tags.includes("V") && pos >= 4) { syn += 0.8; reasons.push("даёт сейв"); }
      if (!tt.W && h.tags.includes("W")) { syn += 0.6; }
      if (tt.P >= 3 && !tt.M && h.tags.includes("M")) { syn += 0.8; reasons.push("добавит маг. урона"); }
      if (tt.M >= 3 && !tt.P && h.tags.includes("P")) { syn += 0.8; reasons.push("добавит физ. урона"); }
    }
    if (allyIds.length) {
      // avoid drafts with two farm-heavy cores
      const farm = allyIds.filter(id => byId.get(id).tags.includes("X")).length;
      if (farm && h.tags.includes("X")) syn -= 1.5;
    }

    const total = comfort + m.v * weights.meta + counter * weights.counter + syn * weights.synergy + (posPen || 0);
    return { h, pos, total, inPool, comfort, meta: m.v, counter, syn, reasons, flags, posOk: posPen != null };
  }

  function recommendations(pos) {
    const taken = takenIds();
    const p = playerFor(pos);
    let list = HEROES.filter(h => !taken.has(h.id));
    if (onlyPool) list = list.filter(h => p.pool.includes(h.id));
    return list
      .map(h => scoreHero(h, pos))
      .filter(r => r.posOk || r.inPool)
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);
  }

  function banSuggestions() {
    const taken = takenIds();
    const ours = Object.values(draft.ally).map(id => byId.get(id));
    const openPos = [1, 2, 3, 4, 5].filter(p => !draft.ally[p]);
    const poolHeroes = openPos.flatMap(p => playerFor(p).pool).map(id => byId.get(id)).filter(h => !taken.has(h.id));
    return HEROES.filter(h => !taken.has(h.id)).map(h => {
      let v = metaScore(h).v;
      const vs = [];
      for (const o of ours) { const a = advantage(h, o); v += a.v * 0.8; if (a.v >= 1.5) vs.push(o.name); }
      for (const o of poolHeroes) if (o.counteredBy.has(h.id)) { v += 0.7; if (!vs.includes(o.name)) vs.push(o.name); }
      return { h, v, vs };
    }).sort((a, b) => b.v - a.v).slice(0, 8);
  }

  // ---------- rendering ----------
  function render() {
    renderAlly();
    renderEnemy();
    renderTabs();
    renderRecs();
    renderBans();
    renderComp();
    renderItems();
  }

  function renderAlly() {
    const box = $("#allySlots");
    box.replaceChildren();
    for (const t of [...team].sort((a, b) => a.pos - b.pos)) {
      const hid = draft.ally[t.pos];
      const h = hid ? byId.get(hid) : null;
      const inPool = h && t.pool.includes(h.id);
      const slot = el("button", {
        class: "slot" + (activePos === t.pos ? " active" : ""),
        onclick: () => {
          if (h) { activePos = t.pos; render(); return; }
          openPicker({ title: `${t.player} · ${t.role}`, sub: "Выбери героя для нашей команды", pos: t.pos, onPick: id => setAlly(t.pos, id) });
        },
      },
        thumb(h),
        el("div", { class: "meta" },
          el("div", { class: "t1" }, el("span", { class: "posbadge" }, "P" + t.pos), h ? h.name : t.player),
          el("div", { class: "t2" }, h ? [t.player, inPool ? el("span", { class: "pooltag" }, " · из пула") : ""] : `${t.role} · не выбран`),
          h ? (() => { const b = buildFor(h, t.pos); return el("div", { class: "slot-items" },
            b.core.map(k => itemIcon(k, "item mini")),
            b.situational.map(s => itemIcon(s.key, "item mini sit-item", ITEMS[s.key][1] + " — " + s.reasons.join("; ")))); })() : null
        ),
        h ? el("span", { class: "x", title: "Убрать", onclick: e => { e.stopPropagation(); delete draft.ally[t.pos]; saveDraft(); render(); } }, "✕") : null
      );
      box.append(slot);
    }
  }

  function renderEnemy() {
    const box = $("#enemySlots");
    box.replaceChildren();
    for (let i = 0; i < 5; i++) {
      const h = draft.enemy[i] ? byId.get(draft.enemy[i]) : null;
      box.append(el("button", {
        class: "slot",
        onclick: () => h ? null : openPicker({ title: "Пик соперника", sub: "Кого взял соперник?", onPick: addEnemy }),
      },
        thumb(h),
        el("div", { class: "meta" },
          el("div", { class: "t1" }, h ? h.name : `Пик ${i + 1}`),
          el("div", { class: "t2" }, h ? h.pos.map(p => POS_NAMES[p]).slice(0, 2).join(" / ") : "ещё не выбран")
        ),
        h ? el("span", { class: "x", title: "Убрать", onclick: e => { e.stopPropagation(); draft.enemy.splice(i, 1); saveDraft(); render(); } }, "✕") : null
      ));
    }
    renderBanRow($("#bans"), draft.enemyBans);
    renderBanRow($("#ourBans"), draft.ourBans);
  }

  function renderBanRow(box, arr) {
    box.replaceChildren();
    if (!arr.length) box.append(el("div", { class: "empty-note" }, "Банов пока нет"));
    arr.forEach((id, i) => {
      const h = byId.get(id);
      box.append(el("button", { class: "ban", title: h.name + " — нажми, чтобы убрать", onclick: () => { arr.splice(i, 1); saveDraft(); render(); } }, heroImg(h)));
    });
  }

  function renderTabs() {
    const seg = $("#posTabs");
    seg.replaceChildren();
    const open = [1, 2, 3, 4, 5].filter(p => !draft.ally[p]);
    if (activePos == null || !team.some(t => t.pos === activePos)) activePos = open[0] || 1;
    for (const t of [...team].sort((a, b) => a.pos - b.pos)) {
      seg.append(el("button", {
        class: (activePos === t.pos ? "on" : "") + (draft.ally[t.pos] ? " done" : ""),
        onclick: () => { activePos = t.pos; render(); },
        title: `${t.player} — ${t.role}`,
      }, `${t.pos} · ${t.player}`));
    }
  }

  function renderRecs() {
    const box = $("#recList");
    box.replaceChildren();
    const pos = activePos;
    const p = playerFor(pos);
    if (draft.ally[pos]) {
      const h = byId.get(draft.ally[pos]);
      box.append(el("div", { class: "empty-note" }, `${p.player} уже на ${h.name}. Выбери другую позицию сверху.`));
    }
    const recs = recommendations(pos);
    if (!recs.length) { box.append(el("div", { class: "empty-note" }, "Нет подходящих героев — выключи фильтр «только пул».")); return; }
    const max = Math.max(...recs.map(r => r.total), 1);
    const min = Math.min(...recs.map(r => r.total), 0);
    recs.forEach((r, i) => {
      const h = r.h;
      const dbSlug = h.name.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-");
      const row = el("div", {
        class: "rec" + (i === 0 ? " top" : ""),
        title: `Комфорт ${r.comfort.toFixed(1)} · мета ${r.meta.toFixed(1)} · контрпик ${r.counter.toFixed(1)} · синергия ${r.syn.toFixed(1)}`,
        onclick: e => { if (e.target.closest("a")) return; if (!draft.ally[pos]) setAlly(pos, h.id); },
      },
        thumb(h),
        el("div", {},
          el("div", { class: "name" }, h.name, ...r.flags.map(([c, t]) => el("span", { class: "tag " + c }, t))),
          el("div", { class: "why", html: r.reasons.length ? r.reasons.join(" · ") : (r.inPool ? "комфортный герой игрока" : "универсальный вариант") }),
          el("div", { class: "links" },
            el("a", { href: `https://www.dotabuff.com/heroes/${dbSlug}/counters`, target: "_blank", rel: "noopener" }, "Dotabuff"),
            el("a", { href: `https://stratz.com/heroes/${h.id}/matchups`, target: "_blank", rel: "noopener" }, "STRATZ"))
        ),
        el("div", { class: "score" },
          el("div", { class: "num" }, r.total.toFixed(1)),
          el("div", { class: "bar" }, el("i", { style: `width:${Math.max(6, ((r.total - min) / (max - min || 1)) * 100)}%` })))
      );
      box.append(row);
    });
  }

  function renderBans() {
    const box = $("#banList");
    box.replaceChildren();
    for (const b of banSuggestions()) {
      const s = stats?.get(b.h.id);
      box.append(el("button", {
        class: "ban-sugg", title: "Нажми, чтобы забанить",
        onclick: () => addBan(b.h.id, "ourBans"),
      },
        thumb(b.h),
        el("div", {},
          el("div", { class: "t1" }, b.h.name),
          el("div", { class: "t2" }, b.vs.length ? "опасен для: " + b.vs.slice(0, 3).join(", ") : s ? `WR ${(s.wr * 100).toFixed(1)}%, пики/баны в про` : "сильный в мете"))
      ));
    }
  }

  function renderComp() {
    const box = $("#comp");
    box.replaceChildren();
    const ids = Object.values(draft.ally);
    if (!ids.length) return;
    const t = teamTags(ids);
    const chip = (ok, okText, needText) => el("span", { class: "chip " + (ok ? "ok" : "need") }, ok ? okText : needText);
    box.append(
      chip(t.I > 0, "✓ инициация", "нужна инициация"),
      chip(t.S >= 2, "✓ контроль", "мало контроля"),
      chip(t.V > 0, "✓ сейв", "нет сейва"),
      chip(t.W > 0, "✓ пуш / фарм крипов", "слабо с пушем"),
      chip(t.M > 0 && t.P > 0, "✓ урон смешанный", t.M ? "мало физ. урона" : "мало маг. урона"),
    );
  }

  // ---------- mutations ----------
  function setAlly(pos, id) {
    draft.ally[pos] = id;
    // move to next open position automatically
    const open = [1, 2, 3, 4, 5].filter(p => !draft.ally[p]);
    activePos = open[0] || pos;
    saveDraft(); render(); ensureMatchups();
    toast(`${playerFor(pos).player}: ${byId.get(id).name}`);
  }
  function addEnemy(id) {
    if (draft.enemy.length >= 5) { toast("У соперника уже 5 героев"); return; }
    draft.enemy.push(id); saveDraft(); render(); ensureMatchups();
  }
  function addBan(id, side = "ourBans") {
    if (takenIds().has(id)) return;
    draft[side].push(id); saveDraft(); render();
    toast(byId.get(id).name + (side === "ourBans" ? " — наш бан" : " — бан соперника"));
  }

  // ---------- picker ----------
  let pickerCtx = null;
  let pickerAttr = "";
  let kbIndex = 0;

  function openPicker(ctx) {
    pickerCtx = ctx;
    $("#pickerTitle").textContent = ctx.title;
    $("#pickerSub").textContent = ctx.sub || "";
    const s = $("#pickerSearch");
    s.value = ctx.query || "";
    $("#picker").hidden = false;
    renderPicker();
    s.focus();
  }
  function closePicker() { $("#picker").hidden = true; pickerCtx = null; $("#pickerSearch").blur(); }

  function pickerMatches() {
    const q = $("#pickerSearch").value.trim().toLowerCase();
    const taken = pickerCtx?.multi ? new Set() : takenIds();
    return sortedHeroes.filter(h => !taken.has(h.id) && (!pickerAttr || h.attr === pickerAttr) && (!q || h.search.includes(q) || h.search.split(" ").some(w => w.startsWith(q))));
  }

  function renderPicker() {
    const body = $("#pickerBody");
    body.replaceChildren();
    const ctx = pickerCtx;
    const taken = ctx.multi ? new Set() : takenIds(); // picked / banned heroes are hidden
    const list = pickerMatches();
    kbIndex = Math.min(kbIndex, Math.max(0, list.length - 1));
    const cell = (h, i) => {
      const sel = ctx.selected?.has(h.id);
      return el("button", {
        class: "hcell" + (taken.has(h.id) ? " taken" : "") + (sel ? " sel" : "") + (i === kbIndex ? " kb" : ""),
        title: `${h.name} · ${ATTR_RU[h.attr]} · ${h.pos.map(p => POS_NAMES[p]).join(", ")}`,
        onclick: () => choose(h.id),
      }, heroImg(h), el("span", { class: "nm" }, h.name));
    };
    if (!list.length) { body.append(el("div", { class: "empty-note" }, "Ничего не найдено")); return; }

    if (ctx.pos && !$("#pickerSearch").value) {
      const p = playerFor(ctx.pos);
      const pool = p.pool.map(id => byId.get(id)).filter(h => !taken.has(h.id) && (!pickerAttr || h.attr === pickerAttr));
      if (pool.length) {
        body.append(el("div", { class: "group-title" }, `Пул: ${p.player}`), el("div", { class: "grid" }, pool.map(h => cell(h, -1))));
      }
      {
        const recs = recommendations(ctx.pos).filter(r => !r.inPool).slice(0, 8).map(r => r.h);
        if (recs.length) body.append(el("div", { class: "group-title" }, "Советуем по мете и драфту"), el("div", { class: "grid" }, recs.map(h => cell(h, -1))));
      }
    }
    body.append(el("div", { class: "group-title" }, "Все герои"), el("div", { class: "grid" }, list.map(cell)));
  }

  function choose(id) {
    const ctx = pickerCtx;
    if (!ctx) return;
    if (ctx.multi) {
      ctx.selected.has(id) ? ctx.selected.delete(id) : ctx.selected.add(id);
      ctx.onPick(id);
      renderPicker();
      return;
    }
    if (takenIds().has(id)) return;
    closePicker();
    ctx.onPick(id);
  }

  // ---------- team sheet ----------
  function renderTeamSheet() {
    const body = $("#teamBody");
    body.replaceChildren();
    for (const t of [...team].sort((a, b) => a.pos - b.pos)) {
      const name = el("input", { value: t.player, "aria-label": "Имя игрока", oninput: e => { t.player = e.target.value || "Игрок"; saveTeam(); render(); } });
      const role = el("input", { value: t.role, "aria-label": "Роль", oninput: e => { t.role = e.target.value; saveTeam(); render(); } });
      const pool = el("div", { class: "pool-list" },
        t.pool.map(id => {
          const h = byId.get(id);
          return el("span", { class: "pool-item" }, thumb(h), h.name,
            el("button", { title: "Убрать", onclick: () => { t.pool = t.pool.filter(x => x !== id); saveTeam(); renderTeamSheet(); render(); } }, "✕"));
        }),
        el("button", {
          class: "pill small-pill", onclick: () => {
            const selected = new Set(t.pool);
            openPicker({
              title: `Пул: ${t.player}`, sub: "Отметь героев, на которых игрок уверенно играет", multi: true, selected,
              onPick: () => { t.pool = [...selected]; saveTeam(); renderTeamSheet(); render(); },
            });
          }
        }, "+ герои")
      );
      body.append(el("div", { class: "team-row" },
        el("div", { class: "top" }, el("span", { class: "posbadge" }, "P" + t.pos), name, role), pool));
    }
    const w = $("#weights");
    w.replaceChildren();
    const slider = (key, label, max) => el("label", {},
      `${label}: ${weights[key]}`,
      el("input", { type: "range", min: 0, max, step: key === "comfort" ? 1 : 0.25, value: weights[key],
        oninput: e => { weights[key] = Number(e.target.value); e.target.previousSibling.textContent = `${label}: ${weights[key]}`; store.set(LS.weights, weights); render(); } }));
    w.append(slider("comfort", "Бонус за пул игрока", 12), slider("meta", "Вес меты", 3), slider("counter", "Вес контрпиков", 3), slider("synergy", "Вес синергии", 3));
  }

  // ---------- events ----------
  function bind() {
    $("#btnAddEnemy").onclick = () => openPicker({ title: "Пик соперника", sub: "Кого взял соперник?", onPick: addEnemy });
    $("#btnAddBan").onclick = () => openPicker({ title: "Бан соперника", sub: "Кого забанил соперник?", onPick: id => addBan(id, "enemyBans") });
    $("#btnOurBan").onclick = () => openPicker({ title: "Наш бан", sub: "Кого баним мы?", onPick: id => addBan(id, "ourBans") });
    $("#btnReset").onclick = () => { if (confirm("Очистить драфт?")) { draft = emptyDraft(); activePos = 1; saveDraft(); render(); } };
    $("#btnTeam").onclick = () => { renderTeamSheet(); $("#teamSheet").hidden = false; };
    $("#btnTeamDefault").onclick = () => { if (confirm("Вернуть составы и пулы по умолчанию?")) { team = defaultTeam(); saveTeam(); renderTeamSheet(); render(); } };
    $("#btnRefreshData").onclick = async () => {
      Object.keys(localStorage).filter(k => k.startsWith(LS.mu) || k.startsWith(LS.items)).forEach(store.del);
      matchups.clear(); itemPop.clear(); setStatus("loading");
      await loadStats(true); await ensureMatchups(); toast("Статистика обновлена");
    };
    $("#dataStatus").onclick = () => toast(dataMode === "live"
      ? "Винрейты Divine/Immortal и про-пики с OpenDota, матчапы подгружаются под пики"
      : "Нет доступа к OpenDota — используется встроенная база контрпиков");
    $("#onlyPool").onchange = e => { onlyPool = e.target.checked; render(); };

    document.querySelectorAll(".sheet-wrap").forEach(w => {
      w.addEventListener("click", e => {
        if (e.target === w || e.target.closest("[data-close]")) {
          w.hidden = true; if (w.id === "picker") closePicker();
        }
      });
    });
    $("#attrSeg").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      pickerAttr = b.dataset.attr;
      $("#attrSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
      renderPicker();
    });
    $("#pickerSearch").addEventListener("input", () => { kbIndex = 0; renderPicker(); });
    $("#pickerSearch").addEventListener("keydown", e => {
      const list = pickerMatches();
      if (e.key === "Enter" && list[kbIndex]) { e.preventDefault(); choose(list[kbIndex].id); }
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); kbIndex = Math.min(list.length - 1, kbIndex + 1); renderPicker(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); kbIndex = Math.max(0, kbIndex - 1); renderPicker(); }
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { document.querySelectorAll(".sheet-wrap").forEach(w => (w.hidden = true)); closePicker(); return; }
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
      const anyOpen = [...document.querySelectorAll(".sheet-wrap")].some(w => !w.hidden);
      if (!typing && !anyOpen && e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        openPicker({ title: "Пик соперника", sub: "Быстрый ввод: Enter — добавить сопернику", onPick: addEnemy, query: e.key });
      }
    });
  }

  // ---------- boot ----------
  bind();
  setStatus("loading");
  render();
  preloadImages();
  loadStats(false).then(ensureMatchups);
})();
