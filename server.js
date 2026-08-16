// 《雨夜山庄》剧本杀 —— 服务端
// 职责：提供网页、管理房间、用 Socket.io 实时同步所有玩家的游戏状态。
// 游戏状态保存在服务端，玩家只能收到自己该看到的信息（防止作弊）。

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const crypto = require('crypto');
const scripts = require('./script-data');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// 前端静态文件目录
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 数据存储 ----------
// rooms: Map<房间号, 房间对象>
const rooms = new Map();

// 环节定义：lobby -> role -> script -> intro -> investigate -> discuss -> vote -> reveal
const PHASES = [
  { id: 'lobby',       label: '等待大厅', host: '' },
  { id: 'role',        label: '角色分配', host: '角色分配完毕。请各位查看自己的身份牌，记住——不要向任何人透露你的秘密。' },
  { id: 'script',      label: '阅读剧本', host: '暴雨封山，命案已生。请各位仔细阅读剧本，了解这座山庄，和属于你的故事。' },
  { id: 'intro',       label: '自我介绍', host: '自我介绍开始。请各位依次介绍自己的身份，以及当晚的行踪。' },
  { id: 'investigate', label: '搜证环节', host: '搜证开始。线索已经浮出水面。请仔细查看每一条线索，真相，就藏在细节里。' },
  { id: 'discuss',     label: '自由讨论', host: '自由讨论时间。请互相质询、逼问，找出那个说谎的人。' },
  { id: 'vote',        label: '投票指认', host: '投票时间到。请指认你心中最可疑的人。' },
  { id: 'reveal',      label: '真相揭晓', host: '' }
];

// ---------- 工具函数 ----------
// 生成 6 位大写字母房间号
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I/O/0/1
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

// 打乱数组（用于随机分配角色）
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 某角色是否已分配给房间内某人
function characterTaken(room, characterId) {
  return room.players.some(p => p.characterId === characterId);
}

// 给某玩家分配一个还没被拿走的角色
function assignCharacter(room, player, script) {
  const pool = shuffle(script.characters);
  const free = pool.find(c => !characterTaken(room, c.id));
  player.characterId = free ? free.id : null;
}

// 获取房间的公开角色名册（只含公开身份，不含秘密）
function publicRoster(script) {
  return script.characters.map(c => ({
    id: c.id, name: c.name, title: c.title, age: c.age, sex: c.sex, publicIntro: c.publicIntro
  }));
}

// 获取某玩家的完整角色数据
function getCharacter(script, characterId) {
  return script.characters.find(c => c.id === characterId);
}

// 发给客户端的角色数据（去掉服务端专用的 isMurderer 标志）
function clientCharacter(c) {
  if (!c) return null;
  const { isMurderer, ...rest } = c;
  return rest;
}

// 把房间内所有人（公开信息）发给 socket
function broadcastPlayers(room) {
  const list = room.players.map(p => ({
    id: p.id, name: p.name, characterId: p.characterId, connected: p.connected
  }));
  io.to(room.code).emit('playersUpdate', { players: list, hostId: room.hostId, phase: room.phase });
}

// 给中途重连的玩家补齐完整游戏状态
function sendGameStateTo(sock, room, player) {
  const script = scripts[room.mode];
  const character = getCharacter(script, player.characterId);
  sock.emit('gameStarted', {
    phase: room.phase,
    mode: room.mode,
    title: script.title,
    background: script.background,
    timeline: script.timeline,
    roster: publicRoster(script),
    myCharacter: clientCharacter(character)
  });
  sock.emit('phaseUpdate', { phase: room.phase, label: (PHASES.find(x => x.id === room.phase) || {}).label || '', host: '' });
  // 搜证及之后的环节，补发公共线索
  if (['investigate', 'discuss', 'vote', 'reveal'].includes(room.phase)) {
    sock.emit('publicClues', { clues: script.publicClues });
  }
  // 补发聊天历史
  (room.chatHistory || []).forEach(e => sock.emit('chat', e));
  // 补发投票状态
  sock.emit('voteUpdate', { votes: room.players.map(p => ({ playerId: p.id, vote: p.vote })) });
  // 若已在揭晓环节，补发真相
  if (room.phase === 'reveal' && room.revealResult) {
    sock.emit('reveal', room.revealResult);
  }
}

