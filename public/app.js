// ===== 雨夜山庄 · 前端逻辑 =====
// 负责：雷雨动画与音效、界面切换、Socket.io 联机、各环节渲染、记事本等。

/* ---------- 全局状态 ---------- */
const G = {
  name: '',
  token: '',
  roomCode: '',
  mode: 4,
  isHost: false,
  myId: null,          // 自己的 socket id（连接后由服务器返回/推算）
  startedFlag: false,  // 是否已进入游戏（用于区分大厅/游戏界面）
  phase: 'lobby',
  roster: [],          // 公开角色名册
  myCharacter: null,   // 自己的完整角色
  background: '',
  timeline: '',
  publicClues: [],
  votes: {},           // playerId -> characterId
  myVote: null
};

const LS = {
  get(key, dft) { try { const v = localStorage.getItem(key); return v == null ? dft : v; } catch (e) { return dft; } },
  set(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
};

/* ---------- 快捷 DOM 引用 ---------- */
const $ = (id) => document.getElementById(id);
const screens = ['screen-rain', 'screen-menu', 'screen-lobby', 'screen-game'];
function showScreen(id) {
  screens.forEach(s => $(s).classList.toggle('active', s === id));
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* =====================================================
   一、雷雨动画 + 音效
===================================================== */
const rainCanvas = $('rain-canvas');
const rctx = rainCanvas.getContext('2d');
let drops = [];

function resizeRain() {
  rainCanvas.width = window.innerWidth;
  rainCanvas.height = window.innerHeight;
  const count = Math.min(220, Math.floor(window.innerWidth / 7));
  drops = [];
  for (let i = 0; i < count; i++) drops.push(newDrop());
}
function newDrop() {
  return {
    x: Math.random() * rainCanvas.width,
    y: Math.random() * rainCanvas.height,
    len: 12 + Math.random() * 22,
    speed: 9 + Math.random() * 14,
    wind: 0.6 + Math.random() * 1.4
  };
}
function drawRain() {
  rctx.clearRect(0, 0, rainCanvas.width, rainCanvas.height);
  rctx.strokeStyle = 'rgba(150,165,190,0.22)';
  rctx.lineWidth = 1;
  rctx.beginPath();
  drops.forEach(d => {
    rctx.moveTo(d.x, d.y);
    rctx.lineTo(d.x - d.wind, d.y - d.len);
    d.y += d.speed;
    d.x -= d.wind;
    if (d.y > rainCanvas.height) { d.y = -d.len; d.x = Math.random() * rainCanvas.width; }
  });
  rctx.stroke();
  requestAnimationFrame(drawRain);
}
resizeRain();
window.addEventListener('resize', resizeRain);
drawRain();

/* 闪电 */
const lightningEl = $('lightning');
function scheduleLightning() {
  const delay = 2500 + Math.random() * 8000;
  setTimeout(() => { flash(); scheduleLightning(); }, delay);
}
function flash() {
  let n = 1 + Math.floor(Math.random() * 3);
  let i = 0;
  function tick() {
    lightningEl.style.opacity = (i % 2 === 0) ? 0.75 : 0.1;
    i++;
    if (i < n * 2) setTimeout(tick, 70);
    else lightningEl.style.opacity = 0;
  }
  tick();
  playThunder();
}
scheduleLightning();

/* 声音（Web Audio 合成，无需外部素材） */
let audioCtx = null;
let rainGain = null;
let soundOn = true;

function initAudio() {
  if (audioCtx) { audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // 雨声：连续白噪声 + 低通滤波
    const size = 2 * audioCtx.sampleRate;
    const buffer = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer; noise.loop = true;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 1100;
    rainGain = audioCtx.createGain();
    rainGain.gain.value = soundOn ? 0.12 : 0;
    noise.connect(filter); filter.connect(rainGain); rainGain.connect(audioCtx.destination);
    noise.start();
  } catch (e) {}
}
function playThunder() {
  if (!audioCtx || !soundOn) return;
  try {
    const size = audioCtx.sampleRate * 2;
    const buffer = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 180;
    const g = audioCtx.createGain(); g.gain.value = 0.6;
    src.connect(filter); filter.connect(g); g.connect(audioCtx.destination);
    src.start();
  } catch (e) {}
}

const soundBtn = $('sound-toggle');
soundBtn.addEventListener('click', () => {
  initAudio();
  soundOn = !soundOn;
  soundBtn.textContent = soundOn ? '🔊' : '🔇';
  if (rainGain) rainGain.gain.value = soundOn ? 0.12 : 0;
});

/* =====================================================
   二、Socket.io 连接
===================================================== */
const socket = io();

// 连接后尝试自动重连（凭本地 token）
socket.on('connect', () => {
  const savedToken = LS.get('mystery_token', '');
  const savedRoom = LS.get('mystery_room', '');
  const savedName = LS.get('mystery_name', '');
  if (savedToken && savedRoom) {
    socket.emit('joinRoom', { roomCode: savedRoom, name: savedName, token: savedToken }, (res) => {
      if (res && res.ok) {
        G.token = savedToken; G.roomCode = res.roomCode; G.mode = res.mode; G.name = savedName;
        // 若游戏已开始，服务器会直接推送游戏状态；否则进入大厅
        if (!res.rejoin) showScreen('screen-lobby');
      } else {
        LS.set('mystery_token', ''); LS.set('mystery_room', '');
      }
    });
  }
});

/* ---------- 服务器事件 ---------- */
socket.on('playersUpdate', (data) => {
  G.phase = data.phase;
  G.isHost = data.hostId === socket.id;
  if (!G.startedFlag) renderLobby(data);
  else renderGameHeader();
});

socket.on('gameStarted', (data) => {
  G.startedFlag = true;
  G.phase = data.phase;
  G.mode = data.mode;
  G.background = data.background;
  G.timeline = data.timeline;
  G.roster = data.roster;
  G.myCharacter = data.myCharacter;
  showScreen('screen-game');
  renderGameHeader();
  renderMain();
});

socket.on('phaseUpdate', (data) => {
  G.phase = data.phase;
  renderGameHeader();
  renderMain();
  if (data.host) showHostText(data.host);
});

socket.on('publicClues', (data) => {
  G.publicClues = data.clues;
  renderMain();
});

socket.on('chat', (entry) => appendChat(entry));

socket.on('voteUpdate', (data) => {
  G.votes = {};
  data.votes.forEach(v => { if (v.vote) G.votes[v.playerId] = v.vote; });
  renderVote();
});

socket.on('reveal', (data) => renderReveal(data));

/* =====================================================
   三、首屏 → 菜单 → 创建/加入
===================================================== */
$('screen-rain').addEventListener('click', () => {
  initAudio(); playThunder();
  showScreen('screen-menu');
});

// 昵称回填
$('name-input').value = LS.get('mystery_name', '');

// 处理 URL 里带的 ?room=CODE，自动填入
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('room-input').value = urlRoom.toUpperCase();

function getName() {
  const n = $('name-input').value.trim() || '玩家';
  LS.set('mystery_name', n);
  return n;
}

$('btn-create-4').addEventListener('click', () => createRoom(4));
$('btn-create-6').addEventListener('click', () => createRoom(6));
$('btn-join').addEventListener('click', () => {
  const code = $('room-input').value.trim().toUpperCase();
  if (!code) return toast('请输入房间号');
  socket.emit('joinRoom', { roomCode: code, name: getName(), token: null }, (res) => {
    if (!res.ok) return toast(res.error);
    G.token = res.token; G.roomCode = res.roomCode; G.mode = res.mode; G.name = getName();
    LS.set('mystery_token', G.token); LS.set('mystery_room', G.roomCode);
    showScreen('screen-lobby');
  });
});

function createRoom(mode) {
  socket.emit('createRoom', { mode, name: getName() }, (res) => {
    if (!res.ok) return toast(res.error);
    G.token = res.token; G.roomCode = res.roomCode; G.mode = res.mode; G.name = getName();
    LS.set('mystery_token', G.token); LS.set('mystery_room', G.roomCode);
    showScreen('screen-lobby');
  });
}

/* =====================================================
   四、等待大厅
===================================================== */
function renderLobby(data) {
  $('lobby-code').textContent = G.roomCode || data.code;
  $('lobby-count').textContent = data.players.length;
  $('lobby-max').textContent = G.mode || 4;

  const ul = $('lobby-players');
  ul.innerHTML = '';
  data.players.forEach(p => {
    const li = document.createElement('li');
    const char = p.characterId ? (G.roster.find(c => c.id === p.characterId) || {}).name : '';
    li.innerHTML = `${escapeHtml(p.name)}${p.id === data.hostId ? '<span class="host-tag">房主</span>' : ''}${char ? `<span class="char-tag">· ${escapeHtml(char)}</span>` : ''}`;
    ul.appendChild(li);
  });

  const isHost = data.hostId === socket.id;
  $('btn-start').style.display = isHost ? 'block' : 'none';
  $('lobby-hint').textContent = isHost ? `你是房主，等人都到齐后点击「开始游戏」（${data.players.length}/${G.mode}）` : '等待房主开始游戏…';
}

$('btn-start').addEventListener('click', () => {
  socket.emit('startGame', (res) => { if (res && !res.ok) toast(res.error); });
});

$('btn-copy-link').addEventListener('click', () => {
  const link = `${location.origin}${location.pathname}?room=${G.roomCode}`;
  copyText(link).then(() => toast('邀请链接已复制，发给朋友即可加入'));
});
function copyText(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  return new Promise((resolve) => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); resolve();
  });
}

