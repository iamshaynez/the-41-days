// 《第 41 天》SPA（无构建，原生 ESM）：服务端权威，前端只渲染 + 输入（技术架构 §9）。
// 界面语言 v3「一页书」：主屏只放一页缓缓落墨的书——选择与批注嵌在正文里；
// 人与家底各浓缩成一行（hover/点按翻详情）；地图操作退场，夜访回到叙事与岔路。
import { injectIcons, svgUse } from './icons.js';
import { splitSentences, SentenceBuffer } from './typist.js';
import { sfx } from './sfx.js';
import { ambience } from './ambience.js';
injectIcons();

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ——— 阅读偏好（字号 / 落墨动效 / 纸色 / 声音），落在本机 ———
const prefs = Object.assign({ font: 'm', motion: 'on', paper: 'dark', sound: 'off', ambience: 'off' }, JSON.parse(localStorage.getItem('twom.prefs') || '{}'));
function savePrefs() { localStorage.setItem('twom.prefs', JSON.stringify(prefs)); }
function applyPrefs() {
  document.body.dataset.fontsize = prefs.font;
  document.body.dataset.paper = prefs.paper;
  sfx.enabled = prefs.sound === 'on';
  ambience.setEnabled(prefs.ambience === 'on');
  document.body.classList.toggle('motion-off', prefs.motion === 'off');
}
applyPrefs();
const wantRM = () => RM || prefs.motion === 'off';

const state = {
  runId: null, mode: 'direct', view: 'play', user: null, s: null,
  busy: false, follow: true,
  lastDay: null, lastPhase: null, pendingDropcap: false,
  asks: {},          // 正文里的「世界停问」卡：key → { sig, el }
  lastAlive: null, popFor: null,
  // 原地反馈（体验批次三）
  fb: null, fbQueue: [], fbLedger: null,
  // 幕页与露布（叙事双轴排印升级）
  lastActId: null, chronShown: null,
  // 季相痕迹：积雪连日、上一次雪天
  lastWKey: null, snowStreak: 0, lastSnowDay: 0
};

// ——— 鉴权门：会话随 cookie 走，未登录回 landing ———
const me = await fetch('/api/auth/me');
if (!me.ok) location.replace('/');
state.user = (await me.json()).user;

// ——— 视图切换（对局 / 档案馆 / 管理；入口收进菜单） ———
function switchView(v) {
  state.view = v;
  for (const x of ['play', 'archive', 'admin']) $(`view-${x}`).hidden = x !== v;
  if (v === 'archive') loadArchive();
  if (v === 'admin') initAdmin();
  syncChrome();
}
function syncChrome() {
  const inPlay = state.view === 'play' && !$('game').hidden;
  $('mode-badge').hidden = !inPlay;
  updateWatch(state.s);
}

/* 更筹（UI设计-v0.3 §1/S4）：页缘五枝更签。
   人定一更、夜半三更；交割前兆（D41-44）鼓点先乱；
   交割夜（D45 夜半）一座座熄灭——这一夜 UI 的全部期待扑空。 */
function updateWatch(s) {
  const w = $('watch'); if (!w) return;
  const inPlay = state.view === 'play' && !$('game').hidden && s && !s.over;
  w.classList.toggle('on', !!inPlay);
  if (!inPlay) return;
  const litByPhase = { dawn: 0, day: 0, dusk: 1, night: 3, prologue: 0 };
  const lit = litByPhase[s.phase] ?? 0;
  const handoverNight = s.day === 45 && s.phase === 'night';
  w.classList.toggle('falter', !handoverNight && s.day >= 41 && (s.phase === 'dusk' || s.phase === 'night'));
  w.classList.toggle('extinguish', handoverNight);
  [...w.children].forEach((stick, i) => stick.classList.toggle('lit', i < lit));
}

// ——— 开局 / 续局 ———
async function startRun(_difficulty, sidestory, { quick = false } = {}) {
  // 模式不由玩家选：服务端按 LLM 路由配置决定（直读是测试与降级通道，不作为游戏模式提供）
  // 难度也不由玩家选：单一难度（低门槛进入，残酷由江陵自己负责）
  const res = await fetch('/api/runs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sidestory ? { sidestory } : quick ? { quick: true } : {})
  });
  const r = await res.json();
  state.runId = r.id;
  clearBook();
  const startDay = r.state.day || 1;
  dayDivider(startDay);
  // 开局仪式：三个名字，一个一个写上门后的墙（别传：先念开场白）
  if (r.state.sidestory) narrateRaw(`—— ${esc(r.state.sidestory.title)} ——\n${esc(r.state.sidestory.intro || '')}`, {});
  if (quick) narrateRaw('（快局 · 从第 21 天入局——这个家已经过了二十天，前情见右侧史卷。）', { cls: 'sys' });
  narrateRaw(`第 ${startDay} 天。`, { dropcap: true });
  const living = r.state.charView.filter((c) => c.alive);
  const wall = el('div', 'wall-names');
  wall.appendChild(el('span', 'wall-kicker', '门后'));
  living.forEach((c, i) => {
    const n = el('span', 'wall-name', esc(c.name));
    n.style.animationDelay = wantRM() ? '0s' : `${0.4 + i * 0.55}s`;
    wall.appendChild(n);
  });
  $('narration').appendChild(wall);
  revealFlow();
  setTimeout(() => {
    narrateRaw(`——${['', '一个名字', '两个名字', '三个名字', '四个名字'][living.length] || '几个名字'}，写在了门后的墙上。`);
    narrateRaw(r.mode === 'llm'
      ? '（日子他们会自己张罗；轮到你时，世界会停下来问。任何时候，都可以随口说点什么。）'
      : '（日子他们会自己张罗；轮到你时，世界会停下来问。直读模式认得大白话，比如「照常过吧」「省着吃」。）', { cls: 'sys' });
  }, wantRM() ? 0 : 400 + living.length * 550 + 500);
  enterGame(r.mode, r.state); // 状态入座在后：露布插页落在开场白之后，不抢卷首
}
$('btn-start').addEventListener('click', () => startRun());
$('btn-start-quick')?.addEventListener('click', () => startRun(null, null, { quick: true }));

/** 合上当前这本书：回到卷首（对局都留在「没写完的局」里） */
function backToSetup() {
  state.runId = null; state.s = null;
  $('game').hidden = true; $('setup').hidden = false;
  clearBook();
  syncChrome();
loadResume();
}

/** 清空书页：新局/续局前，把上一局的字与未决的问句都收走 */
function clearBook() {
  typist.flush(); memoirTypist.flush();
  typist.para = null; memoirTypist.para = null;
  $('narration').innerHTML = '';
  state.asks = {};
  state.lastAlive = null; state.lastDay = null; state.lastPhase = null;
  state.lastPrologueCard = null;
  state.pendingDropcap = false; state.follow = true;
  state.fb = null; state.fbQueue = []; state.fbLedger = null;
  state.lastActId = null; state.chronShown = null;
  state.lastWKey = null; state.snowStreak = 0; state.lastSnowDay = 0;
  hideFlowPing();
  hideCharPop();
}

/** 讣告：黑框、名字、殁日——死亡值得一次排版，不只是一句话 */
function renderObituary(c, day) {
  if (!c) return;
  closePara();
  const box = el('div', 'obituary');
  box.innerHTML = `
    <span class="obit-kicker">讣</span>
    <div class="obit-name">${esc(c.name)}</div>
    <div class="obit-role">${esc(c.role)}${c.desc ? '。' + esc(c.desc) : ''}</div>
    <div class="obit-date">殁于围城第 ${day} 日</div>`;
  $('narration').appendChild(box);
  revealFlow();
}

function enterGame(mode, s) {
  state.mode = mode;
  $('setup').hidden = true; $('game').hidden = false;
  $('mode-badge').textContent = mode === 'llm' ? '叙事引擎 · LLM' : '直读模式';
  $('mode-badge').className = 'badge' + (mode === 'llm' ? ' llm' : '');
  syncChrome();
  applyState(s);
}

/** 续局：前文落过库，书页能翻回去；没有前文的旧局，用一段前情提要接上 */
async function loadResume() {
  const r = await (await fetch('/api/runs')).json();
  if (r.engine === 'direct') $('engine-hint').hidden = false;
  const active = (r.runs || []).filter((x) => x.status === 'active');
  if (!active.length) return;
  $('resume').hidden = false;
  const list = $('resume-list');
  list.innerHTML = '';
  for (const run of active.slice(0, 5)) {
    const b = el('button', 'chip', `第 ${run.day ?? '?'} 天 · ${run.mode === 'llm' ? 'LLM' : '直读'} · ${String(run.started_at || '').slice(5, 10)}`);
    b.addEventListener('click', () => resumeRun(run.id));
    list.appendChild(b);
  }
}
async function resumeRun(id) {
  const r = await (await fetch(`/api/runs/${id}`)).json();
  if (!r.id) return;
  state.runId = id;
  clearBook();
  state.s = r.state; rebuildNounRe(); // 先立名词索引，前文里的名字就能翻
  replayHistory(r.history || [], r.state);
  // 前文里的史步已经活在史卷里——露布插页只管「续上之后」的新步
  state.chronShown = new Set((r.state.chronicle?.entries || []).map(chronKey));
  enterGame(r.mode, r.state);
  scrollFlow(true);
}
/** 前文重铺：落库的书页按日分组、批注归批注、正文归正文——全部瞬时落墨，不重播笔迹 */
function replayHistory(history, s) {
  let lastDay = null;
  for (const h of history) {
    if (h.role === 'annals') continue; // 史笔住在右翼史卷里，不进正文书页
    if (h.role === 'ledger') { // 账卡：落库的台账 JSON 重铺成同一张卡（不参与日分界——它跟着上一段正文走）
      try { renderTurnLedger(JSON.parse(h.text)); } catch { /* 残页跳过 */ }
      continue;
    }
    if (h.day != null && h.day !== lastDay) { dayDivider(h.day); lastDay = h.day; }
    if (h.role === 'player') {
      const line = el('p', 'player-line', esc(h.text));
      $('narration').appendChild(line);
    } else if (h.role === 'sys') {
      narrateRaw(h.text, { cls: 'sys' });
    } else {
      narrateRaw(h.text);
    }
  }
  if (history.length) {
    const mark = el('div', 'day-divider resume-mark', '<b>前文如上 · 翻到此处</b>');
    $('narration').appendChild(mark);
    state.pendingDropcap = true;
  } else {
    recapFromState(s);
  }
}
/** 前情提要：没有落库前文的旧局，用现状写一段接上书页 */
function recapFromState(s) {
  const who = s.charView.filter((c) => c.alive).map((c) => {
    const bits = [];
    if (HUNGER_TXT[c.hunger]) bits.push(HUNGER_TXT[c.hunger]);
    if (c.wound !== '无') bits.push(c.wound);
    if (c.sick !== '无') bits.push(c.sick);
    return c.name + (bits.length ? `（${bits.join('，')}）` : '');
  }).join('、');
  const fallen = s.charView.filter((c) => !c.alive).map((c) => c.name);
  const food = ['meal', 'canned', 'raw', 'meat', 'veg', 'sugar'].reduce((a, i) => a + (s.inventory?.[i] || 0), 0);
  const water = s.inventory?.water || 0;
  const meds = ['bandage', 'meds', 'herbmed'].reduce((a, i) => a + (s.inventory?.[i] || 0), 0);
  const box = el('div', 'recap');
  box.innerHTML = `<span class="kicker">前情提要</span>
    <p>围城第 ${s.day} 日，${WEATHER_NAME[s.weather] || ''}，${PHASE_NAME[s.phase] || ''}${s.winterActive ? '，入冬' : ''}。
    ${who || '屋里没人了'}还在橘里九号。${fallen.length ? `${fallen.join('、')}没能撑到今天。` : ''}
    家里存着食 ×${food}、水 ×${water}、药 ×${meds}——日子从这一页往下写。</p>`;
  $('narration').appendChild(box);
  state.pendingDropcap = false;
}
loadResume();

/* ════════════════════════════════════════════════════════════════
   句级浮现引擎（Typist）——「一句一句写下来」的小说节奏。
   SSE 的 chunk 先入缓冲，按句读边界释放；句子以 .sent 落墨浮现。
   队列越长吐得越快（追上 LLM），动效关闭时直插。
   ════════════════════════════════════════════════════════════════ */
const rich = (() => {
  const esc1 = (t) => esc(t);
  const MK_CLS = { 人: 'p', 地: 'l', 物: 'i', 事: 'e', 决: 'd', 伏: 'f', 要: 'y' };
  return (t) => esc1(t)
    .replace(/\*\*(.+?)\*\*/g, '<b class="ink-em">$1</b>')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<i class="em-kai">$1</i>')
    // 高亮标注（叙事双轴 §6）：七类 [[类|词]] → 色标 span（人朱/地青/物金/事玄/决绛/伏暗金/要朱批）
    .replace(/\[\[([人地物事决伏要])\|([^\]]+)\]\]/g, (m, t, n) => `<span class="mk mk-${MK_CLS[t] || 'p'}">${n}</span>`);
})();
class Typist {
  /** hooks.makePara：自定义段落容器（默认正文叙事流）；hooks.mark=false 关闭名词标注 */
  constructor(hooks = {}) { this.para = null; this.queue = []; this.timer = null; this.hooks = hooks; this.sbuf = new SentenceBuffer(); this.nextCls = ''; }
  /** 入队（流式安全）：跨增量缓冲，只释放完整句——边界落在「字」与「。」之间时不丢标点 */
  feed(text) {
    for (const item of this.sbuf.feed(text)) this.queue.push(item);
    this.pump();
  }
  /** 换段（排队式）：下一个段落用给定 class 起（节拍排版用——每拍一段，段随拍走） */
  beatPara(cls = '') { this.queue.push({ __para: cls }); this.pump(); }
  ensurePara() {
    if (this.para) return this.para;
    this.para = this.hooks.makePara ? this.hooks.makePara() : makePara(this.nextCls);
    this.nextCls = '';
    this.para.classList.add('streaming');
    return this.para;
  }
  pump() {
    if (this.timer || !this.queue.length) return;
    if (wantRM()) { this.flush(); return; }
    const tick = () => {
      if (!this.queue.length) { this.timer = null; return; }
      const op = this.queue.shift();
      const rate = this.queue.length > 12 ? 38 : this.queue.length > 5 ? 62 : 95;
      if (op === 0) this.closePara();
      else if (op && op.__para !== undefined) { this.closePara(); this.nextCls = op.__para; }
      else this.emit(op);
      this.timer = setTimeout(tick, rate);
    };
    this.timer = setTimeout(tick, 90);
  }
  emit(s, instant = false) {
    const sp = document.createElement('span');
    sp.className = 'sent' + (instant ? ' now' : '');
    sp.innerHTML = rich(s);
    if (this.hooks.mark !== false) markNouns(sp);
    this.ensurePara().appendChild(sp);
    if (this.hooks.onSentence) this.hooks.onSentence(); // 原地反馈：一句一拍，页面跟着动一下
    scrollFlow();
  }
  flush() {
    for (const item of this.sbuf.flush()) this.queue.push(item); // 轮次结束：未完句也要落纸
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.queue.length) {
      const op = this.queue.shift();
      if (op === 0) this.closePara();
      else if (op && op.__para !== undefined) { this.closePara(); this.nextCls = op.__para; }
      else this.emit(op, true);
    }
    this.closePara();
  }
  closePara() { if (this.para) { this.para.classList.remove('streaming'); this.para = null; } }
  /** 轮次结束：收段标记入队（不打断仍在落墨的节奏，光标随最后一笔自然熄灭） */
  endTurn() { this.queue.push(0); this.pump(); }
}
const typist = new Typist({      // 叙事流（onSentence：节拍动画随句释放）
  onSentence: () => drainFeedback()
});
const memoirTypist = new Typist({ // 局终回忆录：段落落在独立的排印区块里
  makePara: () => {
    let m = $('memoir-block');
    if (!m) { m = el('div', 'memoir'); m.id = 'memoir-block'; $('narration').appendChild(m); }
    const p = el('p'); m.appendChild(p); return p;
  }
});