// ---------- Socket.io 连接处理 ----------
io.on('connection', (socket) => {
  let currentRoom = null; // 当前 socket 所在的房间号
  let currentPlayer = null; // 当前 socket 对应的玩家对象

  // 创建房间
  socket.on('createRoom', ({ mode, name }, cb) => {
    const code = genRoomCode();
    const player = {
      id: socket.id,
      name: String(name || '').trim() || '玩家',
      token: genToken(),
      characterId: null,
      vote: null,
      connected: true
    };
    const room = {
      code,
      mode: Number(mode) === 6 ? 6 : 4,
      hostId: socket.id,
      phase: 'lobby',
      started: false,
      players: [player],
      chatHistory: []
    };
    rooms.set(code, room);
    currentRoom = code;
    currentPlayer = player;
    socket.join(code);
    cb({ ok: true, roomCode: code, token: player.token, mode: room.mode });
    broadcastPlayers(room);
  });

  // 加入房间
  socket.on('joinRoom', ({ roomCode, name, token }, cb) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: '房间不存在，请检查房间号' });

    // 重连：token 匹配到房间里的旧玩家（游戏进行中也允许）
    if (token) {
      const existing = room.players.find(p => p.token === token);
      if (existing) {
        existing.id = socket.id;
        existing.connected = true;
        currentRoom = code;
        currentPlayer = existing;
        socket.join(code);
        if (room.started) sendGameStateTo(socket, room, existing);
        broadcastPlayers(room);
        return cb({ ok: true, roomCode: code, token: existing.token, mode: room.mode, rejoin: true });
      }
    }

    if (room.started) return cb({ ok: false, error: '游戏已开始，无法加入' });

    // 新人加入
    if (room.players.length >= room.mode) return cb({ ok: false, error: '房间已满' });
    const player = {
      id: socket.id,
      name: String(name || '').trim() || '玩家',
      token: genToken(),
      characterId: null,
      vote: null,
      connected: true
    };
    room.players.push(player);
    currentRoom = code;
    currentPlayer = player;
    socket.join(code);
    cb({ ok: true, roomCode: code, token: player.token, mode: room.mode });
    broadcastPlayers(room);
  });

  // 房主开始游戏
  socket.on('startGame', (cb) => {
    const room = currentRoom ? rooms.get(currentRoom) : null;
    if (!room || !currentPlayer) return cb && cb({ ok: false, error: '不在房间中' });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: '只有房主可以开始游戏' });
    if (room.started) return cb && cb({ ok: false, error: '游戏已经开始了' });

    const script = scripts[room.mode];
    // 为每位玩家随机分配角色
    room.players.forEach(p => assignCharacter(room, p, script));
    room.started = true;
    room.phase = 'role';
    room.chatHistory = [];

    // 向每位玩家单独发送各自的剧本与角色
    room.players.forEach(p => {
      const character = getCharacter(script, p.characterId);
      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        sock.emit('gameStarted', {
          phase: 'role',
          mode: room.mode,
          title: script.title,
          background: script.background,
          timeline: script.timeline,
          roster: publicRoster(script),
          myCharacter: clientCharacter(character) // 只发自己的角色
        });
        sock.emit('phaseUpdate', { phase: 'role', label: '角色分配', host: PHASES.find(x => x.id === 'role').host });
      }
    });
    broadcastPlayers(room);
    cb && cb({ ok: true });
  });

  // 房主推进环节
  socket.on('advancePhase', (cb) => {
    const room = currentRoom ? rooms.get(currentRoom) : null;
    if (!room || !currentPlayer) return cb && cb({ ok: false, error: '不在房间中' });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: '只有房主可以推进环节' });
    if (!room.started) return cb && cb({ ok: false, error: '游戏还未开始' });

    if (room.phase === 'vote') return cb && cb({ ok: false, error: '请点击「揭晓真相」结束游戏' });
    const idx = PHASES.findIndex(p => p.id === room.phase);
    if (idx < 0 || idx >= PHASES.length - 1) return cb && cb({ ok: false, error: '已经是最后环节' });
    const next = PHASES[idx + 1];
    room.phase = next.id;

    // 进入搜证环节时，发送公共线索
    if (next.id === 'investigate') {
      const script = scripts[room.mode];
      room.players.forEach(p => {
        const sock = io.sockets.sockets.get(p.id);
        if (sock) sock.emit('publicClues', { clues: script.publicClues });
      });
    }

    io.to(room.code).emit('phaseUpdate', { phase: next.id, label: next.label, host: next.host });
    broadcastPlayers(room);
    cb && cb({ ok: true });
  });

  // 聊天消息
  socket.on('chat', ({ text }) => {
    const room = currentRoom ? rooms.get(currentRoom) : null;
    if (!room || !currentPlayer) return;
    const msg = String(text || '').trim();
    if (!msg) return;

    const script = room.started ? scripts[room.mode] : null;
    const character = script && currentPlayer.characterId ? getCharacter(script, currentPlayer.characterId) : null;
    const displayName = character ? `${character.name}（${character.title}）` : currentPlayer.name;

    const entry = { name: displayName, playerId: currentPlayer.id, text: msg, time: Date.now() };
    room.chatHistory.push(entry);
    if (room.chatHistory.length > 100) room.chatHistory.shift();
    io.to(room.code).emit('chat', entry);
  });

  // 投票
  socket.on('vote', ({ targetId }) => {
    const room = currentRoom ? rooms.get(currentRoom) : null;
    if (!room || !currentPlayer) return;
    if (room.phase !== 'vote') return;
    // 目标必须是房间里的其他角色
    const target = room.players.find(p => p.characterId === targetId);
    if (!target || target.id === currentPlayer.id) return;
    currentPlayer.vote = targetId;
    io.to(room.code).emit('voteUpdate', { votes: room.players.map(p => ({ playerId: p.id, vote: p.vote })) });
  });

  // 房主揭晓真相
  socket.on('revealTruth', (cb) => {
    const room = currentRoom ? rooms.get(currentRoom) : null;
    if (!room || !currentPlayer) return cb && cb({ ok: false, error: '不在房间中' });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: '只有房主可以揭晓真相' });
    if (room.phase !== 'vote') return cb && cb({ ok: false, error: '当前不是投票环节' });

    const script = scripts[room.mode];
    // 统计票数
    const counts = {};
    room.players.forEach(p => {
      if (p.vote) counts[p.vote] = (counts[p.vote] || 0) + 1;
    });
    let topId = null, topCount = -1;
    Object.keys(counts).forEach(id => {
      if (counts[id] > topCount) { topCount = counts[id]; topId = id; }
    });

    const correct = topId === script.truth.murdererId;
    room.phase = 'reveal';
    room.revealResult = {
      truth: script.truth,
      accusedId: topId,
      accusedName: topId ? (getCharacter(script, topId) ? getCharacter(script, topId).name : topId) : null,
      correct,
      ending: correct ? script.truth.correctEnding : script.truth.wrongEnding
    };

    io.to(room.code).emit('reveal', room.revealResult);
    broadcastPlayers(room);
    cb && cb({ ok: true });
  });

  // 断线：标记离线，但保留玩家一段时间（支持刷新重连）
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentPlayer) return;
    currentPlayer.connected = false;
    currentPlayer.id = null;

    // 房主掉线，把房主转给还在线的玩家
    if (room.hostId === socket.id) {
      const nextHost = room.players.find(p => p.connected && p.id);
      if (nextHost) room.hostId = nextHost.id;
    }

    // 若房间内无人，删除房间；否则广播更新
    const alive = room.players.filter(p => p.connected);
    if (alive.length === 0) {
      rooms.delete(currentRoom);
    } else {
      broadcastPlayers(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`《雨夜山庄》剧本杀已启动：http://localhost:${PORT}`);
});
