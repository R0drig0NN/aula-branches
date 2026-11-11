/* Tier List da Pelada
   Quem tem o link se cadastra (nome, foto e uma senha de 4 números), vota nos outros e vê a tier list.
   O administrador abre e encerra as votações e cuida do elenco.
   Os dados ficam no Firestore; quem pode fazer o quê está em firestore.rules. */
import { firebaseConfig, useEmulators } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

/* ---------- regras do jogo ---------- */
const TIERS = [
  { k: 'S', label: 'Monstro', score: 5 },
  { k: 'A', label: 'Jogou bem', score: 4 },
  { k: 'B', label: 'Na média', score: 3 },
  { k: 'C', label: 'Ficou devendo', score: 2 },
  { k: 'D', label: 'Bagre', score: 1 },
];
const TIER_KEYS = TIERS.map(t => t.k);
// O 00 fica acima do S: um jogador só, o mais escolhido como melhor do futebol na última rodada.
const ROWS = [{ k: '00', label: 'O melhor' }, ...TIERS];
const ROW_KEYS = ROWS.map(t => t.k);
const rankScore = t => (t === '00' ? 6 : SCORE[t] || 0);
const SCORE = Object.fromEntries(TIERS.map(t => [t.k, t.score]));
// A imagem exportada repete as cores --tier-* do style.css (o canvas não lê variáveis CSS).
const TIER_HEX = { '00': '#D4A017', S: '#E95656', A: '#F59B3D', B: '#F9E27A', C: '#3BA463', D: '#7A7FF0' };

const state = {
  phase: 'boot', // boot | config | error | ready
  errorText: '',
  uid: null, authProblem: '', readProblem: '',
  players: new Map(), rounds: new Map(), setup: null,
  ballots: new Map(), ballotsFresh: new Set(), ballotSubs: new Map(),
  got: { players: false, rounds: false, setup: false },
  vote: null, form: null, image: null, busy: false,
  sheetClose: null, confirmYes: null, lastFocus: null,
  filling: new Set(), canShareFiles: false, ver: 0,
};
let F = null; // funções do Firestore + auth + db, depois que o Firebase carrega

/* ---------- html com escape automático ---------- */
const RAW = Symbol('raw');
const raw = s => ({ [RAW]: String(s) });
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
function fmt(v) {
  if (v == null || v === false || v === true) return '';
  if (Array.isArray(v)) return v.map(fmt).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += fmt(vals[i]) + strings[i + 1];
  return raw(out);
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const setHTML = (el, h) => { el.innerHTML = h[RAW]; };

/* ---------- formatação ---------- */
const round1 = x => Math.round(x * 10) / 10;
const fmtAvg = x => round1(x).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDay = ts => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const fmtDate = ts => new Date(ts).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR', { sensitivity: 'base' });
const tierVar = k => `--tc:var(--tier-${String(k).toLowerCase()})`;
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 24);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => (Number.isFinite(+v) ? +v : 0);
const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
function tierFor(avg) { const a = round1(avg); return a >= 4.5 ? 'S' : a >= 3.5 ? 'A' : a >= 2.5 ? 'B' : a >= 1.5 ? 'C' : 'D'; }
function initials(name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  const first = [...w[0]];
  return (w.length > 1 ? first[0] + [...w[w.length - 1]][0] : first.slice(0, 2).join('')).toUpperCase();
}
function hueFor(s) { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
function newId(prefix) { const a = new Uint8Array(6); crypto.getRandomValues(a); return prefix + Date.now().toString(36) + [...a].map(b => (b % 36).toString(36)).join(''); }
function slug(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'rodada'; }
const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- fotos: guardadas como data URL, exibidas como blob URL ---------- */
const photoUrls = new Map();
function photoSrc(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  let url = photoUrls.get(dataUrl);
  if (url) return url;
  try {
    const comma = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    photoUrls.set(dataUrl, url);
  } catch { url = null; }
  return url;
}

async function photoToDataUrl(file) {
  let src;
  try { src = await createImageBitmap(file); } catch {
    src = await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  const w = src.width, h = src.height, side = Math.min(w, h);
  if (!side) throw new Error('empty');
  const sx = (w - side) / 2, sy = h > w ? (h - side) * 0.25 : (h - side) / 2;
  const S = Math.min(256, side);
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, S, S);
  ctx.drawImage(src, sx, sy, side, side, 0, 0, S, S);
  if (src.close) src.close();
  for (const q of [0.82, 0.7, 0.55]) {
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 150000) return url;
  }
  throw new Error('too big');
}

/* ---------- dados ---------- */
const playerList = () => [...state.players.values()].sort(byName);
function me() {
  if (!state.uid) return null;
  let found = null;
  for (const p of state.players.values()) if (p.owners.includes(state.uid) && (!found || p.createdAt < found.createdAt)) found = p;
  return found;
}
const isAdmin = () => { const m = me(); return !!(m && state.setup && state.setup.adminPlayer === m.id); };
const adminPlayer = () => (state.setup ? state.players.get(state.setup.adminPlayer) || null : null);
const roundList = () => [...state.rounds.values()].sort((a, b) => b.createdAt - a.createdAt);
const openRounds = () => roundList().filter(r => r.status === 'open');
const closedRounds = () => roundList().filter(r => r.status === 'closed');
const currentOpenRound = () => openRounds()[0] || null;
// A rodada em andamento: "playing" (pelada rolando, contando gols) ou "open" (votação aberta).
const currentRound = () => roundList().find(r => r.status !== 'closed') || null;
const goalsOf = (r, pid) => (r && r.goals && r.goals[pid]) || 0;
function goalsMap(g) {
  const out = {};
  if (g && typeof g === 'object') for (const [k, v] of Object.entries(g)) { const n = Math.max(0, Math.floor(Number(v) || 0)); if (n) out[k] = n; }
  return out;
}
const totalGoals = pid => roundList().reduce((s, r) => s + goalsOf(r, pid), 0);
const ballotsOf = rid => state.ballots.get(rid) || new Map();

// Quem participa: numa rodada aberta, todo o elenco menos quem o admin marcou como fora.
// Numa encerrada, a lista congelada no encerramento.
function participantsOf(r) {
  if (r.status === 'closed') {
    if (r.result && r.result.players) return Object.keys(r.result.players);
    if (r.participants) return r.participants.filter(pid => state.players.has(pid));
  }
  const absent = new Set(r.absent);
  return playerList().map(p => p.id).filter(pid => !absent.has(pid));
}
function othersOf(r, voter) { return participantsOf(r).filter(pid => pid !== voter).map(pid => state.players.get(pid)).filter(Boolean).sort(byName); }
function ballotState(r, pid) {
  const b = ballotsOf(r.id).get(pid);
  const others = participantsOf(r).filter(x => x !== pid);
  if (!b) return { kind: 'none', missing: others.length };
  const missing = others.filter(x => !SCORE[b.ratings[x]]).length;
  return { kind: missing ? 'partial' : 'done', missing };
}
function allDone(r) {
  const parts = participantsOf(r);
  return parts.length >= 2 && parts.every(pid => ballotState(r, pid).kind === 'done');
}

function computeResult(r) {
  const parts = participantsOf(r);
  const stats = new Map(parts.map(pid => [pid, { n: 0, sum: 0, sq: 0, dist: { S: 0, A: 0, B: 0, C: 0, D: 0 } }]));
  let voters = 0;
  const rev = {}, best = {}, keeper = {};
  for (const [voter, ballot] of ballotsOf(r.id)) {
    if (!stats.has(voter)) continue;
    const pick = ballot.revelation;
    if (pick && pick !== voter && stats.has(pick)) rev[pick] = (rev[pick] || 0) + 1;
    const top = ballot.best;
    if (top && top !== voter && stats.has(top)) best[top] = (best[top] || 0) + 1;
    const gk = ballot.keeper;
    if (gk && gk !== voter && stats.has(gk)) keeper[gk] = (keeper[gk] || 0) + 1;
    let counted = false;
    for (const [pid, t] of Object.entries(ballot.ratings || {})) {
      if (pid === voter || !stats.has(pid) || !SCORE[t]) continue;
      const st = stats.get(pid), s = SCORE[t];
      st.n++; st.sum += s; st.sq += s * s; st.dist[t]++; counted = true;
    }
    if (counted) voters++;
  }
  const players = {};
  for (const pid of parts) {
    const st = stats.get(pid), p = state.players.get(pid);
    const out = { name: p ? p.name : '', n: st.n, dist: st.dist, avg: null, sd: null, tier: null, rev: rev[pid] || 0, best: best[pid] || 0, keeper: keeper[pid] || 0 };
    if (st.n) {
      const avg = st.sum / st.n;
      out.avg = Math.round(avg * 1000) / 1000;
      out.sd = Math.round(Math.sqrt(Math.max(0, st.sq / st.n - avg * avg)) * 1000) / 1000;
      out.tier = tierFor(avg);
    }
    players[pid] = out;
  }
  return { voters, players };
}
// Resultado guardado pelo admin, ou calculado aqui a partir dos votos (rodada encerrada pelo último voto).
function resultFor(r) {
  if (r.result && r.result.players) return r.result;
  if (r.status === 'closed' && state.ballots.has(r.id)) return computeResult(r);
  return null;
}
function resultEntries(r) {
  const res = resultFor(r);
  if (!res) return [];
  return Object.keys(res.players || {}).map(pid => {
    const s = res.players[pid] || {};
    const dist = {};
    for (const k of TIER_KEYS) dist[k] = Math.max(0, num(s.dist && s.dist[k]));
    const n = Math.max(0, num(s.n));
    const avg = n && Number.isFinite(+s.avg) ? +s.avg : null;
    const p = state.players.get(pid);
    return { id: pid, name: p ? p.name : (str(s.name, 24) || 'Ex-jogador'), photo: p ? p.photo : null, goals: goalsOf(r, pid), rev: Math.max(0, num(s.rev)), best: Math.max(0, num(s.best)), keeper: Math.max(0, num(s.keeper)), n, dist, avg, sd: num(s.sd), tier: avg == null ? null : (TIER_KEYS.includes(s.tier) ? s.tier : tierFor(avg)) };
  });
}
// A tier list da pelada: média de cada jogador em todas as rodadas encerradas (cada rodada pesa igual).
function overallEntries(rounds = closedRounds()) {
  const acc = new Map();
  for (const r of rounds) {
    for (const e of resultEntries(r)) {
      if (!e.n) continue;
      const a = acc.get(e.id) || { sum: 0, rounds: 0, goals: 0, e };
      a.sum += e.avg; a.rounds++; a.goals += e.goals;
      acc.set(e.id, a);
    }
  }
  return [...acc.values()].filter(a => state.players.has(a.e.id)).map(({ sum, rounds, goals, e }) => {
    const avg = sum / rounds;
    return { id: e.id, name: e.name, photo: e.photo, goals, avg, n: rounds, tier: tierFor(avg), sub: plural(rounds, 'rodada', 'rodadas') };
  });
}
// Quem subiu, caiu ou entrou na tier list com a última rodada.
// Quem recebeu mais escolhas de "melhor do futebol" numa rodada. Empate: maior média.
function bestOf(r, entries) {
  if (!r) return null;
  const picks = new Map(resultEntries(r).filter(e => e.best > 0).map(e => [e.id, e.best]));
  const pool = entries.filter(e => picks.has(e.id));
  if (!pool.length) return null;
  pool.sort((a, b) => (picks.get(b.id) - picks.get(a.id)) || ((b.avg || 0) - (a.avg || 0)) || byName(a, b));
  return { id: pool[0].id, votes: picks.get(pool[0].id) };
}
function withBest(entries, r) {
  const top = bestOf(r, entries);
  return entries.map(e => (top && e.id === top.id ? { ...e, tier: '00', bestVotes: top.votes } : e));
}
function mainEntries() {
  const closed = closedRounds();
  const before = closed.length > 1 ? new Map(withBest(overallEntries(closed.slice(1)), closed[1]).map(e => [e.id, e])) : null;
  return withBest(overallEntries(closed), closed[0]).map(e => {
    let move = null;
    if (before) {
      const b = before.get(e.id);
      if (!b) move = { kind: 'new' };
      else if (rankScore(e.tier) !== rankScore(b.tier)) move = { kind: rankScore(e.tier) > rankScore(b.tier) ? 'up' : 'down', from: b.tier };
    }
    const o = overallRatings().get(e.id);
    return { ...e, move, ovr: o ? o.ovr : OVR_START, sub: `OVR ${o ? o.ovr : OVR_START}` };
  });
}