/* =====================================================
   五、游戏主界面
===================================================== */
const PHASE_ORDER = ['role', 'script', 'intro', 'investigate', 'discuss', 'vote', 'reveal'];
const PHASE_LABEL = { role: '角色分配', script: '阅读剧本', intro: '自我介绍', investigate: '搜证环节', discuss: '自由讨论', vote: '投票指认', reveal: '真相揭晓' };

function renderGameHeader() {
  $('phase-label').textContent = PHASE_LABEL[G.phase] || G.phase;
  // 环节进度点
  const dots = $('phase-dots');
  dots.innerHTML = '';
  PHASE_ORDER.forEach((id, i) => {
    const d = document.createElement('span');
    d.className = 'dot' + (PHASE_ORDER.indexOf(G.phase) >= i ? ' on' : '');
    dots.appendChild(d);
  });

  // 房主的推进按钮
  const nextBtn = $('btn-next');
  if (G.isHost && G.phase !== 'reveal') {
    nextBtn.style.display = 'inline-block';
    nextBtn.textContent = G.phase === 'vote' ? '⚖ 揭晓真相' : '进入下一环节 →';
  } else {
    nextBtn.style.display = 'none';
  }
}

$('btn-next').addEventListener('click', () => {
  if (G.phase === 'vote') socket.emit('revealTruth', (res) => { if (res && !res.ok) toast(res.error); });
  else socket.emit('advancePhase', (res) => { if (res && !res.ok) toast(res.error); });
});

