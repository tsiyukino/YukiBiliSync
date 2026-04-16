import { WebSocketServer } from 'ws';
import { createServer } from 'https';
import { createHmac, randomUUID } from 'crypto';
import { readFileSync } from 'fs';

const PORT        = parseInt(process.env.PORT || '8444', 10);
const TURN_SECRET = process.env.TURN_SECRET;   // shared secret configured in coturn
const TURN_HOST   = process.env.TURN_HOST;     // e.g. "your-server.com:3478"
const CERT_PATH   = process.env.TLS_CERT;      // path to fullchain.pem
const KEY_PATH    = process.env.TLS_KEY;       // path to privkey.pem

if (!TURN_SECRET) throw new Error('TURN_SECRET env var is required');
if (!TURN_HOST)   throw new Error('TURN_HOST env var is required');
if (!CERT_PATH)   throw new Error('TLS_CERT env var is required');
if (!KEY_PATH)    throw new Error('TLS_KEY env var is required');

// rooms: roomCode → Map<peerId, ws>
const rooms = new Map();

const httpsServer = createServer({
  cert: readFileSync(CERT_PATH),
  key:  readFileSync(KEY_PATH),
});

const wss = new WebSocketServer({ server: httpsServer });

wss.on('connection', (ws) => {
  ws.peerId  = null;
  ws.roomCode = null;
  console.log('client connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    console.log('message:', JSON.stringify(msg));
    handleMessage(ws, msg);
  });

  ws.on('close', () => { console.log('client disconnected', ws.peerId); cleanup(ws); });
  ws.on('error', (e) => { console.log('client error', e.message); cleanup(ws); });
});

function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'join': {
      const { roomCode, peerId } = msg;
      if (!roomCode || !peerId) return;

      // Leave any previous room first
      cleanup(ws);

      ws.peerId   = peerId;
      ws.roomCode = roomCode;

      if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
      const room = rooms.get(roomCode);

      // Tell the newcomer about everyone already in the room
      for (const [existingId] of room) {
        send(ws, { type: 'peer-joined', peerId: existingId });
      }

      // Tell everyone already in the room about the newcomer
      broadcast(room, { type: 'peer-joined', peerId }, ws);

      room.set(peerId, ws);
      break;
    }

    case 'signal': {
      const { roomCode, to, payload } = msg;
      if (!roomCode || !to || !payload) return;

      const room = rooms.get(roomCode);
      if (!room) return;

      const target = room.get(to);
      if (!target) return;

      send(target, { type: 'signal', from: ws.peerId, payload });
      break;
    }

    case 'leave': {
      cleanup(ws);
      break;
    }

    case 'turn-credentials': {
      send(ws, { type: 'turn-credentials', ...makeTurnCredentials() });
      break;
    }

    default:
      break;
  }
}

function cleanup(ws) {
  if (!ws.roomCode || !ws.peerId) return;

  const room = rooms.get(ws.roomCode);
  if (room) {
    room.delete(ws.peerId);
    broadcast(room, { type: 'peer-left', peerId: ws.peerId });
    if (room.size === 0) rooms.delete(ws.roomCode);
  }

  ws.peerId   = null;
  ws.roomCode = null;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg, except = null) {
  for (const [, ws] of room) {
    if (ws !== except) send(ws, msg);
  }
}

// TURN REST API — time-limited credential (valid for 24 hours)
function makeTurnCredentials() {
  const ttl      = 86400; // seconds
  const username = `${Math.floor(Date.now() / 1000) + ttl}:yukibilisync`;
  const credential = createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');
  return { username, credential, ttl, host: TURN_HOST };
}

httpsServer.listen(PORT, () => {
  console.log(`YukiBiliSync signaling server listening on port ${PORT}`);
});