// ——— 输入 → SSE ———
/** 决断意志模型：玩家输入只有两种——自由文本（{input}）与决策卡选择（{intents}）。同一 SSE 管线。 */
async function sendInput(text, display) {
  if (!text || state.busy || !state.runId) return;
  return send({ input: text }, display || text);
}
async function sendIntents(intents, label) {
  if (!intents?.length || state.busy || !state.runId) return;
  return send({ intents }, label || '——');
}
async function send(payload, displayText) {
  if (state.busy || !state.runId) return;
  // 草稿账：自由输入被追问（clarify）时原句回填输入行——别让玩家重打一遍
  state.lastDraft = typeof payload.input === 'string' && payload.input.trim() ? payload.input : null;
  state.busy = true;
  setCardsEnabled(false);
  hideCharPop();
  typist.flush(); // 新落笔前，把上一段一口气写完
  const line = el('p', 'player-line fresh', esc(displayText));
  $('narration').appendChild(line); closePara(); revealFlow();
  try {
    const res = await fetch(`/api/runs/${state.runId}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // display：书页上玩家那一笔的样子——落库的前文与玩家所见一致
      body: JSON.stringify({ ...payload, display: String(displayText || '').slice(0, 500) })
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        handleSse(block);
      }
    }
  } catch (e) {
    narrateRaw('（连接中断——刷新页面可从断点恢复）', { cls: 'sys' });
  }
  typist.endTurn();
  state.busy = false;
  setCardsEnabled(true);
}
/** 内核拒绝原因 → 玩家语言（错误码不亮给玩家） */
const REJECT_TXT = {
  NEED_FACILITY: '还缺家什', NO_AP: '行动力不够了', NO_FOOD: '没有能吃的', NO_FUEL: '没有柴了',
  NO_MATERIAL: '材料不够', NO_TOOL: '没有趁手的工具', BAD_PHASE: '现在不是做这个的时候',
  NOT_DUSK: '得等天黑', HOME_NIGHT: '今晚在家里', NO_MERCHANT: '摊子不在', NO_EVENT: '没有待决的事',
  BAD_OPTION: '没有这个选项', UNAVAILABLE: '条件不够', IN_PROLOGUE: '序章里只能选', BAD_SHAPE: '这话没听懂',
  BAD_TYPE: '这事做不了', EMPTY: '空的', TOO_MANY: '太多了', NOTHING: '没什么可翻的了', NO_TARGET: '没有这样的人',
  NO_CHAR: '这个人不在', BAD_TARGET: '没有这个地方', NO_ITEM: '东西不够', NO_NEED: '现在不需要',
  DONE_TODAY: '今天已经做过了', NEED_TRAIT: '他不会这个', NEED_REPAIR: '得先修好它', NO_LOC: '不知道这个地方', MAX: '已经修到顶了', NOT_NIGHT: '现在不是夜里', NIGHT_DONE: '这一夜已经过去了'
};

function handleSse(block) {
  const ev = block.match(/^event: (.+)$/m)?.[1];
  const dataRaw = block.match(/^data: (.+)$/m)?.[1];
  const data = dataRaw ? JSON.parse(dataRaw) : {};
  if (ev === 'narration-delta') {
    // 节拍对齐（直读/概述日）：直读正文随发 beats——一拍一段，段随拍走；LLM 散文则整段入纸
    if (Array.isArray(data.beats) && data.beats.length) streamBeats(data.beats);
    else typist.feed(data.d || '');
  }
  if (ev === 'feedback') prepFeedback(data);
  if (ev === 'memoir-delta') streamMemoir(data.d || '');
  if (ev === 'clarify') {
    narrateRaw('……' + data.text, { cls: 'clarify' });
    if (state.lastDraft) state.restoreDraft = state.lastDraft; // 状态落定后把原句放回输入行
  }
  if (ev === 'echo') narrateRaw(data.text, { cls: 'clarify' }); // 世界接住狂语的一笔（零状态变化）
  if (ev === 'stage') narrateRaw(data.text); // 戏文轨：舞台导演接的一拍，落进正文
  if (ev === 'ensemble') narrateEnsemble(data); // 堂屋：晨间对话块（内核先裁决，台词是演出）
  if (ev === 'state-patch') {
    // 账卡先进书页、再翻日：这一轮正文写完（flush 打字机），家底与人的每一笔变动亮出来，
    // 然后才立「第 N 日」分界（applyState 内）——账属于翻页前的那一夜
    if (state.fbLedger) { typist.flush(); renderTurnLedger(state.fbLedger); state.fbLedger = null; }
    applyState(data.state); restoreDraft();
  }
/** 被追问的那句话放回输入行：在原句上改，比重打一遍体面 */
function restoreDraft() {
  if (!state.restoreDraft) return;
  const draft = state.restoreDraft;
  state.restoreDraft = null;
  const inp = document.querySelector('.opt-free input');
  if (inp) { inp.value = draft; inp.focus({ preventScroll: true }); inp.setSelectionRange(draft.length, draft.length); }
}
  if (ev === 'done') {
    // 裁判代答的话（say）：世界/NPC 接住了玩家的话——得让玩家看见，不然话凭空消失
    if (data.say) narrateRaw(data.say, { cls: 'clarify' });
    if (data.rejects?.length) narrateRaw('（有些事做不到：' + data.rejects.map((r) => REJECT_TXT[r.reason] || r.reason).join('、') + '）', { cls: 'sys' });
    restoreDraft(); // 追问轮不发 state-patch（state 挂在 done 里）——回填挂这里才追得上
  }
  if (ev === 'error') narrateRaw('（出错：' + esc(data.error) + '）', { cls: 'sys' });
}

// ——— 叙事流：书页的排印 ———
function makePara(cls = '') {
  const p = el('p', 'fresh' + (cls ? ' ' + cls : ''));
  if (state.pendingDropcap && !cls) { p.classList.add('dropcap'); state.pendingDropcap = false; }
  $('narration').appendChild(p);
  return p;
}
/** 流式增量：整块交给 Typist，段落边界入队不打断节奏 */
function streamNarrate(delta) { typist.feed(delta); }
function closePara() { typist.flush(); }

/* ═══ 原地反馈（体验批次三）：书页在长字，家底与人在原地动一下 ═══
   beats=谁在做（行动者脉冲）；moves=物品账（家底小签）；ticks=破晓刻度（人侧小签）。
   动画随打字机的句子释放（一句一拍）；overlay 层不随状态重绘被抹掉。 */
function streamBeats(beats) {
  for (const b of beats) {
    typist.beatPara(b.k === 'day_overview' ? 'overview-line' : '');
    typist.feed(b.line);
  }
}
function prepFeedback(fb) {
  state.fb = fb || {};
  state.fbLedger = state.fb.ledger || null; // 账卡台账：等这一轮正文落完（state-patch 前）进书页
  const beats = state.fb.beats || [];
  const moves = state.fb.moves || [];
  const per = beats.length ? Math.ceil(moves.length / beats.length) : moves.length;
  state.fbQueue = beats.map((b, i) => ({ beat: b, moves: moves.slice(i * per, (i + 1) * per) }));
  if (!beats.length && moves.length) state.fbQueue = [{ beat: null, moves }];
  // 刻度（破晓的饥饿/伤病/心情档）：发生在昨夜，即刻缓开，等不及正文
  (state.fb.ticks || []).forEach((tk, i) => setTimeout(() => fireTick(tk), wantRM() ? 0 : 600 + i * 420));
}
function drainFeedback() {
  const op = state.fbQueue?.shift();
  if (!op || wantRM()) return;
  if (op.beat?.char) pulseChar(op.beat.char);
  for (const mv of op.moves || []) fireMove(mv);
}
function pulseChar(id) {
  const chip = document.querySelector(`.pl-char[data-id="${id}"]`);
  if (!chip) return;
  chip.classList.remove('acting'); void chip.offsetWidth; chip.classList.add('acting');
  setTimeout(() => chip.classList.remove('acting'), 1600);
}
function fireMove(mv) {
  if (!mv?.item || !ITEM_META[mv.item]) return;
  spawnFbChip(`${mv.delta > 0 ? '+' : '−'}${Math.abs(mv.delta)} ${ITEM_META[mv.item][0]}`, mv.delta > 0 ? 'up' : 'down', 'homeline');
}
const MOOD_KEY_TXT = { breakdown: '崩溃', depressed: '抑郁', low: '低落', calm: '平静', firm: '坚定' };
const TICK_TXT = {
  HUNGER_CHANGED: (t) => (t.to < t.from ? '更饿了' : '缓过来些'),
  WOUND_CHANGED: (t) => (t.to > t.from ? '伤重了' : '伤好些了'),
  SICK_CHANGED: (t) => (t.to > t.from ? '病重了' : '病好些了'),
  FATIGUE_CHANGED: (t) => (t.to > t.from ? '更累了' : '歇过来了'),
  MOOD_LEVEL: (t) => `心情·${MOOD_KEY_TXT[t.to] || t.to}`,
  BREAKDOWN_START: () => '崩溃了'
};
function fireTick(tk) {
  const fn = TICK_TXT[tk.t];
  if (!fn) return;
  const worse = tk.t === 'MOOD_LEVEL' ? ['firm', 'calm', 'low', 'depressed', 'breakdown'].indexOf(tk.to) > ['firm', 'calm', 'low', 'depressed', 'breakdown'].indexOf(tk.from) : undefined;
  spawnFbChip(fn(tk), worse === undefined ? 'tick' : (worse || tk.t === 'BREAKDOWN_START' ? 'down' : 'up'), 'partyline', tk.char);
}
/** 一枚原地小签：落在 vitals 侧的 overlay 层——状态重绘抹不掉它，它自己会淡走 */
function spawnFbChip(text, dir, anchorId, charId) {
  const layer = $('fbfx');
  if (!layer) return;
  const anchor = charId ? document.querySelector(`.pl-char[data-id="${charId}"]`) : $(anchorId);
  const chip = el('span', 'fb-chip ' + dir, text);
  layer.appendChild(chip);
  const r = anchor?.getBoundingClientRect();
  const lr = layer.getBoundingClientRect();
  if (r) {
    chip.style.left = Math.max(4, r.left - lr.left + r.width / 2 - 36) + 'px';
    chip.style.top = (r.bottom - lr.top + 5) + 'px';
  }
  setTimeout(() => chip.remove(), 2600);
}
/** 堂屋对话块（人物血肉计划 PR2）：场记一行 → 逐人台词 → 结局拍收束 */
const ENS_KIND_TXT = { comment: '评史', idle: '闲话', bond: '交心', friction: '争执', shadow: '翻旧账' };
function narrateEnsemble(data) {
  closePara();
  const head = el('div', 'ensemble-head', `— 堂屋 · ${ENS_KIND_TXT[data.kind] || '晨话'} —`);
  $('narration').appendChild(head);
  const nameOf = (id) => state.s?.charView?.find((c) => c.id === id)?.name || id;
  narrateRaw(data.lines.map((l) => `${nameOf(l.char)}：${l.text}`).join('\n'), { cls: 'ensemble' });
  if (data.beat) narrateRaw('——' + data.beat, { cls: 'ensemble-beat' });
}
function narrateRaw(text, { cls = '', dropcap = false, telegraph = false } = {}) {
  closePara();
  for (const p of String(text).split('\n')) {
    if (!p.trim()) continue;
    if (dropcap) state.pendingDropcap = true;
    if (telegraph && !cls && !wantRM()) { typist.feed(p + '\n'); }
    else { const para = makePara(cls); para.innerHTML = rich(p); if (state.s) markNouns(para); }
  }
  scrollFlow();
}
/** 日分隔回廊：— 第 N 日 — */
function dayDivider(day, suffix = '') {
  closePara();
  const d = el('div', 'day-divider', `<b>第 ${day} 日</b>${suffix ? ' · ' + suffix : ''}`);
  $('narration').appendChild(d);
  state.pendingDropcap = true;
  revealFlow();
}
/** 幕页：— 第二幕 · 问讯 —（换幕那天，书页里立一道幕题） */
const ACT_ORD = { A1: '一', A2: '二', A3: '三', A4: '四', A5: '五' };
function actDivider(act) {
  closePara();
  const d = el('div', 'act-divider', `<b>第${ACT_ORD[act.id] || ''}幕 · ${esc(act.title)}</b>`);
  $('narration').appendChild(d);
  state.pendingDropcap = true;
  revealFlow();
}
/** 露布插页（叙事双轴排印升级）：史卷新落定的大事步进正文，一次一页、只进不重排 */
function chronKey(e) { return e.day + ':' + (e.title || '') + ':' + (e.ending ? 'end' : ''); }
function renderNewChronicle(ch) {
  if (!state.chronShown) state.chronShown = new Set();
  for (const e of ch.entries) {
    const key = chronKey(e);
    if (state.chronShown.has(key) || e.day > state.s.day) continue;
    if (!e.anchor && !(e.pens || []).length && !(e.mirrors || []).length) continue; // 空笔不占页
    state.chronShown.add(key);
    if (e.ending) continue; // 收束步由终局排版负责
    if (e.anchor) gazetteBlock(e);
    else penMargin(e);
  }
}
function gazetteBlock(e) {
  closePara();
  const g = el('div', 'gazette' + (e.track ? ' tr-' + e.track : ''));
  g.innerHTML = `<span class="gz-kicker">露布 · 第${e.day}日</span><b class="gz-title">${esc(e.title)}</b>` +
    (e.text ? `<p class="gz-text">${rich(e.text)}</p>` : '') +
    (e.echo ? `<p class="gz-echo">这一家 · ${rich(e.echo)}</p>` : '');
  penNotes(g, e);
  markNouns(g);
  $('narration').appendChild(g);
  revealFlow();
}
/** 页边闲笔：不上正文，贴着页边小字 */
function penMargin(e) {
  const d = el('div', 'pen-margin');
  penNotes(d, e);
  if (d.children.length) { closePara(); $('narration').appendChild(d); revealFlow(); }
}
function penNotes(box, e) {
  for (const pn of e.pens || []) box.appendChild(el('p', 'pen-note', `闲笔 · ${rich((pn.name || '') + (pn.line ? '：' : ''))}${rich(pn.line || '')}`));
  for (const m of e.mirrors || []) box.appendChild(el('p', 'pen-note mir', rich(m)));
}

/* ═══ 账卡（turn-ledger）：一轮之内，家底与人的每一笔变动——变多少、为什么 ═══
   数据来自内核事件流原账（buildLedger 服务端聚合），随书页落库为 role:ledger，
   续局重铺走同一副排版。变化不许无端：每一行都带出处。 */
const LEDGER_SIGN = (n) => (n > 0 ? '+' : '−') + Math.abs(n);
const ldDirCls = (d) => (d === 'good' ? 'up' : d === 'bad' ? 'down' : '');
function renderTurnLedger(lg) {
  if (!lg || (!lg.items?.length && !lg.chars?.length)) return;
  closePara();
  const box = el('div', 'turn-ledger');
  let html = `<span class="ld-kicker">账 · 第${lg.day ?? ''}日</span>`;
  if (lg.items?.length) {
    html += '<p class="ld-sec">家底</p>';
    for (const it of lg.items) {
      html += `<div class="ld-row"><span class="ld-name">${esc(it.name)}</span>` +
        `<b class="ld-num ${it.delta > 0 ? 'up' : 'down'}">${LEDGER_SIGN(it.delta)}</b>` +
        `<span class="ld-why">${esc(it.why || '')}</span></div>`;
    }
  }
  if (lg.chars?.length) {
    html += '<p class="ld-sec">人</p>';
    for (const c of lg.chars) {
      for (const r of c.rows) {
        const shift = r.from && r.to && r.from !== r.to ? `${esc(r.from)}<i class="ld-ar">→</i>${esc(r.to)}` : esc(String(r.to ?? ''));
        const pts = typeof r.delta === 'number' && r.delta !== 0 ? `<i class="ld-pts">（${LEDGER_SIGN(r.delta)}）</i>` : '';
        html += `<div class="ld-row"><span class="ld-name">${esc(c.name)}</span>` +
          `<span class="ld-what">${esc(r.label)}</span>` +
          `<b class="ld-num ${ldDirCls(r.dir)}">${shift}${pts}</b>` +
          (r.why ? `<span class="ld-why">${esc(r.why)}</span>` : '') + '</div>';
      }
    }
  }
  box.innerHTML = html;
  $('narration').appendChild(box);
  revealFlow();
}
// 用户往上翻阅时暂停跟随（已读回滚，UI 设计 §5）——监听的是正文栏的内部滚动
const flowScroll = () => $('flow-scroll');
flowScroll().addEventListener('scroll', () => {
  const f = flowScroll();
  state.follow = f.scrollTop + f.clientHeight >= f.scrollHeight - 90;
  if (state.follow) hideFlowPing();
}, { passive: true });
function scrollFlow(force = false) {
  if (!force && !state.follow) return;
  const f = flowScroll();
  if (f) f.scrollTo({ top: f.scrollHeight, behavior: state.busy || wantRM() ? 'auto' : 'smooth' });
}
/* 新的一拍落位（卡片/落笔/日分界/讣告）：跟着用户的屏幕走——
   在底部追更的人平滑送下去；还在读上文的人视口不动，只在纸面下缘
   浮一枚提示，读完了自己下来（点它即到）。强制滚底只留给恢复对局与终局。 */
function revealFlow() {
  if (state.follow) { scrollFlow(true); hideFlowPing(); }
  else showFlowPing();
}
const flowPing = el('button', 'flow-ping');
flowPing.type = 'button';
flowPing.hidden = true;
flowPing.textContent = '新的一拍 ↓';
flowPing.addEventListener('click', () => { state.follow = true; scrollFlow(true); hideFlowPing(); });
$('flow').appendChild(flowPing);
function showFlowPing() { flowPing.hidden = false; }
function hideFlowPing() { flowPing.hidden = true; }
/** 静默重绘：签名未变时不重播入场动画（状态补丁频繁到达，浓缩行不许每次闪一遍） */
function quietSwap(box, sig) {
  const same = box.dataset.sig === String(sig);
  box.dataset.sig = String(sig);
  if (same) box.setAttribute('data-quiet', '1');
  else box.removeAttribute('data-quiet');
}

// ——— 渲染：状态（数在图里，事在文里；浓缩成两行） ———
const PHASE_NAME = { prologue: '序章', dawn: '平旦', day: '日中', dusk: '人定', night: '夜半' };
const WEATHER_ICON = { clear: 'clear', fog: 'fogw', rain: 'rainw', snow: 'snow', cold: 'cold' };
const WEATHER_NAME = { clear: '晴', fog: '雾', rain: '雨', snow: '雪', cold: '严寒' };
const HUNGER_TXT = { 濒死: '饿到极限', 严重饥饿: '很饿', 饥饿: '饿', 正常: '', 饱足: '吃饱了' };
const HUNGER_SEV = { 濒死: 3, 严重饥饿: 2, 饥饿: 1, 正常: 0, 饱足: 0 };
const HARM_SEV = { 无: 0, 轻伤: 1, 重伤: 2, 危重: 3, 微恙: 1, 重病: 2 };
const MOOD_FILL = { 坚定: 5, 平静: 4, 低落: 3, 抑郁: 2, 崩溃: 1 };
const MOOD_FIG = { 坚定: 'fig-sit', 平静: 'fig-sit', 低落: 'fig-low', 抑郁: 'fig-low', 崩溃: 'fig-curl' };

function applyState(s) {
  state.s = s;
  rebuildNounRe(); // 名词索引随状态刷新（人物/物资/已知地点都会变）
  // 讣告：有人没能撑过去——黑框排进正文流（UI 设计 §2）
  const aliveNow = Object.fromEntries(s.charView.map((c) => [c.id, c.alive]));
  if (state.lastAlive) {
    for (const [id, was] of Object.entries(state.lastAlive)) {
      if (was && aliveNow[id] === false) renderObituary(s.charView.find((c) => c.id === id), s.day);
    }
  }
  state.lastAlive = aliveNow;
  // 阶段切换：天光扫过 + 全局换肤
  if (state.lastPhase !== s.phase) {
    document.body.dataset.phase = s.phase === 'prologue' ? 'dawn' : s.phase; // 序章走破晓的天光
    if (state.lastPhase !== null && !wantRM()) {
      const veil = $('veil');
      veil.classList.remove('sweep'); void veil.offsetWidth; veil.classList.add('sweep');
    }
    if (s.phase === 'night' && state.lastPhase) sfx.drum(); // 入夜一记远更鼓
    state.lastPhase = s.phase;
  }
  document.body.dataset.day = s.day;
  updateWatch(s);
  document.body.dataset.winter = s.winterActive ? '1' : '0';
  if (state.lastDay !== null && state.lastDay !== s.day && s.phase !== 'prologue' && !s.over) dayDivider(s.day);
  state.lastDay = s.day;
  // 季相（体验批次三·痕迹）：冬深页缘霜重；雪下连日，檐雪渐厚
  if (s.season) {
    document.body.classList.toggle('winter', !!s.season.winter);
    document.documentElement.style.setProperty('--winter-depth', String(s.season.depth));
  }
  // 环境声基底（UI设计 §7）：天气×季节×夜访地点 → 床响度
  ambience.scene({ weather: s.weather, winter: !!s.winterActive, phase: s.phase, locId: s.nightView?.locId || null });
  const wkey = s.day + ':' + s.weather;
  if (state.lastWKey !== wkey) {
    state.snowStreak = s.weather === 'snow' ? (state.lastSnowDay === s.day - 1 ? state.snowStreak + 1 : 1) : 0;
    if (s.weather === 'snow') state.lastSnowDay = s.day;
    state.lastWKey = wkey;
    document.body.dataset.snow = String(Math.min(3, state.snowStreak));
  }
  // 幕页（叙事双轴）：换幕那天，书页里立一道幕题
  const act = s.chronicle?.currentAct;
  if (act && state.lastActId && act.id !== state.lastActId && s.phase !== 'prologue' && !s.over) actDivider(act);
  if (act) state.lastActId = act.id;
  // 露布插页：新落定的大事步从史卷走进正文——史与家在同一页上；闲笔作页边批注
  if (s.chronicle && s.phase !== 'prologue' && !s.over) renderNewChronicle(s.chronicle);

  const weather = WEATHER_NAME[s.weather] || s.weather;
  $('clock').innerHTML = `${svgUse(WEATHER_ICON[s.weather] || 'clear', 'clock-ic')} 第 ${s.day} 日 · ${weather} · ${PHASE_NAME[s.phase] || s.phase}${s.winterActive ? ' · 冬' : ''}`;

  renderPartyline(s);
  renderHomeline(s);
  renderPrologue(s); // 序章三幕（文本幕翻页 + 卡拍选择）排进正文流
  renderMap(s.mapView);       // 右翼上：舆图（三态 + 走向 + 留痕）
  renderChronicle(s.chronicle); // 右翼下：史卷（大事步 + 闲笔 + 我方一行）
  syncAsks(s);       // 世界停问的卡，嵌在正文流里
  if (state.popFor) fillCharPop(state.popFor); // 浮卡开着时随状态刷新
  if (s.over && s.ending && !s.endingRendered) { renderEnding(s); s.endingRendered = true; }
}

/* ════════════════════════════════════════════════════════════════
   人物行：一人一签——剪影姿态 + 名字 + 一句人话，最多两个词。
   细看（仪表与全部状态）收进 hover/点按的浮卡里，不占书页。
   ════════════════════════════════════════════════════════════════ */
function charWords(c) {
  const words = [];
  if (!c.alive) return ['没能撑过去'];
  if (c.breakdown) words.push('崩溃了');
  if (HUNGER_TXT[c.hunger]) words.push(HUNGER_TXT[c.hunger]);
  if (c.wound !== '无') words.push(c.wound);
  if (c.sick !== '无') words.push(c.sick);
  if (c.fatigue !== '正常') words.push(c.fatigue);
  if (!words.length && (c.mood === '低落' || c.mood === '抑郁')) words.push(c.mood);
  return words;
}
function charSev(c) {
  return Math.min(Math.max(
    HUNGER_SEV[c.hunger] || 0, HARM_SEV[c.wound] || 0, HARM_SEV[c.sick] || 0,
    c.fatigue === '力竭' ? 2 : c.fatigue === '疲惫' ? 1 : 0, c.breakdown ? 3 : 0
  ), 3);
}
function renderPartyline(s) {
  const box = $('partyline');
  quietSwap(box, s.charView.map((c) => `${c.id}${c.alive ? 1 : 0}${c.hunger}${c.mood}${c.ap}${c.wound}${c.sick}${c.fatigue}${c.breakdown ? 1 : 0}`).join('|'));
  box.innerHTML = '';
  for (const c of s.charView) {
    const words = charWords(c);
    const chip = el('button', 'pl-char' + (c.alive ? '' : ' dead'));
    chip.type = 'button';
    chip.dataset.sev = charSev(c);
    chip.dataset.id = c.id;
    chip.innerHTML = `${svgUse(c.alive ? (MOOD_FIG[c.mood] || 'fig-sit') : 'fig-curl', 'pl-fig')}
      <span class="pl-name">${esc(c.name)}</span>
      <span class="pl-word">${esc(words.slice(0, 2).join(' · ') || '还好')}</span>`;
    box.appendChild(chip);
  }
}
/** 人物浮卡：档案索引卡的完整内容（人话 + 制图仪表），悬停/点按显形 */
function gaugeRows(c) {
  const gauge = (label, pct, cls) =>
    `<div class="g ${cls}"><span class="g-label">${label}</span><span class="g-track"><i style="width:${Math.round(pct * 100)}%"></i></span></div>`;
  const hungerN = ['濒死', '严重饥饿', '饥饿', '正常', '饱足'].indexOf(c.hunger) + 1;
  const harm = Math.max(HARM_SEV[c.wound] || 0, HARM_SEV[c.sick] || 0);
  return `<div class="gauges">
    ${gauge('饱腹', hungerN / 5, 'g-hunger')}
    ${gauge('心情', (MOOD_FILL[c.mood] || 3) / 5, 'g-mood')}
    ${gauge('伤患', harm / 3, 'g-harm')}
    ${gauge('行动', (c.ap ?? 0) / (c.apMax || 3), 'g-ap')}
  </div>`;
}
function fillCharPop(id) {
  const c = state.s?.charView.find((x) => x.id === id);
  if (!c) return hideCharPop();
  const pop = $('char-pop');
  const words = charWords(c);
  pop.innerHTML = `
    <div class="cp-head">${svgUse(c.alive ? (MOOD_FIG[c.mood] || 'fig-sit') : 'fig-curl', 'pl-fig')}
      <b>${esc(c.name)}</b><span class="cp-role">${esc(c.role)} · 心情${esc(c.mood)}</span></div>
    <p class="cp-words">${esc(words.join('，') || '身上没伤，肚里有食。')}</p>
    ${gaugeRows(c)}`;
  pop.dataset.sev = charSev(c);
}
function showCharPop(id, anchor) {
  fillCharPop(id);
  const pop = $('char-pop');
  pop.hidden = false;
  state.popFor = id;
  const r = anchor.getBoundingClientRect();
  const cw = pop.offsetWidth, ch = pop.offsetHeight;
  let x = Math.min(Math.max(r.left + r.width / 2 - cw / 2, 10), window.innerWidth - cw - 10);
  let y = r.bottom + 8;
  if (y + ch > window.innerHeight - 10) y = Math.max(10, r.top - ch - 8);
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
}
function hideCharPop() { $('char-pop').hidden = true; state.popFor = null; }
{
  const line = $('partyline');
  let hideTimer = null;
  const isTouch = matchMedia('(hover: none)').matches;
  if (!isTouch) {
    line.addEventListener('mouseover', (e) => {
      const chip = e.target.closest('.pl-char');
      if (!chip) return;
      clearTimeout(hideTimer);
      showCharPop(chip.dataset.id, chip);
    });
    line.addEventListener('mouseout', (e) => {
      if (e.target.closest('.pl-char')) hideTimer = setTimeout(hideCharPop, 120);
    });
    $('char-pop').addEventListener('mouseenter', () => clearTimeout(hideTimer));
    $('char-pop').addEventListener('mouseleave', hideCharPop);
  }
  line.addEventListener('click', (e) => {
    const chip = e.target.closest('.pl-char');
    if (!chip) return;
    if (state.popFor === chip.dataset.id && !$('char-pop').hidden) hideCharPop();
    else showCharPop(chip.dataset.id, chip);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.pl-char') && !e.target.closest('#char-pop')) hideCharPop();
  });
  flowScroll().addEventListener('scroll', hideCharPop, { passive: true });
}

/* ════════════════════════════════════════════════════════════════
   家底行：门、七类家什、设施、夜里的火柴——一行收完；
   「细目」翻开抽屉：围城日历、这个家、物资格、夜访现状。
   ════════════════════════════════════════════════════════════════ */
const ITEM_META = {
  raw: ['生食', '食物'], meal: ['熟食', '食物'], canned: ['罐头', '食物'], veg: ['蔬菜', '食物'], meat: ['肉', '食物'], sugar: ['糖', '食物'],
  water: ['水', '水'], firewood: ['柴', '燃料'], fuel: ['燃料', '燃料'],
  bandage: ['绷带', '医疗'], meds: ['药品', '医疗'], herbmed: ['草药药', '医疗'], herb: ['草', '医疗'],
  wood: ['木板', '材料'], parts: ['零件', '材料'], comp: ['部件', '材料'], elec: ['电子件', '材料'], chem: ['化学剂', '材料'], powder: ['火药', '材料'],
  crowbar: ['撬棍', '工具'], shovel: ['铲', '工具'], saw: ['锯', '工具'], knife: ['刀', '工具'], axe: ['斧', '工具'], lockpick: ['开锁器', '工具'],
  pistol: ['手枪', '工具'], rifle: ['步枪', '工具'], bullet: ['子弹', '工具'],
  cigs: ['香烟', '嗜好'], coffee: ['咖啡', '嗜好'], tobacco: ['烟草', '嗜好'], moonshine: ['私酿', '嗜好'], wine: ['好酒', '嗜好'],
  jewel: ['珠宝', '值钱'], book: ['书', '值钱'], doc: ['文件', '值钱']
};
const CAT_ORDER = ['食物', '水', '燃料', '医疗', '材料', '工具', '嗜好', '值钱'];
const CAT_TOKEN = { 食物: '食', 水: '水', 燃料: '火', 医疗: '医', 材料: '材', 工具: '具', 嗜好: '嗜', 值钱: '值' };
const ROOM_NAME = { hall: '门厅', living: '客厅', kitchen: '厨房', bedroom: '卧室', attic: '阁楼', cellar: '地窖', yard: '后院', garage: '车库' };
const FAC_NAME = (s) => {
  const f = s.facilities || {};
  const out = [];
  if (f.stove) out.push(f.stove_eco ? '节能炉' : '炉灶');
  if ((f.stoveFireLeft || 0) > 0) out.push('灶有余火'); // 痕迹：一灶火没熄，日子就有余温
  if (f.heater) out.push(f.heater_iron ? '铁炉' : '火盆');
  if (f.radio) out.push('烽鼓具');
  if (f.piano >= 3) out.push('续弦的琴');
  if (f.bed) out.push('床');
  if (f.garden) out.push('苗圃');
  if (f.trap) out.push('陷阱');
  if (f.rain) out.push('集雨器');
  if (f.workbench) out.push('工作台');
  if (f.distill) out.push('蒸馏器');
  return out;
};
function catSums(inv) {
  const sums = new Map();
  for (const [id, n] of Object.entries(inv || {})) {
    if (n <= 0 || !ITEM_META[id]) continue;
    const cat = ITEM_META[id][1];
    sums.set(cat, (sums.get(cat) || 0) + n);
  }
  return sums;
}
function renderHomeline(s) {
  const box = $('homeline');
  const sums = catSums(s.inventory);
  const facs = FAC_NAME(s);
  const sig = [s.doorLevel, ...CAT_ORDER.map((c) => sums.get(c) || 0), facs.join(','),
    s.nightView ? s.nightView.slots + '/' + s.nightView.noise : '', s.war?.telegraphed ? 1 : 0, s.franko ? 1 : 0].join('|');
  quietSwap(box, sig);
  box.innerHTML = '';
  // 门
  const planks = Array.from({ length: 3 }, (_, i) => `<i class="${i < s.doorLevel ? 'on' : ''}"></i>`).join('');
  box.appendChild(el('span', 'hl-item', `${svgUse('door', 'hl-ic')}<span class="hl-label">门</span><span class="planks">${planks}</span>`));
  // 家什七类（零的不出声）
  const tokens = CAT_ORDER.filter((c) => sums.get(c)).map((c) => `${CAT_TOKEN[c]}×${sums.get(c)}`);
  box.appendChild(el('span', 'hl-item hl-goods', tokens.length ? esc(tokens.join(' · ')) : '<span class="hl-dim">家徒四壁</span>'));
  // 设施
  if (facs.length) box.appendChild(el('span', 'hl-item hl-facs', esc(facs.join(' · '))));
  // 夜里的火柴与声响
  if (s.nightView) {
    box.appendChild(el('span', 'hl-item', `${svgUse('matchi', 'hl-ic')}火柴 <b>${s.nightView.slots}</b>`));
    if (s.nightView.noise > 0) box.appendChild(el('span', 'hl-item hl-alert', `${svgUse('noise', 'hl-ic')}声响 ×${s.nightView.noise}`));
  }
  if (s.war?.telegraphed) box.appendChild(el('span', 'hl-item hl-alert', `${svgUse('warn', 'hl-ic')}炮声稀了`));
  if (s.franko) box.appendChild(el('span', 'hl-item hl-alert', `${svgUse('scale', 'hl-ic')}鲁舟在渡口`));
  const detail = el('button', 'hl-detail', '细目');
  detail.type = 'button';
  detail.addEventListener('click', openHomebook);
  box.appendChild(detail);
}

/** 细目抽屉：围城日历 + 这个家 + 物资格 + 夜访现状（看，不操作——操作都在正文里） */
function openHomebook() {
  const s = state.s;
  if (!s) return;
  const sheet = $('homebook');
  const sums = catSums(s.inventory);
  const facs = FAC_NAME(s);
  const opened = Object.entries(s.house?.opened || {}).filter(([, v]) => v).map(([k]) => ROOM_NAME[k] || k);
  let html = `<div class="sheet-head"><span class="kicker">家底 · 细目</span>
    <button class="sheet-x" type="button" aria-label="合上">${svgUse('close')}</button></div>`;
  // 围城日历（从报头搬进抽屉：45 天的尺度，交割日涂雾）
  html += `<section class="hb-sec"><p class="m-kicker">时局</p><div id="hb-siege"></div>
    <p class="hint">${WEATHER_NAME[s.weather] || s.weather}${s.winterActive ? ' · 严冬' : ''} · 第 ${s.day} 日</p></section>`;
  // 这个家
  html += `<section class="hb-sec"><p class="m-kicker">这个家</p>
    <p class="hb-line">门板加固 ${s.doorLevel || 0} 层${facs.length ? ' · ' + esc(facs.join('、')) : ' · 还没有像样的家什'}</p>
    <p class="hb-line dim">走得动的房间：${esc(opened.join('、') || '门厅')}</p></section>`;
  // 物资格
  html += `<section class="hb-sec"><p class="m-kicker">物资清单</p><div id="hb-inv"></div></section>`;
  // 夜访现状
  if (s.nightView) {
    const nv = s.nightView;
    html += `<section class="hb-sec"><p class="m-kicker">夜访中 · ${esc(nv.loc)}</p>
      <div class="matches small">${Array.from({ length: 10 }, (_, i) => `<span class="match ${i < 10 - nv.slots ? 'burnt' : ''}"></span>`).join('')}</div>
      <p class="hb-line">在「${esc(nv.room)}」${nv.noise > 0 ? ` · <span class="hl-alert">声响 ×${nv.noise}——有人听见了</span>` : ''}</p></section>`;
  }
  // 规矩：概述日开关（长线体验 §4.4——平淡日一笔带过；想逐件细看随时关）
  if (!s.over) {
    const on = s.policy?.overviewDays !== false;
    html += `<section class="hb-sec"><p class="m-kicker">规矩</p>
      <button class="chip hb-policy" type="button">${on ? '平淡的日子一笔带过（点此改为逐日细看）' : '平淡的日子逐日细看（点此改为一笔带过）'}</button></section>`;
  }
  sheet.innerHTML = html;
  renderSiegeInto($('hb-siege'), s);
  renderInvGrid($('hb-inv'), s.inventory);
  const polBtn = sheet.querySelector('.hb-policy');
  if (polBtn) polBtn.addEventListener('click', () => {
    const on = state.s?.policy?.overviewDays !== false;
    sendIntents([{ type: 'policy', key: 'overviewDays', value: !on }], on ? '平淡的日子，改一天一天细看' : '平淡的日子，一笔带过');
    closeSheets();
  });
  sheet.querySelector('.sheet-x').addEventListener('click', closeSheets);
  openSheet('homebook');
}
/** 物资图标格（细目抽屉用，与旧侧栏同一副版式） */
function renderInvGrid(box, inv) {
  box.innerHTML = '';
  const entries = Object.entries(inv || {}).filter(([id, n]) => n > 0 && ITEM_META[id]);
  if (!entries.length) { box.appendChild(el('p', 'hint', '空。')); return; }
  const cats = new Map();
  for (const [id, n] of entries) {
    const [name, cat] = ITEM_META[id];
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push({ id, name, n });
  }
  const grid = el('div', 'inv-grid');
  for (const cat of CAT_ORDER) {
    if (!cats.has(cat)) continue;
    grid.appendChild(el('div', 'inv-cat', cat));
    for (const it of cats.get(cat)) {
      grid.appendChild(el('div', 'item', `${svgUse(it.id)}<span class="item-name">${esc(it.name)}</span><b class="item-qty">×${it.n}</b>`)).title = (state.s?.itemFlavors || {})[it.id] || '';
    }
  }
  box.appendChild(grid);
}
/** 围城日历：45 天的尺度，交割前夜涂雾，今日拨针 */
function renderSiegeInto(box, s) {
  if (!box) return;
  const W = 640, H = 40, x0 = 34, x1 = W - 14, dayX = (d) => x0 + (x1 - x0) * ((d - 1) / 59);
  let ticks = '';
  for (let d = 1; d <= 60; d += 5) {
    const x = dayX(d);
    ticks += `<line x1="${x}" y1="24" x2="${x}" y2="${d % 10 === 0 ? 16 : 20}"/><text x="${x}" y="34" text-anchor="middle" class="${d === s.day ? 'tick-now' : ''}">${d}</text>`;
  }
  const today = dayX(Math.min(s.day, 60));
  box.innerHTML = `<div class="siege"><span class="siege-label">围城日历</span>
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <rect x="${dayX(30)}" y="19" width="${dayX(45) - dayX(30)}" height="6" class="fog-band"/>
    <line x1="${x0}" y1="22" x2="${x1}" y2="22" class="axis"/>
    ${ticks}
    <line x1="${dayX(60)}" y1="14" x2="${dayX(60)}" y2="22" class="hard-end"/>
    <line x1="${today}" y1="10" x2="${today}" y2="22" class="today-line"/>
    <path d="M${today - 4} 8 L${today + 4} 8 L${today} 13 Z" class="today-pin"/>
  </svg></div>`;
}

/* ════════════════════════════════════════════════════════════════
   世界停问（ask）：急件 / 黄昏 / 夜访 / 价目 / 晨报——
   全部嵌进正文流，像序章卡那样是书页的一部分；
   时过境迁就合上（.settled），字留着，选项收走。
   ════════════════════════════════════════════════════════════════ */
function settleAsk(rec) {
  if (!rec?.el) return;
  rec.el.classList.add('settled');
  rec.el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  rec.el.querySelectorAll('.opt-free input').forEach((i) => { i.disabled = true; });
}
/** 同步一类停问卡：视图没了→合上；签名变了→合上旧的、在书尾开新的一页 */
function syncAsk(key, present, sig, build) {
  const cur = state.asks[key];
  if (!present) {
    if (cur) { settleAsk(cur); delete state.asks[key]; }
    return;
  }
  if (cur && cur.sig === sig) return;
  if (cur) settleAsk(cur);
  const node = el('div', 'ask');
  node.dataset.ask = key;
  node.id = 'ask-' + key;
  closePara(); // 先收笔再开停问页——卡永远落在写完的句子后面
  build(node);
  $('narration').appendChild(node);
  state.asks[key] = { sig, el: node };
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1200);
  revealFlow();
}
function askHead(kicker, title, icon) {
  return `<div class="ask-head"><span class="kicker">${esc(kicker)}</span>${icon ? svgUse(icon, 'card-ic') : ''}<b class="ask-title">${esc(title)}</b></div>`;
}
/** 忙碌态：未合上的卡里所有按钮与输入行一起停摆；预算耗尽的刷新按钮保持停摆 */
function setCardsEnabled(on) {
  document.querySelectorAll('.ask:not(.settled) button, .prologue button, .opt-free input')
    .forEach((x) => { if (!x.dataset.done) x.disabled = !on; });
}

function optBtn(label, key, onClick, hint = '', disabledWhy = '') {
  const b = el('button', 'opt', `<span class="key">${esc(key)}</span><span>${esc(label)}${hint ? `<span class="plan-hint">${esc(hint)}${disabledWhy ? `（${esc(disabledWhy)}）` : ''}</span>` : (disabledWhy ? `<span class="plan-hint">（${esc(disabledWhy)}）</span>` : '')}</span>`);
  b.type = 'button';
  if (disabledWhy) { b.disabled = true; b.title = disabledWhy; return b; }
  b.addEventListener('click', () => { onClick(); });
  return b;
}
/** 出场取谋士选项（纯取数，不碰 DOM）：auto 免费额度，25s 超时兜底——
 *  调用方等它落定后红金同拍渲染；失败/为空返回 []（只显红） */
function fetchAutoOptions(cardKey, optsEl, s) {
  if (state.mode !== 'llm') return Promise.resolve([]);
  if (optsEl.dataset.autoed) return Promise.resolve([]);
  optsEl.dataset.autoed = '1';
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), 25000);
  return fetch(`/api/runs/${state.runId}/options`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card: cardKey, exclude: [...optsEl.querySelectorAll('.opt')].map((x) => x.dataset.label).filter(Boolean).slice(0, 8), auto: true }),
    signal: ctl.signal
  }).then((r) => r.json()).then((r) => (r.options || [])).catch(() => []).finally(() => clearTimeout(kill));
}

/** 谋士选项插入（与内核选项同一副红印——用户分不出来，也不该分出来） */
function insertGoldOptions(optsEl, options, onClick, beforeEl) {
  for (const o of options || []) {
    const ob = optBtn(o.label, '◆', () => (onClick ? onClick(o) : sendIntents(o.intents, o.label)), o.hint || '');
    ob.dataset.label = o.label;
    optsEl.insertBefore(ob, beforeEl || null);
  }
}

/** 整卷同拍落纸：等墨期间整张卡（含输入行）隐去，只留落墨动画——
 *  等待期不可见也不可输入，杜绝误操作；谋士落定（或失败/超时）整卷一次上纸 */
function revealCardVeiled(node, optsEl, cardKey, s, { onClick, beforeEl } = {}) {
  if (state.mode !== 'llm') return; // 直读无谋士，立即出卷
  const gold = fetchAutoOptions(cardKey, optsEl, s);
  const veil = el('div', 'card-veil', '<span class="ink-dots"><i></i><i></i><i></i></span>史官正在落墨……');
  node.classList.add('veiled');
  node.appendChild(veil);
  gold.catch(() => []).then((opts) => {
    if (!node.isConnected) return; // 卡已重建：随旧卡一并消失
    if (opts && opts.length) insertGoldOptions(optsEl, opts, onClick, beforeEl);
    veil.remove();
    node.classList.remove('veiled');
    node.classList.add('unveil'); // 一次成卷的淡入
    setTimeout(() => node.classList.remove('unveil'), 800);
  });
}

/** 刷新命运（统一交互面）：让谋士再想几个——只换自谋类卡的选项，世界的问题不重掷 */
function refreshRow(cardKey, optsEl, onGoldClick) {
  if (state.mode !== 'llm') return null;
  const row = el('div', 'opt-refresh-row');
  const b = el('button', 'opt-refresh', '<span class="candle" aria-hidden="true"></span><span class="txt">⟳ 再想想</span>');
  b.type = 'button';
  const txt = () => b.querySelector('.txt');
  let used = 0;
  const seenLabels = () => new Set([...optsEl.querySelectorAll('.opt')].map((x) => x.dataset.label).filter(Boolean));
  b.addEventListener('click', async () => {
    if (state.busy || used >= 2) return;
    b.disabled = true; b.classList.add('thinking'); txt().textContent = '谋士在想…';
    try {
      const res = await fetch(`/api/runs/${state.runId}/options`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card: cardKey, exclude: [...seenLabels()].slice(0, 8) })
      });
      const r = await res.json();
      let added = 0;
      const seen = seenLabels();
      for (const o of r.options || []) {
        if (seen.has(o.label)) continue;
        seen.add(o.label);
        insertGoldOptions(optsEl, [o], onGoldClick);
        added++;
      }
      b.classList.remove('thinking');
      if (r.reason) { b.title = r.reason; row.appendChild(el('p', 'ask-hint opt-refresh-reason', '（' + esc(r.reason.slice(0, 60)) + '）')); }
      if (added) used++; // 只有真出了选项才计入两次上限
      if (used >= 2) { b.dataset.done = '1'; txt().textContent = '就这些了'; }
      else { txt().textContent = added ? '⟳ 再想想' : '谋士没词了'; b.disabled = false; }
    } catch {
      b.classList.remove('thinking');
      txt().textContent = '（没接上）'; b.disabled = false;
    }
  });
  row.appendChild(b);
  return row;
}

/** 末位自由输入行（命运导演 P0b）：与选项同宗的第四种可能——自己拿主意。
 *  示例由内核按状态现算（freeExamples），随天数轮换；点「落笔」= 与选项同一条输入管线。 */
function freeOptRow(s, kind, note = '') {
  const row = el('div', 'opt-free');
  const examples = s?.freeExamples?.[kind] || [];
  const ex = examples.length ? examples[(s.day + examples.length) % examples.length] : '';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.maxLength = 60;
  inp.placeholder = note || '让我自由发挥，落笔他们的故事走向';
  inp.enterKeyHint = 'send';
  inp.setAttribute('aria-label', '自己拿主意');
  const btn = el('button', 'free-send', '✎ 落笔');
  btn.type = 'button';
  const go = () => {
    const v = inp.value.trim();
    if (!v || state.busy) return;
    inp.value = '';
    sendInput(v);
  };
  btn.addEventListener('click', go);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  if (ex && !note) inp.title = `比如：「${ex}」`; // 示例只作悬停提示，不再占输入行
  row.append(inp, btn);
  return row;
}
/** 微操夜的逃生门：一路岔路问下来太累——剩下的夜交给方针，一击走完 */
function appendDirectiveHandoff(opts, s) {
  const stance = s.policy?.nightApproach || 'normal';
  opts.appendChild(optBtn('剩下的一夜交给方针', '◆', () => sendIntents(
    [{ type: 'night_directive', stance, text: '剩下的一夜照常走' }], '交给方针'
  ), '按现行规矩的挡位走完'));
}

function syncAsks(s) {
  const inPrologue = s.phase === 'prologue';
  // 今日卡（统一交互面）：白天常驻——晨报 + 念头 + 情境选项 + 刷新命运 + 输入行。
  // 有急件时让位（门口的事优先）；夜访/黄昏各由自己的卡接管。
  syncAsk('day', !!(!inPrologue && s.phase === 'day' && !s.eventView && !s.over),
    [s.day, s.phase, s.rngCursor, (s.careView?.problems || []).map((p) => p.text).join('|'),
      (s.suggests || []).map((x) => x.label).join('|'), (s.directions || []).map((d) => d.text).join('|')].join('§'), (node) => {
      node.innerHTML = askHead('今天', s.careView?.title || '这一天怎么过', 'sun');
      if (s.careView?.problems?.length) {
        const body = el('div', 'ask-body');
        for (const p of s.careView.problems.slice(0, 4)) {
          body.appendChild(el('p', 'care-line' + (p.sev >= 3 ? ' bad' : p.sev >= 2 ? ' mid' : ''), esc(p.text)));
        }
        node.appendChild(body);
      }
      if (s.directions?.length) {
        const dir = el('div', 'ask-body dir-box');
        dir.appendChild(el('p', 'm-kicker', '种下的念头'));
        for (const d of s.directions) dir.appendChild(el('p', 'care-line', `「${esc(d.text)}」——${esc(d.name)}记着呢（第${d.day}天种下）`));
        node.appendChild(dir);
      }
      const opts = el('div', 'ask-opts');
      for (const sg of (s.suggests || []).filter((x) => !x.focus)) {
        const ob = optBtn(sg.label, '·', () => (sg.intents ? sendIntents(sg.intents, sg.label) : sendInput(sg.text, sg.label)));
        ob.dataset.label = sg.label;
        opts.appendChild(ob);
      }
      if (!opts.children.length) opts.appendChild(optBtn('让他们自己张罗这一天', '▸', () => sendIntents([{ type: 'auto_day' }], '照常过吧')));
      node.appendChild(opts);
      node.appendChild(el('p', 'ask-hint', '点任何一个选项都会收卷今天——方略一次走完这一天。'));
      const rr = refreshRow('day', opts);
      if (rr) node.appendChild(rr);
      node.appendChild(freeOptRow(s, 'day'));
      revealCardVeiled(node, opts, 'day', s); // 整卷等墨：选项+输入行一起上纸
    });
  // 急件：门口的事（电报体 + 叩门章）
  syncAsk('event', !!(!inPrologue && s.eventView && !s.over),
    s.eventView ? s.eventView.title + s.eventView.options.length : '', (node) => {
      const v = s.eventView;
      const evIcon = /敲|门/.test(v.title) ? 'knock' : 'news';
      if (evIcon === 'knock') sfx.knock(); // 语义音：叩门（仅新开门的急件）
      node.classList.add('ask-urgent');
      node.innerHTML = askHead('急件', v.title, evIcon);
      const body = el('div', 'ask-body');
      // 卡面正文走 rich：内容包的 [[要|]] 朱批与名词标注在事件卡上同样生效（文案丰满批次一）
      for (const p of String(v.text).split('\n').filter(Boolean)) { const elp = el('p', '', rich(p)); markNouns(elp); body.appendChild(elp); }
      node.appendChild(body);
      const opts = el('div', 'ask-opts');
      v.options.forEach((o, i) => opts.appendChild(optBtn(o.label, String(i + 1), () => sendIntents([{ type: 'event_choice', option: o.key }], o.label), '', o.ok === false ? (o.why || '条件不够') : '')));
      node.appendChild(opts);
      node.appendChild(freeOptRow(s, 'event'));
    });
  // 黄昏：今晚怎么安排——方案自带夜间方针（点一个方案 = 黄昏+整夜一口气走完）
  syncAsk('dusk', !!(s.duskView && !s.over),
    s.duskView ? s.duskView.plans.map((p) => p.label).join('|') + (s.duskView.fate ? s.duskView.fate.title : '') + (s.duskView.overviewNote ? '·ovd' : '') : '', (node) => {
      node.innerHTML = askHead('黄昏', '今晚怎么安排', 'moon');
      if (s.duskView.overviewNote) node.appendChild(el('p', 'ask-hint', esc(s.duskView.overviewNote)));
      // 夜方针挡位（默认跟现行规矩；只影响外出方案，在家方案无需方针）
      const stances = [['cautious', '今夜谨慎'], ['normal', '照常走'], ['bold', '放手干']];
      const pol = s.policy?.nightApproach || 'normal';
      const stanceRow = el('div', 'stance-row');
      let stance = pol;
      stanceRow.appendChild(el('span', 'stance-label', '夜里的路子'));
      for (const [key, name] of stances) {
        const b = el('button', 'stance' + (key === pol ? ' on' : ''), name);
        b.type = 'button';
        b.addEventListener('click', () => {
          stance = key;
          stanceRow.querySelectorAll('.stance').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
        });
        stanceRow.appendChild(b);
      }
      const micro = el('button', 'stance stance-micro', '自己走');
      micro.type = 'button';
      micro.title = '今晚我自己一步步走（岔路逐个问我）';
      micro.addEventListener('click', () => {
        stance = 'micro';
        stanceRow.querySelectorAll('.stance').forEach((x) => x.classList.remove('on'));
        micro.classList.add('on');
      });
      stanceRow.appendChild(micro);
      node.appendChild(stanceRow);
      const opts = el('div', 'ask-opts');
      for (const p of s.duskView.plans) {
        const go = () => {
          const intents = [p.intent];
          if (p.intent.scavenger && stance === 'micro') intents.push({ type: 'auto_night' }); // 自己走：出门即自走，到第一个岔路停
          else if (p.intent.scavenger && stance !== 'micro') intents.push({ type: 'night_directive', stance, text: p.label });
          sendIntents(intents, p.label);
        };
        opts.appendChild(optBtn(p.label, { a: '甲', b: '乙', stay: '守' }[p.key] || '·', go, p.hint || ''));
      }
      // 同拍落纸：红色保底在暗处备好，谋士方案一到（或失败）一起上纸；金色点击同样按方针挡位走整夜
      const goldClick = (o) => {
        const intents = o.intents.filter((i) => i.type !== 'auto_day');
        if (intents.some((i) => i.type === 'dusk_assign' && i.scavenger)) {
          if (stance === 'micro') intents.push({ type: 'auto_night' });
          else intents.push({ type: 'night_directive', stance, text: o.label });
        }
        sendIntents(intents, o.label);
      };
      node.appendChild(opts);
      if (s.duskView.fate) {
        const fate = el('div', 'fate-box');
        fate.appendChild(el('p', 'fate-title', esc(s.duskView.fate.title)));
        for (const p of String(s.duskView.fate.text).split('\n').filter(Boolean)) { const elp = el('p', '', rich(p)); markNouns(elp); fate.appendChild(elp); }
        const fopts = el('div', 'ask-opts');
        s.duskView.fate.options.forEach((o) => fopts.appendChild(optBtn(o.label, '◆', () => sendIntents([{ type: 'event_choice', option: o.key }], o.label), '', o.ok === false ? (o.why || '条件不够') : '')));
        fate.appendChild(fopts);
        fate.appendChild(el('p', 'ask-hint', '不答也行——出了门，这件事就过去了。'));
        node.appendChild(fate);
      }
      const rr = refreshRow('dusk', opts, goldClick);
      if (rr) node.appendChild(rr);
      node.appendChild(freeOptRow(s, 'dusk'));
      revealCardVeiled(node, opts, 'dusk', s, { onClick: goldClick }); // 整卷等墨：方案+挡位+输入行一起上纸
    });
  // 夜访：岔路停问（地图退场——路在叙事里，停问在书页里）
  syncAsk('night', !!(s.nightView && !s.over),
    s.nightView ? [s.nightView.loc, s.nightView.room, s.nightView.slots, s.nightView.noise,
      s.nightView.directives ? 'directives' : '',
      s.nightView.fork ? s.nightView.fork.kind + s.nightView.fork.text : '',
      s.nightView.containers.map((c) => c.name + c.searched + c.locked).join('/'),
      s.nightView.npcs.map((n) => n.name + n.state).join('/')].join('|') : '', (node) => {
      const nv = s.nightView;
      node.innerHTML = askHead('夜访', nv.loc, 'moon');
      const meta = el('div', 'ask-meta');
      meta.innerHTML = `<span class="ask-room">在「${esc(nv.room)}」</span>
        <span class="matches small">${Array.from({ length: 10 }, (_, i) => `<span class="match ${i < 10 - nv.slots ? 'burnt' : ''}"></span>`).join('')}</span>
        ${nv.noise > 0 ? `<span class="noise-line">${svgUse('noise', 'hint-ic')}声响 ×${nv.noise}——有人听见了</span>` : ''}`;
      node.appendChild(meta);
      if (nv.containers.length) {
        const list = el('div', 'leaders');
        for (const c of nv.containers) {
          list.appendChild(el('div', 'lead-row' + (c.searched ? ' searched' : ''),
            `${svgUse(c.locked ? 'lock' : 'doc', 'lead-ic')}<span class="name">${esc(c.name)}</span><span class="dots-line"></span><span class="qty">${c.searched ? '已搜' : '—'}</span>`));
        }
        node.appendChild(list);
      }
      if (nv.npcs.length) {
        node.appendChild(el('p', 'ask-hint', '这里的人：' + nv.npcs.map((n) => {
          const st = { hostile: '敌意', wary: '警惕', friendly: '友好', ignored: '互不打扰', unknown: '?' }[n.state] || n.state;
          return `${esc(n.name)}（${st}）`;
        }).join('、')));
      }
      const opts = el('div', 'ask-opts');
      let nightReveal = null;
      if (nv.directives) {
        node.appendChild(el('p', 'fork-text', '定一个方针，他自己走完这一夜——遇人绕不绕、锁撬不撬、手动不动，方针和运气说了算。'));
        for (const d of nv.directives) {
          const ob = optBtn(d.label, '◆', () => sendIntents([{ type: 'night_directive', stance: d.stance, text: d.label }], d.label), d.hint || '');
          ob.dataset.label = d.label;
          opts.appendChild(ob);
        }
        const micro = optBtn('今夜我自己一步步走', '·', () => sendIntents([{ type: 'auto_night' }], '自己走'));
        micro.dataset.label = micro.textContent;
        opts.appendChild(micro);
        nightReveal = { beforeEl: micro }; // 谋士方针插在「自己走」前
      } else if (nv.fork) {
        node.appendChild(el('p', 'fork-text', esc(nv.fork.text || '怎么办？')));
        for (const o of nv.fork.options) opts.appendChild(optBtn(o.label, '◆', () => sendIntents(o.intents, o.label)));
        if (nv.micro) appendDirectiveHandoff(opts, s); // 微操夜的逃生门：剩下的夜交给方针
      } else if (!s.activeEvent) {
        opts.appendChild(optBtn('继续摸黑前进', '▸', () => sendIntents([{ type: 'auto_night' }], '继续')));
        opts.appendChild(optBtn('今晚到此为止', '←', () => sendIntents([{ type: 'night', action: 'retreat' }], '撤退')));
        if (nv.micro) appendDirectiveHandoff(opts, s);
      }
      node.appendChild(opts);
      const rr = refreshRow('night', opts);
      if (rr) node.appendChild(rr);
      node.appendChild(freeOptRow(s, 'night'));
      if (nightReveal) revealCardVeiled(node, opts, 'night', s, nightReveal); // 整卷等墨（岔路/继续分支不等）
    });
}

/** 序章三幕（叙事双轴 §2）：文本幕（天下/围城/前传/合流）翻页推进，卡拍沿用停问版式。
 *  首局无跳过键；二周目（short）给「翻过序章」——入口在 preludeView.canSkip。 */
function renderPrologue(s) {
  if (s.phase !== 'prologue') {
    if (state.lastPrologueCard) {
      state.lastPrologueCard = null;
      document.querySelectorAll('.prologue:not(.settled)').forEach((b) => b.classList.add('settled'));
    }
    return;
  }
  const pv = s.preludeView;
  const sig = pv ? `${pv.idx}:${pv.kind}:${pv.title || ''}:${pv.canSkip ? 1 : 0}` : `card:${s.eventView?.title || ''}`;
  if (state.lastPrologueCard === sig) return;
  state.lastPrologueCard = sig;
  document.querySelectorAll('.prologue').forEach((b) => b.classList.add('settled'));
  typist.flush();
  if (pv && pv.kind !== 'card') {
    const box = el('div', 'prologue prelude-beat');
    const kicker = pv.kind === 'prequel' ? `前传 · ${pv.title}` : (pv.title || '卷首');
    box.innerHTML = `<span class="kicker">${esc(kicker)}</span>`;
    for (const p of String(pv.text).split('\n').filter(Boolean)) {
      // 引文块：以「> 」开头的行按史书引文排版（序章引《三国志》原文与《演义》回目用）
      const isQuote = p.startsWith('> ');
      const para = el(isQuote ? 'blockquote' : 'p', '', rich(isQuote ? p.slice(2) : p));
      markNouns(para);
      box.appendChild(para);
    }
    const opts = el('div', 'prologue-opts');
    if (pv.id === 'openingChoice') {
      // 开场二选一（拍板 v5）：本账号完结一周目后才出现——完整三幕 or 精简版
      const full = el('button', 'opt', '<span class="key">全</span><span>完整开场——从天下讲起</span>');
      full.type = 'button';
      full.addEventListener('click', () => sendIntents([{ type: 'prelude_full' }], '完整开场'));
      const brief = el('button', 'opt', '<span class="key">简</span><span>精简开场——单句前传，直入城</span>');
      brief.type = 'button';
      brief.addEventListener('click', () => sendIntents([{ type: 'advance' }], '精简开场'));
      opts.append(full, brief);
    } else {
      const next = el('button', 'opt', '<span class="key">▸</span><span>翻页</span>');
      next.type = 'button';
      next.addEventListener('click', () => sendIntents([{ type: 'advance' }], '翻页'));
      opts.appendChild(next);
      if (pv.canSkip) {
        // 单句版专属：翻全卷（从「天下」重读完整三幕，已答过的卡不重复）
        const full = el('button', 'opt', '<span class="key">全</span><span>翻全卷——从天下读起</span>');
        full.type = 'button';
        full.addEventListener('click', () => sendIntents([{ type: 'prelude_full' }], '翻全卷'));
        opts.appendChild(full);
        const skip = el('button', 'opt opt-ghost', '<span class="key">⏎</span><span>翻过序章，直接进城</span>');
        skip.type = 'button';
        skip.addEventListener('click', () => sendIntents([{ type: 'skip_prelude' }], '翻过序章'));
        opts.appendChild(skip);
      }
    }
    box.appendChild(opts);
    $('narration').appendChild(box);
    revealFlow();
    return;
  }
  if (!s.eventView) return;
  const v = s.eventView;
  const box = el('div', 'prologue');
  box.innerHTML = `<span class="kicker">${esc(v.title)}</span>`;
  for (const p of String(v.text).split('\n').filter(Boolean)) { const elp = el('p', '', rich(p)); markNouns(elp); box.appendChild(elp); }
  const opts = el('div', 'prologue-opts');
  v.options.forEach((o, i) => {
    const b = el('button', 'opt', `<span class="key">${i + 1}</span><span>${esc(o.label)}</span>`);
    b.type = 'button';
    b.addEventListener('click', () => sendIntents([{ type: 'event_choice', option: o.key }], o.label));
    opts.appendChild(b);
  });
  box.appendChild(opts);
  $('narration').appendChild(box);
  revealFlow();
}


/** 局终：长卷结算（回忆录 → 局的日线 → 三件事 → 人的账 → 后日谈） */
function renderEnding(s) {
  const box = $('narration');
  closePara();
  const END_TITLE = { ceasefire: '第四十一天', maicheng: '麦城得脱', pyrrhic: '惨　胜', alt_both: '另一种三国', contract_end: '交割日', lighthouse: '还　师', join_table: '出江陵记', hostage: '槛　车', sidestory: '别传' };
  const title = s.ending.type === 'sidestory' ? (s.ending.storyline?.title || '别传') : (END_TITLE[s.ending.type] || '无人幸免');
  const story = s.ending.storyline;
  const codex = story?.codex || {};
  /* ── 幕一 落幕：题名 + 收束行（手写正典文案，逐行浮现）── */
  const curtain = el('div', 'finale curtain');
  curtain.appendChild(el('div', 'ending', `<div class="title">${title}</div>`));
  for (const [i, line] of (codex.lines || []).entries()) {
    const cls = line.startsWith('变了') ? 'finale-line flip-chg reveal' : line.startsWith('没变') ? 'finale-line flip-keep reveal' : 'finale-line reveal';
    curtain.appendChild(el('p', cls, esc(line)));
    curtain.lastChild.style.animationDelay = `${1.2 + i * 1.6}s`;
  }
  box.appendChild(curtain);

  /* ── 幕二·五 后日谈：本局结局的开放未来（0.21.0：每局自己的城市肌理）── */
  const futures = codex.futures || [];
  if (futures.length) {
    const fu = el('div', 'finale-act futures reveal');
    fu.style.animationDelay = `${1.6 + (codex.lines || []).length * 1.6 + 1.6}s`;
    fu.appendChild(el('span', 'kicker', '后日谈'));
    for (const l of futures) {
      const cls = l.startsWith('（') ? 'future-line blank' : 'future-line';
      fu.appendChild(el('p', cls, esc(l)));
    }
    box.appendChild(fu);
  }

  /* ── 幕二 史册：双轨摊开（城轨 × 将军轨）+ 野史批注 ── */
  const scroll = el('div', 'finale-act codex reveal');
  scroll.style.animationDelay = `${1.6 + (codex.lines || []).length * 1.6 + 1}s`;
  scroll.appendChild(el('span', 'kicker', '史册 · 双轨'));
  const dual = el('div', 'dual-track');
  const mkCol = (label, list) => {
    const col = el('div', 'track-col');
    col.appendChild(el('h5', '', label));
    for (const b of list.slice(-7)) col.appendChild(el('p', 'sys', `第${b.day}天　${esc(b.title)}　${esc((b.text || '').slice(0, 26))}…`));
    return col;
  };
  dual.appendChild(mkCol('城　轨（你们的日子）', codex.tracks?.city || []));
  dual.appendChild(mkCol('将军轨（北边的路）', codex.tracks?.gen || []));
  scroll.appendChild(dual);
  const annals = story?.annals || [];
  if (annals.length) {
    const an = el('div', 'annals');
    an.appendChild(el('span', 'kicker', '野史'));
    for (const a of annals) {
      if (a.text) an.appendChild(el('p', 'fate', esc(a.text)));
      an.appendChild(el('p', 'sys', `批注：${esc(a.note)}`));
    }
    scroll.appendChild(an);
  }
  box.appendChild(scroll);

  /* ── 幕三 擦痕：史×你（同一天的两种记账）── */
  const echoes = story?.echoes || [];
  if (echoes.length) {
    const ec = el('div', 'finale-act echoes reveal');
    ec.style.animationDelay = `${1.6 + (codex.lines || []).length * 1.6 + 2.2}s`;
    ec.appendChild(el('span', 'kicker', '史 × 你'));
    for (const e of echoes) {
      ec.appendChild(el('p', 'echo-line', `<i>第${e.day}天</i>史册记「${esc(e.hist)}」；你的墙上记：${esc(e.deed)}。<b>史书没记这一页。</b>`));
    }
    box.appendChild(ec);
  }

  /* ── 幕四 回忆录与人的账（原区块：回忆录/三件事/账/命运/列传）── */
  if (s.ending.memoir) {
    memoirTypist.flush();
    const m = $('memoir-block') || el('div', 'memoir'); m.id = 'memoir-block';
    m.innerHTML = '';
    for (const para of String(s.ending.memoir).split('\n').filter(Boolean)) m.appendChild(el('p', '', esc(para)));
    box.appendChild(m);
  }
  if (s.ending.threeThings?.length) {
    const tt = el('div', 'three-things');
    tt.appendChild(el('span', 'kicker', '这一局的三件事'));
    tt.appendChild(runTimeline(s));
    for (const t of s.ending.threeThings) tt.appendChild(el('p', 'sys', `第${t.day}天　${esc(t.text)}`));
    box.appendChild(tt);
  }
  if (story) {
    const acc = el('div', 'three-things ledger');
    acc.appendChild(el('span', 'kicker', '人的账'));
    for (const ep of story.epilogues || []) {
      for (const chn of (story.chains?.[ep.id] || []).slice(0, 2)) {
        acc.appendChild(el('p', 'sys', `${esc(ep.name)}${esc(chn.read)}的：第${chn.day}天　${esc(chn.text)}`));
      }
    }
    for (const l of [...(story.pairLines || []), ...(story.charLines || [])]) acc.appendChild(el('p', 'sys', esc(l)));
    box.appendChild(acc);
  }
  for (const c of s.ending.chars) box.appendChild(el('p', 'fate', `<b>${esc(c.name)}</b>　${esc(c.fate)}`));
  const bios = s.ending.biographies || [];
  if (bios.length) {
    const DIR_BADGE = { fallen: '殁', haunted: '恸', honored: '誉', survived: '存' };
    const bd = el('div', 'three-things bios');
    bd.appendChild(el('span', 'kicker', '列传'));
    for (const b of bios) {
      const card = el('div', 'bio-card');
      card.appendChild(el('h4', 'bio-name', esc(b.name)));
      const ep = (story?.epilogues || []).find((x) => x.id === b.id);
      if (ep?.direction) card.appendChild(el('span', `bio-dir bio-${ep.direction}`, DIR_BADGE[ep.direction] || ''));
      for (const para of String(b.text).split(/(?=后日谈：)/).filter(Boolean)) card.appendChild(el('p', '', esc(para)));
      if (ep?.timeline?.length) {
        const tl = el('ul', 'bio-timeline');
        for (const t of ep.timeline) tl.appendChild(el('li', '', `第${t.day}天　${esc(t.text)}`));
        card.appendChild(tl);
      }
      bd.appendChild(card);
    }
    box.appendChild(bd);
  }

  /* ── 幕五 留赠：把一件东西留给后来的陌生人（反战的最后一拍）── */
  renderCapsuleForm(box, s);
  box.appendChild(el('p', 'sys', '（档案馆已收录本局与这篇复盘。从菜单翻开新的一页，城市会记得。）'));
  scrollFlow(true);
}
/** 局终日线：1..day 轴上钉三件事的落点 */
function runTimeline(s) {
  const last = Math.max(s.day, ...s.ending.threeThings.map((t) => t.day), 10);
  const W = 480, H = 30, x0 = 10, x1 = W - 10;
  const dx = (d) => x0 + (x1 - x0) * ((d - 1) / Math.max(last - 1, 1));
  let g = `<svg viewBox="0 0 ${W} ${H}" class="run-tl" aria-hidden="true"><line x1="${x0}" y1="15" x2="${x1}" y2="15" class="axis"/>`;
  g += `<text x="${x0}" y="27" text-anchor="middle">第1日</text><text x="${x1}" y="27" text-anchor="middle">第${last}日</text>`;
  for (const t of s.ending.threeThings) {
    const x = dx(t.day);
    g += `<line x1="${x}" y1="7" x2="${x}" y2="15" class="evt-line"/><circle cx="${x}" cy="15" r="3" class="evt-dot"/>`;
  }
  g += '</svg>';
  return el('div', 'run-tl-box', g);
}
/** 回忆录流式增量：交给句级浮现引擎，与叙事流同节拍 */
function streamMemoir(delta) { memoirTypist.feed(delta); }

/* ════════════════════════════════════════════════════════════════
   覆盖层与选单：幕布共用；Esc / 点幕布合上。
   选单 = 这本书的扉页：这一局、没写完的局、另起一局、阅读、别处、落款。
   ════════════════════════════════════════════════════════════════ */
function openSheet(id) {
  hideCharPop();
  for (const x of ['menu', 'homebook']) $(x).hidden = x !== id;
  document.body.classList.add('overlay-open');
}
function closeSheets() {
  for (const x of ['menu', 'homebook']) $(x).hidden = true;
  closeWing();
  document.body.classList.remove('overlay-open');
}
// 舆图/史卷抽屉（移动端）：窄屏下侧栏让位给书页，点「舆图」从底部拉出
function closeWing() { document.body.classList.remove('wing-open'); }
$('btn-wing').addEventListener('click', () => {
  if (document.body.classList.contains('wing-open')) closeWing();
  else { closeSheets(); document.body.classList.add('wing-open'); }
});
// 抽屉头上给一只合上的手（一次性注入，窄屏 CSS 才显形）
{
  const head = el('div', 'wing-drawer-head');
  head.innerHTML = `<span class="kicker">舆图 · 史卷</span><button class="sheet-x" type="button" aria-label="合上">${svgUse('close')}</button>`;
  head.querySelector('.sheet-x').addEventListener('click', closeWing);
  $('wing').prepend(head);
}
$('overlay-backdrop').addEventListener('click', () => { closeSheets(); });
// 档案馆/管理的显式返回（菜单里的「对局」仍在，但入口要一眼看得见）
$('back-from-archive').addEventListener('click', () => switchView('play'));
$('back-from-admin').addEventListener('click', () => switchView('play'));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.body.classList.contains('wing-open')) closeWing();
    else if (document.body.classList.contains('overlay-open')) closeSheets();
    else if (state.view === 'play' && !$('game').hidden) openMenu();
    hideCharPop();
  }
});
$('btn-menu').addEventListener('click', () => {
  if (document.body.classList.contains('overlay-open') && !$('menu').hidden) closeSheets();
  else openMenu();
});

async function openMenu() {
  const sheet = $('menu');
  const s = state.s;
  const inGame = state.view === 'play' && !$('game').hidden && state.runId;
  // 对局列表现取（另一台设备上的进度也算数）
  const r = await (await fetch('/api/runs')).json().catch(() => ({}));
  const runs = (r.runs || []).filter((x) => x.status === 'active');

  let html = `<div class="sheet-head"><span class="kicker">选单 · 扉页</span>
    <button class="sheet-x" type="button" aria-label="合上">${svgUse('close')}</button></div>
    <h1 class="sheet-title">门后之书</h1>`;

  // 这一局
  html += `<section class="m-sec"><p class="m-kicker">这一局</p>`;
  if (inGame && s) {
    html += `<p class="m-line">第 <b>${s.day}</b> 日 · ${PHASE_NAME[s.phase] || s.phase} · ${WEATHER_NAME[s.weather] || ''}${s.over ? ' · 已写完' : ' · 进行中'}</p>
      <p class="hint">每一笔都落在纸上——不用存，也不会丢。合上眼、刷新、换一台机器，日子都在。</p>
      ${s.over ? '' : '<button class="ghost" id="m-abandon" type="button">封存这一局</button>'}`;
  } else {
    html += `<p class="hint">手边还没有翻开的书。从下面另起一局，或在卷首语里住进去。</p>`;
  }
  html += `</section>`;

  // 没写完的局（每行：翻回去 + 删掉——删是真删，两步确认）
  html += `<section class="m-sec"><p class="m-kicker">没写完的局</p>`;
  if (runs.length) {
    html += `<div class="m-runs">` + runs.map((run) =>
      `<div class="m-run-row">
        <button class="m-run" type="button" data-run="${run.id}" ${run.id === state.runId ? 'disabled' : ''}>
          <b>第 ${run.day ?? '?'} 日</b><span class="m-run-meta">${run.mode === 'llm' ? 'LLM' : '直读'} · ${String(run.started_at || '').slice(5, 10)}${run.id === state.runId ? ' · 手头这本' : ''}</span>
        </button>
        <button class="m-del" type="button" data-del="${run.id}" title="删掉这份存档（档案馆的收录保留）">删</button>
      </div>`).join('') + `</div>`;
  } else {
    html += `<p class="hint">没有没写完的局。</p>`;
  }
  html += `</section>`;

  // 另起一局
  html += `<section class="m-sec"><p class="m-kicker">另起一局</p>
    <div class="m-row"><button class="primary" id="m-new" type="button">翻开新的一页</button></div>
    ${inGame ? '<p class="hint">手头这局会留在「没写完的局」里，随时翻回来。</p>' : ''}</section>`;

  // 阅读
  html += `<section class="m-sec"><p class="m-kicker">阅读</p>
    <div class="m-row"><span class="m-label">字号</span><span class="seg" id="m-font">
      ${[['s', '小'], ['m', '中'], ['l', '大']].map(([v, n]) => `<button type="button" data-v="${v}" class="${prefs.font === v ? 'on' : ''}">${n}</button>`).join('')}
    </span></div>
    <div class="m-row"><span class="m-label">落墨动效</span><span class="seg" id="m-motion">
      ${[['on', '开'], ['off', '关']].map(([v, n]) => `<button type="button" data-v="${v}" class="${prefs.motion === v ? 'on' : ''}">${n}</button>`).join('')}
    </span></div>
    <div class="m-row"><span class="m-label">纸色</span><span class="seg" id="m-paper">
      ${[['dark', '玄案'], ['silk', '素帛']].map(([v, n]) => `<button type="button" data-v="${v}" class="${prefs.paper === v ? 'on' : ''}">${n}</button>`).join('')}
    </span></div>
    <div class="m-row"><span class="m-label">声音</span><span class="seg" id="m-sound">
      ${[['off', '关'], ['on', '开']].map(([v, n]) => `<button type="button" data-v="${v}" class="${prefs.sound === v ? 'on' : ''}">${n}</button>`).join('')}
    </span></div>
    <div class="m-row"><span class="m-label">环境声</span><span class="seg" id="m-ambience">
      ${[['off', '关'], ['on', '开']].map(([v, n]) => `<button type="button" data-v="${v}" class="${prefs.ambience === v ? 'on' : ''}">${n}</button>`).join('')}
    </span><span class="m-note">雨声·风雪·远水，随天气与去处</span></div></section>`;

  // 别传（档案馆认出的门；未解锁的不点灯）
  html += `<section class="m-sec" id="m-sides"><p class="m-kicker">别传</p><div class="m-row hint">…</div></section>`;
  fetch('/api/sidestories').then((r) => r.json()).then((r) => {
    const box = sheet.querySelector('#m-sides .m-row');
    if (!box) return;
    const open = (r.stories || []).filter((x) => x.unlocked);
    if (!open.length) { box.innerHTML = '<span class="hint">档案馆里还没有认得你的故事。</span>'; return; }
    box.innerHTML = '';
    for (const st of open) {
      const b = el('button', 'ghost', `${esc(st.title)}（${st.days}日）`);
      b.title = st.blurb || '';
      b.addEventListener('click', () => { closeSheets(); startRun(null, st.id); });
      box.appendChild(b);
    }
  }).catch(() => {});
  // 别处
  html += `<section class="m-sec"><p class="m-kicker">别处</p>
    <div class="m-row">
      ${state.view === 'play' && inGame ? '<button class="ghost" id="m-back" type="button">回到书里</button>' : ''}
      ${state.view !== 'archive' ? '<button class="ghost" id="m-archive" type="button">档案馆</button>' : ''}
      ${state.view !== 'play' ? '<button class="ghost" id="m-play" type="button">对局</button>' : ''}
      ${state.user.is_admin && state.view !== 'admin' ? '<button class="ghost" id="m-admin" type="button">管理</button>' : ''}
    </div></section>`;

  // 落款
  html += `<section class="m-sec m-account"><span class="m-user">${esc(state.user.name)}${state.user.is_admin ? ' · 管理' : ''}</span>
    <button class="ghost" id="m-logout" type="button">退出登录</button></section>`;

  sheet.innerHTML = html;

  sheet.querySelector('.sheet-x').addEventListener('click', closeSheets);
  sheet.querySelector('#m-abandon')?.addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed) { abandonRun(); return; }
    b.dataset.armed = '1';
    b.textContent = '再按一次确认封存（档案馆记得这一局）';
    b.classList.add('armed');
    setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '封存这一局'; b.classList.remove('armed'); } }, 3500);
  });
  sheet.querySelectorAll('.m-run').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.run;
    closeSheets();
    if (id !== state.runId) resumeRun(id);
    else switchView('play');
  }));
  // 删掉存档：两步确认；删的是手头这本 → 回卷首（删是真删，档案馆的收录保留）
  sheet.querySelectorAll('.m-del').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.del;
    if (state.busy) return;
    if (!b.dataset.armed) {
      b.dataset.armed = '1';
      b.textContent = '真删？';
      b.classList.add('armed');
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '删'; b.classList.remove('armed'); } }, 3500);
      return;
    }
    b.disabled = true;
    const res = await fetch(`/api/runs/${id}`, { method: 'DELETE' });
    if (!res.ok) { b.disabled = false; b.textContent = '删'; b.classList.remove('armed'); return; }
    if (id === state.runId) { closeSheets(); backToSetup(); return; }
    const row = b.closest('.m-run-row');
    if (row) {
      row.remove();
      const box = sheet.querySelector('.m-runs');
      if (box && !box.querySelectorAll('.m-run-row').length) box.innerHTML = '<p class="hint">没有没写完的局。</p>';
    }
  }));
  sheet.querySelector('#m-new').addEventListener('click', () => {
    closeSheets();
    if (state.view !== 'play') switchView('play');
    startRun();
  });
  sheet.querySelector('#m-font').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    prefs.font = v; savePrefs(); applyPrefs();
    sheet.querySelectorAll('#m-font button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
  });
  sheet.querySelector('#m-motion').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    prefs.motion = v; savePrefs(); applyPrefs();
    sheet.querySelectorAll('#m-motion button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
  });
  sheet.querySelector('#m-paper').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    prefs.paper = v; savePrefs(); applyPrefs();
    sheet.querySelectorAll('#m-paper button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
  });
  sheet.querySelector('#m-sound').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    prefs.sound = v; savePrefs(); applyPrefs();
    sheet.querySelectorAll('#m-sound button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
    if (v === 'on') sfx.drum(); // 试音：一记远鼓
  });
  sheet.querySelector('#m-ambience').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    prefs.ambience = b.dataset.v; savePrefs(); applyPrefs();
    sheet.querySelectorAll('#m-ambience button').forEach((x) => x.classList.toggle('on', x.dataset.v === b.dataset.v));
  });
  sheet.querySelector('#m-back')?.addEventListener('click', () => { closeSheets(); switchView('play'); });
  sheet.querySelector('#m-archive')?.addEventListener('click', () => { closeSheets(); switchView('archive'); });
  sheet.querySelector('#m-play')?.addEventListener('click', () => { closeSheets(); switchView('play'); });
  sheet.querySelector('#m-admin')?.addEventListener('click', () => { closeSheets(); switchView('admin'); });
  sheet.querySelector('#m-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.replace('/');
  });
  openSheet('menu');
}
/** 封存当前局：书合上，回卷首 */
async function abandonRun() {
  if (!state.runId) return;
  await fetch(`/api/runs/${state.runId}/abandon`, { method: 'POST' });
  closeSheets();
  backToSetup();
}

/* ════════════════════════════════════════════════════════════════
   UIP-4 名词情报卡：散文不只是读的，是可以进去翻的。
   叙事流里的人名/地名/物品名浮出「已知情报」——全部由内核状态
   驱动的模板（不超纲、零成本），LLM 现编一个字都不行。
   ════════════════════════════════════════════════════════════════ */
const LOC_NAMES = { home: '橘里九号', market: '南市', church: '里社', hospital: '医棚', post: '驿亭', villas: '宅区', frontline: '水门渡旧垒', sewer: '城濠水窦', beacon: '北津台' };
const LOC_LINE = {
  home: '家。门、床、炉火，和墙上的名字。白天在这里做事，夜里从这里出发。',
  market: '被焚过的南市。铺面塌了，货被翻过几轮——白天别去，夜里小心人。',
  church: '府库里社。听得见钟声的地方，也是这座城还剩不多的讲理的地方。',
  hospital: '杜仲的医棚。还有药，也还有排队的人。别在这儿提捷报。',
  post: '驿亭，死信库。几千封没能送到的信——有人的一整个秋天都压在里面。',
  villas: '大族宅区。值钱东西多，锁也多——大族带走了符传，带不走的都在这儿。',
  frontline: '水门渡旧垒。炮声从那里来；滩涂上叠着旧垒，最贵的东西在没人敢去的地方。',
  sewer: '城濠水窦。濠里的人知道所有墙根的洞——吃的换话，是他们唯一的市。',
  beacon: '北津台，江边第三台。鼓架还在，薪柴还干——像有人一直在等它再响。'
};
const CAT_LINE = {
  '食物': '能吃。做熟的更顶饿——生粮伤胃，熟饭养人。', '水': '渴的时候它比什么都贵。烧开了再喝。', '燃料': '火与暖的来路。严冬里，柴就是命。',
  '医疗': '伤病时的指望。药可以省，干净不能省。', '材料': '修修补补的原料。家什都从这儿长出来。', '工具': '手上的力气，门后的底气。别外借过头。',
  '嗜好': '不是必需品——所以才金贵。人心也要吃饭。', '值钱': '饿不死人的东西，能换饿死人的东西。留给鲁舟。'
};
/** 名词索引：人名恒收；地名恒收；物品名只收双字以上（单字词误伤散文） */
function nounIndex() {
  const s = state.s;
  if (!s) return null;
  const idx = new Map();
  for (const c of s.charView) idx.set(c.name, { kind: 'char', id: c.id });
  for (const [id, name] of Object.entries(LOC_NAMES)) idx.set(name, { kind: 'loc', id });
  for (const [id, [name]] of Object.entries(ITEM_META)) {
    if (name.length >= 2) idx.set(name, { kind: 'item', id });
  }
  return idx;
}
let NOUN_RE = null, NOUN_IDS = null;
function rebuildNounRe() {
  const idx = nounIndex();
  if (!idx) { NOUN_RE = null; return; }
  NOUN_IDS = idx;
  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keys = [...idx.keys()].sort((a, b) => b.length - a.length);
  NOUN_RE = keys.length ? new RegExp(keys.map(escRe).join('|'), 'g') : null;
}
/** 把句子里已知的名词包上 .noun（只走文本节点，不碰已有标记） */
function markNouns(rootEl) {
  if (!NOUN_RE) rebuildNounRe();
  if (!NOUN_RE) return;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);
  for (const node of targets) {
    const text = node.nodeValue;
    NOUN_RE.lastIndex = 0;
    if (!NOUN_RE.test(text)) continue;
    NOUN_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = NOUN_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const entry = NOUN_IDS.get(m[0]);
      const w = document.createElement('span');
      w.className = 'noun';
      w.dataset.k = entry.kind; w.dataset.id = entry.id;
      w.textContent = m[0];
      frag.appendChild(w);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}
/** 情报内容：人/物/地各一副模板，全部读 state.s */
function nounIntel(entry) {
  const s = state.s;
  if (!s) return null;
  if (entry.kind === 'char') {
    const c = s.charView.find((x) => x.id === entry.id);
    if (!c) return null;
    if (!c.alive) return { kicker: '讣', title: c.name, lines: [c.role, c.desc, '没能撑过去。'].filter(Boolean) };
    return { kicker: '人', title: c.name, lines: [c.role, `心情${c.mood}`, charWords(c).join('，') || '身上没伤，肚里有食。'] };
  }
  if (entry.kind === 'item') {
    const [name, cat] = ITEM_META[entry.id] || [];
    if (!name) return null;
    const n = (s.inventory || {})[entry.id] || 0;
    return { kicker: '物', title: name + (n ? ` ×${n}` : ''), lines: [cat, (state.s.itemFlavors || {})[entry.id] || CAT_LINE[cat] || ''] };
  }
  if (entry.kind === 'loc') {
    const known = (s.knownLocs || []).includes(entry.id);
    return { kicker: known ? '地' : '？', title: LOC_NAMES[entry.id] || entry.id, lines: [known ? '去过，夜里可以再去。' : '只在传闻里。', LOC_LINE[entry.id] || ''] };
  }
  return null;
}
// 情报卡本体：悬浮出现，随名词移动
(function initNounCard() {
  const card = el('div', 'noun-card'); card.id = 'noun-card'; card.hidden = true;
  document.body.appendChild(card);
  let hideTimer = null;
  const show = (noun) => {
    const entry = { kind: noun.dataset.k, id: noun.dataset.id };
    const intel = nounIntel(entry);
    if (!intel) return;
    card.innerHTML = `<span class="nc-kicker">${intel.kicker}</span><b class="nc-title">${esc(intel.title)}</b>` +
      intel.lines.filter(Boolean).map((l) => `<span class="nc-line">${esc(l)}</span>`).join('');
    card.hidden = false;
    const r = noun.getBoundingClientRect();
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x = Math.min(Math.max(r.left + r.width / 2 - cw / 2, 10), window.innerWidth - cw - 10);
    let y = r.top - ch - 10;
    if (y < 10) y = r.bottom + 10;
    card.style.left = x + 'px'; card.style.top = y + 'px';
  };
  const hide = () => { card.hidden = true; };
  document.addEventListener('mouseover', (e) => {
    const noun = e.target.closest('.noun');
    if (!noun) return;
    clearTimeout(hideTimer);
    show(noun);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.noun')) hideTimer = setTimeout(hide, 80);
  });
  // 触屏：点名词翻卡，点别处合上
  document.addEventListener('click', (e) => {
    const noun = e.target.closest('.noun');
    if (noun) { e.preventDefault(); show(noun); }
    else if (!e.target.closest('#noun-card')) hide();
  });
})();

// ——— 档案馆 ———
async function loadArchive() {
  const r = await (await fetch('/api/archive')).json();
  // 合上兰台（§3.6）：条件齐了才出现，两步确认，谢幕是内容不是彩蛋
  const cb = $('closure-box');
  if (cb) {
    cb.innerHTML = '';
    if (r.closure?.done) {
      cb.hidden = false;
      cb.appendChild(el('p', 'hint', '兰台已合上。这个故事讲完了——架子还在，随时能再翻开。'));
    } else if (r.closure?.available) {
      cb.hidden = false;
      const b = el('button', 'ghost', '合上兰台');
      b.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = '再按一次：把这三个月讲完'; return; }
        const rr = await (await fetch('/api/archive/close', { method: 'POST' })).json();
        cb.innerHTML = '';
        cb.appendChild(el('p', 'fate', '这三个月讲完了。江陵会记得。'));
        for (const line of rr.farewell || []) cb.appendChild(el('p', 'sys', esc(line)));
      });
      cb.appendChild(el('p', 'hint', '文档齐了，还师与出江陵各走过一回，回忆录也厚了。'));
      cb.appendChild(b);
    }
  }
  const ENDING_NAME = { ceasefire: '开城', maicheng: '开城·麦城得脱', pyrrhic: '惨胜', alt_both: '另一种三国', contract_end: '交割日', wiped: '无人幸免', lighthouse: '还师', join_table: '出江陵记', sidestory: '别传' };
  $('archive-progress').textContent = `已入档 ${r.layers.progress.docs} / ${r.layers.progress.total} 份文件——这座城还没说完的话，都在纸上。`;
  const wall = $('layer-states'); wall.innerHTML = '';
  for (const [k, name] of Object.entries(r.layers.layerNames)) {
    const unlocked = r.layers['layer' + k];
    wall.appendChild(el('div', 'layer-state' + (unlocked ? '' : ' locked'),
      `<b>${esc(name)}</b><span class="tag-line">${unlocked ? '已显形' : '尚未显形'}</span>`));
  }
  const dw = $('doc-wall'); dw.innerHTML = '';
  if (!r.docs.length) dw.appendChild(el('p', 'hint', '还没有任何文件。夜晚去驿亭、里社、宅区翻一翻——或者在自家地窖的墙皮后面。'));
  for (const d of r.docs) {
    // 材质分级：层 3 铁证=碑拓（黑底白文），层 0 私物=缣帛（家书/死信），其余=竹简
    const mat = d.layer >= 3 ? ' iron' : (d.layer <= 0 ? ' silk' : '');
    const doc = el('div', 'doc' + mat);
    doc.innerHTML = `<span class="doc-id">${esc(d.id)}</span><b>${esc(d.title)}</b>
      <details><summary>读</summary><p>${esc(d.text)}</p></details>`;
    dw.appendChild(doc);
  }
  // 已显形的真相（封印注入协议：解锁过的才在墙上）
  const sealWall = $('seal-wall');
  if (sealWall) {
    sealWall.innerHTML = '';
    const seals = r.seals || [];
    $('archive-seals-box').hidden = !seals.length;
    if (seals.length) sfx.crack(); // 语义音：封泥碎裂——墙上有你挣出来的真相
    for (const x of seals) {
      const d = el('div', 'doc seal');
      d.innerHTML = `<span class="doc-id">层 ${esc(x.layer)}</span><p>${esc(x.text)}</p>`;
      sealWall.appendChild(d);
    }
  }
  // 史册格（GDD-v0.2 §12.1）：正史栏=通行叙事；野史栏=你打出来的那几页
  const ca = $('canon-annals'); ca.innerHTML = '';
  for (const a of r.canonAnnals || []) ca.appendChild(el('div', 'doc annal-canon', `<p>${esc(a.text)}</p>`));
  const aa = $('alt-annals'); aa.innerHTML = '';
  if (!(r.annals || []).length) aa.appendChild(el('p', 'hint', '野史栏空着。历史还没有被你惊动过。'));
  for (const a of r.annals || []) {
    const d = el('div', 'doc annal-alt');
    d.innerHTML = `<span class="doc-id">${esc(ENDING_NAME[a.id] || '或然')}</span>${a.text ? `<p>${esc(a.text)}</p>` : ''}<p class="mem-meta">批注：${esc(a.note)}</p>`;
    aa.appendChild(d);
  }
  // 回响区（EC）：时间胶囊、遗愿、商路的记性
  const echoes = r.echoes || [];
  $('archive-echoes-box').hidden = !echoes.length;
  const ew = $('echoes-wall'); ew.innerHTML = '';
  for (const e of echoes) {
    const d = el('div', 'doc');
    if (e.kind === 'capsule') d.innerHTML = `<span class="doc-id">时间胶囊</span><p>「${esc(e.message)}」${e.foundRun ? '（东西已被后来的局取走）' : '（埋在橘里九号的后院）'}</p>`;
    else if (e.kind === 'wish') d.innerHTML = `<span class="doc-id">遗愿</span><p>${esc(e.text)}——${e.status === 'fulfilled' ? '已偿' : e.status === 'expired' ? '未完成' : '在办'}</p>`;
    else d.innerHTML = `<span class="doc-id">商路记得</span><p>${esc(e.text || '')}</p>`;
    ew.appendChild(d);
  }
  // 回忆录书架（EPI-02 的跨局回读）：有回忆录的局，倒序上墙
  const memoirs = (r.runs || []).filter((x) => x.memoir).reverse();
  $('archive-memoirs-box').hidden = !memoirs.length;
  const shelf = $('memoir-shelf'); shelf.innerHTML = '';
  // 回忆录成册（EX-01 导出）：一本书，下载即走
  if (memoirs.length) {
    const dl = el('a', 'ghost-link', '装订成册 · 下载《我的江陵》');
    dl.href = '/api/archive/memoir-book';
    dl.setAttribute('download', 'wo-de-jiangling.txt');
    shelf.before(dl);
  }
  for (const run of memoirs) {
    const card = el('div', 'doc memoir-card');
    const who = [
      run.survivors?.length ? `生还：${run.survivors.join('、')}` : '',
      run.fallen?.length ? `殁：${run.fallen.join('、')}` : ''
    ].filter(Boolean).join('；');
    card.innerHTML = `<span class="doc-id">${esc(ENDING_NAME[run.ending] || run.ending || '终局')}</span><b>${run.day} 天的一局</b>
      <p class="mem-meta">${esc(who || '没有人走出来')}</p>
      <details><summary>读复盘</summary><div class="mem-text">${String(run.memoir).split('\n').filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')}</div></details>`;
    // 删掉这一局：复盘随局走（档案馆其余收录保留），两步确认
    if (run.runId) {
      const del = el('button', 'memoir-del', '删掉这一局');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!del.dataset.armed) {
          del.dataset.armed = '1';
          del.textContent = '再按一次：复盘与存档一并删去';
          del.classList.add('armed');
          setTimeout(() => { if (del.isConnected) { del.dataset.armed = ''; del.textContent = '删掉这一局'; del.classList.remove('armed'); } }, 3500);
          return;
        }
        del.disabled = true;
        const res = await fetch(`/api/runs/${run.runId}`, { method: 'DELETE' });
        if (res.ok) loadArchive();
        else { del.disabled = false; del.textContent = '删掉这一局'; del.classList.remove('armed'); }
      });
      card.appendChild(del);
    }
    shelf.appendChild(card);
  }
}