// Overall, como no FIFA: todo mundo começa com 70. Depois de cada rodada encerrada, quem jogou
// ganha ou perde conforme a faixa em que ficou na tier list depois daquela rodada.
const OVR_START = 70;
const OVR_DELTA = { '00': 3, S: 2, A: 1, B: 0, C: -1, D: -2 };
let ovrCache = { ver: -1, map: null };
function overallRatings() {
  if (ovrCache.map && ovrCache.ver === state.ver) return ovrCache.map;
  const map = new Map();
  const closed = closedRounds().slice().reverse(); // da mais antiga para a mais nova
  for (let k = 0; k < closed.length; k++) {
    const r = closed[k];
    const played = new Set(resultEntries(r).filter(e => e.n > 0).map(e => e.id));
    if (!played.size) continue;
    for (const e of withBest(overallEntries(closed.slice(0, k + 1)), r)) {
      if (!played.has(e.id)) continue;
      const cur = map.get(e.id) || { ovr: OVR_START, delta: 0, round: null };
      const d = OVR_DELTA[e.tier] || 0;
      cur.ovr = Math.max(1, Math.min(99, cur.ovr + d));
      cur.delta = d; cur.round = r.id;
      map.set(e.id, cur);
    }
  }
  ovrCache = { ver: state.ver, map };
  return map;
}
const ovrOf = pid => { const o = overallRatings().get(pid); return o ? o.ovr : OVR_START; };
function lastDelta(pid) {
  const o = overallRatings().get(pid), last = closedRounds()[0];
  return o && last && o.round === last.id ? o.delta : null;
}
const signed = d => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0');
function groupRows(entries) {
  const rows = { '00': [], S: [], A: [], B: [], C: [], D: [] };
  for (const e of entries) if (e.tier && rows[e.tier]) rows[e.tier].push(e);
  for (const k of ROW_KEYS) rows[k].sort((a, b) => (b.avg - a.avg) || byName(a, b));
  return rows;
}
function playerHistory(pid) {
  const out = [];
  for (const r of closedRounds()) { const e = resultEntries(r).find(x => x.id === pid); if (e && e.n) out.push(e); }
  return out;
}

