import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { config } from './config.js';
import { engine } from './engine.js';
import { stkPush, normalizePhone } from './mpesa.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const adminTokens = new Map();
let tokenSeq = 0;

function isSuper(password) { return password === config.adminPassword; }
function isAdmin(password) { return isSuper(password) || adminTokens.has(password); }

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed logins. Try again in 15 minutes.' },
});
app.use('/api/admin/login', loginLimiter);
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  if (isSuper(password)) return res.json({ role: 'super', name: 'Super Admin' });
  if (adminTokens.has(password)) return res.json({ role: 'admin', name: adminTokens.get(password).name });
  return res.status(401).json({ error: 'wrong password' });
});

app.get('/api/admin/preview', (req, res) => {
  const password = String(req.query.password || '');
  if (!isAdmin(password)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ mode: 'TEST', label: 'PREVIEW (TEST ONLY)', upcoming: engine.previewUpcoming(config.previewQueueSize) });
});

app.get('/api/admin/stats', (req, res) => {
  const password = String(req.query.password || '');
  if (!isAdmin(password)) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    totalDeposits: engine.totalDeposits,
    totalWithdrawals: engine.totalWithdrawals,
    totalBets: engine.totalBets,
    activePlayers: engine.balances.size
  });
});

app.get('/api/admin/list', (req, res) => {
  const password = String(req.query.password || '');
  if (!isSuper(password)) return res.status(403).json({ error: 'super only' });
  const list = [...adminTokens.entries()].map(([token, info]) => ({ token, ...info }));
  res.json({ admins: list });
});

app.post('/api/admin/add', (req, res) => {
  const { password, name } = req.body || {};
  if (!isSuper(password)) return res.status(403).json({ error: 'super only' });
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'name required' });
  tokenSeq += 1;
  const token = `adm_${Date.now()}_${tokenSeq}`;
  adminTokens.set(token, { name: name.trim(), addedBy: 'super', addedAt: new Date().toISOString() });
  res.json({ ok: true, token, name: name.trim() });
});

app.delete('/api/admin/remove', (req, res) => {
  const { password, token } = req.body || {};
  if (!isSuper(password)) return res.status(403).json({ error: 'super only' });
  if (!adminTokens.has(token)) return res.status(404).json({ error: 'not found' });
  adminTokens.delete(token);
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => res.json(engine.snapshot()));

// ───────────── M-PESA pending maps + helpers ─────────────
const pendingStk = new Map(); // CheckoutRequestID -> { playerId, amount, createdAt }
const pendingB2C = new Map(); // OriginatorConversationID -> { playerId, amount, reqId }
const WITHDRAW_FEE = 350;
const feePaid = new Map(); // playerId -> { amount, phone } (fee confirmed, request not yet created)

// NEW: withdrawal requests waiting for admin review
let withdrawals = []; // { id, playerId, phone, amount, status, createdAt }
let wdSeq = 0;

function sendToPlayer(playerId, msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.playerId === playerId) c.send(s);
  });
}

function refund(playerId, amount) {
  engine.balances.set(playerId, engine.balanceOf(playerId) + amount);
  engine.totalWithdrawals -= amount;
}

setInterval(() => { // drop STK requests never answered after 10 min
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, p] of pendingStk) if (p.createdAt < cutoff) pendingStk.delete(id);
}, 60 * 1000);

// Safaricom -> STK result
app.post('/api/mpesa/stk-callback', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // always ack fast
  const cb = req.body?.Body?.stkCallback;
  if (!cb) return;
  const pending = pendingStk.get(cb.CheckoutRequestID);
  if (!pending) return; // unknown or already processed (idempotent)
  pendingStk.delete(cb.CheckoutRequestID);
  const isFee = pending.kind === 'fee';

  if (cb.ResultCode !== 0) {
    sendToPlayer(pending.playerId, {
      type: isFee ? 'withdrawFeeResult' : 'stkPushResult',
      error: cb.ResultDesc || 'Payment cancelled',
    });
    return;
  }
  const items = cb.CallbackMetadata?.Item || [];
  const paid = Number(items.find(i => i.Name === 'Amount')?.Value || 0);

  if (isFee) {
    if (paid < WITHDRAW_FEE) {
      console.warn('Fee amount mismatch', cb.CheckoutRequestID, paid);
      return;
    }
    feePaid.set(pending.playerId, { amount: pending.withdrawAmount, phone: pending.phone });
    sendToPlayer(pending.playerId, { type: 'feePaid' });
    return;
  }

  if (paid < pending.amount) {
    console.warn('Amount mismatch', cb.CheckoutRequestID, paid, pending.amount);
    return;
  }
  const r = engine.deposit(pending.playerId, paid);
  sendToPlayer(pending.playerId, { type: 'depositResult', balance: r.balance, bonus: r.bonus });
});