// ——— 管理后台（管理员账号登录后可用；会话走 cookie） ———
async function initAdmin() {
  if (!state.user?.is_admin) { $('admin-login').hidden = false; $('admin-body').hidden = true; return; }
  $('admin-login').hidden = true; $('admin-body').hidden = false;
  await loadAdmin();
}
async function loadAdmin() {
  loadSignupToggle();
  const r = await (await fetch('/api/admin/providers')).json();
  loadUsers();
  const t = $('providers-table');
  t.innerHTML = '<tr><th>名称</th><th>协议</th><th>Base URL</th><th>模型</th><th>Key</th><th>操作</th></tr>';
  for (const p of r.providers) {
    const tr = el('tr', '', `<td>${esc(p.name)}</td><td>${esc(p.adapter)}</td><td>${esc(p.base_url)}</td><td>${esc(p.model)}</td><td>${p.hasKey ? '已配置' : '—'}</td>`);
    const td = el('td');
    const test = el('button', 'ghost', '测试'); test.style.padding = '2px 12px';
    test.addEventListener('click', async () => {
      test.textContent = '…';
      const res = await (await fetch('/api/admin/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: p.id }) })).json();
      const h = res.results[0];
      test.textContent = h.ok ? `${h.latencyMs}ms` : '失败';
      test.className = h.ok ? 'ok' : 'fail';
      test.title = h.ok ? h.echo : h.error;
      loadHealth();
    });
    const del = el('button', 'ghost', '删除'); del.style.padding = '2px 12px';
    del.addEventListener('click', async () => { await fetch(`/api/admin/providers/${p.id}`, { method: 'DELETE' }); loadAdmin(); });
    td.append(test, del); tr.appendChild(td); t.appendChild(tr);
  }
  const rt = $('routes-table');
  rt.innerHTML = '<tr><th>用途</th><th>主 Provider</th><th>备 Provider</th></tr>';
  const purposes = ['referee', 'narrator', 'actor'];
  const routeMap = Object.fromEntries(r.routes.map((x) => [x.purpose, x]));
  for (const purpose of purposes) {
    const tr = el('tr');
    tr.appendChild(el('td', '', { referee: '裁判（意图解析）', narrator: '叙事者', actor: '演员（NPC）' }[purpose]));
    for (const which of ['providerId', 'fallbackId']) {
      const td = el('td');
      const s2 = el('select');
      s2.innerHTML = '<option value="">（无·直读）</option>' + r.providers.map((p) => {
        const cur = which === 'providerId' ? routeMap[purpose]?.provider_id : routeMap[purpose]?.fallback_provider_id;
        return `<option value="${p.id}" ${cur === p.id ? 'selected' : ''}>${esc(p.name)}</option>`;
      }).join('');
      s2.onchange = async () => {
        const body = { purpose, providerId: routeMap[purpose]?.provider_id || null, fallbackId: routeMap[purpose]?.fallback_provider_id || null };
        body[which] = Number(s2.value) || null;
        await fetch('/api/admin/llm/routes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        loadAdmin();
      };
      td.appendChild(s2); tr.appendChild(td);
    }
    rt.appendChild(tr);
  }
  loadHealth();
}
async function loadHealth() {
  const r = await (await fetch('/api/admin/llm/health-history')).json();
  $('health-history').innerHTML = (r.history || []).slice(0, 12).map((h) =>
    `<div class="row">${esc(h.provider_name || '?')} · <span class="${h.ok ? 'ok' : 'fail'}">${h.ok ? '通' : '断'}</span> · ${h.latency_ms}ms · ${esc((h.detail?.error || h.detail?.echo || '').slice(0, 60))} · ${esc(h.at?.slice(5, 16))}</div>`).join('');
}
/** 准入开关（管理页）：新用户注册——城门开合，全服一处 */
async function loadSignupToggle() {
  const btn = $('btn-signup-toggle');
  const state = $('signup-toggle-state');
  if (!btn) return;
  const r = await (await fetch('/api/admin/settings')).json();
  const paint = (open) => {
    btn.textContent = open ? '合上城门（暂停登记）' : '开城门（恢复登记）';
    state.textContent = open ? '开放中——新住户可以登记' : '已暂停——仅老住户可登录';
  };
  paint(!!r.signupOpen);
  btn.onclick = async () => {
    btn.disabled = true;
    const res = await fetch('/api/admin/signup-toggle', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: !r.signupOpen })
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok) { r.signupOpen = !!out.open; paint(r.signupOpen); }
    btn.disabled = false;
  };
}

async function loadUsers() {
  const r = await (await fetch('/api/admin/users')).json();
  const t = $('users-table');
  t.innerHTML = '<tr><th>名字</th><th>角色</th><th>对局</th><th>档案条目</th><th>注册于</th></tr>';
  for (const u of r.users || []) {
    t.appendChild(el('tr', '',
      `<td>${esc(u.name)}</td><td>${u.is_admin ? '管理员' : '玩家'}</td><td>${u.runs}</td><td>${u.archive}</td><td>${esc(String(u.created_at || '').slice(0, 10))}</td>`));
  }
}
// ——— 供应商添加：预设卡 → 只填 key 和 model → 添加并自动测试 ———
let chosenPreset = null;
document.querySelectorAll('.preset-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.preset-card').forEach((c) => c.classList.toggle('active', c === card));
    chosenPreset = card.dataset.preset;
    $('provider-form').hidden = false;
    $('p-add-result').hidden = true;
    $('p-chosen').textContent = card.querySelector('b').textContent;
    $('p-model').value = { deepseek: 'deepseek-chat', glm_coding: 'glm-4.6' }[chosenPreset] || '';
    $('p-key').value = '';
    $('p-key').focus();
  });
});
$('btn-add-provider').addEventListener('click', async () => {
  if (!chosenPreset) return;
  const PRESET = {
    deepseek: { name: 'DeepSeek', adapter: 'openai-compat', baseUrl: 'https://api.deepseek.com' },
    glm_coding: { name: 'GLM Coding Plan（国内版）', adapter: 'anthropic-compat', baseUrl: 'https://open.bigmodel.cn/api/anthropic' }
  }[chosenPreset];
  const model = $('p-model').value.trim();
  const apiKey = $('p-key').value;
  const out = $('p-add-result');
  if (!model || !apiKey) { out.hidden = false; out.textContent = '模型和 Key 都要填。'; return; }
  out.hidden = false; out.textContent = '添加中…';
  const r = await (await fetch('/api/admin/providers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...PRESET, model, apiKey })
  })).json();
  if (!r.id) { out.textContent = r.error || '添加失败'; return; }
  out.textContent = '已接入全部用途，正在真实调用一次…';
  $('p-key').value = '';
  loadAdmin();
  const res = await (await fetch('/api/admin/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: r.id }) })).json();
  const h = res.results[0];
  out.textContent = h.ok ? `通了：${h.latencyMs}ms，回显「${h.echo}」。开局即是 LLM 模式。` : `没通：${h.error}`;
  out.className = 'hint ' + (h.ok ? 'ok' : 'fail');
  loadAdmin();
});
$('btn-add-custom').addEventListener('click', async () => {
  const r = await (await fetch('/api/admin/providers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: $('c-name').value.trim(), adapter: $('c-adapter').value, baseUrl: $('c-baseurl').value.trim(), model: $('c-model').value.trim(), apiKey: $('c-key').value })
  })).json();
  if (r.id) { $('c-key').value = ''; loadAdmin(); } else alert(r.error || '失败');
});
$('btn-sim').addEventListener('click', async () => {
  $('sim-out').textContent = '跑着…';
  const r = await (await fetch('/api/admin/sim/smoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const b = r.kpis?.balanced || {};
  $('sim-out').textContent = `均衡策略 ${b.n} 局：中位 ${b.median_days} 天 · 有人活到停火 ${(b.any_survivor_to_end * 100).toFixed(0)}% · 全灭 ${(b.wipe_rate * 100).toFixed(0)}%`;
});

/** 时间胶囊表单（局终）：选终局库存里的一件 + ≤100 字留话 */
function renderCapsuleForm(box, s) {
  const inv = Object.entries(s.inventory || {}).filter(([, n]) => n > 0);
  if (!inv.length || s.ending.type === 'wiped') return;
  const wrap = el('div', 'three-things capsule-form');
  wrap.appendChild(el('span', 'kicker', '埋一件东西，留一句话（后续周目，后院可挖）'));
  const sel = document.createElement('select');
  const names = s.itemNames || {};
  for (const [id, n] of inv) { const o = document.createElement('option'); o.value = id; o.textContent = `${names[id] || id} ×${n}`; sel.appendChild(o); }
  const input = document.createElement('input');
  input.maxLength = 100; input.placeholder = '给后来的人写一句……（一百字以内）';
  const btn = el('button', 'ghost', '埋进后院');
  const done = el('span', 'hint', '');
  btn.onclick = async () => {
    btn.disabled = true;
    const r = await fetch(`/api/runs/${state.runId}/capsule`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: sel.value, message: input.value.trim() })
    });
    done.textContent = r.ok ? '埋好了。城里会替你记住这个位置。' : (await r.json()).error || '埋不了。';
    if (r.ok) { sel.disabled = input.disabled = true; btn.remove(); } else btn.disabled = false;
  };
  wrap.append(sel, input, btn, done);
  box.appendChild(wrap);
}