/* ---------- peças ---------- */
const ICON_DL = raw('<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
const ICON_TICK = raw('<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>');

function avatar(p, cls = '') {
  const src = p && p.photo ? photoSrc(p.photo) : null;
  return html`<span class="av ${cls}" style="--h:${hueFor((p && (p.id || p.name)) || '')}"><b aria-hidden="true">${initials(p && p.name)}</b>${src ? html`<img src="${src}" alt="" decoding="async">` : ''}</span>`;
}
function chip(e, mine, sel) {
  if (mine) {
    return html`<button type="button" class="chip ${sel === e.id ? 'sel' : ''}" data-act="focus" data-pid="${e.id}" data-fk="chip-${e.id}" draggable="true" data-drag-pid="${e.id}" aria-label="${e.name}: ${e.tier ? 'tier ' + e.tier : 'sem tier'}. Toque para mudar.">${avatar(e)}<span class="cap">${e.name}</span></button>`;
  }
  return html`<figure class="chip">${avatar(e)}${goalBadge(e.goals)}${moveBadge(e.move)}<figcaption class="cap">${e.name}${e.sub ? html`<small>${e.sub}</small>` : ''}</figcaption>${e.avg != null ? html`<span class="score" aria-label="média ${fmtAvg(e.avg)}">${fmtAvg(e.avg)}</span>` : ''}</figure>`;
}
function moveBadge(m) {
  if (!m) return '';
  if (m.kind === 'new') return html`<span class="move new">novo</span>`;
  return html`<span class="move ${m.kind}" aria-label="${m.kind === 'up' ? 'subiu' : 'caiu'} do ${m.from}">${m.kind === 'up' ? '▲' : '▼'}</span>`;
}
function goalBadge(n) {
  return n > 0 ? html`<span class="goals" aria-label="${plural(n, 'gol', 'gols')}">⚽${n > 1 ? ' ' + n : ''}</span>` : '';
}
function board(rows, extraClass = '') {
  return html`<div class="board ${extraClass}">${ROWS.map(t => html`
    <div class="tier" style="${tierVar(t.k)}" role="group" aria-label="Tier ${t.k}, ${t.label}: ${plural(rows[t.k].length, 'jogador', 'jogadores')}">
      <div class="tier-label"><span>${t.k}</span><small>${t.label}</small></div>
      <div class="tier-items">${rows[t.k].map(e => chip(e))}${t.k === '00' && !rows[t.k].length && !extraClass ? html`<p class="bench-done">Ninguém ainda: sai da escolha de melhor do futebol.</p>` : ''}</div>
    </div>`)}</div>`;
}
const emptyBoard = () => board({ '00': [], S: [], A: [], B: [], C: [], D: [] }, 'preview');
const RULE = html`<p class="rule">Cada voto vale <b>S 5 · A 4 · B 3 · C 2 · D 1</b>. A média de cada um decide o tier: S a partir de 4,5, A de 3,5, B de 2,5, C de 1,5. Na tier list da pelada, vale a média de todas as rodadas. O 00 é quem recebeu mais escolhas de melhor do futebol na última rodada.</p>`;

function howItWorks() {
  return html`<ol class="steps">
    <li><span><b>Cadastre-se</b>Nome, foto e uma senha de 4 números, para entrar de outro celular se precisar.</span></li>
    <li><span><b>Acabou o jogo? Abre a votação</b>Quem abre é o administrador. Só vota e recebe voto quem jogou.</span></li>
    <li><span><b>Todo mundo vota</b>Cada um coloca os outros em S, A, B, C ou D. Ninguém vota em si mesmo, e a página não mostra quem votou em quem.</span></li>
    <li><span><b>A tier list atualiza</b>Quando o último votar, os votos da rodada entram na conta e a tier list da pelada é atualizada. Dá para mandar a imagem no grupo.</span></li>
  </ol>`;
}
function joinActions(big = true) {
  if (!state.uid) return html`<p class="muted">Conectando…</p>`;
  return html`<div class="actions"><button type="button" class="btn primary ${big ? 'big' : ''}" data-act="register">Me cadastrar</button><button type="button" class="btn" data-act="claim">Já tenho cadastro</button></div>`;
}

function whoItem(p, st, goals = 0) {
  if (!st) return html`<li class="who-item">${avatar(p)}${goalBadge(goals)}<span class="who-name">${p.name}</span></li>`;
  const cls = st.kind === 'done' ? 'done' : st.kind === 'partial' ? 'partial' : 'pending';
  const mark = st.kind === 'done' ? html`<i class="tick">${ICON_TICK}</i><span class="sr">já votou</span>`
    : st.kind === 'partial' ? html`<i class="tick half" aria-hidden="true">${st.missing}</i><span class="sr">falta votar em ${st.missing}</span>`
    : html`<span class="sr">ainda não votou</span>`;
  return html`<li class="who-item ${cls}">${avatar(p)}${goalBadge(goals)}<span class="who-name">${p.name}</span>${mark}</li>`;
}
function myRoundStatus(r, m) {
  if (!m) return html`<div class="mine-status"><p>Jogou hoje? Cadastre seu nome e sua foto para votar.</p>${joinActions()}</div>`;
  if (r.absent.includes(m.id)) return html`<div class="mine-status"><p class="muted">Você está marcado como fora desta rodada. Se jogou, fale com o administrador.</p></div>`;
  if (!othersOf(r, m.id).length) return html`<div class="mine-status"><p class="muted">Ainda não tem ninguém para você votar. Chame a galera para se cadastrar.</p></div>`;
  const st = ballotState(r, m.id);
  if (st.kind === 'done') return html`<div class="mine-status"><p class="done-line">${ICON_TICK}Seu voto está registrado.</p><div class="actions"><a class="btn ghost" href="#votar">Mudar meu voto</a></div></div>`;
  if (st.kind === 'partial') return html`<div class="mine-status"><p>Entrou gente depois do seu voto. Falta votar em ${plural(st.missing, 'pessoa', 'pessoas')}.</p><div class="actions"><a class="btn primary big" href="#votar">Completar meu voto</a></div></div>`;
  return html`<div class="mine-status"><div class="actions"><a class="btn primary big" href="#votar">Votar agora</a></div></div>`;
}
function openRoundCard(r) {
  const parts = participantsOf(r).map(pid => state.players.get(pid)).filter(Boolean);
  const states = new Map(parts.map(p => [p.id, ballotState(r, p.id)]));
  const done = parts.filter(p => states.get(p.id).kind === 'done').length;
  return html`<section class="card round-open">
    <div class="round-head">
      <span class="pill"><i class="dot"></i>Votação aberta</span>
      <h2>${r.title}</h2>
      <p class="muted"><span class="count">${done} de ${parts.length}</span> já votaram. Quando o último votar, a tier list é atualizada.</p>
    </div>
    <div class="segments" aria-hidden="true">${parts.map(p => html`<i class="${states.get(p.id).kind === 'done' ? 'on' : ''}"></i>`)}</div>
    <ul class="who">${parts.map(p => whoItem(p, states.get(p.id), goalsOf(r, p.id)))}</ul>
    ${myRoundStatus(r, me())}
    ${isAdmin() ? html`<div class="actions"><a class="btn small ghost" href="#admin">Gerenciar votação</a></div>` : ''}
  </section>`;
}

function goalList(r, parts) {
  return html`<ul class="goal-list">${parts.map(p => {
    const g = goalsOf(r, p.id);
    return html`<li class="goal-row">${avatar(p)}<span class="admin-name">${p.name}</span>
      <div class="stepper">
        <button type="button" class="step" data-act="goal-minus" data-rid="${r.id}" data-pid="${p.id}" aria-label="Tirar um gol de ${p.name}" ${g ? '' : raw('disabled')}>−</button>
        <span class="goal-count" aria-label="${plural(g, 'gol', 'gols')}">${g}</span>
        <button type="button" class="step plus" data-act="goal-plus" data-rid="${r.id}" data-pid="${p.id}" aria-label="Gol de ${p.name}">+</button>
      </div></li>`;
  })}</ul>`;
}
function playingCard(r) {
  const parts = participantsOf(r).map(pid => state.players.get(pid)).filter(Boolean);
  const total = parts.reduce((sum, p) => sum + goalsOf(r, p.id), 0);
  const admin = isAdmin();
  return html`<section class="card round-open">
    <div class="round-head">
      <span class="pill"><i class="dot"></i>Pelada rolando</span>
      <h2>${r.title}</h2>
      <p class="muted"><span class="count">${plural(total, 'gol', 'gols')}</span> até agora. ${admin ? 'Toque no + quando alguém fizer gol.' : 'A votação abre quando o jogo acabar.'}</p>
    </div>
    ${admin ? goalList(r, parts) : html`<ul class="who">${parts.map(p => whoItem(p, null, goalsOf(r, p.id)))}</ul>`}
    ${admin ? html`<div class="actions"><button type="button" class="btn primary big" data-act="start-voting" data-rid="${r.id}">Acabou! Abrir votação</button><a class="btn small ghost" href="#admin">Quem jogou</a></div>`
      : me() ? '' : html`<div class="mine-status"><p>Vai votar depois do jogo? Já deixa seu cadastro pronto.</p>${joinActions()}</div>`}
  </section>`;
}
const roundCard = r => (r.status === 'playing' ? playingCard(r) : openRoundCard(r));

function bestCard(entries) {
  const max = Math.max(0, ...entries.map(e => e.best || 0));
  if (!max) return '';
  const tops = entries.filter(e => e.best === max).sort(byName);
  return html`<div class="hl">${avatar(tops[0])}<span class="hl-k">O melhor do futebol (00)</span><span class="hl-name">${tops.map(e => e.name).join(' e ')}</span><span class="hl-v">👑 ${plural(max, 'voto', 'votos')}${tops.length > 1 ? ' cada, desempate pela média' : ''}</span></div>`;
}
function keeperCard(entries) {
  const max = Math.max(0, ...entries.map(e => e.keeper || 0));
  if (!max) return '';
  const tops = entries.filter(e => e.keeper === max).sort(byName);
  return html`<div class="hl">${avatar(tops[0])}<span class="hl-k">Melhor goleiro</span><span class="hl-name">${tops.map(e => e.name).join(' e ')}</span><span class="hl-v">🧤 ${plural(max, 'voto', 'votos')}</span></div>`;
}
// Time da rodada: o goleiro mais votado, o melhor do futebol mais votado e os três com as maiores médias.
function teamOfRound(entries) {
  const top = (key, pool) => {
    const max = Math.max(0, ...pool.map(e => e[key] || 0));
    if (!max) return null;
    return pool.filter(e => e[key] === max).sort((a, b) => ((b.avg || 0) - (a.avg || 0)) || byName(a, b))[0];
  };
  const gk = top('keeper', entries);
  const best = top('best', entries.filter(e => e !== gk));
  const used = new Set([gk && gk.id, best && best.id]);
  const others = entries.filter(e => e.n > 0 && !used.has(e.id)).sort((a, b) => (b.avg - a.avg) || byName(a, b)).slice(0, 3);
  if (!gk && !best && !others.length) return null;
  return { gk, best, others };
}
function teamBlock(entries) {
  const t = teamOfRound(entries);
  if (!t) return '';
  const spot = (e, tag) => html`<figure class="spot">${avatar(e)}<figcaption>${e.name}<small>${tag}</small></figcaption></figure>`;
  return html`<section class="team">
    <div class="round-head"><h3>Time da rodada</h3><p class="muted small">Goleiro e melhor do futebol pelos votos; os outros três pelas maiores médias.</p></div>
    <div class="pitch">
      <div class="pitch-row">${t.best ? spot(t.best, '00 · melhor') : ''}</div>
      <div class="pitch-row">${t.others.map(e => spot(e, `média ${fmtAvg(e.avg)}`))}</div>
      <div class="pitch-row">${t.gk ? spot(t.gk, 'goleiro') : html`<p class="pitch-empty">Sem votos para goleiro nesta rodada</p>`}</div>
    </div>
  </section>`;
}
function highlightsBlock(entries) {
  const rated = entries.filter(e => e.n > 0).sort((a, b) => (b.avg - a.avg) || byName(a, b));
  if (!rated.length) return '';
  const best = rated[0];
  const worst = rated.length > 1 && round1(rated[rated.length - 1].avg) < round1(best.avg) ? rated[rated.length - 1] : null;
  const hot = rated.filter(e => e.n >= 2 && e.sd > 0 && e !== best && e !== worst).sort((a, b) => (b.sd - a.sd) || byName(a, b))[0] || null;
  const spread = e => { const ks = TIER_KEYS.filter(k => e.dist[k] > 0); return ks.length > 1 ? `votos de ${ks[0]} a ${ks[ks.length - 1]}` : `todos os votos ${ks[0]}`; };
  const maxRev = Math.max(0, ...entries.map(e => e.rev || 0));
  const revs = maxRev ? entries.filter(e => e.rev === maxRev).sort(byName) : [];
  const maxGoals = Math.max(0, ...entries.map(e => e.goals || 0));
  const scorers = maxGoals ? entries.filter(e => e.goals === maxGoals).sort(byName) : [];
  const cards = [
    scorers.length ? html`<div class="hl">${avatar(scorers[0])}<span class="hl-k">${scorers.length > 1 ? 'Artilheiros' : 'Artilheiro'}</span><span class="hl-name">${scorers.map(e => e.name).join(' e ')}</span><span class="hl-v">⚽ ${plural(maxGoals, 'gol', 'gols')}</span></div>` : '',
    bestCard(entries),
    keeperCard(entries),
    revs.length ? html`<div class="hl">${avatar(revs[0])}<span class="hl-k">Revelação da rodada</span><span class="hl-name">${revs.map(e => e.name).join(' e ')}</span><span class="hl-v">⭐ ${plural(maxRev, 'voto', 'votos')}</span></div>` : '',
    html`<div class="hl">${avatar(best)}<span class="hl-k">Craque da rodada</span><span class="hl-name">${best.name}</span><span class="hl-v">média ${fmtAvg(best.avg)}</span></div>`,
    hot ? html`<div class="hl">${avatar(hot)}<span class="hl-k">Mais polêmico</span><span class="hl-name">${hot.name}</span><span class="hl-v">${spread(hot)}</span></div>` : '',
    worst ? html`<div class="hl">${avatar(worst)}<span class="hl-k">Bagre da rodada</span><span class="hl-name">${worst.name}</span><span class="hl-v">média ${fmtAvg(worst.avg)}</span></div>` : '',
  ].filter(Boolean);
  return html`<div class="highlights" style="--n:${cards.length}">${cards}</div>`;
}
function distBlock(entries) {
  const rated = entries.filter(e => e.n > 0).sort((a, b) => (b.avg - a.avg) || byName(a, b));
  if (!rated.length) return '';
  return html`<section class="dist">
    <div class="round-head"><h3>Como cada um foi votado</h3><p class="muted small">Aparece quantos votos de cada tier a pessoa recebeu, nunca quem deu.</p></div>
    <ol class="dist-list">${rated.map(e => {
      const squares = [], said = [];
      for (const k of TIER_KEYS) {
        for (let i = 0; i < e.dist[k]; i++) squares.push(html`<span class="v" style="${tierVar(k)}">${k}</span>`);
        if (e.dist[k]) said.push(`${e.dist[k]} ${k}`);
      }
      return html`<li class="dist-row">${avatar(e)}<span class="dist-name">${e.name}</span><span class="dist-avg"><span class="badge" style="${tierVar(e.tier)}" aria-label="tier ${e.tier}">${e.tier}</span>${fmtAvg(e.avg)}</span><span class="votes" role="img" aria-label="${plural(e.n, 'voto', 'votos')}: ${said.join(', ')}">${squares}</span></li>`;
    })}</ol>
    ${RULE}
  </section>`;
}
function resultBlock(r, { detail = false, eyebrow = '' } = {}) {
  const res = resultFor(r);
  if (!res) return html`<section class="result"><div class="result-title">${eyebrow ? html`<p class="eyebrow">${eyebrow}</p>` : ''}<h2>${r.title}</h2><p class="muted">Calculando a tier list…</p></div>${emptyBoard()}</section>`;
  const entries = resultEntries(r);
  const rated = entries.filter(e => e.n > 0);
  const unrated = entries.filter(e => !e.n);
  const voters = num(res.voters);
  return html`<section class="result">
    <div class="result-head">
      <div class="result-title">
        ${eyebrow ? html`<p class="eyebrow">${eyebrow}</p>` : ''}
        <h2>${r.title}</h2>
        <p class="muted">${fmtDate(r.closedAt || r.createdAt)} · ${plural(voters, 'pessoa votou', 'pessoas votaram')}</p>
      </div>
      <button type="button" class="btn" data-act="image" data-rid="${r.id}">${ICON_DL}Imagem da tier list</button>
    </div>
    ${board(groupRows(withBest(rated, r)))}
    ${unrated.length ? html`<p class="muted small">Sem votos nesta rodada: ${unrated.map(e => e.name).join(', ')}.</p>` : ''}
    ${detail ? teamBlock(entries) : ''}
    ${highlightsBlock(entries)}
    ${detail ? distBlock(entries) : html`<a class="more" href="#rodada-${r.id}">Ver como cada um foi votado</a>`}
    ${detail && isAdmin() ? html`<div class="actions"><button type="button" class="btn small" data-act="reopen-round" data-rid="${r.id}">Reabrir votação</button><button type="button" class="btn small ghost danger" data-act="delete-round" data-rid="${r.id}">Apagar rodada</button></div>` : ''}
  </section>`;
}

/* ---------- telas ---------- */
function viewConfig() {
  return html`<section class="card">
    <p class="eyebrow">Falta um passo</p>
    <h2>Ligar o banco de dados</h2>
    <p>O site já está no ar, mas ainda não sabe onde guardar os cadastros e os votos. O passo a passo completo está no README do repositório e leva uns 15 minutos:</p>
    <ol class="steps">
      <li><span><b>Crie um projeto no Firebase</b>Em console.firebase.google.com, com uma conta Google. É grátis.</span></li>
      <li><span><b>Ligue o login anônimo</b>Authentication › Método de login › Anônimo.</span></li>
      <li><span><b>Crie o Firestore e publique as regras</b>Cole o conteúdo do arquivo <code>firestore.rules</code> na aba Regras.</span></li>
      <li><span><b>Cole a configuração</b>No arquivo <code>firebase-config.js</code>, troque cada COLE_AQUI pelos valores do seu projeto.</span></li>
    </ol>
  </section>${emptyBoard()}`;
}
function viewLoading() {
  return html`<section class="result"><div class="result-title"><p class="eyebrow">Carregando</p><h2>Buscando a resenha…</h2></div>${emptyBoard()}</section>`;
}

function mainTierBlock() {
  const closed = closedRounds();
  if (!closed.length) return html`<section class="result"><div class="result-title"><p class="eyebrow">A tier list da pelada</p><h2>Ainda sem tier list</h2><p class="muted">Ela nasce na primeira rodada e é atualizada depois de cada uma.</p></div>${emptyBoard()}</section>`;
  const last = closed[0];
  const entries = mainEntries();
  const moved = entries.filter(e => e.move).sort(byName);
  const said = moved.map(e => e.tier === '00' ? `${e.name} virou o 00` : e.move.kind === 'new' ? `${e.name} entrou no ${e.tier}` : `${e.name} ${e.move.kind === 'up' ? 'subiu' : 'caiu'} para ${e.tier}`);
  return html`<section class="result">
    <div class="result-head">
      <div class="result-title"><p class="eyebrow">A tier list da pelada</p><h2>Tier list</h2>
        <p class="muted">Atualizada com a rodada ${last.title} · média de ${plural(closed.length, 'rodada', 'rodadas')}</p></div>
      <button type="button" class="btn" data-act="image-overall">${ICON_DL}Imagem da tier list</button>
    </div>
    ${board(groupRows(entries))}
    ${said.length ? html`<p class="changes"><b>O que mudou nessa rodada:</b> ${said.join(', ')}.</p>` : closed.length > 1 ? html`<p class="muted small">Ninguém mudou de tier na última rodada.</p>` : ''}
    <p class="rule"><b>OVR</b> é o overall: todo mundo começa com 70 e, a cada rodada que joga, ganha ou perde conforme a faixa em que ficou: <b>00 +3 · S +2 · A +1 · B 0 · C −1 · D −2</b>. Veja o de todo mundo no Elenco.</p>
  </section>`;
}
function lastRoundBlock(r) {
  const res = resultFor(r);
  if (!res) return '';
  return html`<section class="result">
    <div class="result-title"><p class="eyebrow">Última rodada</p><h2>${r.title}</h2><p class="muted">${fmtDate(r.closedAt || r.createdAt)} · ${plural(num(res.voters), 'pessoa votou', 'pessoas votaram')}</p></div>
    ${teamBlock(resultEntries(r))}
    ${highlightsBlock(resultEntries(r))}
    <a class="more" href="#rodada-${r.id}">Ver os votos dessa rodada</a>
  </section>`;
}
// Artilharia: todos os gols, somando todas as rodadas (inclusive a que está rolando).
function scorers() {
  const list = playerList().map(p => ({ ...p, goals: totalGoals(p.id), rounds: roundList().filter(r => goalsOf(r, p.id) > 0).length })).filter(e => e.goals > 0);
  list.sort((a, b) => (b.goals - a.goals) || byName(a, b));
  for (const e of list) e.pos = 1 + list.filter(o => o.goals > e.goals).length;
  return list;
}
function podium(list) {
  const top = list.filter(e => e.pos <= 3);
  if (!top.length) return '';
  return html`<ol class="podium">${top.slice(0, 3).map((e, i) => html`<li class="pod p${e.pos} i${i}"><span class="pod-pos">${e.pos}º</span>${avatar(e, 'lg')}<span class="pod-name">${e.name}</span><span class="pod-goals">⚽ ${plural(e.goals, 'gol', 'gols')}</span></li>`)}</ol>`;
}
function scorersCard() {
  const list = scorers();
  if (!list.length) return '';
  return html`<section class="result">
    <div class="result-title"><p class="eyebrow">Somando todas as rodadas</p><h2>Artilharia</h2></div>
    ${podium(list)}
    <a class="more" href="#artilharia">Ver a artilharia completa</a>
  </section>`;
}
function viewScorers() {
  const list = scorers();
  return html`<section class="stack">
    <div class="round-head"><p class="eyebrow">Somando todas as rodadas</p><h2>Artilharia</h2><p class="muted">Os gols contados pelo administrador em cada pelada vão se somando aqui.</p></div>
    ${list.length ? html`${podium(list)}
    <ol class="scorers">${list.map(e => html`<li class="scorer-row"><span class="scorer-pos">${e.pos}º</span>${avatar(e)}<span class="admin-name">${e.name}</span><span class="admin-sub">${plural(e.rounds, 'rodada com gol', 'rodadas com gol')}</span><span class="scorer-goals">${e.goals}</span></li>`)}</ol>`
      : html`<div class="card"><h3>Ninguém marcou ainda</h3><p class="muted">Durante a pelada, o administrador conta os gols e eles aparecem aqui.</p></div>`}
  </section>`;
}
function viewHome() {
  const m = me();
  const open = currentRound();
  const last = closedRounds()[0];
  const blocks = [];
  if (!state.players.size) blocks.push(html`<section class="card"><p class="eyebrow">Como funciona</p><h2>A votação acaba com a discussão</h2>${howItWorks()}${joinActions()}</section>`);
  if (open) blocks.push(roundCard(open));
  else if (isAdmin()) blocks.push(html`<section class="card cta"><div class="round-head"><h2>Vai ter pelada?</h2><p class="muted">Comece a rodada para contar os gols. Quando o jogo acabar, você abre a votação.</p></div><div class="actions"><button type="button" class="btn primary big" data-act="new-round" ${state.players.size < 2 ? raw('disabled') : ''}>Começar pelada</button></div></section>`);
  else if (!m && state.players.size) blocks.push(html`<section class="card"><h2>Você joga nessa pelada?</h2><p class="muted">Cadastre seu nome e sua foto. Depois do jogo, a votação aparece aqui.</p>${joinActions()}</section>`);
  else if (state.players.size) blocks.push(html`<section class="card"><h2>Nenhuma votação aberta</h2><p class="muted">Depois do jogo, o administrador abre a votação e ela aparece aqui.</p></section>`);
  blocks.push(mainTierBlock());
  blocks.push(scorersCard());
  if (last) blocks.push(lastRoundBlock(last));
  return html`${blocks}`;
}

function viewHistory() {
  const all = roundList();
  const top = r => resultEntries(r).filter(e => e.n).sort((a, b) => (b.avg - a.avg) || byName(a, b)).slice(0, 3);
  return html`
  <section class="stack">
    <div class="section-head"><div class="round-head"><h2>Rodadas</h2><p class="muted">Cada rodada atualiza a tier list da página inicial. Aqui fica como foi cada uma.</p></div><span class="muted">${plural(all.length, 'rodada', 'rodadas')}</span></div>
    ${all.length ? html`<ul class="rounds">${all.map(r => {
      const res = resultFor(r);
      const best = res ? top(r) : [];
      const meta = r.status === 'playing' ? `Pelada rolando · ${plural(participantsOf(r).reduce((sum, pid) => sum + goalsOf(r, pid), 0), 'gol', 'gols')}`
        : r.status === 'open'
        ? `Votação aberta · ${participantsOf(r).filter(pid => ballotState(r, pid).kind === 'done').length} de ${participantsOf(r).length} votaram`
        : res ? [plural(num(res.voters), 'voto', 'votos'), best[0] ? `craque: ${best[0].name}` : ''].filter(Boolean).join(' · ') : 'Calculando…';
      return html`<li><a class="round-link" href="${r.status !== 'closed' ? '#inicio' : '#rodada-' + r.id}">
        <span class="rl-date">${fmtDay(r.createdAt)}</span>
        <span class="rl-title">${r.title}</span>
        <span class="rl-meta">${meta}</span>
        <span class="rl-top">${r.status !== 'closed' ? html`<span class="pill"><i class="dot"></i>${r.status === 'playing' ? 'Rolando' : 'Aberta'}</span>` : best.map(e => avatar(e))}</span>
      </a></li>`;
    })}</ul>` : html`<p class="muted">Nenhuma rodada ainda. Depois do jogo, o administrador abre a primeira.</p>`}
  </section>`;
}

function viewRoster() {
  const ps = playerList().sort((a, b) => (ovrOf(b.id) - ovrOf(a.id)) || byName(a, b));
  const m = me(), admin = isAdmin();
  return html`<section class="stack">
    <div class="section-head">
      <div class="round-head"><h2>Elenco</h2><p class="muted">${plural(ps.length, 'jogador', 'jogadores')}, do maior overall para o menor${m ? '. Toque no seu cartão para mudar nome, foto ou senha.' : '.'}</p></div>
      ${m ? '' : joinActions(false)}
    </div>
    ${ps.length ? html`<div class="roster">${ps.map(p => {
      const hist = playerHistory(p.id);
      const avg = hist.length ? hist.reduce((s, e) => s + e.avg, 0) / hist.length : null;
      const tag = m && m.id === p.id ? 'Você' : state.setup && state.setup.adminPlayer === p.id ? 'Admin' : '';
      const d = lastDelta(p.id);
      const inner = html`${avatar(p)}${tag ? html`<span class="tag">${tag}</span>` : ''}<span class="ovr" aria-label="overall ${ovrOf(p.id)}"><b>${ovrOf(p.id)}</b><small>OVR</small></span>${d ? html`<span class="ovr-delta ${d > 0 ? 'up' : 'down'}">${signed(d)} na última</span>` : ''}<span class="fig-name">${p.name}</span><span class="fig-meta">${[hist.length ? `${plural(hist.length, 'rodada', 'rodadas')} · média ${fmtAvg(avg)}` : 'Ainda sem rodada', totalGoals(p.id) ? `⚽ ${plural(totalGoals(p.id), 'gol', 'gols')}` : ''].filter(Boolean).join(' · ')}</span><span class="fig-trail" aria-label="${hist.length ? 'Últimos tiers: ' + hist.slice(0, 5).map(e => e.tier).join(', ') : 'Sem tiers ainda'}">${hist.slice(0, 5).map(e => html`<span class="badge mini" style="${tierVar(e.tier)}">${e.tier}</span>`)}</span>`;
      if (m && m.id === p.id) return html`<button type="button" class="fig" data-act="profile">${inner}</button>`;
      if (admin) return html`<button type="button" class="fig" data-act="admin-edit" data-pid="${p.id}">${inner}</button>`;
      return html`<div class="fig">${inner}</div>`;
    })}</div>` : html`<div class="card"><h3>Ninguém cadastrado ainda</h3><p class="muted">Seja o primeiro: nome, foto e uma senha de 4 números.</p>${joinActions(false)}</div>`}
  </section>`;
}

function viewRound(rid) {
  const r = state.rounds.get(rid);
  const back = html`<a class="back" href="#historico">← Histórico</a>`;
  if (!r) return html`<div class="stack">${back}<section class="card"><h2>Rodada não encontrada</h2><p class="muted">Ela pode ter sido apagada.</p></section></div>`;
  if (r.status !== 'closed') return html`<div class="stack">${back}${roundCard(r)}</div>`;
  return html`<div class="stack">${back}${resultBlock(r, { detail: true, eyebrow: 'Votos da rodada' })}</div>`;
}

/* ---------- votação ---------- */
function nextUnrated(r, v, after) {
  const ids = othersOf(r, v.voter).map(p => p.id);
  if (!ids.length) return null;
  const start = after ? ids.indexOf(after) + 1 : 0;
  for (let i = 0; i < ids.length; i++) { const pid = ids[(start + i) % ids.length]; if (!v.ratings[pid]) return pid; }
  return null;
}
function ensureVote(r, m) {
  let v = state.vote;
  const saved = ballotsOf(r.id).get(m.id);
  if (!v || v.rid !== r.id || v.voter !== m.id) v = state.vote = { rid: r.id, voter: m.id, ratings: {}, current: null, dirty: false };
  if (!v.dirty && saved && !Object.keys(v.ratings).length) { v.ratings = { ...saved.ratings }; v.revelation = saved.revelation || null; v.best = saved.best || null; v.keeper = saved.keeper || null; }
  const ids = new Set(othersOf(r, m.id).map(p => p.id));
  for (const pid of Object.keys(v.ratings)) if (!ids.has(pid) || !SCORE[v.ratings[pid]]) delete v.ratings[pid];
  if (v.current && !ids.has(v.current)) v.current = null;
  if (v.revelation && !ids.has(v.revelation)) v.revelation = null;
  if (v.best && !ids.has(v.best)) v.best = null;
  if (v.keeper && !ids.has(v.keeper)) v.keeper = null;
  if (!v.current && !v.dirty) v.current = nextUnrated(r, v, null);
  return v;
}
function rateCard(r, v) {
  const others = othersOf(r, v.voter);
  const done = others.filter(p => v.ratings[p.id]).length;
  const cur = v.current ? state.players.get(v.current) : null;
  if (!cur) {
    if (done < others.length) return html`<div class="card rate-card"><p class="eyebrow">${done} de ${others.length} no quadro</p><h3>Falta gente no quadro</h3><p class="muted">Toque numa foto em "Faltam" para colocar no quadro.</p></div>`;
    return html`<div class="card rate-card">
      <p class="eyebrow">Últimos passos</p>
      <h3>O melhor do futebol</h3>
      <p class="muted">Quem é o melhor da pelada? O mais escolhido vira o 00 da tier list.</p>
      <div class="rev-grid">${others.map(p => html`<button type="button" class="rev ${v.best === p.id ? 'on' : ''}" data-act="pick-best" data-pid="${p.id}" data-fk="best-${p.id}" aria-pressed="${v.best === p.id ? 'true' : 'false'}">${avatar(p)}<span>${p.name}</span></button>`)}</div>
      <h3>Melhor goleiro</h3>
      <p class="muted">Quem pegou mais no gol?</p>
      <div class="rev-grid">${others.map(p => html`<button type="button" class="rev ${v.keeper === p.id ? 'on' : ''}" data-act="pick-keeper" data-pid="${p.id}" data-fk="gk-${p.id}" aria-pressed="${v.keeper === p.id ? 'true' : 'false'}">${avatar(p)}<span>${p.name}</span></button>`)}</div>
      <h3>Revelação da rodada</h3>
      <p class="muted">Quem surpreendeu nesta pelada? Escolha uma pessoa.</p>
      <div class="rev-grid">${others.map(p => html`<button type="button" class="rev ${v.revelation === p.id ? 'on' : ''}" data-act="pick-rev" data-pid="${p.id}" data-fk="rev-${p.id}" aria-pressed="${v.revelation === p.id ? 'true' : 'false'}">${avatar(p)}<span>${p.name}</span></button>`)}</div>
      <p class="muted small">Quer mudar o tier de alguém? Toque na foto no quadro.</p>
    </div>`;
  }
  const pos = others.findIndex(p => p.id === cur.id) + 1;
  const mine = v.ratings[cur.id];
  return html`<div class="card rate-card">
    <p class="eyebrow">${pos} de ${others.length}</p>
    ${avatar(cur, 'xl')}
    <h3>${cur.name}</h3>
    <p class="muted">Em que tier fica nesta pelada?</p>
    <div class="tier-buttons">${TIERS.map(t => html`<button type="button" class="tb ${mine === t.k ? 'on' : ''}" style="${tierVar(t.k)}" data-act="rate" data-tier="${t.k}" data-fk="tb-${t.k}" aria-pressed="${mine === t.k ? 'true' : 'false'}" aria-label="${t.k}: ${t.label}"><b>${t.k}</b><small>${t.label}</small></button>`)}</div>
    <p class="kbd-hint">No teclado: S, A, B, C ou D.</p>
  </div>`;
}
function voteBoard(r, v) {
  const rows = { S: [], A: [], B: [], C: [], D: [] };
  const bench = [];
  for (const p of othersOf(r, v.voter)) {
    const t = v.ratings[p.id];
    const e = { id: p.id, name: p.name, photo: p.photo, tier: t || null };
    if (t && rows[t]) rows[t].push(e); else bench.push(e);
  }
  return html`<div class="board mine">
    ${TIERS.map(t => html`<div class="tier" style="${tierVar(t.k)}" data-drop-tier="${t.k}"><div class="tier-label"><span>${t.k}</span><small>${t.label}</small></div><div class="tier-items">${rows[t.k].map(e => chip(e, true, v.current))}</div></div>`)}
    <div class="tier bench" data-drop-tier=""><div class="tier-label"><span>?</span><small>Faltam</small></div><div class="tier-items">${bench.length ? bench.map(e => chip(e, true, v.current)) : html`<p class="bench-done">Todo mundo no quadro.</p>`}</div></div>
  </div>`;
}
function viewVote() {
  const r = currentOpenRound();
  const back = html`<a class="back" href="#inicio">← Rodada</a>`;
  if (!r && currentRound()) return html`<div class="stack">${back}<section class="card"><h2>A pelada está rolando</h2><p class="muted">A votação abre quando o jogo acabar.</p></section></div>`;
  if (!r) return html`<div class="stack">${back}<section class="card"><h2>Nenhuma votação aberta</h2><p class="muted">Depois do jogo, o administrador abre a votação e ela aparece aqui.</p></section></div>`;
  const m = me();
  if (!m) return html`<div class="stack">${back}<section class="card"><p class="eyebrow">${r.title}</p><h2>Cadastre-se para votar</h2><p class="muted">Nome, foto e uma senha de 4 números. Leva um minuto.</p>${joinActions()}</section></div>`;
  if (r.absent.includes(m.id)) return html`<div class="stack">${back}<section class="card"><h2>Você está fora desta rodada</h2><p class="muted">O administrador marcou que você não jogou. Se jogou, fale com ele.</p></section></div>`;
  const others = othersOf(r, m.id);
  if (!others.length) return html`<div class="stack">${back}<section class="card"><h2>Ainda não tem em quem votar</h2><p class="muted">Chame a galera para se cadastrar pelo link.</p></section></div>`;
  const v = ensureVote(r, m);
  const missing = others.filter(p => !v.ratings[p.id]).length;
  const saved = ballotsOf(r.id).has(m.id);
  return html`<section class="stack vote">
    <div class="vote-top">${back}<p class="muted">${r.title} · votando como <b>${m.name}</b></p></div>
    <div class="vote-layout">
      ${rateCard(r, v)}
      <div class="stack">
        <div class="section-head"><h3>Seu quadro</h3><span class="muted small">${others.length - missing} de ${others.length}</span></div>
        ${voteBoard(r, v)}
        <p class="muted small">Toque numa foto para mudar o tier. No computador, dá para arrastar.</p>
      </div>
    </div>
    <div class="submit-bar"><button type="button" class="btn primary big" data-act="submit-vote" data-fk="submit" ${missing || !v.revelation || !v.best || !v.keeper ? raw('disabled') : ''}>${missing ? `Falta${missing > 1 ? 'm' : ''} ${missing}` : !v.best ? 'Escolha o melhor (00)' : !v.keeper ? 'Escolha o goleiro' : !v.revelation ? 'Escolha a revelação' : saved ? 'Atualizar meu voto' : 'Enviar meus votos'}</button></div>
  </section>`;
}

/* ---------- admin ---------- */
function viewAdmin() {
  const m = me();
  if (!state.setup) {
    if (!m) return html`<section class="card"><p class="eyebrow">Administrador</p><h2>Ainda não tem administrador</h2><p class="muted">Primeiro faça seu cadastro. Depois volte aqui para virar o administrador.</p>${joinActions(false)}</section>`;
    return html`<section class="card"><p class="eyebrow">Administrador</p><h2>Ainda não tem administrador</h2><p>O administrador abre e encerra as votações, marca quem jogou e cuida do elenco.</p><p class="muted">Só uma pessoa vira administrador: quem tocar no botão primeiro. Faça isso antes de mandar o link para a galera.</p><div class="actions"><button type="button" class="btn primary big" data-act="become-admin">Virar administrador</button></div></section>`;
  }
  if (!isAdmin()) {
    const a = adminPlayer();
    return html`<section class="card"><p class="eyebrow">Administrador</p><h2>Área do administrador</h2>
      <p class="muted">${a ? `Quem administra esta pelada é ${a.name}. Só essa pessoa mexe aqui.` : 'O administrador saiu do elenco. Para escolher outro, apague o documento config/setup no console do Firebase.'}</p>
      ${a && !m ? html`<p class="muted">Se você é ${a.name} e está em outro aparelho, entre com "Já tenho cadastro".</p>${joinActions(false)}` : ''}
    </section>`;
  }
  return html`${adminRoundSection()}${adminPlayersSection()}${adminHistorySection()}${adminLinkSection()}`;
}
function playedSwitch(r, p) {
  return html`<label class="switch"><input type="checkbox" data-absent-pid="${p.id}" ${r.absent.includes(p.id) ? '' : raw('checked')}>Jogou</label>`;
}
function adminRoundSection() {
  const r = currentRound();
  if (!r) return html`<section class="card cta"><div class="round-head"><p class="eyebrow">Rodada</p><h2>Nenhuma pelada rolando</h2><p class="muted">Antes do jogo, comece a rodada para contar os gols. Quando acabar, você abre a votação.</p></div><div class="actions"><button type="button" class="btn primary big" data-act="new-round" ${state.players.size < 2 ? raw('disabled') : ''}>Começar pelada</button></div></section>`;
  if (r.status === 'playing') {
    const parts = participantsOf(r).map(pid => state.players.get(pid)).filter(Boolean);
    const out = playerList().filter(p => r.absent.includes(p.id));
    return html`<section class="card">
      <div class="round-head"><span class="pill"><i class="dot"></i>Pelada rolando</span><h2>${r.title}</h2><p class="muted">Toque no + quando alguém fizer gol. Só você vê esses botões; a galera vê os gols junto da foto.</p></div>
      ${goalList(r, parts)}
      <div class="actions"><button type="button" class="btn primary big" data-act="start-voting" data-rid="${r.id}">Acabou! Abrir votação</button></div>
      <h3>Quem jogou</h3>
      <ul class="admin-list">${playerList().map(p => html`<li class="admin-row">${avatar(p)}<span class="admin-name">${p.name}</span><span class="admin-sub">${r.absent.includes(p.id) ? 'Não jogou' : plural(goalsOf(r, p.id), 'gol', 'gols')}</span>${playedSwitch(r, p)}</li>`)}</ul>
      ${out.length ? '' : html`<p class="muted small">Quem se cadastrar agora entra na rodada.</p>`}
    </section>`;
  }
  const absent = new Set(r.absent);
  const parts = participantsOf(r);
  const done = parts.filter(pid => ballotState(r, pid).kind === 'done').length;
  const voted = parts.filter(pid => ballotState(r, pid).kind !== 'none').length;
  return html`<section class="card">
    <div class="round-head"><span class="pill"><i class="dot"></i>Votação aberta</span><h2>${r.title}</h2>
      <p class="muted"><span class="count">${done} de ${parts.length}</span> já votaram. Desmarque quem não jogou: a pessoa não vota nem recebe voto. Quem se cadastrar agora entra na rodada.</p></div>
    <ul class="admin-list">${playerList().map(p => {
      const out = absent.has(p.id);
      const st = out ? null : ballotState(r, p.id);
      const sub = out ? html`<span class="admin-sub">Não jogou</span>`
        : st.kind === 'done' ? html`<span class="admin-sub ok">Votou</span>`
        : st.kind === 'partial' ? html`<span class="admin-sub warn">Falta votar em ${st.missing}</span>`
        : html`<span class="admin-sub">Ainda não votou</span>`;
      return html`<li class="admin-row">${avatar(p)}<span class="admin-name">${p.name}</span>${sub}${playedSwitch(r, p)}</li>`;
    })}</ul>
    <div class="actions"><button type="button" class="btn primary" data-act="close-round" data-rid="${r.id}" ${voted ? '' : raw('disabled')}>Encerrar e montar a tier list</button></div>
    <h3>Gols</h3>
    ${goalList(r, parts.map(pid => state.players.get(pid)).filter(Boolean))}
  </section>`;
}
function adminPlayersSection() {
  const ps = playerList();
  return html`<section class="card">
    <div class="section-head"><div class="round-head"><p class="eyebrow">Elenco</p><h2>Jogadores</h2></div><span class="muted">${plural(ps.length, 'jogador', 'jogadores')}</span></div>
    ${ps.length ? html`<ul class="admin-list">${ps.map(p => html`<li class="admin-row">${avatar(p)}<span class="admin-name">${p.name}${state.setup.adminPlayer === p.id ? ' · admin' : ''}</span><span class="admin-sub">${p.owners.length ? plural(p.owners.length, 'aparelho conectado', 'aparelhos conectados') : 'Nenhum aparelho conectado'}</span><div class="actions"><button type="button" class="btn small" data-act="admin-edit" data-pid="${p.id}">Editar</button></div></li>`)}</ul>` : html`<p class="muted">Ninguém cadastrado ainda.</p>`}
  </section>`;
}
function adminHistorySection() {
  const rs = closedRounds();
  if (!rs.length) return '';
  return html`<section class="card">
    <div class="round-head"><p class="eyebrow">Histórico</p><h2>Rodadas encerradas</h2></div>
    <ul class="admin-list">${rs.map(r => {
      const res = resultFor(r);
      return html`<li class="admin-row"><span class="admin-date">${fmtDay(r.createdAt)}</span><span class="admin-name">${r.title}</span><span class="admin-sub">${res ? plural(num(res.voters), 'voto', 'votos') : 'Calculando…'}</span><div class="actions row-actions"><a class="btn small ghost" href="#rodada-${r.id}">Ver</a><button type="button" class="btn small" data-act="reopen-round" data-rid="${r.id}">Reabrir</button><button type="button" class="btn small ghost danger" data-act="delete-round" data-rid="${r.id}">Apagar</button></div></li>`;
    })}</ul>
  </section>`;
}
function adminLinkSection() {
  return html`<section class="card">
    <div class="round-head"><p class="eyebrow">Convite</p><h2>Link para a galera</h2><p class="muted">Mande no grupo. Quem abrir se cadastra e vota, sem precisar criar conta.</p></div>
    <div class="share-link"><code id="shareUrl">${location.origin + location.pathname}</code><button type="button" class="btn" data-act="copy-link">Copiar link</button></div>
  </section>`;
}

/* ---------- desenho da tela ---------- */
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (['votar', 'historico', 'elenco', 'admin', 'artilharia'].includes(h)) return { name: h };
  const m = /^rodada-([A-Za-z0-9]+)$/.exec(h);
  if (m) return { name: 'rodada', rid: m[1] };
  return { name: 'inicio' };
}
const tabOf = r => (r.name === 'rodada' ? 'historico' : r.name === 'votar' ? 'inicio' : r.name);
function go(hash) { if (location.hash === '#' + hash) renderNow(); else location.hash = hash; }