/* 主持人漂浮文字 */
function showHostText(text) {
  $('host-text').textContent = text;
  $('host-overlay').classList.remove('hidden');
}
$('host-overlay').addEventListener('click', () => {
  $('host-overlay').classList.add('hidden');
});

/* ---------- 主内容区渲染 ---------- */
function renderMain() {
  const area = $('main-area');
  area.innerHTML = '';
  switch (G.phase) {
    case 'role': renderRole(area); break;
    case 'script': renderScript(area); break;
    case 'intro': renderIntro(area); break;
    case 'investigate':
    case 'discuss': renderClues(area); break;
    case 'vote': renderVote(area); break;
    case 'reveal': break; // reveal 由单独事件渲染
  }
}

function renderRole(area) {
  const c = G.myCharacter;
  if (!c) return;
  area.innerHTML = `
    <div class="paper role-card">
      <div class="role-title">${escapeHtml(c.title)}</div>
      <div class="role-name">${escapeHtml(c.name)}</div>
      <div class="role-meta">${escapeHtml(c.age)} · ${escapeHtml(c.sex)}</div>
      <div class="story-text" style="text-align:left">${escapeHtml(c.publicIntro)}</div>
      <p style="margin-top:18px;color:var(--text-dim);letter-spacing:.1em">你的秘密与目标，藏在「📜 剧本」中。请点击下方按钮阅读。</p>
    </div>`;
}

function renderScript(area) {
  const c = G.myCharacter;
  area.innerHTML = `
    <h2 class="content-title">📜 你的剧本</h2>
    <div class="paper"><h4 class="role-section" style="margin-top:0">【背景】</h4>${escapeHtml(G.background)}</div>
    <div class="paper"><h4 class="role-section" style="margin-top:0">【时间线】</h4>${escapeHtml(G.timeline)}</div>
    <div class="paper"><h4 class="role-section" style="margin-top:0">【你的身份】${escapeHtml(c.name)}（${escapeHtml(c.title)}）</h4>${escapeHtml(c.script)}</div>
    <div class="paper"><h4 class="role-section" style="margin-top:0">【你的目标】</h4>${escapeHtml(c.goal)}</div>
    <div class="paper"><h4 class="role-section" style="margin-top:0">【你的专属线索】</h4>${escapeHtml(c.clue)}</div>`;
}

function renderIntro(area) {
  area.innerHTML = `
    <h2 class="content-title">🎭 在场之人</h2>
    <div class="clue-grid">${G.roster.map(c => `
      <div class="clue-card" data-open-roster="${c.id}">
        <div class="clue-title">${escapeHtml(c.name)}</div>
        <div class="clue-preview">${escapeHtml(c.title)} · ${escapeHtml(c.age)} · ${escapeHtml(c.sex)}</div>
      </div>`).join('')}</div>
    <div class="paper" style="margin-top:16px;text-align:center;color:var(--text-dim)">请在右侧聊天区，依次介绍自己的身份与当晚的行踪。</div>`;
  bindRosterCards();
}