// Safaricom -> B2C result
app.post('/api/mpesa/b2c-result', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const r = req.body?.Result;
  if (!r) return;
  const pending = pendingB2C.get(r.OriginatorConversationID);
  if (!pending) return;
  pendingB2C.delete(r.OriginatorConversationID);
  const w = withdrawals.find(x => x.id === pending.reqId);
  if (r.ResultCode !== 0) {
    refund(pending.playerId, pending.amount);
    if (w) w.status = 'failed';
    sendToPlayer(pending.playerId, {
      type: 'withdrawResult',
      error: 'Withdrawal failed, amount refunded',
      balance: engine.balanceOf(pending.playerId),
    });
  } else if (w) {
    w.status = 'paid';
  }
});

app.post('/api/mpesa/b2c-timeout', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  console.warn('B2C timeout', JSON.stringify(req.body)); // check manually before refunding
});

// ───────────── NEW: admin review of withdrawal requests ─────────────
app.get('/api/admin/withdrawals', (req, res) => {
  const password = String(req.query.password || '');
  if (!isAdmin(password)) return res.status(401).json({ error: 'unauthorized' });
  const list = [...withdrawals].reverse().slice(0, 100);
  res.json({ withdrawals: list });
});

app.post('/api/admin/withdrawals/approve', async (req, res) => {
  const { password, id } = req.body || {};
  if (!isAdmin(String(password || ''))) return res.status(401).json({ error: 'unauthorized' });
  const w = withdrawals.find(x => x.id === id && x.status === 'pending');
  if (!w) return res.status(404).json({ error: 'Request not found or already handled' });
  w.status = 'processing'; // blocks double clicks
  try {
    const out = await b2c({ phone: w.phone, amount: w.amount });
    w.status = 'approved';
    engine.totalWithdrawals += w.amount;
    pendingB2C.set(out.OriginatorConversationID, { playerId: w.playerId, amount: w.amount, reqId: w.id });
    saveBalances();
    res.json({ ok: true });
  } catch (e) {
    console.error('Approve B2C error:', e.message);
    w.status = 'pending'; // stays in the list so you can retry
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/withdrawals/reject', (req, res) => {
  const { password, id } = req.body || {};
  if (!isAdmin(String(password || ''))) return res.status(401).json({ error: 'unauthorized' });
  const w = withdrawals.find(x => x.id === id && x.status === 'pending');
  if (!w) return res.status(404).json({ error: 'Request not found or already handled' });
  w.status = 'rejected';
  engine.balances.set(w.playerId, engine.balanceOf(w.playerId) + w.amount);
  saveBalances();
  sendToPlayer(w.playerId, {
    type: 'withdrawResult',
    error: 'Withdrawal rejected, amount returned to your balance',
    balance: engine.balanceOf(w.playerId),
  });
  res.json({ ok: true });
});
// ───────────── END NEW ─────────────

// ───────────── Balance persistence ─────────────
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'balances.json');
const WD_FILE = join(DATA_DIR, 'withdrawals.json');

function loadBalances() {
  try {
    if (existsSync(DATA_FILE)) {
      const saved = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      for (const [id, bal] of Object.entries(saved.balances || {})) engine.balances.set(id, Number(bal));
      engine.totalDeposits = Number(saved.totalDeposits || 0);
      engine.totalWithdrawals = Number(saved.totalWithdrawals || 0);
      engine.totalBets = Number(saved.totalBets || 0);
      console.log(`  Loaded ${engine.balances.size} player balance(s) from disk`);
    }
    if (existsSync(WD_FILE)) {
      withdrawals = JSON.parse(readFileSync(WD_FILE, 'utf8'));
      withdrawals.forEach(w => { if (w.status === 'processing') w.status = 'pending'; });
      wdSeq = withdrawals.length;
      console.log(`  Loaded ${withdrawals.length} withdrawal request(s) from disk`);
    }
  } catch (e) {
    console.error('Could not load saved data:', e.message);
  }
}

function saveBalances() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const out = {
      balances: Object.fromEntries(engine.balances),
      totalDeposits: engine.totalDeposits,
      totalWithdrawals: engine.totalWithdrawals,
      totalBets: engine.totalBets,
    };
    const tmp = DATA_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, DATA_FILE);
    const tmp2 = WD_FILE + '.tmp';
    writeFileSync(tmp2, JSON.stringify(withdrawals));
    renameSync(tmp2, WD_FILE);
  } catch (e) {
    console.error('Could not save balances:', e.message);
  }
}

loadBalances();
setInterval(saveBalances, 2000);
process.on('SIGINT', () => { saveBalances(); process.exit(0); });
process.on('SIGTERM', () => { saveBalances(); process.exit(0); });
// ───────────── End persistence ─────────────
engine.on('tick', data => broadcast({ type: 'tick', data }));
engine.on('state', data => broadcast({ type: 'state', data }));
engine.on('countdown', data => broadcast({ type: 'countdown', data }));

