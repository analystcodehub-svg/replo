/**
 * FEMALE EXPERT NODE.JS CLIENT - MULTI-ACCOUNT EDITION
 * Supports multiple female IDs simultaneously:
 * - Open multiple browser tabs (Tab 1: Sonia, Tab 2: Swati, Tab 3: Pooja...)
 * - Independent Real-time Messaging (Transit & ACKs per UID)
 * - Independent Real-time Incoming Calls & WebRTC Audio per UID
 * - Interactive CLI with multi-expert switching
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const PRIMARY_DB_URL = 'https://zegochat-c44b0.asia-southeast1.firebasedatabase.app';
const SECONDARY_DB_URL = 'https://zegochat-c44b0-4cbfb.asia-southeast1.firebasedatabase.app';
const PORT = process.env.PORT || 3000;

// ANSI Colors for Terminal
const C_RESET = '\x1b[0m';
const C_BOLD = '\x1b[1m';
const C_RED = '\x1b[91m';
const C_GREEN = '\x1b[92m';
const C_YELLOW = '\x1b[93m';
const C_BLUE = '\x1b[94m';
const C_MAGENTA = '\x1b[95m';
const C_CYAN = '\x1b[96m';
const C_WHITE = '\x1b[97m';

// ============================================================================
// HTTP / FIREBASE DATABASE CLIENT
// ============================================================================

async function rtdbRequest(dbUrl, dbPath, method = 'GET', data = null) {
  try {
    const url = `${dbUrl}/${dbPath.replace(/^\/+/, '')}.json`;
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (data !== null) {
      options.body = JSON.stringify(data);
    }
    const res = await fetch(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

const rtdbGet = (dbUrl, path) => rtdbRequest(dbUrl, path, 'GET');
const rtdbPut = (dbUrl, path, data) => rtdbRequest(dbUrl, path, 'PUT', data);
const rtdbPatch = (dbUrl, path, data) => rtdbRequest(dbUrl, path, 'PATCH', data);
const rtdbDelete = (dbUrl, path) => rtdbRequest(dbUrl, path, 'DELETE');
const rtdbPush = (dbUrl, path, data) => rtdbRequest(dbUrl, path, 'POST', data);

// ============================================================================
// STATE & MULTI-EXPERT SESSIONS
// ============================================================================

class ExpertSession {
  constructor(uid) {
    this.uid = uid;
    this.profile = {
      nickname: 'Female Expert',
      language: 'hindi',
      pricePerMin: 4.0,
      totalEarnings: 0.0,
      balance: 0.0,
      totalSeconds: 0,
      age: 23,
      avatarIndex: 1,
    };
    this.isOnline = false;
    this.pendingCall = null;
    this.activeCall = null;
    this.callStartTime = null;
    this.lastContactUid = null;
    this.lastContactName = 'User';
    this.wsClients = new Set();
    this.isListeningMessages = false;
    this.messagePollTimer = null;
  }
}

const sessions = new Map(); // femaleUid -> ExpertSession
let activeCliUid = null;
let isRunning = true;
let isCallListenersStarted = false;
const userCache = {};
let wss = null;

function getSession(uid, create = true) {
  if (!uid) return null;
  if (sessions.has(uid)) return sessions.get(uid);
  if (!create) return null;
  const session = new ExpertSession(uid);
  sessions.set(uid, session);
  return session;
}

// ============================================================================
// WEBSOCKET BROADCASTING
// ============================================================================

function broadcastToSession(session, type, payload = {}) {
  if (!session) return;
  const msg = JSON.stringify({ type, femaleUid: session.uid, payload });
  session.wsClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastAll(type, payload = {}) {
  if (!wss) return;
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ============================================================================
// PROFILE & PRESENCE
// ============================================================================

async function getRegisteredExperts() {
  try {
    const data = await rtdbGet(SECONDARY_DB_URL, 'experts');
    if (data && typeof data === 'object') {
      return Object.entries(data);
    }
  } catch (_) {}
  return [];
}

async function fetchProfile(session) {
  let data = await rtdbGet(SECONDARY_DB_URL, `experts/${session.uid}`);
  if (!data) data = await rtdbGet(SECONDARY_DB_URL, `users/${session.uid}`);
  if (!data) data = await rtdbGet(PRIMARY_DB_URL, `users/${session.uid}`);

  if (data) {
    session.profile.nickname = data.nickname || data.name || 'Female Expert';
    const lang = data.languages || data.primaryLanguage || 'Hindi';
    session.profile.language = lang.trim().toLowerCase();
    session.profile.pricePerMin = parseFloat(data.pricePerMin || 4.0);
    session.profile.totalEarnings = parseFloat(data.totalEarnings || 0.0);
    session.profile.balance = parseFloat(data.redeemableBalance || session.profile.totalEarnings);
    session.profile.totalSeconds = parseInt(data.totalTalkSeconds || 0);
    session.profile.age = data.age || 23;
    session.profile.avatarIndex = data.avatarIndex || 1;
    return true;
  }
  return false;
}

async function createDefaultProfile(session, name = 'Zoya', language = 'Hindi') {
  session.profile.nickname = name;
  session.profile.language = language.toLowerCase();
  session.profile.pricePerMin = 4.0;
  const payload = {
    uid: session.uid,
    nickname: name,
    languages: language,
    age: 23,
    avatarIndex: 1,
    pricePerMin: 4.0,
    rating: 5.0,
    redeemableBalance: 0.0,
    totalEarnings: 0.0,
    totalTalkSeconds: 0,
    totalTalktimeMinutes: 0,
    mobileNumber: '9999999999',
  };
  await rtdbPut(SECONDARY_DB_URL, `experts/${session.uid}`, payload);
}

async function setPresence(session, online = true) {
  session.isOnline = online;
  const nowMs = Date.now();
  if (online) {
    await rtdbPatch(PRIMARY_DB_URL, `status/${session.uid}`, {
      callStatus: 'available',
      isOnline: true,
      status: 'online',
      lastChanged: nowMs,
      totalTalkSeconds: session.profile.totalSeconds,
    });

    const queueData = {
      nickname: session.profile.nickname,
      age: session.profile.age || 23,
      avatarIndex: session.profile.avatarIndex || 1,
      timestamp: nowMs,
      totalTalkSeconds: session.profile.totalSeconds,
    };
    await rtdbPut(PRIMARY_DB_URL, `queues/female_${session.profile.language}/${session.uid}`, queueData);
    await rtdbPut(SECONDARY_DB_URL, `expert_buckets/${session.profile.language}/${session.uid}`, queueData);
  } else {
    await rtdbPatch(PRIMARY_DB_URL, `status/${session.uid}`, {
      callStatus: 'offline',
      isOnline: false,
      status: 'offline',
      lastChanged: nowMs,
    });
    await rtdbDelete(PRIMARY_DB_URL, `queues/female_${session.profile.language}/${session.uid}`);
    await rtdbDelete(SECONDARY_DB_URL, `expert_buckets/${session.profile.language}/${session.uid}`);
  }
  broadcastToSession(session, 'presence_update', { isOnline: online, status: online ? 'available' : 'offline' });
}

function startGlobalHeartbeat() {
  setInterval(async () => {
    if (!isRunning) return;
    for (const session of sessions.values()) {
      if (session.isOnline && !session.activeCall) {
        await rtdbPatch(PRIMARY_DB_URL, `status/${session.uid}`, {
          lastChanged: Date.now(),
          isOnline: true,
        }).catch(() => {});
      }
    }
  }, 25000);
}

async function getUserName(uid) {
  if (userCache[uid]) return userCache[uid];
  let doc = await rtdbGet(SECONDARY_DB_URL, `users/${uid}`);
  if (!doc) doc = await rtdbGet(PRIMARY_DB_URL, `users/${uid}`);
  let name = uid.slice(0, 6) + '...';
  if (doc) name = doc.nickname || doc.name || name;
  userCache[uid] = name;
  return name;
}

// ============================================================================
// MESSAGING ENGINE
// ============================================================================

async function sendMessage(fromUid, receiverUid, text) {
  if (!fromUid || !receiverUid || !text || !text.trim()) return false;
  const session = getSession(fromUid, false);
  const fromName = session ? session.profile.nickname : 'Female Expert';

  const msgId = `-M${Date.now()}`;
  const nowMs = Date.now();
  const sorted = [fromUid, receiverUid].sort();
  const roomId = `${sorted[0]}__${sorted[1]}`;

  const messagePayload = {
    msgId,
    roomId,
    senderId: fromUid,
    text: text.trim(),
    timestamp: nowMs,
  };

  await rtdbPut(PRIMARY_DB_URL, `transit/messages/${receiverUid}/${msgId}`, messagePayload);
  const targetName = await getUserName(receiverUid);
  console.log(`\n${C_GREEN}✓ [${fromName} -> ${targetName}]: ${text.trim()}${C_RESET}`);
  if (session) {
    broadcastToSession(session, 'message_sent', {
      receiverUid,
      targetName,
      text: text.trim(),
      timestamp: nowMs,
    });
  }
  return true;
}

async function processSingleMessage(session, msgId, msgData) {
  const senderId = msgData.senderId;
  const text = msgData.text || '';
  if (!senderId || senderId === session.uid) return;

  // 1. Delete from transit immediately
  await rtdbDelete(PRIMARY_DB_URL, `transit/messages/${session.uid}/${msgId}`);

  // 2. Read ACK
  await rtdbPut(PRIMARY_DB_URL, `transit/acks/${senderId}/${msgId}`, {
    status: 3,
    timestamp: Date.now(),
  });

  // 3. Earning
  session.profile.totalEarnings = Math.round((session.profile.totalEarnings + 0.10) * 100) / 100;
  session.profile.balance = Math.round((session.profile.balance + 0.10) * 100) / 100;
  rtdbPatch(SECONDARY_DB_URL, `experts/${session.uid}`, {
    totalEarnings: session.profile.totalEarnings,
    redeemableBalance: session.profile.balance,
  });

  const senderName = await getUserName(senderId);
  session.lastContactUid = senderId;
  session.lastContactName = senderName;

  // Terminal bell
  process.stdout.write('\x07');

  console.log(`\n${C_CYAN}------------------------------------------------------------${C_RESET}`);
  console.log(`${C_CYAN}💬 [MESSAGE FOR ${C_BOLD}${session.profile.nickname.toUpperCase()}${C_RESET}${C_CYAN}] From ${C_BOLD}${senderName}${C_RESET}${C_CYAN} (${senderId}):${C_RESET}`);
  console.log(`   "${C_WHITE}${text}${C_RESET}"`);
  console.log(`${C_YELLOW}   → Earned +₹0.10 (Balance: ₹${session.profile.balance.toFixed(2)})${C_RESET}`);
  console.log(`${C_CYAN}------------------------------------------------------------${C_RESET}`);
  process.stdout.write('>>> ');

  broadcastToSession(session, 'incoming_message', {
    senderId,
    senderName,
    text,
    timestamp: msgData.timestamp || Date.now(),
    earnings: 0.10,
    balance: session.profile.balance,
  });
}

function handleMessageStreamEvent(session, parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  const data = parsed.data;
  if (!data) return;
  const p = parsed.path || '/';

  if (p === '/' && typeof data === 'object') {
    for (const [msgId, msgData] of Object.entries(data)) {
      if (msgData && typeof msgData === 'object') {
        processSingleMessage(session, msgId, msgData);
      }
    }
  } else if (typeof data === 'object') {
    const msgId = p.replace(/^\/+/, '');
    processSingleMessage(session, msgId, data);
  }
}

function startMessageListenersForSession(session) {
  if (session.isListeningMessages) return;
  session.isListeningMessages = true;

  // 1. Real-time SSE streaming reader
  (async () => {
    while (isRunning && session.isOnline) {
      try {
        const url = `${PRIMARY_DB_URL}/transit/messages/${session.uid}.json`;
        const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
        if (res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (isRunning && session.isOnline) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data:')) {
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr && jsonStr !== 'null') {
                  try {
                    handleMessageStreamEvent(session, JSON.parse(jsonStr));
                  } catch (_) {}
                }
              }
            }
          }
        }
      } catch (_) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    session.isListeningMessages = false;
  })();

  // 2. Fallback polling every 1.5s
  session.messagePollTimer = setInterval(async () => {
    if (!isRunning || !session.isOnline) return;
    try {
      const data = await rtdbGet(PRIMARY_DB_URL, `transit/messages/${session.uid}`);
      if (data && typeof data === 'object') {
        for (const [msgId, msgData] of Object.entries(data)) {
          if (msgData && typeof msgData === 'object') {
            await processSingleMessage(session, msgId, msgData);
          }
        }
      }
    } catch (_) {}
  }, 1500);
}

// ============================================================================
// CALLING ENGINE (MULTI-ACCOUNT READY)
// ============================================================================

async function triggerIncomingCall(session, roomId, callDoc) {
  if (session.pendingCall && session.pendingCall.roomId === roomId) return;
  if (session.activeCall) {
    await rtdbPatch(PRIMARY_DB_URL, `calls/${roomId}`, { status: 'rejected_busy' });
    return;
  }

  const callerId = callDoc.callerId || 'unknown';
  const callerName = callDoc.callerName || (await getUserName(callerId));
  const callerCoins = callDoc.callerCoins !== undefined ? callDoc.callerCoins : 'N/A';
  const price = callDoc.pricePerMin || session.profile.pricePerMin;

  session.pendingCall = {
    roomId,
    callerId,
    callerName,
    callerCoins,
    pricePerMin: price,
    offer: callDoc.offer,
    receiverId: session.uid,
  };
  session.lastContactUid = callerId;
  session.lastContactName = callerName;

  await rtdbPatch(PRIMARY_DB_URL, `status/${session.uid}`, { callStatus: 'ringing' });
  await rtdbPatch(PRIMARY_DB_URL, `active_calls/${session.uid}`, { status: 'ringing' });
  await rtdbPatch(PRIMARY_DB_URL, `calls/${roomId}`, { status: 'ringing' });

  // Terminal bell
  process.stdout.write('\x07');

  console.log(`\n${C_RED}************************************************************${C_RESET}`);
  console.log(`${C_RED}${C_BOLD}🔔📞 INCOMING CALL FOR [${session.profile.nickname.toUpperCase()}]! 📞🔔${C_RESET}`);
  console.log(`   Caller: ${C_BOLD}${callerName}${C_RESET} (${callerId})`);
  console.log(`   Coins:  ${C_YELLOW}${callerCoins}${C_RESET} | Rate: ₹${price}/min`);
  console.log(`   Room:   ${roomId}`);
  console.log(`\n   ${C_GREEN}>>> Press 'a' (or type '/accept') to ANSWER in terminal${C_RESET}`);
  console.log(`   ${C_CYAN}>>> Or answer directly in ${session.profile.nickname}'s browser tab!${C_RESET}`);
  console.log(`${C_RED}************************************************************${C_RESET}`);
  process.stdout.write('>>> ');

  broadcastToSession(session, 'incoming_call', session.pendingCall);
}

async function acceptCall(session) {
  if (!session || !session.pendingCall) {
    console.log(`${C_YELLOW}No incoming call for this expert to accept.${C_RESET}`);
    return;
  }

  const callInfo = session.pendingCall;
  session.pendingCall = null;
  session.activeCall = callInfo;
  session.callStartTime = Date.now();

  console.log(`\n${C_GREEN}Connecting call with ${callInfo.callerName} for ${session.profile.nickname}...${C_RESET}`);

  await rtdbPatch(PRIMARY_DB_URL, `calls/${callInfo.roomId}`, {
    status: 'connected',
    connectedAt: Date.now(),
  });
  await rtdbPatch(PRIMARY_DB_URL, `status/${session.uid}`, { callStatus: 'busy' });
  await rtdbPatch(PRIMARY_DB_URL, `active_calls/${session.uid}`, { status: 'busy' });

  console.log(`\n${C_GREEN}============================================================${C_RESET}`);
  console.log(`${C_GREEN}${C_BOLD}🟢 CALL CONNECTED: ${session.profile.nickname.toUpperCase()} <-> ${callInfo.callerName.toUpperCase()}!${C_RESET}`);
  console.log(`   Rate: ₹${callInfo.pricePerMin} / minute`);
  console.log(`   Type 'e' or '/end' to hang up.`);
  console.log(`${C_GREEN}============================================================${C_RESET}`);
  process.stdout.write('>>> ');

  broadcastToSession(session, 'call_connected', callInfo);
}

async function rejectCall(session) {
  if (!session || !session.pendingCall) return;
  const callInfo = session.pendingCall;
  session.pendingCall = null;

  await rtdbPatch(PRIMARY_DB_URL, `calls/${callInfo.roomId}`, { status: 'rejected' });
  await rtdbPatch(PRIMARY_DB_URL, `status/${session.uid}`, { callStatus: 'available' });
  await rtdbDelete(PRIMARY_DB_URL, `active_calls/${session.uid}`);

  console.log(`\n${C_RED}❌ Rejected call from ${callInfo.callerName} for ${session.profile.nickname}.${C_RESET}`);
  broadcastToSession(session, 'call_rejected', { roomId: callInfo.roomId });
}

async function endCall(session, remote = false) {
  if (!session || !session.activeCall) return;

  const callInfo = session.activeCall;
  const roomId = callInfo.roomId;
  const callerId = callInfo.callerId;
  const callerName = callInfo.callerName;
  const price = parseFloat(callInfo.pricePerMin || session.profile.pricePerMin);

  let durationSec = 0;
  if (session.callStartTime) {
    durationSec = Math.max(0, Math.floor((Date.now() - session.callStartTime) / 1000));
  }

  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  const durationStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  const ratePerSec = (price * 0.5) / 60.0;
  const earned = Math.round(durationSec * ratePerSec * 100) / 100;

  if (!remote && roomId) {
    await rtdbPatch(PRIMARY_DB_URL, `calls/${roomId}`, { status: 'ended' });
  }

  await rtdbPatch(PRIMARY_DB_URL, `status/${session.uid}`, { callStatus: 'available' });
  await rtdbDelete(PRIMARY_DB_URL, `active_calls/${session.uid}`);

  if (durationSec > 0) {
    session.profile.totalSeconds += durationSec;
    session.profile.totalEarnings = Math.round((session.profile.totalEarnings + earned) * 100) / 100;
    session.profile.balance = Math.round((session.profile.balance + earned) * 100) / 100;

    await rtdbPatch(SECONDARY_DB_URL, `experts/${session.uid}`, {
      totalTalkSeconds: session.profile.totalSeconds,
      totalEarnings: session.profile.totalEarnings,
      redeemableBalance: session.profile.balance,
      lastCallAt: Date.now(),
    });

    const logPayload = {
      callId: roomId,
      callerId,
      receiverId: session.uid,
      callerName,
      receiverName: session.profile.nickname,
      durationSeconds: durationSec,
      status: 'ended',
      timestamp: Date.now(),
      pricePerMin: price,
      earnedAmount: earned,
    };
    if (callerId) {
      await rtdbPut(SECONDARY_DB_URL, `user_call_logs/${callerId}/${roomId}`, logPayload);
    }
    await rtdbPut(SECONDARY_DB_URL, `user_call_logs/${session.uid}/${roomId}`, logPayload);
  }

  console.log(`\n${C_MAGENTA}------------------------------------------------------------${C_RESET}`);
  console.log(`${C_MAGENTA}${C_BOLD}📞 CALL FINISHED: ${session.profile.nickname} with ${callerName}${C_RESET}`);
  console.log(`   Duration: ${C_BOLD}${durationStr}${C_RESET}`);
  console.log(`   Earned:   ${C_GREEN}${C_BOLD}+₹${earned.toFixed(2)}${C_RESET}`);
  console.log(`   Balance:  ${C_YELLOW}₹${session.profile.balance.toFixed(2)}${C_RESET}`);
  console.log(`${C_MAGENTA}------------------------------------------------------------${C_RESET}`);
  process.stdout.write('>>> ');

  broadcastToSession(session, 'call_ended', {
    roomId,
    callerName,
    durationStr,
    earned,
    balance: session.profile.balance,
  });

  session.activeCall = null;
  session.callStartTime = null;
}

function handleGlobalCallStreamEvent(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  const data = parsed.data;
  if (!data) return;
  const p = parsed.path || '/';

  if (p === '/' && typeof data === 'object') {
    for (const [roomId, callDoc] of Object.entries(data)) {
      if (callDoc && callDoc.status === 'calling') {
        const session = sessions.get(callDoc.receiverId);
        if (session && session.isOnline && !session.activeCall && !session.pendingCall) {
          triggerIncomingCall(session, roomId, callDoc);
        }
      }
    }
  } else if (typeof data === 'object') {
    const roomId = p.replace(/^\/+/, '');
    if (data.status === 'calling') {
      const session = sessions.get(data.receiverId);
      if (session && session.isOnline && !session.activeCall && !session.pendingCall) {
        triggerIncomingCall(session, roomId, data);
      }
    }
    for (const session of sessions.values()) {
      if (session.activeCall && roomId === session.activeCall.roomId) {
        if (['ended', 'cancelled', 'missed', 'rejected_blocked'].includes(data.status)) {
          endCall(session, true);
        }
      }
    }
  }
}

function startCallListeners() {
  if (isCallListenersStarted) return;
  isCallListenersStarted = true;

  // 1. Real-time SSE streaming reader
  (async () => {
    while (isRunning) {
      try {
        const url = `${PRIMARY_DB_URL}/calls.json`;
        const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
        if (res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (isRunning) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data:')) {
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr && jsonStr !== 'null') {
                  try {
                    handleGlobalCallStreamEvent(JSON.parse(jsonStr));
                  } catch (_) {}
                }
              }
            }
          }
        }
      } catch (_) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  // 2. Fallback polling every 1.5s
  setInterval(async () => {
    if (!isRunning) return;
    try {
      const data = await rtdbGet(PRIMARY_DB_URL, 'calls');
      if (data && typeof data === 'object') {
        for (const [roomId, callDoc] of Object.entries(data)) {
          if (callDoc && callDoc.status === 'calling') {
            const session = sessions.get(callDoc.receiverId);
            if (session && session.isOnline && !session.activeCall && !session.pendingCall) {
              await triggerIncomingCall(session, roomId, callDoc);
            }
          }
        }
      }
    } catch (_) {}
  }, 1500);
}

// ============================================================================
// EXPRESS & WEBSOCKET WEB SERVER
// ============================================================================

function startWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Get active session config
  app.get('/api/config', (req, res) => {
    const uid = req.query.uid || req.headers['x-female-uid'];
    let session = null;

    if (uid && sessions.has(uid)) {
      session = sessions.get(uid);
    } else if (!uid && sessions.size === 1) {
      session = sessions.values().next().value;
    }

    const activeSessionsList = Array.from(sessions.values()).map((s) => ({
      uid: s.uid,
      nickname: s.profile.nickname,
      language: s.profile.language,
      pricePerMin: s.profile.pricePerMin,
      isOnline: s.isOnline,
      hasActiveCall: Boolean(s.activeCall),
    }));

    if (session) {
      return res.json({
        loggedIn: true,
        femaleUid: session.uid,
        ...session.profile,
        isOnline: session.isOnline,
        activeCall: session.activeCall,
        pendingCall: session.pendingCall,
        primaryDbUrl: PRIMARY_DB_URL,
        secondaryDbUrl: SECONDARY_DB_URL,
        activeSessions: activeSessionsList,
      });
    }

    res.json({
      loggedIn: false,
      femaleUid: '',
      primaryDbUrl: PRIMARY_DB_URL,
      secondaryDbUrl: SECONDARY_DB_URL,
      activeSessions: activeSessionsList,
    });
  });

  // Get pre-registered female experts
  app.get('/api/experts', async (req, res) => {
    try {
      const list = await getRegisteredExperts();
      const formatted = list.map(([uid, doc]) => ({
        uid,
        name: doc.nickname || doc.name || 'Expert',
        languages: doc.languages || 'Hindi',
        pricePerMin: doc.pricePerMin || 4,
        avatarIndex: doc.avatarIndex || 1,
      }));
      res.json(formatted);
    } catch (_) {
      res.json([]);
    }
  });

  // Login a specific female expert
  app.post('/api/login', async (req, res) => {
    const { uid } = req.body;
    if (!uid || typeof uid !== 'string') {
      return res.status(400).json({ error: 'UID is required' });
    }
    const session = await performLogin(uid.trim());
    res.json({
      success: true,
      config: {
        loggedIn: true,
        femaleUid: session.uid,
        ...session.profile,
        isOnline: session.isOnline,
        primaryDbUrl: PRIMARY_DB_URL,
        secondaryDbUrl: SECONDARY_DB_URL,
      },
    });
  });

  // Send message
  app.post('/api/send-message', async (req, res) => {
    const { femaleUid, receiverUid, text } = req.body;
    const fUid = femaleUid || activeCliUid;
    const success = await sendMessage(fUid, receiverUid, text);
    res.json({ success });
  });

  // Call actions
  app.post('/api/accept-call', async (req, res) => {
    const { femaleUid } = req.body;
    const session = sessions.get(femaleUid) || sessions.get(activeCliUid);
    if (session) await acceptCall(session);
    res.json({ success: true });
  });

  app.post('/api/reject-call', async (req, res) => {
    const { femaleUid } = req.body;
    const session = sessions.get(femaleUid) || sessions.get(activeCliUid);
    if (session) await rejectCall(session);
    res.json({ success: true });
  });

  app.post('/api/end-call', async (req, res) => {
    const { femaleUid } = req.body;
    const session = sessions.get(femaleUid) || sessions.get(activeCliUid);
    if (session) await endCall(session);
    res.json({ success: true });
  });

  // Logout a specific female expert
  app.post('/api/logout', async (req, res) => {
    const { femaleUid } = req.body;
    const uid = femaleUid || req.query.uid;
    if (uid && sessions.has(uid)) {
      const session = sessions.get(uid);
      if (session.activeCall) {
        await endCall(session);
      }
      await setPresence(session, false);
      sessions.delete(uid);
      if (activeCliUid === uid) {
        activeCliUid = sessions.size > 0 ? sessions.keys().next().value : null;
      }
      console.log(`\n${C_YELLOW}Logged out expert: ${session.profile.nickname} (${uid})${C_RESET}`);
      process.stdout.write('>>> ');
    }
    res.json({ success: true });
  });

  const server = http.createServer(app);
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    let assignedUid = null;
    try {
      const host = req.headers.host || `localhost:${PORT}`;
      const parsedUrl = new URL(req.url, `http://${host}`);
      assignedUid = parsedUrl.searchParams.get('uid');
    } catch (_) {}

    let session = assignedUid ? sessions.get(assignedUid) : null;
    if (!session && sessions.size === 1) {
      session = sessions.values().next().value;
      assignedUid = session ? session.uid : null;
    }

    if (session) {
      session.wsClients.add(ws);
      ws.send(JSON.stringify({
        type: 'init',
        femaleUid: session.uid,
        payload: {
          femaleUid: session.uid,
          ...session.profile,
          isOnline: session.isOnline,
          pendingCall: session.pendingCall,
          activeCall: session.activeCall,
        },
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'init',
        payload: { loggedIn: false },
      }));
    }

    ws.on('close', () => {
      if (session) {
        session.wsClients.delete(ws);
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`${C_CYAN}🌐 Local WebRTC Panel running at: ${C_BOLD}http://localhost:${PORT}${C_RESET}`);
  });
}

// ============================================================================
// LOGIN & SESSION MANAGEMENT
// ============================================================================

async function performLogin(uid) {
  const session = getSession(uid, true);
  if (!activeCliUid) activeCliUid = session.uid;

  console.log(`\n${C_CYAN}Logging in as UID: ${session.uid}...${C_RESET}`);
  const found = await fetchProfile(session);
  if (!found) {
    console.log(`${C_YELLOW}Profile not found for ${session.uid}. Initializing default profile...${C_RESET}`);
    await createDefaultProfile(session, 'Zoya', 'Hindi');
    await fetchProfile(session);
  }

  await setPresence(session, true);
  startMessageListenersForSession(session);
  startCallListeners();

  console.log(`
${C_GREEN}================================================================================
✅ LOGGED IN: ${session.profile.nickname.toUpperCase()} (${session.uid})
--------------------------------------------------------------------------------${C_RESET}
  ${C_BOLD}Name:${C_RESET}       ${session.profile.nickname} (${session.profile.language})
  ${C_BOLD}Rate:${C_RESET}       ₹${session.profile.pricePerMin}/min
  ${C_BOLD}Earnings:${C_RESET}   ₹${session.profile.totalEarnings.toFixed(2)} (Balance: ₹${session.profile.balance.toFixed(2)})
  ${C_BOLD}Talk Time:${C_RESET}  ${Math.floor(session.profile.totalSeconds / 60)} mins ${session.profile.totalSeconds % 60} secs
  ${C_BOLD}Status:${C_RESET}     ${C_GREEN}ONLINE & AVAILABLE (Listening for calls & messages)${C_RESET}
  ${C_BOLD}Browser URL:${C_RESET} ${C_CYAN}http://localhost:${PORT}/?uid=${session.uid}${C_RESET}
${C_GREEN}================================================================================${C_RESET}
`);

  broadcastToSession(session, 'login_success', {
    femaleUid: session.uid,
    ...session.profile,
    isOnline: true,
    primaryDbUrl: PRIMARY_DB_URL,
    secondaryDbUrl: SECONDARY_DB_URL,
  });

  return session;
}

async function shutdown() {
  if (!isRunning) return;
  isRunning = false;
  console.log(`\n${C_YELLOW}Shutting down and setting all active experts offline...${C_RESET}`);
  for (const session of sessions.values()) {
    if (session.activeCall) {
      await endCall(session);
    }
    await setPresence(session, false);
  }
  console.log(`${C_GREEN}All experts safely disconnected. Goodbye!${C_RESET}`);
  process.exit(0);
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

function printBanner() {
  console.log(`
${C_CYAN}================================================================================
          ███╗   ██╗ ██████╗ ██████╗ ███████╗   ██╗███████╗
          ████╗  ██║██╔═══██╗██╔══██╗██╔════╝   ██║██╔════╝
          ██╔██╗ ██║██║   ██║██║  ██║█████╗     ██║███████╗
          ██║╚██╗██║██║   ██║██║  ██║██╔══╝██   ██║╚════██║
          ██║ ╚████║╚██████╔╝██████╔╝███████╗█████╔╝███████║
          ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚══════╝╚════╝ ╚══════╝
           FEMALE EXPERT CLIENT - MULTI-ACCOUNT EDITION
================================================================================${C_RESET}`);
}

function showHelp() {
  console.log(`
${C_BOLD}MULTI-ACCOUNT COMMANDS CHEAT SHEET:${C_RESET}
  ${C_GREEN}/list${C_RESET}                 : List all active logged-in female experts
  ${C_GREEN}/login <uid|name|num>${C_RESET} : Log in another female expert
  ${C_GREEN}/switch <name|num>${C_RESET}    : Switch active terminal expert for /send & /r
  ${C_GREEN}/send <uid> <message>${C_RESET} : Send message to any user (from active expert)
  ${C_GREEN}/r <message>${C_RESET}          : Quick reply to the last user
  ${C_GREEN}a${C_RESET} or ${C_GREEN}/accept${C_RESET}             : Answer incoming call
  ${C_RED}r${C_RESET} or ${C_RED}/reject${C_RESET}             : Reject incoming call
  ${C_RED}e${C_RESET} or ${C_RED}/end${C_RESET}                : Hang up ongoing call
  ${C_CYAN}/stats${C_RESET}                : View earnings & balances for all active experts
  ${C_CYAN}/web${C_RESET}                  : Display WebRTC browser URLs for each expert
  ${C_WHITE}/help${C_RESET}                 : Show this cheat sheet
  ${C_RED}/exit${C_RESET}                 : Disconnect all and quit
`);
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

async function main() {
  printBanner();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  startWebServer();
  startGlobalHeartbeat();

  const experts = await getRegisteredExperts();
  if (experts.length > 0) {
    console.log(`${C_WHITE}Registered Female Experts in Database:${C_RESET}`);
    experts.slice(0, 6).forEach(([uid, doc], idx) => {
      const name = doc.nickname || doc.name || 'Expert';
      const lang = doc.languages || 'Hindi';
      const rate = doc.pricePerMin || 4;
      console.log(`  ${C_GREEN}[${idx + 1}]${C_RESET} ${C_BOLD}${name}${C_RESET} (${lang}, ₹${rate}/min) → UID: ${C_CYAN}${uid}${C_RESET}`);
    });
    console.log();
  }

  // Handle command line arguments (e.g. node index.js Sonia Swati)
  const args = process.argv.slice(2);
  if (args.length > 0) {
    for (const arg of args) {
      let selected = arg;
      const num = parseInt(arg);
      if (!isNaN(num) && num >= 1 && num <= experts.length) {
        selected = experts[num - 1][0];
      } else {
        const match = experts.find(([u, doc]) => (doc.nickname || doc.name || '').toLowerCase() === arg.toLowerCase());
        if (match) selected = match[0];
      }
      await performLogin(selected);
    }
    showHelp();
  } else {
    console.log(`${C_YELLOW}Enter Number (1-${Math.min(experts.length, 6)}) or paste Female UID to log in (or open http://localhost:${PORT} in browser):${C_RESET}`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '>>> ',
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const cmd = line.trim();
    if (!cmd) {
      rl.prompt();
      return;
    }

    if (sessions.size === 0) {
      const num = parseInt(cmd);
      let selected = cmd;
      if (!isNaN(num) && num >= 1 && num <= experts.length) {
        selected = experts[num - 1][0];
      }
      await performLogin(selected);
      showHelp();
      rl.prompt();
      return;
    }

    const lower = cmd.toLowerCase();
    const activeSession = sessions.get(activeCliUid) || sessions.values().next().value;

    // Call controls
    if (['a', '/accept'].includes(lower)) {
      // Find session with pending call
      let ringingSession = null;
      for (const s of sessions.values()) {
        if (s.pendingCall) {
          ringingSession = s;
          break;
        }
      }
      if (ringingSession) {
        await acceptCall(ringingSession);
      } else if (activeSession) {
        await acceptCall(activeSession);
      }
    } else if (['r', '/reject'].includes(lower)) {
      let ringingSession = null;
      for (const s of sessions.values()) {
        if (s.pendingCall) {
          ringingSession = s;
          break;
        }
      }
      if (ringingSession) {
        await rejectCall(ringingSession);
      } else if (activeSession) {
        await rejectCall(activeSession);
      }
    } else if (['e', '/end', '/hangup'].includes(lower)) {
      let talkingSession = null;
      for (const s of sessions.values()) {
        if (s.activeCall) {
          talkingSession = s;
          break;
        }
      }
      if (talkingSession) {
        await endCall(talkingSession);
      } else if (activeSession) {
        await endCall(activeSession);
      }
    }

    // Multi-account controls
    else if (lower === '/list') {
      console.log(`\n${C_BOLD}Active Logged-In Female Experts (${sessions.size}):${C_RESET}`);
      let idx = 1;
      for (const s of sessions.values()) {
        const isCurrent = s.uid === activeCliUid ? ` ${C_GREEN}★ [ACTIVE CLI]${C_RESET}` : '';
        const status = s.activeCall ? `${C_RED}[IN CALL]${C_RESET}` : (s.pendingCall ? `${C_YELLOW}[RINGING]${C_RESET}` : `${C_GREEN}[ONLINE]${C_RESET}`);
        console.log(`  ${C_CYAN}[${idx++}]${C_RESET} ${C_BOLD}${s.profile.nickname}${C_RESET} (${s.uid}) ${status}${isCurrent}`);
        console.log(`      Tab URL: ${C_WHITE}http://localhost:${PORT}/?uid=${s.uid}${C_RESET}`);
      }
    } else if (lower.startsWith('/login ')) {
      const target = cmd.slice(7).trim();
      let selected = target;
      const num = parseInt(target);
      if (!isNaN(num) && num >= 1 && num <= experts.length) {
        selected = experts[num - 1][0];
      } else {
        const match = experts.find(([u, doc]) => (doc.nickname || doc.name || '').toLowerCase() === target.toLowerCase());
        if (match) selected = match[0];
      }
      await performLogin(selected);
    } else if (lower.startsWith('/switch ')) {
      const target = cmd.slice(8).trim();
      let switched = false;
      const num = parseInt(target);
      const sessionArr = Array.from(sessions.values());
      if (!isNaN(num) && num >= 1 && num <= sessionArr.length) {
        activeCliUid = sessionArr[num - 1].uid;
        switched = true;
      } else {
        for (const s of sessions.values()) {
          if (s.uid === target || s.profile.nickname.toLowerCase() === target.toLowerCase()) {
            activeCliUid = s.uid;
            switched = true;
            break;
          }
        }
      }
      if (switched) {
        const cur = sessions.get(activeCliUid);
        console.log(`${C_GREEN}Active CLI context switched to: ${cur.profile.nickname} (${cur.uid})${C_RESET}`);
      } else {
        console.log(`${C_YELLOW}Expert not found among active sessions. Type /list to see active experts.${C_RESET}`);
      }
    }

    // Message sending
    else if (lower.startsWith('/send ')) {
      const parts = cmd.split(' ');
      if (parts.length >= 3) {
        const target = parts[1].trim();
        const msg = parts.slice(2).join(' ').trim();
        await sendMessage(activeSession.uid, target, msg);
      } else {
        console.log(`${C_YELLOW}Usage: /send <user_uid> <message>${C_RESET}`);
      }
    } else if (lower.startsWith('/r ') || lower.startsWith('/reply ')) {
      const parts = cmd.split(' ');
      if (parts.length >= 2) {
        if (activeSession.lastContactUid) {
          const msg = parts.slice(1).join(' ').trim();
          await sendMessage(activeSession.uid, activeSession.lastContactUid, msg);
        } else {
          console.log(`${C_YELLOW}No recent contact to reply to for ${activeSession.profile.nickname}. Use /send <uid> <message>${C_RESET}`);
        }
      }
    }

    // Stats
    else if (['/stats', '/profile'].includes(lower)) {
      console.log(`\n${C_BOLD}Active Experts Balances & Earnings:${C_RESET}`);
      for (const s of sessions.values()) {
        await fetchProfile(s);
        console.log(`  ${C_BOLD}${s.profile.nickname}${C_RESET} (${s.uid}):`);
        console.log(`    Balance: ${C_YELLOW}₹${s.profile.balance.toFixed(2)}${C_RESET} | Earnings: ₹${s.profile.totalEarnings.toFixed(2)} | Time: ${Math.floor(s.profile.totalSeconds / 60)}m ${s.profile.totalSeconds % 60}s`);
      }
    } else if (lower === '/web') {
      console.log(`\n${C_CYAN}Browser Access Links for Active Experts:${C_RESET}`);
      for (const s of sessions.values()) {
        console.log(`  ${C_BOLD}${s.profile.nickname}${C_RESET}: ${C_GREEN}http://localhost:${PORT}/?uid=${s.uid}${C_RESET}`);
      }
    } else if (lower === '/clear') {
      console.clear();
      printBanner();
    } else if (lower === '/help') {
      showHelp();
    } else if (lower === '/exit') {
      await shutdown();
    } else {
      console.log(`${C_YELLOW}Unknown command: "${cmd}". Type /help for cheat sheet.${C_RESET}`);
    }

    rl.prompt();
  });
}

main().catch((err) => {
  console.error('Fatal client error:', err);
  process.exit(1);
});
