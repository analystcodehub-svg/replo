/**
 * FEMALE EXPERT WEB CLIENT & WEBRTC ENGINE - MULTI-ACCOUNT EDITION
 * Supports multiple female IDs in different tabs concurrently.
 * - Each tab stores femaleUid in sessionStorage and URL query ?uid=...
 * - WebRTC 2-way audio per tab (supports separate or shared microphones)
 * - Independent chat and incoming calls
 */

let config = {};
let ws = null;
let tabFemaleUid = '';
let currentChatTargetUid = '';
let currentChatTargetName = '';

// WebRTC State
let peerConnection = null;
let localStream = null;
let pendingCallData = null;
let activeCallData = null;
let callTimerInterval = null;
let callSeconds = 0;
let ringtoneAudioContext = null;
let ringtoneInterval = null;

// Audio Meter State
let meterAudioContext = null;
let meterAnalyser = null;
let meterSource = null;
let meterRaf = null;

const PRIMARY_DB_URL = 'https://zegochat-c44b0.asia-southeast1.firebasedatabase.app';
let candidatePollTimer = null;
let callStatusPollTimer = null;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

// ============================================================================
// INITIALIZATION & TAB SESSION ISOLATION
// ============================================================================

async function init() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const queryUid = urlParams.get('uid');
    const isNewTab = urlParams.get('new') === '1';

    if (isNewTab) {
      sessionStorage.removeItem('femaleUid');
      tabFemaleUid = '';
      // Clean query param
      window.history.replaceState({}, '', '/');
    } else if (queryUid) {
      tabFemaleUid = queryUid.trim();
      sessionStorage.setItem('femaleUid', tabFemaleUid);
    } else {
      tabFemaleUid = sessionStorage.getItem('femaleUid') || '';
    }

    const configUrl = tabFemaleUid ? `/api/config?uid=${encodeURIComponent(tabFemaleUid)}` : '/api/config';
    const res = await fetch(configUrl);
    config = await res.json();

    if (!config.loggedIn) {
      showLoginModal();
    } else {
      tabFemaleUid = config.femaleUid;
      sessionStorage.setItem('femaleUid', tabFemaleUid);
      window.history.replaceState({}, '', `?uid=${tabFemaleUid}`);
      hideLoginModal();
      updateProfileUI(config);
      setupWebSocket(tabFemaleUid);
    }

    setupAudioDevices();
    setupEventListeners();
  } catch (err) {
    console.error('Initialization error:', err);
  }
}

async function showLoginModal() {
  const modal = document.getElementById('loginModal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const container = document.getElementById('quickExpertsList');
  try {
    const res = await fetch('/api/experts');
    const list = await res.json();
    container.innerHTML = '';
    if (list && list.length > 0) {
      list.slice(0, 6).forEach((exp) => {
        const btn = document.createElement('div');
        btn.className = 'expert-btn';
        btn.innerHTML = `
          <div>
            <span class="expert-btn-name">${escapeHtml(exp.name)} (${exp.languages})</span>
            <span class="expert-btn-uid">${exp.uid}</span>
          </div>
          <span class="expert-btn-rate">₹${exp.pricePerMin}/m →</span>
        `;
        btn.addEventListener('click', () => performBrowserLogin(exp.uid));
        container.appendChild(btn);
      });
    } else {
      container.innerHTML = '<div style="font-size:12px;color:#94a3b8;text-align:center;">No pre-registered experts found. Enter custom UID below.</div>';
    }
  } catch (_) {
    container.innerHTML = '<div style="font-size:12px;color:#94a3b8;text-align:center;">Enter your UID below to login:</div>';
  }
}

function hideLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.add('hidden');
}

async function performBrowserLogin(uid) {
  if (!uid) {
    const input = document.getElementById('loginUidInput');
    uid = input ? input.value.trim() : '';
  }
  if (!uid) {
    alert('Please enter or select a Female UID');
    return;
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
    const result = await res.json();
    if (result.success) {
      config = result.config;
      tabFemaleUid = config.femaleUid;
      sessionStorage.setItem('femaleUid', tabFemaleUid);
      window.history.replaceState({}, '', `?uid=${tabFemaleUid}`);
      hideLoginModal();
      updateProfileUI(config);
      setupWebSocket(tabFemaleUid);
    }
  } catch (err) {
    alert('Login error: ' + err.message);
  }
}