/* ════════════════════════════════════════════════════════════════
   右翼：舆图与史卷（叙事双轴-v0.1 §3/§4/§6）。
   舆图 = 一张挂在墙上的手绘（无交互）：三态地点、今夜走向、战争留痕。
   史卷 = 大事轴（史书体日笔 + 闲笔 + 投影）与我方一行（账不粉饰）。
   ════════════════════════════════════════════════════════════════ */
const TRACE_GLYPH = {
  gap: '<path d="M-2.6,-3 l1.6,2.6 -2,3.2 M1,-3 l1.6,2.6 -2,3.2" class="tr-st"/>',
  scar: '<path d="M-3.2,1 Q0,-3.4 3.2,1 Q0,4 -3.2,1 Z" class="tr-fl"/><path d="M-1.2,-2.6 v-3 M1.2,-2.6 v-4" class="tr-st"/>',
  smoke: '<path d="M-1.6,2.4 q-1.1,-2.4 0,-4.8 M1.6,2.4 q1.1,-2.4 0,-4.8" class="tr-st"/>',
  arrow: '<path d="M-3.2,3.2 L3.2,-3.2 M3.2,-3.2 h-2.8 M3.2,-3.2 v2.8" class="tr-st"/>',
  arrow_hush: '<path d="M-3.2,3.2 L3.2,-3.2 M3.2,-3.2 h-2.8 M3.2,-3.2 v2.8 M-3.2,-1.6 h6.4" class="tr-st"/>',
  drum: '<circle r="2.6" class="tr-st"/><path d="M-4.6,-4.2 a2.2,2.2 0 0 1 2.8,-0.4 M4.6,-4.2 a2.2,2.2 0 0 0 -2.8,-0.4" class="tr-st"/>',
  ship: '<path d="M-3.2,0 h6.4 l-1.4,2 h-3.6 Z" class="tr-fl"/>',
  ships: '<path d="M-4.4,0 h2 M-1.2,0 h2 M2,0 h2.4 M-2.8,-2.2 h2 M0.4,-2.2 h2 M3.2,-2.2 h1.4 M-1.6,2.2 h3.2" class="tr-st"/>',
  door: '<rect x="-1.8" y="-3" width="3.6" height="6" class="tr-st"/><path d="M0,-3 v6" class="tr-st"/><circle cx="1.1" cy="0" r=".45" class="tr-fl"/>',
  door_dry: '<rect x="-1.8" y="-3" width="3.6" height="6" class="tr-st"/><path d="M0,-3 v6 M-1.8,-3 L1.8,3 M1.8,-3 L-1.8,3" class="tr-st"/>',
  seal: '<rect x="-2" y="-2" width="4" height="4" class="tr-st"/><path d="M-1,-1 l2,2 M1,-1 l-2,2" class="tr-st"/>',
  rut: '<path d="M-4,-1.2 q4,1.2 8,0 M-4,1.6 q4,1.2 8,0" class="tr-st"/>',
  lamp: '<circle cy="-1.4" r="1.1" class="tr-fl"/><path d="M0,-0.3 v3.2 M-1.4,3 h2.8" class="tr-st"/>',
  frost: '', waterline: ''
};
/** 舆图 SVG 内景（侧栏一览与大观全屏共用同一张手绘） */
function mapSvgMarkup(mv) {
  const b = mv.base || { viewBox: [0, 0, 100, 100], paths: [] };
  const [x, y, w, h] = b.viewBox || [0, 0, 100, 100];
  return `<svg viewBox="${x} ${y} ${w} ${h}" class="map-svg${mv.winter ? ' frost' : ''}${mv.rain ? ' rainy' : ''}" role="img" aria-label="江陵舆图">
    ${(b.paths || []).map((p) => `<path d="${p.d}" class="mp-${p.cls}"/>${p.label ? `<text x="${p.lx}" y="${p.ly}" class="mp-label">${esc(p.label)}</text>` : ''}`).join('')}
    ${(mv.gates || []).map((g) => `<circle cx="${g.x}" cy="${g.y}" r="0.9" class="mp-gate"><title>${esc(g.name)}</title></circle>`).join('')}
    ${mv.route && mv.places.find((p) => p.id === mv.route.to) ? (() => {
      const from = mv.places.find((p) => p.id === 'home') || { x: 50, y: 53 };
      const to = mv.places.find((p) => p.id === mv.route.to);
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="mp-route"/>`;
    })() : ''}
    ${(mv.traces || []).map((t) => `<g transform="translate(${t.x},${t.y})" class="trace"><title>${esc(t.label || '')}</title>${TRACE_GLYPH[t.icon] || ''}</g>`).join('')}
    ${mv.places.filter((p) => p.state !== 'unknown').map((p) => `
      <g class="place ${p.state === 'tonight' ? 'tonight' : 'known'}" data-place="${esc(p.id)}" data-name="${esc(p.name)}" data-state="${p.state}"${p.who ? ` data-who="${esc(p.who)}"` : ''} tabindex="0">
        <circle cx="${p.x}" cy="${p.y}" r="${p.state === 'tonight' ? 2.6 : 1.8}"/>
        <text x="${p.x + 3}" y="${p.y + 1.4}">${esc(p.name)}${p.who ? `（${esc(p.who)}）` : ''}</text>
      </g>`).join('')}
  </svg>`;
}

function renderMap(mv) {
  const panel = $('map-panel');
  if (!mv) { panel.hidden = true; return; }
  panel.hidden = false;
  const box = $('map-box');
  const sig = [mv.places.filter((p) => p.state !== 'unknown').map((p) => `${p.id}${p.state === 'tonight' ? 'T' : 'K'}`).join(','),
    mv.traces.map((t) => t.id).join(','), mv.winter ? 'w' : '', mv.rain ? 'r' : '', mv.tonight?.loc || ''].join('|');
  quietSwap(box, sig);
  box.classList.toggle('frost', !!mv.winter);
  box.classList.toggle('rainy', !!mv.rain);
  box.innerHTML = '';
  const svg = el('div');
  svg.innerHTML = mapSvgMarkup(mv);
  box.appendChild(svg);
  $('map-note').textContent = mv.tonight ? `今夜：${mv.places.find((p) => p.id === mv.tonight.loc)?.name || ''}${mv.tonight.who ? ' · ' + mv.tonight.who : ''}` : '白日，全员在橘里九号。';
  updateMapBig(mv); // 大观开着时同步换纸
}

/* ═══ 舆图 · 大观：点图全屏展开——拖动平移、滚轮/双指缩放、点地名看注 ═══
   侧栏保持一览不抢书页；看细节进大观（桌面滚轮/手机双指，同一套手势）。 */
const mbState = { el: null, view: null, k: 1, x: 0, y: 0, dragged: false };
function ensureMapBig() {
  if (mbState.el) return mbState.el;
  const root = el('div', 'mapbig');
  root.hidden = true;
  root.innerHTML = `
    <div class="mb-backdrop"></div>
    <div class="mb-sheet" role="dialog" aria-label="舆图大观">
      <div class="mb-head">
        <span class="wing-kicker">舆图 · 大观</span>
        <span class="mb-sub">拖动平移 · 滚轮/双指缩放 · 点地名看注</span>
        <span class="mb-btns">
          <button class="mb-btn" type="button" data-z="in" aria-label="放大">＋</button>
          <button class="mb-btn" type="button" data-z="out" aria-label="缩小">−</button>
          <button class="mb-btn mb-reset" type="button" data-z="reset">复位</button>
          <button class="mb-btn mb-x" type="button" aria-label="收起">✕</button>
        </span>
      </div>
      <div class="mb-stage"><div class="mb-canvas"></div></div>
      <div class="mb-note" hidden></div>
    </div>`;
  document.body.appendChild(root);
  mbState.el = root;
  root.querySelector('.mb-backdrop').addEventListener('click', closeMapBig);
  root.querySelector('.mb-x').addEventListener('click', closeMapBig);
  for (const b of root.querySelectorAll('.mb-btn[data-z]')) b.addEventListener('click', () => {
    if (b.dataset.z === 'reset') resetMapBig();
    else zoomMapBig(b.dataset.z === 'in' ? 1.25 : 1 / 1.25);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) closeMapBig(); });
  bindMapBigGestures(root.querySelector('.mb-stage'));
  // 点地名出注（挂在 sheet 上一次性绑定；tap 与拖拽以位移阈值区分）
  root.querySelector('.mb-sheet').addEventListener('click', (e) => {
    const g = e.target.closest('g.place');
    if (!g || mbState.dragged) return;
    const note = root.querySelector('.mb-note');
    const st = g.dataset.state === 'tonight' ? `今夜在此${g.dataset.who ? ' · ' + g.dataset.who : ''}` : '已知的地方';
    note.textContent = `${g.dataset.name} —— ${st}`;
    note.hidden = false;
  });
  return root;
}
function openMapBig(mv) {
  const root = ensureMapBig();
  mbState.view = mv;
  root.querySelector('.mb-canvas').innerHTML = mapSvgMarkup(mv);
  root.hidden = false;
  document.body.classList.add('mapbig-open');
  resetMapBig();
  root.querySelector('.mb-note').hidden = true;
}
function closeMapBig() {
  if (!mbState.el) return;
  mbState.el.hidden = true;
  document.body.classList.remove('mapbig-open');
}
function updateMapBig(mv) {
  if (!mbState.el || mbState.el.hidden) return;
  mbState.el.querySelector('.mb-canvas').innerHTML = mapSvgMarkup(mv);
}
function applyMapBigTransform() {
  const c = mbState.el?.querySelector('.mb-canvas');
  if (c) c.style.transform = `translate(${mbState.x}px, ${mbState.y}px) scale(${mbState.k})`;
}
function resetMapBig() { mbState.k = 1; mbState.x = 0; mbState.y = 0; applyMapBigTransform(); }
/** 以点(px,py)（stage 内坐标）为锚缩放 ratio 倍，钳在 1~5 */
function zoomMapBigAt(ratio, px, py) {
  const k0 = mbState.k;
  const k1 = Math.min(5, Math.max(1, k0 * ratio));
  if (k1 === k0) return;
  mbState.x = px - (px - mbState.x) * (k1 / k0);
  mbState.y = py - (py - mbState.y) * (k1 / k0);
  mbState.k = k1;
  applyMapBigTransform();
}
function zoomMapBig(ratio) {
  const st = mbState.el?.querySelector('.mb-stage');
  if (!st) return;
  zoomMapBigAt(ratio, st.clientWidth / 2, st.clientHeight / 2);
}
/** 手势：单指拖 = 平移；双指捏 = 缩放（手机）；wheel = 桌面缩放 */
function bindMapBigGestures(stage) {
  const ptrs = new Map();
  let pinch0 = null;
  stage.style.touchAction = 'none';
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomMapBigAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), k: mbState.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x: mbState.x, y: mbState.y };
    }
    mbState.dragged = false;
  });
  stage.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId);
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.abs(dx) + Math.abs(dy) > 1) mbState.dragged = true;
    if (ptrs.size === 1) { mbState.x += dx; mbState.y += dy; applyMapBigTransform(); }
    else if (ptrs.size === 2 && pinch0) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = stage.getBoundingClientRect();
      const k1 = Math.min(5, Math.max(1, pinch0.k * (d / pinch0.d)));
      const px = pinch0.cx - r.left, py = pinch0.cy - r.top;
      mbState.k = pinch0.k;
      mbState.x = pinch0.x; mbState.y = pinch0.y;
      zoomMapBigAt(k1 / pinch0.k, px, py);
    }
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
}
// 侧栏一览点图即入大观（含手机抽屉里那张横滚大图）
document.addEventListener('click', (e) => {
  if (e.target.closest('#map-box') && state.s?.mapView) { openMapBig(state.s.mapView); }
});
function renderChronicle(ch) {
  const panel = $('chronicle-panel');
  if (!ch) { panel.hidden = true; return; }
  panel.hidden = false;
  const box = $('chronicle-box');
  const sig = ch.entries.map((e) => `${e.day}${e.ending ? '!' : ''}${(e.text || '').length}:${(e.pens || []).length}:${(e.mirrors || []).length}`).join('|');
  quietSwap(box, sig);
  box.innerHTML = '';
  $('map-act').textContent = ch.currentAct ? `${ch.currentAct.title}` : '';
  if (!ch.entries.length) {
    box.appendChild(el('p', 'wing-note', '史卷未开——破晓即有一笔。'));
    return;
  }
  for (const e of ch.entries) {
    const d = el('div', 'chron-day' + (e.ending ? ' chron-end' : ''));
    const head = el('div', 'chron-head');
    const trackBadge = e.track === 'gen' ? '<span class="chron-track gen">将军轨</span>' : (e.track === 'city' ? '<span class="chron-track city">城轨</span>' : '');
    head.innerHTML = `<span class="chron-d">第${e.day}日</span>${trackBadge}${e.ending ? '<span class="chron-flag">收束</span>' : (e.act ? `<span class="chron-act">${esc(e.act)}</span>` : '<span class="chron-act chron-dim">闲笔</span>')}`;
    d.appendChild(head);
    if (e.text) {
      const p = el('p', 'chron-text');
      p.innerHTML = rich(e.text);
      d.appendChild(p);
    }
    for (const pn of e.pens || []) {
      const p = el('p', 'chron-pen');
      p.innerHTML = `闲笔 · ${rich(pn.line)}`;
      d.appendChild(p);
    }
    for (const m of e.mirrors || []) {
      const p = el('p', 'chron-mir');
      p.innerHTML = rich(m);
      d.appendChild(p);
    }
    if (e.digest) d.appendChild(el('p', 'chron-dig', `我方 · ${esc(e.digest)}`));
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}