function renderClues(area) {
  const myClue = G.myCharacter ? G.myCharacter.clue : '';
  area.innerHTML = `
    <h2 class="content-title">🔍 案件线索</h2>
    <div class="paper"><h4 class="role-section" style="margin-top:0">【你的专属线索（仅你可见）】</h4>${escapeHtml(myClue)}</div>
    <h3 class="lobby-sub" style="margin-top:18px">公共线索（点击查看详情）</h3>
    <div class="clue-grid">${(G.publicClues || []).map((c, i) => `
      <div class="clue-card" data-open-clue="${i}">
        <div class="clue-title">${escapeHtml(c.title)}</div>
        <div class="clue-preview">${escapeHtml(c.content.slice(0, 40))}…</div>
      </div>`).join('')}</div>
    ${G.phase === 'discuss' ? '<div class="paper" style="margin-top:16px;text-align:center;color:var(--text-dim)">自由讨论时间，请在右侧聊天区互相质询。</div>' : ''}`;
  bindClueCards();
}

function renderVote(area) {
  area = area || $('main-area');
  const others = G.roster.filter(c => c.id !== (G.myCharacter && G.myCharacter.id));
  area.innerHTML = `
    <h2 class="content-title">⚖ 投票指认</h2>
    <p class="lobby-sub">请指认你心中最可疑的人（点击选择，可改选）</p>
    <div class="vote-grid">${others.map(c => `
      <div class="vote-card ${G.myVote === c.id ? 'selected' : ''}" data-vote="${c.id}">
        <div class="v-name">${escapeHtml(c.name)}</div>
        <div class="v-title">${escapeHtml(c.title)}</div>
      </div>`).join('')}</div>
    ${G.isHost ? '<div class="lobby-hint">点击右上角「揭晓真相」公布结果</div>' : '<div class="lobby-hint">投票后，等待房主揭晓真相…</div>'}`;

  area.querySelectorAll('.vote-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.vote;
      G.myVote = id;
      socket.emit('vote', { targetId: id });
      renderVote(); // 立即高亮所选
    });
  });
}

function renderReveal(data) {
  const t = data.truth;
  const myAccused = G.myVote ? (G.roster.find(c => c.id === G.myVote) || {}).name : '弃权';
  const area = $('main-area');
  area.innerHTML = `
    <div class="ending-box">
      <div class="ending-title">${data.correct ? '🕯 真凶落网' : '🌫 真凶脱逃'}</div>
      <div class="lobby-sub">多数人指认：${escapeHtml(data.accusedName || '无人')}；真正的凶手：${escapeHtml(t.murdererName)}</div>
      <div class="paper" style="text-align:left"><h4 class="role-section">【真相】</h4>${escapeHtml(t.reveal)}</div>
      <div class="paper" style="text-align:left">${escapeHtml(data.ending)}</div>
      <div class="lobby-hint" style="margin-top:16px">你指认的是：${escapeHtml(myAccused)}</div>
    </div>`;
  $('btn-next').style.display = 'none';
}

/* 角色卡 / 线索卡点击 */
function bindRosterCards() {
  document.querySelectorAll('[data-open-roster]').forEach(el => {
    el.addEventListener('click', () => {
      const c = G.roster.find(x => x.id === el.dataset.openRoster);
      if (c) openDetail(`${c.name} · ${c.title}`, `${c.age} · ${c.sex}\n\n${c.publicIntro}`);
    });
  });
}
function bindClueCards() {
  document.querySelectorAll('[data-open-clue]').forEach(el => {
    el.addEventListener('click', () => {
      const c = G.publicClues[Number(el.dataset.openClue)];
      if (c) openDetail(`线索：${c.title}`, c.content);
    });
  });
}

function openDetail(title, body) {
  $('detail-title').textContent = title;
  $('detail-body').textContent = body;
  $('detail-modal').classList.remove('hidden');
}

/* =====================================================
   六、聊天
===================================================== */
$('chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat', { text });
  input.value = '';
}
function appendChat(entry) {
  const box = $('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (entry.playerId === socket.id ? ' self' : '');
  div.innerHTML = `<span class="who">${escapeHtml(entry.name)}：</span>${escapeHtml(entry.text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* =====================================================
   七、记事本（本地保存）
===================================================== */
function notepadKey() { return 'mystery_notepad_' + (G.roomCode || 'global'); }

$('btn-notepad').addEventListener('click', () => {
  $('notepad-text').value = LS.get(notepadKey(), '');
  $('notepad-modal').classList.remove('hidden');
});
$('notepad-text').addEventListener('input', () => {
  LS.set(notepadKey(), $('notepad-text').value);
});

/* 工具栏 */
$('btn-clues').addEventListener('click', () => { renderClues($('main-area')); });
$('btn-roster').addEventListener('click', () => { renderIntro($('main-area')); });
$('btn-script').addEventListener('click', () => { renderScript($('main-area')); });

/* 模态框关闭 */
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
});
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
});

/* 工具：转义 HTML，防止 XSS */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