wss.on('connection', ws => {
  ws.playerId = null;
  ws.send(JSON.stringify({ type: 'state', data: engine.snapshot() }));

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello') {
      ws.playerId = String(msg.playerId || '').slice(0, 64) || null;
      if (ws.playerId) ws.send(JSON.stringify({ type: 'balance', balance: engine.balanceOf(ws.playerId) }));
      return;
    }

    if (!ws.playerId) return ws.send(JSON.stringify({ type: 'error', error: 'send hello first' }));

    if (msg.type === 'bet') {
      const r = engine.placeBet(ws.playerId, msg.amount, msg.slot);
      ws.send(JSON.stringify({ type: 'betResult', slot: msg.slot, ...r }));
      return;
    }

    if (msg.type === 'cashout') {
      const r = engine.cashOut(ws.playerId, msg.slot);
      ws.send(JSON.stringify({ type: 'cashoutResult', slot: msg.slot, ...r }));
      return;
    }

    // Client can no longer credit itself. Real deposits come from the STK callback.
    if (msg.type === 'deposit') return;

    if (msg.type === 'stkPush') {
      const amount = Math.floor(Number(msg.amount));
      const phoneNo = normalizePhone(msg.phone);
      if (!Number.isFinite(amount) || amount < 350) {
        return ws.send(JSON.stringify({ type: 'stkPushResult', error: 'Minimum deposit is 350 KES' }));
      }
      if (!phoneNo) {
        return ws.send(JSON.stringify({ type: 'stkPushResult', error: 'Invalid M-PESA number' }));
      }
      try {
  const r = await stkPush({ phone: phoneNo, amount, accountRef: 'FALCON' });
  pendingStk.set(r.checkoutRequestId, { playerId: ws.playerId, amount, createdAt: Date.now() });
  ws.send(JSON.stringify({ type: 'stkPushResult', ok: true }));
} catch (e) {
  console.error('STK error:', e.message);
  ws.send(JSON.stringify({ type: 'stkPushResult', error: e.message }));
}
return;
}  
    if (msg.type === 'promo') {
      const r = engine.redeemPromo(ws.playerId, msg.code);
      ws.send(JSON.stringify({ type: 'promoResult', ...r }));
      return;
    }

    // Step 1 of withdrawal: charge the 350 fee by STK push
    if (msg.type === 'withdrawFee') {
      const amount = Math.floor(Number(msg.amount));
      const phoneNo = normalizePhone(msg.phone);
      const bal = engine.balanceOf(ws.playerId);
      const fail = e => ws.send(JSON.stringify({ type: 'withdrawFeeResult', error: e }));
      if (!phoneNo) return fail('Invalid M-PESA number');
      if (!Number.isFinite(amount) || amount < 20) return fail('Minimum withdrawal is 20 KES');
      if (amount > bal) return fail('Insufficient balance');
      try {
       const r = await stkPush({ phone: phoneNo, amount: WITHDRAW_FEE, accountRef: 'WFEE' });
pendingStk.set(r.checkoutRequestId, {
  kind: 'fee', playerId: ws.playerId, phone: phoneNo,
  withdrawAmount: amount, amount: WITHDRAW_FEE, createdAt: Date.now(),
});
        ws.send(JSON.stringify({ type: 'withdrawFeeResult', ok: true }));
      } catch (e) {
        console.error('Fee STK error:', e.message);
        fail(e.message);
      }
      return;
    }

    // Step 2: runs only after the fee is confirmed. Deducts the amount and creates a pending request for admin review.
    if (msg.type === 'withdraw') {
      const fee = feePaid.get(ws.playerId);
      const reply = o => ws.send(JSON.stringify({ type: 'withdrawResult', balance: engine.balanceOf(ws.playerId), ...o }));
      if (!fee) return reply({ error: 'Pay the 350 KES withdrawal fee first' });
      feePaid.delete(ws.playerId);
      const bal = engine.balanceOf(ws.playerId);
      if (fee.amount > bal) return reply({ error: 'Insufficient balance' });
      engine.balances.set(ws.playerId, bal - fee.amount);
      wdSeq += 1;
      withdrawals.push({
        id: `w_${Date.now()}_${wdSeq}`, playerId: ws.playerId, phone: fee.phone,
        amount: fee.amount, status: 'pending', createdAt: Date.now(),
      });
      saveBalances();
      reply({ ok: true, pending: true });
      return;
    }
  });
});

function broadcast(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); });
}

server.listen(config.port, () => {
  console.log(`  WashindiHub Game   →  http://localhost:${config.port}`);
  console.log(`  Login Page         →  http://localhost:${config.port}/login.html`);
  console.log(`  Admin Panel        →  http://localhost:${config.port}/admin.html`);
  console.log(`  M-PESA env: ${process.env.MPESA_ENV || 'sandbox'}  callback: ${process.env.MPESA_CALLBACK_URL || '(not set)'}`);
});