let queued = false;
function render() { if (queued) return; queued = true; Promise.resolve().then(renderNow); }
function renderNow() {
  queued = false;
  const r = route();
  const ready = state.phase === 'ready' && state.got.players && state.got.rounds && state.got.setup;
  const admin = ready && isAdmin();
  $('#adminTab').hidden = !admin;
  $('#adminLink').hidden = admin;
  for (const a of $$('.tabs a')) a.setAttribute('aria-current', a.dataset.tab === tabOf(r) ? 'page' : 'false');
  $('#mastMeta').textContent = ready ? `${plural(state.players.size, 'jogador', 'jogadores')} · ${plural(closedRounds().length, 'rodada', 'rodadas')}` : 'Votação pós-jogo';
  const m = ready ? me() : null;
  setHTML($('#meChip'), m ? html`<button type="button" class="me-chip" data-act="profile" aria-label="Meu cadastro: ${m.name}">${avatar(m)}<span>${m.name}</span></button>`
    : ready && state.uid ? html`<button type="button" class="me-chip join" data-act="register">Me cadastrar</button>` : html``);
  const notes = [];
  if (state.authProblem) notes.push(html`<p class="note">${state.authProblem}</p>`);
  if (state.readProblem) notes.push(html`<p class="note">${state.readProblem}</p>`);
  setHTML($('#banner'), html`${notes}`);
  const fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
  let view;
  if (state.phase === 'config') view = viewConfig();
  else if (state.phase === 'error') view = html`<p class="note">${state.errorText}</p>${emptyBoard()}`;
  else if (!ready) view = viewLoading();
  else if (r.name === 'votar') view = viewVote();
  else if (r.name === 'historico') view = viewHistory();
  else if (r.name === 'elenco') view = viewRoster();
  else if (r.name === 'artilharia') view = viewScorers();
  else if (r.name === 'admin') view = viewAdmin();
  else if (r.name === 'rodada') view = viewRound(r.rid);
  else view = viewHome();
  setHTML($('#view'), view);
  if (fk) { const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`); if (el) el.focus({ preventScroll: true }); }
}

/* ---------- avisos ---------- */
let toastTimer = 0;
function toast(msg, ms = 3400) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms); }
function hideToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }
function setBusy(b) { state.busy = b; document.body.setAttribute('aria-busy', b ? 'true' : 'false'); }
function showErr(sel, msg) { const el = $(sel); if (!el) return; el.textContent = msg || ''; el.hidden = !msg; }
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code: 'timeout' }), ms))]); }
async function attempt(fn) {
  try { await withTimeout(fn(), 20000); return { ok: true }; }
  catch (error) { console.warn(error); return { ok: false, error }; }
}
const errCode = e => String((e && e.code) || '');
function writeMessage(e) {
  const c = errCode(e);
  if (c === 'timeout' || c.includes('unavailable')) return 'A conexão está ruim. Confira a internet e tente de novo.';
  if (c.includes('permission-denied')) return 'O banco recusou essa ação. Recarregue a página e tente de novo.';
  if (c.includes('resource-exhausted')) return 'O limite gratuito do Firebase acabou por hoje. Amanhã volta.';
  return 'Não deu para salvar. Tente de novo.';
}
function readMessage(e) {
  const c = errCode(e);
  if (c.includes('permission-denied')) return 'O banco recusou a leitura. Confira se as regras do arquivo firestore.rules foram publicadas no Firebase.';
  if (c.includes('not-found') || c.includes('failed-precondition')) return 'O banco de dados ainda não foi criado no Firebase (Firestore Database › Criar banco de dados).';
  return 'Não deu para ler os dados agora. Recarregue a página.';
}
function authMessage(e) {
  const c = errCode(e);
  if (c.includes('operation-not-allowed') || c.includes('admin-restricted')) return 'O login anônimo está desligado no Firebase. Ligue em Authentication › Método de login › Anônimo.';
  if (c.includes('api-key') || c.includes('invalid-api-key')) return 'A apiKey do arquivo firebase-config.js está errada.';
  if (c.includes('network')) return 'Sem internet. Recarregue a página quando a conexão voltar.';
  return 'Não deu para conectar. Recarregue a página.';
}

/* ---------- janelas ---------- */
function openSheet(content, onClose) {
  const prev = state.sheetClose; state.sheetClose = null;
  if (prev) prev();
  const host = $('#sheet');
  if (host.hidden) state.lastFocus = document.activeElement;
  setHTML(host, html`<div class="sheet-backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">${content}</div>`);
  host.hidden = false;
  document.body.classList.add('sheet-open');
  state.sheetClose = onClose || null;
  setTimeout(() => { const f = host.querySelector('[autofocus]') || host.querySelector('input:not([type=file]):not([type=checkbox]):not([type=radio]), .sheet button'); if (f) f.focus(); }, 30);
}
function closeSheet() {
  const host = $('#sheet');
  if (host.hidden) return;
  host.hidden = true; host.innerHTML = '';
  document.body.classList.remove('sheet-open');
  const cb = state.sheetClose; state.sheetClose = null;
  if (cb) cb();
  const lf = state.lastFocus; state.lastFocus = null;
  if (lf && document.contains(lf)) lf.focus({ preventScroll: true });
}
function confirmSheet({ title, body, ok, danger = false }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    openSheet(html`<h2 id="sheetTitle">${title}</h2><p class="muted">${body}</p>
      <div class="sheet-actions"><button type="button" class="btn ghost" data-act="close-sheet">Cancelar</button><button type="button" class="btn ${danger ? 'danger-solid' : 'primary'}" data-act="confirm-yes" autofocus>${ok}</button></div>`, () => finish(false));
    state.confirmYes = () => { state.confirmYes = null; finish(true); closeSheet(); };
  });
}
const clearForm = () => { state.form = null; };
function photoField(p) {
  return html`<div class="photo-field"><div id="pfPreview">${avatar(p || { id: 'novo', name: '' }, 'xl')}</div>
    <div class="photo-actions"><button type="button" class="btn" data-act="pick-photo">${p && p.photo ? 'Trocar foto' : 'Escolher foto'}</button>${p && p.photo ? html`<button type="button" class="link" data-act="remove-photo">Tirar a foto</button>` : ''}<input type="file" id="pfFile" accept="image/*" hidden><p class="hint">Uma foto de rosto. Ela é cortada em quadrado.</p></div></div>`;
}
function nameTaken(name, exceptPid) {
  const lower = name.toLocaleLowerCase('pt-BR');
  return playerList().find(p => p.id !== exceptPid && p.name.toLocaleLowerCase('pt-BR') === lower) || null;
}

/* ---------- cadastro, entrar de outro aparelho, meu cadastro ---------- */
function openRegisterSheet() {
  if (!state.uid) return toast('Conectando… tente de novo em instantes.');
  if (me()) return openProfileSheet();
  state.form = { kind: 'register', photo: null };
  openSheet(html`<form id="registerForm" class="form" novalidate>
    <h2 id="sheetTitle">Entrar na pelada</h2>
    ${photoField(null)}
    <label class="field-label" for="pfName">Nome ou apelido</label>
    <input class="input" id="pfName" maxlength="24" autocomplete="nickname" required autofocus>
    <label class="field-label" for="pfPin">Senha de 4 números</label>
    <input class="input pin" id="pfPin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" required>
    <p class="hint">Serve para entrar de outro celular ou navegador. Não precisa ser segura, só não esqueça.</p>
    <p class="form-error" id="pfError" hidden></p>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-act="close-sheet">Cancelar</button><button type="submit" class="btn primary">Entrar na pelada</button></div>
  </form>`, clearForm);
}
async function saveRegister(form) {
  const f = state.form; if (!f) return;
  const name = cleanName(form.querySelector('#pfName').value);
  const pin = form.querySelector('#pfPin').value.trim();
  if (!name) return showErr('#pfError', 'Escreva seu nome ou apelido.');
  if (!/^\d{4}$/.test(pin)) return showErr('#pfError', 'A senha precisa ter 4 números.');
  const dup = nameTaken(name);
  if (dup) return showErr('#pfError', `Já tem ${dup.name} no elenco. Se for você, use "Já tenho cadastro".`);
  if (!state.uid) return showErr('#pfError', 'Conectando… tente de novo em instantes.');
  const pid = newId('p');
  setBusy(true);
  const res = await attempt(() => {
    const b = F.writeBatch(F.db);
    b.set(F.doc(F.db, 'players', pid), { name, photo: f.photo || null, owners: [state.uid], createdAt: Date.now() });
    b.set(F.doc(F.db, 'pins', pid), { pin });
    return b.commit();
  });
  setBusy(false);
  if (!res.ok) return showErr('#pfError', writeMessage(res.error));
  closeSheet();
  toast(`Bem-vindo, ${name}!`);
  const r = currentOpenRound();
  if (r && !r.absent.includes(pid)) go('votar'); else renderNow();
}

function openClaimSheet() {
  if (!state.uid) return toast('Conectando… tente de novo em instantes.');
  const ps = playerList();
  if (!ps.length) return openRegisterSheet();
  state.form = { kind: 'claim' };
  openSheet(html`<form id="claimForm" class="form" novalidate>
    <h2 id="sheetTitle">Já tenho cadastro</h2>
    <p class="muted">Escolha seu nome e digite a sua senha de 4 números.</p>
    <div class="pick-grid">${ps.map(p => html`<label class="pick"><input type="radio" name="pid" value="${p.id}">${avatar(p)}<span>${p.name}</span></label>`)}</div>
    <label class="field-label" for="clPin">Senha</label>
    <input class="input pin" id="clPin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off">
    <p class="form-error" id="clError" hidden></p>
    <p class="hint">Esqueceu a senha? Peça ao administrador uma senha nova.</p>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-act="close-sheet">Cancelar</button><button type="submit" class="btn primary">Entrar</button></div>
  </form>`, clearForm);
}
async function saveClaim(form) {
  const picked = form.querySelector('input[name=pid]:checked');
  const pin = form.querySelector('#clPin').value.trim();
  if (!picked) return showErr('#clError', 'Toque no seu nome.');
  if (!/^\d{4}$/.test(pin)) return showErr('#clError', 'A senha tem 4 números.');
  const pid = picked.value, p = state.players.get(pid);
  if (!p) return showErr('#clError', 'Esse jogador não está mais no elenco.');
  setBusy(true);
  const res = await attempt(() => {
    const b = F.writeBatch(F.db);
    b.set(F.doc(F.db, 'claims', state.uid), { pid, pin, at: Date.now() });
    b.update(F.doc(F.db, 'players', pid), { owners: F.arrayUnion(state.uid) });
    return b.commit();
  });
  setBusy(false);
  if (!res.ok) return showErr('#clError', errCode(res.error).includes('permission-denied') ? 'Senha errada. Se esqueceu, peça ao administrador uma senha nova.' : writeMessage(res.error));
  closeSheet();
  toast(`Pronto, ${p.name}! Este aparelho agora está com você.`);
  renderNow();
}

function openProfileSheet() {
  const m = me(); if (!m) return openRegisterSheet();
  state.form = { kind: 'profile', pid: m.id, photo: undefined };
  openSheet(html`<form id="profileForm" class="form" novalidate>
    <h2 id="sheetTitle">Meu cadastro</h2>
    ${photoField(m)}
    <label class="field-label" for="pfName">Nome ou apelido</label>
    <input class="input" id="pfName" maxlength="24" autocomplete="nickname" required value="${m.name}">
    <label class="field-label" for="pfPin">Nova senha (opcional)</label>
    <input class="input pin" id="pfPin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off">
    <p class="hint">Deixe em branco para manter a senha atual.</p>
    <p class="form-error" id="pfError" hidden></p>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-act="leave-device">Sair deste aparelho</button><span class="spacer"></span><button type="button" class="btn ghost" data-act="close-sheet">Cancelar</button><button type="submit" class="btn primary">Salvar</button></div>
  </form>`, clearForm);
}
async function savePlayerEdit(form) {
  const f = state.form; if (!f || !f.pid) return;
  const p = state.players.get(f.pid); if (!p) return closeSheet();
  const name = cleanName(form.querySelector('#pfName').value);
  const pin = form.querySelector('#pfPin').value.trim();
  if (!name) return showErr('#pfError', 'Escreva o nome ou apelido.');
  if (pin && !/^\d{4}$/.test(pin)) return showErr('#pfError', 'A senha precisa ter 4 números.');
  const dup = nameTaken(name, p.id);
  if (dup) return showErr('#pfError', `Já tem ${dup.name} no elenco.`);
  const patch = { name };
  if (f.photo !== undefined) patch.photo = f.photo;
  setBusy(true);
  const res = await attempt(() => {
    const b = F.writeBatch(F.db);
    b.update(F.doc(F.db, 'players', p.id), patch);
    if (pin) b.set(F.doc(F.db, 'pins', p.id), { pin });
    return b.commit();
  });
  setBusy(false);
  if (!res.ok) return showErr('#pfError', writeMessage(res.error));
  closeSheet();
  toast(pin ? `${name} salvo, com senha nova.` : `${name} salvo.`);
}
async function leaveDevice() {
  const m = me(); if (!m) return;
  const yes = await confirmSheet({ title: 'Sair deste aparelho?', body: `Para voltar, use "Já tenho cadastro" com a sua senha.${isAdmin() ? ' Você continua administrador quando entrar de novo.' : ''}`, ok: 'Sair' });
  if (!yes) return;
  setBusy(true);
  const res = await attempt(() => F.updateDoc(F.doc(F.db, 'players', m.id), { owners: F.arrayRemove(state.uid) }));
  setBusy(false);
  state.vote = null;
  toast(res.ok ? 'Você saiu deste aparelho.' : writeMessage(res.error));
}

/* ---------- ações do admin ---------- */
async function becomeAdmin() {
  const m = me(); if (!m || state.setup) return;
  const yes = await confirmSheet({ title: `${m.name} vai ser o administrador?`, body: 'Só dá para fazer uma vez. Para trocar depois, é preciso apagar o documento config/setup no console do Firebase.', ok: 'Sim, sou o administrador' });
  if (!yes) return;
  setBusy(true);
  const res = await attempt(() => F.setDoc(F.doc(F.db, 'config', 'setup'), { adminPlayer: m.id, createdAt: Date.now() }));
  setBusy(false);
  if (res.ok) toast(`Pronto, ${m.name}. Agora você é o administrador.`);
  else toast(errCode(res.error).includes('permission-denied') ? 'Alguém já virou administrador.' : writeMessage(res.error));
}
function openRoundSheet() {
  if (!isAdmin()) return;
  if (currentRound()) return toast('Já tem uma rodada em andamento.');
  const ps = playerList();
  openSheet(html`<form id="roundForm" class="form" novalidate>
    <h2 id="sheetTitle">Começar pelada</h2>
    <label class="field-label" for="rfTitle">Nome da rodada</label>
    <input class="input" id="rfTitle" maxlength="40" value="Pelada de ${fmtDay(Date.now())}">
    <div class="field-label row-between"><span>Quem jogou?</span><span id="rfCount">${ps.length} de ${ps.length}</span></div>
    <div class="check-grid">${ps.map(p => html`<label class="check"><input type="checkbox" name="p" value="${p.id}" checked>${avatar(p, 'sm')}<span>${p.name}</span></label>`)}</div>
    <p class="hint">Durante o jogo você conta os gols. Quando acabar, toca em "Abrir votação". Quem se cadastrar depois entra na rodada sozinho.</p>
    <p class="form-error" id="rfError" hidden></p>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-act="close-sheet">Cancelar</button><button type="submit" class="btn primary">Começar</button></div>
  </form>`);
}
function updateRfCount() {
  const el = $('#rfCount'); if (!el) return;
  el.textContent = `${$$('#roundForm input[name=p]:checked').length} de ${$$('#roundForm input[name=p]').length}`;
}
async function saveRound(form) {
  if (!isAdmin()) return;
  const played = new Set($$('input[name=p]:checked', form).map(i => i.value));
  if (played.size < 2) return showErr('#rfError', 'Marque pelo menos 2 jogadores.');
  if (currentRound()) { closeSheet(); return toast('Já tem uma rodada em andamento.'); }
  const title = String(form.querySelector('#rfTitle').value || '').trim().replace(/\s+/g, ' ').slice(0, 40) || `Pelada de ${fmtDay(Date.now())}`;
  const absent = playerList().map(p => p.id).filter(pid => !played.has(pid));
  const rid = newId('r');
  setBusy(true);
  const res = await attempt(() => F.setDoc(F.doc(F.db, 'rounds', rid), { title, status: 'playing', createdAt: Date.now(), absent, goals: {}, closedAt: null, closedBy: null, participants: null, result: null }));
  setBusy(false);
  if (!res.ok) return showErr('#rfError', writeMessage(res.error));
  closeSheet();
  go('inicio');
  toast('Pelada começou! Conte os gols por aqui.');
}
async function toggleAbsent(input) {
  const r = currentRound(); if (!r || !isAdmin()) return;
  const pid = input.dataset.absentPid, played = input.checked;
  const res = await attempt(() => F.updateDoc(F.doc(F.db, 'rounds', r.id), { absent: played ? F.arrayRemove(pid) : F.arrayUnion(pid) }));
  if (!res.ok) { input.checked = !played; toast(writeMessage(res.error)); }
}
async function changeGoal(rid, pid, delta) {
  const r = state.rounds.get(rid);
  if (!r || r.status === 'closed' || !isAdmin() || !state.players.has(pid)) return;
  if (delta < 0 && goalsOf(r, pid) <= 0) return;
  const res = await attempt(() => F.updateDoc(F.doc(F.db, 'rounds', rid), { ['goals.' + pid]: F.increment(delta) }));
  if (!res.ok) toast(writeMessage(res.error));
}
async function startVoting(rid) {
  const r = state.rounds.get(rid);
  if (!r || r.status !== 'playing' || !isAdmin()) return;
  setBusy(true);
  const res = await attempt(() => F.updateDoc(F.doc(F.db, 'rounds', rid), { status: 'open' }));
  setBusy(false);
  if (!res.ok) return toast(writeMessage(res.error));
  go('inicio');
  toast('Votação aberta! Mande o link no grupo.');
}
async function closeRoundAdmin(rid) {
  const r = state.rounds.get(rid), m = me();
  if (!r || r.status !== 'open' || !isAdmin() || !m) return;
  const parts = participantsOf(r);
  const done = parts.filter(pid => ballotState(r, pid).kind === 'done').length;
  if (done < parts.length) {
    const yes = await confirmSheet({ title: 'Encerrar a votação agora?', body: `${done} de ${parts.length} votaram. A tier list sai com os votos que já entraram e quem não votou fica sem voto dado.`, ok: 'Encerrar e ver a tier list' });
    if (!yes) return;
  }
  const result = computeResult(r);
  if (!result.voters) return toast('Ninguém votou ainda.');
  setBusy(true);
  const res = await attempt(() => F.updateDoc(F.doc(F.db, 'rounds', rid), { status: 'closed', closedAt: Date.now(), closedBy: m.id, participants: parts, result }));
  setBusy(false);
  if (!res.ok) return toast(writeMessage(res.error));
  go('inicio');
  toast('Votação encerrada. A tier list foi atualizada!');
}
async function reopenRound(rid) {
  const r = state.rounds.get(rid); if (!r || !isAdmin()) return;
  if (currentRound()) return toast('Já tem uma rodada em andamento. Encerre ela antes de reabrir esta.');
  const yes = await confirmSheet({ title: `Reabrir ${r.title}?`, body: 'A tier list desta rodada some até a votação ser encerrada de novo. Os votos já dados continuam valendo e quem se cadastrou depois entra na rodada.', ok: 'Reabrir votação' });
  if (!yes) return;
  setBusy(true);
  const res = await attempt(() => F.updateDoc(F.doc(F.db, 'rounds', rid), { status: 'open', closedAt: null, closedBy: null, participants: null, result: null }));
  setBusy(false);
  if (!res.ok) return toast(writeMessage(res.error));
  go('inicio');
  toast('Votação reaberta.');
}
async function deleteRound(rid) {
  const r = state.rounds.get(rid); if (!r || !isAdmin()) return;
  const yes = await confirmSheet({ title: `Apagar ${r.title}?`, body: 'A tier list e os votos desta rodada somem de vez, inclusive da tier list geral.', ok: 'Apagar rodada', danger: true });
  if (!yes) return;
  setBusy(true);
  const res = await attempt(async () => {
    const snap = await F.getDocs(F.collection(F.db, 'rounds', rid, 'ballots'));
    const b = F.writeBatch(F.db);
    snap.docs.forEach(d => b.delete(d.ref));
    b.delete(F.doc(F.db, 'rounds', rid));
    return b.commit();
  });
  setBusy(false);
  if (!res.ok) return toast(writeMessage(res.error));
  go('historico');
  toast('Rodada apagada.');
}
function openAdminPlayerSheet(pid) {
  const p = state.players.get(pid); if (!p || !isAdmin()) return;
  if (me() && me().id === pid) return openProfileSheet();
  state.form = { kind: 'admin', pid, photo: undefined };
  openSheet(html`<form id="adminPlayerForm" class="form" novalidate>
    <h2 id="sheetTitle">Editar ${p.name}</h2>
    ${photoField(p)}
    <label class="field-label" for="pfName">Nome ou apelido</label>
    <input class="input" id="pfName" maxlength="24" autocomplete="off" required value="${p.name}">
    <label class="field-label" for="pfPin">Senha nova (opcional)</label>
    <input class="input pin" id="pfPin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off">
    <p class="hint">Para quando a pessoa esquecer a senha. Ela entra com "Já tenho cadastro" e a senha nova.</p>
    <p class="form-error" id="pfError" hidden></p>
    <div class="sheet-actions">
      <button type="button" class="btn ghost danger" data-act="admin-remove" data-pid="${p.id}">Remover</button>
      ${p.owners.length ? html`<button type="button" class="btn ghost" data-act="admin-unlink" data-pid="${p.id}">Desconectar aparelhos</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" data-act="close-sheet">Cancelar</button>
      <button type="submit" class="btn primary">Salvar</button>
    </div>
  </form>`, clearForm);
}
async function adminUnlink(pid) {
  const p = state.players.get(pid); if (!p || !isAdmin()) return;
  const yes = await confirmSheet({ title: `Desconectar os aparelhos de ${p.name}?`, body: 'Ele vai precisar entrar de novo com "Já tenho cadastro" e a senha. Use quando alguém perder o celular.', ok: 'Desconectar' });
  if (!yes) return openAdminPlayerSheet(pid);
  setBusy(true);
  const res = await attempt(() => F.updateDoc(F.doc(F.db, 'players', pid), { owners: [] }));
  setBusy(false);
  toast(res.ok ? `Aparelhos de ${p.name} desconectados.` : writeMessage(res.error));
}
async function adminRemove(pid) {
  const p = state.players.get(pid); if (!p || !isAdmin()) return;
  const yes = await confirmSheet({ title: `Remover ${p.name}?`, body: 'Sai do elenco e da votação aberta. As tier lists antigas continuam mostrando o nome.', ok: 'Remover', danger: true });
  if (!yes) return openAdminPlayerSheet(pid);
  setBusy(true);
  const res = await attempt(() => { const b = F.writeBatch(F.db); b.delete(F.doc(F.db, 'players', pid)); b.delete(F.doc(F.db, 'pins', pid)); return b.commit(); });
  setBusy(false);
  toast(res.ok ? `${p.name} saiu do elenco.` : writeMessage(res.error));
}
// Rodada encerrada pelo último voto não tem o resultado guardado (só o admin grava).
// Quando o admin abre o site, o resultado é calculado e guardado.
function maybeFillResults() {
  if (state.phase !== 'ready' || !state.got.players || !state.got.setup || !isAdmin()) return;
  for (const r of roundList()) {
    if (r.status !== 'closed' || r.result || state.filling.has(r.id) || !state.ballotsFresh.has(r.id)) continue;
    state.filling.add(r.id);
    const result = computeResult(r);
    attempt(() => F.updateDoc(F.doc(F.db, 'rounds', r.id), { result })).then(res => { if (!res.ok) state.filling.delete(r.id); });
  }
}

/* ---------- ações da votação ---------- */
function rate(tier) {
  const r = currentOpenRound(), v = state.vote;
  if (!r || !v || !v.voter || !v.current || !SCORE[tier]) return;
  v.ratings[v.current] = tier; v.dirty = true;
  v.current = nextUnrated(r, v, v.current);
  renderNow();
  if (!v.current) { const s = $('[data-fk="submit"]'); if (s) s.focus({ preventScroll: true }); }
}
function rateFor(pid, tier) {
  const r = currentOpenRound(), v = state.vote;
  if (!r || !v || !v.voter || !othersOf(r, v.voter).some(p => p.id === pid)) return;
  if (SCORE[tier]) v.ratings[pid] = tier; else delete v.ratings[pid];
  v.dirty = true;
  if (v.current === pid && SCORE[tier]) v.current = nextUnrated(r, v, pid);
  if (!v.current) v.current = nextUnrated(r, v, null);
  renderNow();
}
function pickKeeper(pid) {
  const v = state.vote; if (!v || !v.voter) return;
  v.keeper = pid; v.dirty = true;
  renderNow();
}
function pickBest(pid) {
  const v = state.vote; if (!v || !v.voter) return;
  v.best = pid; v.dirty = true;
  renderNow();
}
function pickRevelation(pid) {
  const v = state.vote; if (!v || !v.voter) return;
  v.revelation = pid; v.dirty = true;
  renderNow();
  const s2 = $('[data-fk="submit"]'); if (s2) s2.focus({ preventScroll: true });
}
function focusPlayer(pid) {
  const v = state.vote; if (!v || !v.voter) return;
  v.current = pid; v.dirty = true;
  renderNow();
  const card = $('.rate-card');
  if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
}
async function submitVote() {
  const r = currentOpenRound(), m = me(), v = state.vote;
  if (!r || !m || !v || v.voter !== m.id) return;
  const ratings = {};
  for (const p of othersOf(r, m.id)) {
    if (!v.ratings[p.id]) return toast('Ainda falta colocar alguém no quadro.');
    ratings[p.id] = v.ratings[p.id];
  }
  const revelation = v.revelation;
  if (!revelation || !othersOf(r, m.id).some(p => p.id === revelation)) return toast('Escolha a revelação da rodada.');
  const best = v.best;
  if (!best || !othersOf(r, m.id).some(p => p.id === best)) return toast('Escolha o melhor do futebol.');
  const keeper = v.keeper;
  if (!keeper || !othersOf(r, m.id).some(p => p.id === keeper)) return toast('Escolha o melhor goleiro.');
  setBusy(true);
  const res = await attempt(() => F.setDoc(F.doc(F.db, 'rounds', r.id, 'ballots', m.id), { voter: m.id, ratings, revelation, best, keeper, updatedAt: Date.now() }));
  if (!res.ok) { setBusy(false); return toast(writeMessage(res.error)); }
  state.vote = null;
  const b = new Map(ballotsOf(r.id)); b.set(m.id, { voter: m.id, ratings, revelation, best, keeper }); state.ballots.set(r.id, b);
  const live = state.rounds.get(r.id);
  if (live && live.status === 'open' && allDone(live)) {
    const patch = { status: 'closed', closedAt: Date.now(), closedBy: m.id, participants: participantsOf(live) };
    if (isAdmin()) patch.result = computeResult(live);
    const closed = await attempt(() => F.updateDoc(F.doc(F.db, 'rounds', r.id), patch));
    setBusy(false);
    if (closed.ok) { go('inicio'); window.scrollTo({ top: 0 }); toast('Todo mundo votou. A tier list foi atualizada!'); return; }
  }
  setBusy(false);
  go('inicio');
  window.scrollTo({ top: 0 });
  toast('Voto registrado!');
}

/* ---------- a imagem da tier list ---------- */
function fitText(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function loadImages(entries) {
  const map = new Map();
  return Promise.all(entries.filter(e => e.photo).map(e => new Promise(res => {
    const src = photoSrc(e.photo); if (!src) return res();
    const img = new Image();
    const done = ok => { clearTimeout(t); if (ok) map.set(e.id, img); res(); };
    const t = setTimeout(() => done(false), 8000);
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = src;
  }))).then(() => map);
}
const DISPLAY = '"Barlow Condensed", "Arial Narrow", sans-serif';
const BODY = '"Barlow", system-ui, sans-serif';
async function drawTierPng({ title, subtitle, entries }) {
  try { await Promise.all([`italic 800 76px ${DISPLAY}`, `800 70px ${DISPLAY}`, `700 22px ${DISPLAY}`, `600 24px ${BODY}`].map(f => document.fonts.load(f))); } catch { /* usa a fonte reserva */ }
  const rows = groupRows(entries);
  const W = 1080, PAD = 40, LABEL = 132, CELL = 112, CAP = 36, GAP = 16, ROWGAP = 6, HEAD = 196, FOOT = 78;
  const itemsX = PAD + LABEL, itemsW = W - PAD - itemsX;
  const perLine = Math.max(1, Math.floor((itemsW - GAP) / (CELL + GAP)));
  const heights = ROW_KEYS.map(k => { const lines = Math.max(1, Math.ceil(rows[k].length / perLine)); return lines * (CELL + CAP) + (lines + 1) * GAP - 6; });
  const H = HEAD + PAD / 2 + heights.reduce((a, b) => a + b, 0) + ROWGAP * (ROW_KEYS.length - 1) + FOOT;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const imgs = await loadImages(entries);

  ctx.fillStyle = '#0F1913'; ctx.fillRect(0, 0, W, H);
  for (let x = 0, i = 0; x < W; x += 72, i++) { ctx.fillStyle = i % 2 ? '#237D47' : '#1F7240'; ctx.fillRect(x, 0, 72, HEAD); }
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, HEAD); ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,.42)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(W - 70, HEAD / 2, 104, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W - 70, 0); ctx.lineTo(W - 70, HEAD); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 22px ${DISPLAY}`; ctx.fillText('TIER LIST DA PELADA', PAD, 56);
  ctx.font = `italic 800 76px ${DISPLAY}`; ctx.fillText(fitText(ctx, title.toUpperCase(), W - PAD * 2 - 190), PAD, 128);
  ctx.font = `600 24px ${BODY}`; ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.fillText(fitText(ctx, subtitle, W - PAD * 2 - 190), PAD, 166);

  let y = HEAD + PAD / 2;
  ROW_KEYS.forEach((k, i) => {
    const h = heights[i];
    ctx.fillStyle = TIER_HEX[k]; rrect(ctx, PAD, y, LABEL - 8, h, 10); ctx.fill();
    ctx.fillStyle = '#1A1712'; ctx.textAlign = 'center';
    ctx.font = `800 70px ${DISPLAY}`; ctx.fillText(k, PAD + (LABEL - 8) / 2, y + h / 2 + 12);
    ctx.font = `700 16px ${DISPLAY}`; ctx.fillText(ROWS[i].label.toUpperCase(), PAD + (LABEL - 8) / 2, y + h / 2 + 38);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#18251D'; rrect(ctx, itemsX, y, itemsW, h, 10); ctx.fill();
    rows[k].forEach((e, j) => {
      const line = Math.floor(j / perLine), col = j % perLine;
      const x = itemsX + GAP + col * (CELL + GAP), yy = y + GAP + line * (CELL + CAP + GAP);
      ctx.save();
      rrect(ctx, x - 3, yy - 3, CELL + 6, CELL + 6, 12); ctx.fillStyle = '#F4F7F2'; ctx.fill();
      rrect(ctx, x, yy, CELL, CELL, 9); ctx.clip();
      const img = imgs.get(e.id);
      if (img) {
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, side = Math.min(iw, ih);
        ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, x, yy, CELL, CELL);
      } else {
        ctx.fillStyle = `hsl(${hueFor(e.id || e.name)}, 34%, 38%)`; ctx.fillRect(x, yy, CELL, CELL);
        ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `800 46px ${DISPLAY}`; ctx.fillText(initials(e.name), x + CELL / 2, yy + CELL / 2 + 2);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
      ctx.restore();
      if (e.goals > 0) {
        const gl = '⚽' + (e.goals > 1 ? ' ' + e.goals : '');
        ctx.font = `800 20px ${DISPLAY}`;
        const gw = ctx.measureText(gl).width + 14;
        rrect(ctx, x - 6, yy - 6, gw, 28, 7); ctx.fillStyle = '#FFFFFF'; ctx.fill();
        ctx.fillStyle = '#0F1913'; ctx.fillText(gl, x + 1, yy + 15);
      }
      if (e.move) {
        const ml = e.move.kind === 'new' ? 'NOVO' : e.move.kind === 'up' ? '▲' : '▼';
        ctx.font = `800 18px ${DISPLAY}`;
        const mw = ctx.measureText(ml).width + 12;
        rrect(ctx, x + CELL - mw + 6, yy - 6, mw, 26, 7); ctx.fillStyle = e.move.kind === 'down' ? '#E5484D' : '#2E9E57'; ctx.fill();
        ctx.fillStyle = '#FFFFFF'; ctx.fillText(ml, x + CELL - mw + 12, yy + 13);
      }
      if (e.ovr) {
        const ol = String(e.ovr);
        ctx.font = `800 22px ${DISPLAY}`;
        const ow = ctx.measureText(ol).width + 14;
        rrect(ctx, x - 6, yy + CELL - 22, ow, 28, 7); ctx.fillStyle = '#D4A017'; ctx.fill();
        ctx.fillStyle = '#1A1712'; ctx.fillText(ol, x + 1, yy + CELL - 1);
      }
      if (e.avg != null) {
        const label = fmtAvg(e.avg);
        ctx.font = `800 21px ${DISPLAY}`;
        const bw = ctx.measureText(label).width + 14;
        rrect(ctx, x + CELL - bw + 6, yy + CELL - 22, bw, 28, 7); ctx.fillStyle = '#0F1913'; ctx.fill();
        ctx.fillStyle = '#FFFFFF'; ctx.fillText(label, x + CELL - bw + 13, yy + CELL - 1);
      }
      ctx.fillStyle = '#E9F1EB'; ctx.textAlign = 'center'; ctx.font = `700 22px ${DISPLAY}`;
      ctx.fillText(fitText(ctx, e.name.toUpperCase(), CELL + GAP - 2), x + CELL / 2, yy + CELL + 28);
      ctx.textAlign = 'left';
    });
    y += h + ROWGAP;
  });
  ctx.fillStyle = '#93A99A'; ctx.font = `600 19px ${BODY}`;
  ctx.fillText(`Cada voto vale S 5 · A 4 · B 3 · C 2 · D 1. O tier sai da média. O 00 é o mais escolhido como melhor.${entries.some(e => e.ovr) ? ' Em dourado, o overall.' : ''}`, PAD, H - FOOT / 2 + 6);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
}
async function showImage(opts) {
  setBusy(true);
  toast('Gerando a imagem…', 8000);
  let blob = null;
  try { blob = await drawTierPng(opts); } catch { blob = null; }
  setBusy(false);
  hideToast();
  if (!blob) return toast('Não deu para gerar a imagem. Tente de novo.');
  const url = URL.createObjectURL(blob);
  state.image = { blob, url, filename: opts.filename };
  openSheet(html`<h2 id="sheetTitle">Imagem da tier list</h2>
    <img class="export-preview" src="${url}" alt="${opts.title}: tier list em imagem">
    <p class="hint">No celular, também dá para tocar e segurar na imagem para salvar.</p>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-act="close-sheet">Fechar</button><button type="button" class="btn ${state.canShareFiles ? '' : 'primary'}" data-act="download-image">${ICON_DL}Baixar</button>${state.canShareFiles ? html`<button type="button" class="btn primary" data-act="share-image">Compartilhar</button>` : ''}</div>`,
  () => { URL.revokeObjectURL(url); state.image = null; });
}
function downloadImage() {
  const im = state.image; if (!im) return;
  const a = document.createElement('a'); a.href = im.url; a.download = im.filename;
  document.body.appendChild(a); a.click(); a.remove();
}
async function shareImage() {
  const im = state.image; if (!im) return;
  try { await navigator.share({ files: [new File([im.blob], im.filename, { type: 'image/png' })], title: 'Tier List da Pelada' }); }
  catch (e) { if (!e || e.name !== 'AbortError') downloadImage(); }
}
function imageForRound(rid) {
  const r = state.rounds.get(rid), res = r && resultFor(r); if (!res) return;
  return showImage({ title: r.title, subtitle: `${fmtDate(r.closedAt || r.createdAt)} · ${plural(num(res.voters), 'pessoa votou', 'pessoas votaram')}`, entries: resultEntries(r).filter(e => e.n), filename: `tier-list-${slug(r.title)}.png` });
}
function imageOverall() {
  const closed = closedRounds(); if (!closed.length) return;
  return showImage({ title: `Depois da ${closed[0].title}`, subtitle: `Média de ${plural(closed.length, 'rodada', 'rodadas')} · ${fmtDate(closed[0].closedAt || closed[0].createdAt)}`, entries: mainEntries(), filename: `tier-list-${slug(closed[0].title)}.png` });
}
async function copyLink() {
  const text = location.origin + location.pathname;
  try { await navigator.clipboard.writeText(text); toast('Link copiado.'); }
  catch {
    const code = $('#shareUrl');
    if (code) { const range = document.createRange(); range.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    toast('Selecionei o link: é só copiar.');
  }
}

/* ---------- eventos ---------- */
// Ações que gravam no banco esperam a gravação anterior terminar.
const WRITE_ACTS = new Set(['start-voting', 'become-admin', 'close-round', 'reopen-round', 'delete-round', 'admin-unlink', 'admin-remove', 'leave-device', 'submit-vote', 'confirm-yes', 'image', 'image-overall']);
function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act, rid = el.dataset.rid, pid = el.dataset.pid;
  if (state.busy && WRITE_ACTS.has(act)) { e.preventDefault(); toast('Só um instante, ainda salvando…'); return; }
  switch (act) {
    case 'close-sheet': closeSheet(); break;
    case 'confirm-yes': if (state.confirmYes) state.confirmYes(); break;
    case 'register': openRegisterSheet(); break;
    case 'claim': openClaimSheet(); break;
    case 'profile': openProfileSheet(); break;
    case 'leave-device': leaveDevice(); break;
    case 'pick-photo': { const f = $('#pfFile'); if (f) f.click(); break; }
    case 'remove-photo': if (state.form) { state.form.photo = null; const prev = $('#pfPreview'); if (prev) setHTML(prev, avatar({ id: state.form.pid || 'novo', name: ($('#pfName') || {}).value || '' }, 'xl')); el.remove(); } break;
    case 'become-admin': becomeAdmin(); break;
    case 'new-round': openRoundSheet(); break;
    case 'close-round': closeRoundAdmin(rid); break;
    case 'start-voting': startVoting(rid); break;
    case 'goal-plus': changeGoal(rid, pid, 1); break;
    case 'goal-minus': changeGoal(rid, pid, -1); break;
    case 'reopen-round': reopenRound(rid); break;
    case 'delete-round': deleteRound(rid); break;
    case 'admin-edit': openAdminPlayerSheet(pid); break;
    case 'admin-unlink': adminUnlink(pid); break;
    case 'admin-remove': adminRemove(pid); break;
    case 'copy-link': copyLink(); break;
    case 'rate': rate(el.dataset.tier); break;
    case 'focus': focusPlayer(pid); break;
    case 'pick-rev': pickRevelation(pid); break;
    case 'pick-best': pickBest(pid); break;
    case 'pick-keeper': pickKeeper(pid); break;
    case 'submit-vote': submitVote(); break;
    case 'image': imageForRound(rid); break;
    case 'image-overall': imageOverall(); break;
    case 'download-image': downloadImage(); break;
    case 'share-image': shareImage(); break;
  }
}
const SAVERS = { registerForm: saveRegister, claimForm: saveClaim, profileForm: savePlayerEdit, adminPlayerForm: savePlayerEdit, roundForm: saveRound };
async function onSubmit(e) {
  e.preventDefault();
  const form = e.target, save = SAVERS[form.id];
  const btn = form.querySelector('button[type=submit]');
  if (!save || (btn && btn.disabled)) return;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
  try { await save(form); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
}
async function onChange(e) {
  const t = e.target;
  if (t.id === 'pfFile' && t.files && t.files[0] && state.form) {
    const file = t.files[0]; t.value = '';
    showErr('#pfError', '');
    try {
      const dataUrl = await photoToDataUrl(file);
      if (!state.form) return;
      state.form.photo = dataUrl;
      const prev = $('#pfPreview');
      if (prev) setHTML(prev, html`<span class="av xl"><img src="${photoSrc(dataUrl)}" alt="Prévia da foto"></span>`);
    } catch { showErr('#pfError', 'Não consegui abrir essa imagem. Tente uma foto em JPG ou PNG.'); }
  } else if (t.name === 'p' && t.closest('#roundForm')) updateRfCount();
  else if (t.dataset && t.dataset.absentPid) toggleAbsent(t);
}
function onKey(e) {
  const sheetOpen = !$('#sheet').hidden;
  if (e.key === 'Escape' && sheetOpen) { closeSheet(); return; }
  if (sheetOpen || route().name !== 'votar' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const k = e.key.length === 1 ? e.key.toUpperCase() : '';
  const t = SCORE[k] ? k : ({ 1: 'S', 2: 'A', 3: 'B', 4: 'C', 5: 'D' })[k];
  if (t && state.vote && state.vote.current) { e.preventDefault(); rate(t); }
}
function bindEvents() {
  window.addEventListener('hashchange', () => { closeSheet(); renderNow(); window.scrollTo({ top: 0 }); });
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKey);
  document.addEventListener('dragstart', e => {
    const c = e.target.closest && e.target.closest('[data-drag-pid]');
    if (c && e.dataTransfer) { e.dataTransfer.setData('text/plain', c.dataset.dragPid); e.dataTransfer.effectAllowed = 'move'; }
  });
  document.addEventListener('dragover', e => {
    const row = e.target.closest && e.target.closest('[data-drop-tier]');
    if (!row) return;
    e.preventDefault();
    $$('.tier.drop').forEach(x => { if (x !== row) x.classList.remove('drop'); });
    row.classList.add('drop');
  });
  document.addEventListener('dragend', () => $$('.tier.drop').forEach(x => x.classList.remove('drop')));
  document.addEventListener('drop', e => {
    const row = e.target.closest && e.target.closest('[data-drop-tier]');
    $$('.tier.drop').forEach(x => x.classList.remove('drop'));
    if (!row || !e.dataTransfer) return;
    e.preventDefault();
    const pid = e.dataTransfer.getData('text/plain');
    if (pid) rateFor(pid, row.dataset.dropTier);
  });
}

/* ---------- Firebase ---------- */
function isConfigured() {
  const c = firebaseConfig || {};
  return [c.apiKey, c.projectId, c.appId].every(v => typeof v === 'string' && v && !v.includes('COLE_AQUI'));
}
function syncBallotSubs() {
  const want = new Set(roundList().filter(r => r.status === 'open' || (r.status === 'closed' && !r.result)).map(r => r.id));
  for (const [rid, unsub] of state.ballotSubs) {
    if (!want.has(rid)) { unsub(); state.ballotSubs.delete(rid); state.ballots.delete(rid); state.ballotsFresh.delete(rid); }
  }
  for (const rid of want) {
    if (state.ballotSubs.has(rid)) continue;
    const unsub = F.onSnapshot(F.collection(F.db, 'rounds', rid, 'ballots'), snap => {
      const m = new Map();
      for (const d of snap.docs) { const b = d.data(); if (b && b.ratings && typeof b.ratings === 'object') m.set(d.id, { voter: d.id, ratings: b.ratings, revelation: typeof b.revelation === 'string' ? b.revelation : null, best: typeof b.best === 'string' ? b.best : null, keeper: typeof b.keeper === 'string' ? b.keeper : null }); }
      state.ballots.set(rid, m); state.ver++;
      if (!snap.metadata.fromCache) state.ballotsFresh.add(rid);
      maybeFillResults();
      render();
    }, () => {});
    state.ballotSubs.set(rid, unsub);
  }
}
function readFailed(e) {
  console.warn(e);
  state.readProblem = readMessage(e);
  state.got.players = state.got.rounds = state.got.setup = true;
  render();
}
function subscribe() {
  F.onSnapshot(F.collection(F.db, 'players'), snap => {
    const m = new Map();
    for (const d of snap.docs) {
      const v = d.data();
      const name = cleanName(v && v.name);
      if (!name) continue;
      m.set(d.id, { id: d.id, name, photo: typeof v.photo === 'string' && v.photo.startsWith('data:image/') ? v.photo : null, owners: strList(v.owners), createdAt: num(v.createdAt) });
    }
    state.players = m; state.got.players = true; state.ver++;
    maybeFillResults(); render();
  }, readFailed);
  F.onSnapshot(F.collection(F.db, 'rounds'), snap => {
    const m = new Map();
    for (const d of snap.docs) {
      const v = d.data(); if (!v) continue;
      m.set(d.id, {
        id: d.id,
        title: str(v.title, 60) || 'Rodada',
        status: ['playing', 'open', 'closed'].includes(v.status) ? v.status : 'open',
        goals: goalsMap(v.goals),
        createdAt: num(v.createdAt), closedAt: num(v.closedAt),
        absent: strList(v.absent),
        participants: Array.isArray(v.participants) ? strList(v.participants) : null,
        result: v.result && typeof v.result === 'object' && v.result.players && typeof v.result.players === 'object' ? v.result : null,
      });
    }
    state.rounds = m; state.got.rounds = true; state.ver++;
    syncBallotSubs(); maybeFillResults(); render();
  }, readFailed);
  F.onSnapshot(F.doc(F.db, 'config', 'setup'), snap => {
    const d = snap.exists() ? snap.data() : null;
    state.setup = d && typeof d.adminPlayer === 'string' ? { adminPlayer: d.adminPlayer } : null;
    state.got.setup = true;
    maybeFillResults(); render();
  }, readFailed);
}

async function boot() {
  bindEvents();
  try { state.canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch { state.canShareFiles = false; }
  if (!isConfigured()) { state.phase = 'config'; renderNow(); return; }
  renderNow();
  let appM, authM, fsM;
  try { [appM, authM, fsM] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`)]); }
  catch (e) { console.warn(e); state.phase = 'error'; state.errorText = 'Não foi possível carregar o Firebase. Confira a internet e recarregue a página.'; renderNow(); return; }
  let auth, db;
  try {
    const app = appM.initializeApp(firebaseConfig);
    // Só usamos login anônimo, então não carregamos o suporte a janelas de login do Google.
    auth = authM.initializeAuth(app, { persistence: [authM.indexedDBLocalPersistence, authM.browserLocalPersistence] });
    db = fsM.getFirestore(app);
    if (useEmulators) {
      authM.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      fsM.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    }
  } catch (e) { console.warn(e); state.phase = 'error'; state.errorText = 'A configuração do Firebase parece errada. Confira o arquivo firebase-config.js.'; renderNow(); return; }
  F = { ...fsM, auth, db };
  state.phase = 'ready';
  subscribe();
  authM.onAuthStateChanged(auth, user => {
    state.uid = user ? user.uid : null;
    if (user) state.authProblem = '';
    else authM.signInAnonymously(auth).catch(e => { state.authProblem = authMessage(e); render(); });
    maybeFillResults();
    render();
  });
  renderNow();
}

boot();