function updateProfileUI(data) {
  document.getElementById('expertName').textContent = data.nickname || 'Expert';
  document.getElementById('expertLang').textContent = (data.language || 'Hindi').toUpperCase();
  document.getElementById('expertUid').textContent = `UID: ${data.femaleUid || ''}`;
  document.getElementById('totalEarnings').textContent = `₹${(data.totalEarnings || 0).toFixed(2)}`;
  document.getElementById('balance').textContent = `₹${(data.balance || 0).toFixed(2)}`;

  const mins = Math.floor((data.totalSeconds || 0) / 60);
  const secs = (data.totalSeconds || 0) % 60;
  document.getElementById('talkTime').textContent = `${mins}m ${secs}s`;

  const initials = (data.nickname || 'FE').slice(0, 2).toUpperCase();
  document.getElementById('avatarText').textContent = initials;

  const dot = document.getElementById('statusDot');
  dot.className = `status-indicator ${data.isOnline ? (data.activeCall ? 'busy' : 'online') : 'offline'}`;
}

function clearProfileUI() {
  document.getElementById('expertName').textContent = 'Logged Out';
  document.getElementById('expertLang').textContent = 'OFFLINE';
  document.getElementById('expertUid').textContent = 'UID: None';
  document.getElementById('totalEarnings').textContent = '₹0.00';
  document.getElementById('balance').textContent = '₹0.00';
  document.getElementById('talkTime').textContent = '0m 0s';
  document.getElementById('avatarText').textContent = '--';
  const dot = document.getElementById('statusDot');
  dot.className = 'status-indicator offline';
}

// ============================================================================
// WEBSOCKET COMMUNICATION (SCOPED TO TAB FEMALE UID)
// ============================================================================

function setupWebSocket(uid = tabFemaleUid) {
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = uid ? `?uid=${encodeURIComponent(uid)}` : '';
  ws = new WebSocket(`${protocol}//${window.location.host}${query}`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      // Filter out messages targeted to a different female ID
      if (data.femaleUid && tabFemaleUid && data.femaleUid !== tabFemaleUid) {
        return;
      }
      handleWsMessage(data.type, data.payload || data);
    } catch (_) {}
  };

  ws.onclose = () => {
    setTimeout(() => {
      if (tabFemaleUid) setupWebSocket(tabFemaleUid);
    }, 2500);
  };
}

function handleWsMessage(type, payload) {
  if (type === 'init') {
    if (payload.femaleUid) {
      hideLoginModal();
      updateProfileUI(payload);
    }
    if (payload.pendingCall) showIncomingCall(payload.pendingCall);
  } else if (type === 'login_success') {
    hideLoginModal();
    config = payload;
    updateProfileUI(payload);
  } else if (type === 'incoming_message') {
    handleIncomingMessage(payload);
  } else if (type === 'message_sent') {
    handleOutgoingMessage(payload);
  } else if (type === 'incoming_call') {
    showIncomingCall(payload);
  } else if (type === 'call_connected') {
    handleCallConnected(payload);
  } else if (type === 'call_rejected') {
    handleCallRejected();
  } else if (type === 'call_ended') {
    handleCallEnded(payload);
  } else if (type === 'presence_update') {
    document.getElementById('statusDot').className = `status-indicator ${payload.isOnline ? 'online' : 'offline'}`;
  }
}

// ============================================================================
// AUDIO DEVICES & METERING
// ============================================================================

async function setupAudioDevices() {
  const select = document.getElementById('micSelect');
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach((t) => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    select.innerHTML = '';

    let voicemodOption = null;

    devices
      .filter((d) => d.kind === 'audioinput')
      .forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Microphone ${idx + 1}`;
        if (dev.label.toLowerCase().includes('voicemod')) {
          voicemodOption = opt;
        }
        select.appendChild(opt);
      });

    if (voicemodOption) {
      voicemodOption.selected = true;
    }
  } catch (err) {
    console.warn('Microphone permission or enumeration warning:', err);
  }
}

async function startMicMeter() {
  const deviceId = document.getElementById('micSelect').value;
  try {
    if (meterSource) meterSource.disconnect();
    if (meterAudioContext) meterAudioContext.close();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });

    meterAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    meterAnalyser = meterAudioContext.createAnalyser();
    meterAnalyser.fftSize = 256;
    meterSource = meterAudioContext.createMediaStreamSource(stream);
    meterSource.connect(meterAnalyser);

    const fill = document.getElementById('micMeterFill');
    const dataArray = new Uint8Array(meterAnalyser.frequencyBinCount);

    function update() {
      meterAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      const pct = Math.min(100, Math.round((avg / 128) * 100));
      fill.style.width = `${pct}%`;
      meterRaf = requestAnimationFrame(update);
    }
    update();
  } catch (err) {
    console.error('Mic meter error:', err);
  }
}

// ============================================================================
// MESSAGING UI
// ============================================================================

function handleIncomingMessage(msg) {
  const container = document.getElementById('chatMessages');
  const empty = container.querySelector('.empty-chat');
  if (empty) empty.remove();

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble msg-incoming';
  bubble.innerHTML = `
    <strong>${escapeHtml(msg.senderName)}</strong><br>
    ${escapeHtml(msg.text)}
    <div class="msg-meta">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;

  setChatTarget(msg.senderId, msg.senderName);
  document.getElementById('balance').textContent = `₹${(msg.balance || 0).toFixed(2)}`;
}

function handleOutgoingMessage(msg) {
  const container = document.getElementById('chatMessages');
  const empty = container.querySelector('.empty-chat');
  if (empty) empty.remove();

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble msg-outgoing';
  bubble.innerHTML = `
    ${escapeHtml(msg.text)}
    <div class="msg-meta">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ✓✓</div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function setChatTarget(uid, name) {
  currentChatTargetUid = uid;
  currentChatTargetName = name;
  document.getElementById('chatTargetName').textContent = `💬 Chat with ${name}`;
  document.getElementById('chatTargetUid').textContent = `UID: ${uid}`;
}

async function sendCurrentMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || !currentChatTargetUid) {
    if (!currentChatTargetUid) alert('Please enter or select a User UID to chat with.');
    return;
  }

  input.value = '';
  await fetch('/api/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      femaleUid: tabFemaleUid,
      receiverUid: currentChatTargetUid,
      text,
    }),
  });
}

// ============================================================================
// INCOMING & WEBRTC CALL ENGINE
// ============================================================================

function playRingtone() {
  try {
    ringtoneAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    function beep() {
      if (!ringtoneAudioContext) return;
      const osc = ringtoneAudioContext.createOscillator();
      const gain = ringtoneAudioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ringtoneAudioContext.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ringtoneAudioContext.currentTime + 0.3);
      gain.gain.setValueAtTime(0.25, ringtoneAudioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ringtoneAudioContext.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ringtoneAudioContext.destination);
      osc.start();
      osc.stop(ringtoneAudioContext.currentTime + 0.35);
    }
    beep();
    ringtoneInterval = setInterval(beep, 1500);
  } catch (_) {}
}

function stopRingtone() {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
  if (ringtoneAudioContext) {
    try { ringtoneAudioContext.close(); } catch (_) {}
    ringtoneAudioContext = null;
  }
}

function showIncomingCall(callDoc) {
  pendingCallData = callDoc;
  document.getElementById('modalCallerName').textContent = callDoc.callerName || 'Male Caller';
  document.getElementById('modalCallerUid').textContent = `UID: ${callDoc.callerId || ''}`;
  document.getElementById('modalCallerCoins').textContent = `Coins: ${callDoc.callerCoins || 'N/A'}`;
  document.getElementById('modalCallRate').textContent = `Rate: ₹${callDoc.pricePerMin || 4.0} / min`;

  document.getElementById('incomingCallModal').classList.remove('hidden');
  playRingtone();
}

async function acceptIncomingCall() {
  stopRingtone();
  document.getElementById('incomingCallModal').classList.add('hidden');
  if (!pendingCallData) return;

  activeCallData = pendingCallData;
  pendingCallData = null;

  const roomId = activeCallData.roomId;

  try {
    console.log('[WebRTC] Starting call acceptance for room:', roomId);

    // 1. Fetch latest room data to get SDP offer
    const roomSnap = await fetch(`${PRIMARY_DB_URL}/calls/${roomId}.json`).then((r) => r.json());
    const offer = (roomSnap && roomSnap.offer) || activeCallData.offer;
    if (!offer || !offer.sdp) {
      alert('Call offer missing from room.');
      return;
    }

    // 2. Get local microphone stream
    const micSelectId = document.getElementById('micSelect').value;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: micSelectId ? { deviceId: { exact: micSelectId } } : true,
        video: false,
      });
    } catch (micErr) {
      console.warn('Selected mic failed, falling back to default mic:', micErr);
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }

    // 3. Create Peer Connection with STUN & TURN
    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // 4. Add local audio track
    localStream.getAudioTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });

    // 5. Remote audio track listener
    peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Remote track received:', event.track.kind);
      const remoteAudio = document.getElementById('remoteAudio');
      if (event.streams && event.streams[0]) {
        remoteAudio.srcObject = event.streams[0];
      } else {
        remoteAudio.srcObject = new MediaStream([event.track]);
      }
      remoteAudio.play().catch((e) => console.log('Audio autoplay info:', e));
    };

    // 6. ICE Candidate upload to expertCandidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate) {
        fetch(`${PRIMARY_DB_URL}/calls/${roomId}/expertCandidates.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid || '0',
            sdpMLineIndex: event.candidate.sdpMLineIndex !== null && event.candidate.sdpMLineIndex !== undefined ? event.candidate.sdpMLineIndex : 0,
          }),
        }).catch(() => {});
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE Connection State:', peerConnection.iceConnectionState);
    };

    // 7. Apply SDP Offer
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    // 8. Add existing caller candidates & handle incoming
    const seenCandidates = new Set();
    async function addCandidateSafely(key, c) {
      if (!c || !c.candidate || seenCandidates.has(key)) return;
      seenCandidates.add(key);
      try {
        const iceCand = new RTCIceCandidate({
          candidate: c.candidate,
          sdpMid: c.sdpMid ? String(c.sdpMid) : '0',
          sdpMLineIndex: c.sdpMLineIndex !== null && c.sdpMLineIndex !== undefined ? parseInt(c.sdpMLineIndex, 10) : 0,
        });
        await peerConnection.addIceCandidate(iceCand);
        console.log('[WebRTC] Added remote candidate:', key);
      } catch (e) {
        console.warn('[WebRTC] Error adding remote candidate:', e);
      }
    }

    if (roomSnap && roomSnap.callerCandidates) {
      for (const [key, c] of Object.entries(roomSnap.callerCandidates)) {
        await addCandidateSafely(key, c);
      }
    }

    // Start background poller for continuous/late caller candidates
    if (candidatePollTimer) clearInterval(candidatePollTimer);
    candidatePollTimer = setInterval(async () => {
      if (!peerConnection || !activeCallData || activeCallData.roomId !== roomId) {
        clearInterval(candidatePollTimer);
        return;
      }
      try {
        const cSnap = await fetch(`${PRIMARY_DB_URL}/calls/${roomId}/callerCandidates.json`).then(r => r.json());
        if (cSnap && typeof cSnap === 'object') {
          for (const [key, c] of Object.entries(cSnap)) {
            await addCandidateSafely(key, c);
          }
        }
      } catch (_) {}
    }, 500);

    // 9. Generate SDP Answer
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    // 10. Upload SDP Answer to Firebase RTDB & notify server
    await fetch(`${PRIMARY_DB_URL}/calls/${roomId}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer: { sdp: answer.sdp, type: answer.type },
        status: 'connected',
        connectedAt: Date.now(),
      }),
    });

    await fetch('/api/accept-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ femaleUid: tabFemaleUid, roomId }),
    });

    // Show active call banner
    showActiveCallBanner(activeCallData.callerName);

    // Monitor for remote hangup
    if (callStatusPollTimer) clearInterval(callStatusPollTimer);
    callStatusPollTimer = setInterval(async () => {
      if (!activeCallData || activeCallData.roomId !== roomId) {
        clearInterval(callStatusPollTimer);
        return;
      }
      try {
        const s = await fetch(`${PRIMARY_DB_URL}/calls/${roomId}/status.json`).then(r => r.json());
        if (['ended', 'cancelled', 'missed', 'rejected', 'rejected_blocked'].includes(s)) {
          clearInterval(callStatusPollTimer);
          handleCallEnded({ roomId });
        }
      } catch (_) {}
    }, 1000);

  } catch (err) {
    console.error('Error accepting call:', err);
    alert('Failed to connect call: ' + err.message);
    endActiveCall();
  }
}

async function rejectIncomingCall() {
  stopRingtone();
  document.getElementById('incomingCallModal').classList.add('hidden');
  const roomId = pendingCallData ? pendingCallData.roomId : null;
  pendingCallData = null;
  await fetch('/api/reject-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ femaleUid: tabFemaleUid, roomId }),
  });
}

function handleCallConnected(callInfo) {
  stopRingtone();
  document.getElementById('incomingCallModal').classList.add('hidden');
  if (!peerConnection && (pendingCallData || callInfo)) {
    pendingCallData = callInfo;
    acceptIncomingCall();
    return;
  }
  activeCallData = callInfo;
  showActiveCallBanner(callInfo.callerName);
}

function handleCallRejected() {
  stopRingtone();
  document.getElementById('incomingCallModal').classList.add('hidden');
  pendingCallData = null;
}

function showActiveCallBanner(callerName) {
  document.getElementById('activeCallerName').textContent = callerName || 'Caller';
  document.getElementById('activeCallBanner').classList.remove('hidden');

  callSeconds = 0;
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('callDuration').textContent = `${m}:${s}`;
  }, 1000);
}

async function endActiveCall() {
  if (candidatePollTimer) {
    clearInterval(candidatePollTimer);
    candidatePollTimer = null;
  }
  if (callStatusPollTimer) {
    clearInterval(callStatusPollTimer);
    callStatusPollTimer = null;
  }
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  document.getElementById('activeCallBanner').classList.add('hidden');

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  const roomId = activeCallData ? activeCallData.roomId : null;
  activeCallData = null;
  await fetch('/api/end-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ femaleUid: tabFemaleUid, roomId }),
  });
}

function handleCallEnded(payload) {
  if (candidatePollTimer) {
    clearInterval(candidatePollTimer);
    candidatePollTimer = null;
  }
  if (callStatusPollTimer) {
    clearInterval(callStatusPollTimer);
    callStatusPollTimer = null;
  }
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  document.getElementById('activeCallBanner').classList.add('hidden');
  document.getElementById('incomingCallModal').classList.add('hidden');
  stopRingtone();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  activeCallData = null;

  if (payload && payload.balance !== undefined) {
    document.getElementById('balance').textContent = `₹${payload.balance.toFixed(2)}`;
  }
}

function toggleMuteLocalStream() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    const btn = document.getElementById('btnMuteActive');
    btn.textContent = audioTrack.enabled ? 'Mute' : 'Unmute';
    btn.className = `btn btn-sm ${audioTrack.enabled ? 'btn-secondary' : 'btn-danger'}`;
  }
}

// ============================================================================
// EVENT LISTENERS & MULTI-ACCOUNT ACTIONS
// ============================================================================

function setupEventListeners() {
  const loginSubmit = document.getElementById('btnLoginSubmit');
  if (loginSubmit) {
    loginSubmit.addEventListener('click', () => performBrowserLogin());
  }
  const loginInput = document.getElementById('loginUidInput');
  if (loginInput) {
    loginInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') performBrowserLogin();
    });
  }

  const btnNewTab = document.getElementById('btnNewFemaleTab');
  if (btnNewTab) {
    btnNewTab.addEventListener('click', () => {
      window.open('/?new=1', '_blank');
    });
  }

  const btnSwitch = document.getElementById('btnSwitchExpert');
  if (btnSwitch) {
    btnSwitch.addEventListener('click', () => {
      sessionStorage.removeItem('femaleUid');
      tabFemaleUid = '';
      window.history.replaceState({}, '', '/');
      showLoginModal();
    });
  }

  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      if (confirm('Are you sure you want to log out this female expert and set status offline?')) {
        const uidToLogout = tabFemaleUid;
        if (uidToLogout) {
          try {
            await fetch('/api/logout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ femaleUid: uidToLogout }),
            });
          } catch (_) {}
        }

        if (ws) {
          try { ws.close(); } catch (_) {}
          ws = null;
        }
        if (peerConnection) {
          try { peerConnection.close(); } catch (_) {}
          peerConnection = null;
        }
        if (localStream) {
          localStream.getTracks().forEach((t) => t.stop());
          localStream = null;
        }
        stopRingtone();

        sessionStorage.removeItem('femaleUid');
        tabFemaleUid = '';
        window.history.replaceState({}, '', '/');
        clearProfileUI();
        showLoginModal();
      }
    });
  }

  document.getElementById('btnTestMic').addEventListener('click', startMicMeter);

  document.getElementById('btnStartChat').addEventListener('click', () => {
    const customUid = document.getElementById('customUserUid').value.trim();
    if (customUid) {
      setChatTarget(customUid, `User (${customUid.slice(0, 6)}...)`);
    }
  });

  document.getElementById('btnSendMessage').addEventListener('click', sendCurrentMessage);
  document.getElementById('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCurrentMessage();
  });

  document.getElementById('btnAcceptCall').addEventListener('click', acceptIncomingCall);
  document.getElementById('btnRejectCall').addEventListener('click', rejectIncomingCall);
  document.getElementById('btnEndCall').addEventListener('click', endActiveCall);
  document.getElementById('btnMuteActive').addEventListener('click', toggleMuteLocalStream);
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

window.addEventListener('DOMContentLoaded', init);
