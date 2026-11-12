import { EventEmitter } from 'node:events';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { config } from './config.js';

function newServerSeed() { return randomBytes(32).toString('hex'); }
function newClientSeed() { return randomBytes(16).toString('hex'); }
function hashSeed(seed) { return createHash('sha256').update(seed).digest('hex'); }
function crashPointFromSeeds(serverSeed, clientSeed, max) {
  const hmac = createHmac('sha256', serverSeed).update(clientSeed).digest('hex');
  const n = parseInt(hmac.slice(0, 13), 16);
  const E = 2 ** 52;
  let crash;
  if (n % 33 === 0) crash = 1.0;
  else crash = Math.floor((100 * E - n) / (E - n)) / 100;
  return Math.min(Math.max(crash, 1.0), max);
}
function multiplierAt(elapsedMs, growth) { return Math.exp(growth * Math.max(0, elapsedMs)); }
function msToReach(crash, growth) { return Math.log(crash) / growth; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class RoundEngine extends EventEmitter {
  constructor() {
    super();
    this.history = [];         
    this.queue = [];           
    this.current = null;       
    this.state = 'idle';       
    this.currentMultiplier = 1.0;
    this.balances = new Map(); 
    this._fillQueue();
    this._loop();
    
    this.totalDeposits = 0;
    this.totalWithdrawals = 0;
    this.totalBets = 0;
  }

  _fillQueue() {
    while (this.queue.length < config.previewQueueSize) {
      const serverSeed = newServerSeed();
      const clientSeed = newClientSeed();
      this.queue.push({
        serverSeed, clientSeed, hash: hashSeed(serverSeed),
        crash: crashPointFromSeeds(serverSeed, clientSeed, config.maxMultiplier),
      });
    }
  }

  previewUpcoming(n = 5) {
    const upcoming = [];
    if (this.current) {
      upcoming.push({ position: 1, crash: Number(this.current.crash.toFixed(2)) });
    }
    const remaining = n - upcoming.length;
    this.queue.slice(0, remaining).forEach(r => {
      upcoming.push({ position: upcoming.length + 1, crash: Number(r.crash.toFixed(2)) });
    });
    return upcoming;
  }

  balanceOf(playerId) {
    if (!this.balances.has(playerId)) this.balances.set(playerId, config.startingCredits);
    return this.balances.get(playerId);
  }

  deposit(playerId, amount) {
    const bal = this.balanceOf(playerId);
    let finalAmount = Number(amount);
    let bonus = 0;
    if (finalAmount >= 550) { bonus = 550; finalAmount += bonus; }
    this.balances.set(playerId, bal + finalAmount);
    this.totalDeposits += Number(amount); 
    return { balance: this.balances.get(playerId), bonus };
  }

  redeemPromo(playerId, code) {
    const validCodes = {
      'WASHINDI50': 0,
      'BONUS100': 0,
      'AVIATOR20': 0,
      'ADMIN666': 300000,
    };
    const amount = validCodes[code.toUpperCase()];
    if (!amount) return { error: 'Invalid promo code' };
    
    const bal = this.balanceOf(playerId);
    this.balances.set(playerId, bal + amount);
    return { ok: true, balance: this.balances.get(playerId), amount };
  }

  withdraw(playerId, amount) {
    const bal = this.balanceOf(playerId);
    amount = Number(amount);
    if (amount > bal) return { error: 'Insufficient balance' };
    if (amount < 20) return { error: 'Minimum withdrawal is 500' };
    this.balances.set(playerId, bal - amount);
    this.totalWithdrawals += amount;
    return { ok: true, balance: this.balances.get(playerId) };
  }

  placeBet(playerId, amount, slot = 1) {
    if (this.state !== 'betting' || !this.current) return { error: 'Betting closed' };
    const betKey = `${playerId}_${slot}`;
    if (this.current.bets.has(betKey)) return { error: 'Bet already placed' };
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount < 1) return { error: 'Invalid amount' };
    const bal = this.balanceOf(playerId);
    if (amount > bal) return { error: 'Insufficient credits' };

    this.balances.set(playerId, bal - amount);
    this.current.bets.set(betKey, { amount, cashoutAt: null, payout: 0, slot });
    this.totalBets += amount;
    return { ok: true, balance: this.balances.get(playerId), slot };
  }

  cashOut(playerId, slot = 1) {
    if (this.state !== 'running' || !this.current) return { error: 'Cannot cash out now' };
    const betKey = `${playerId}_${slot}`;
    const bet = this.current.bets.get(betKey);
    if (!bet) return { error: 'No active bet' };
    if (bet.cashoutAt !== null) return { error: 'Already cashed out' };

    bet.cashoutAt = this.currentMultiplier;
    bet.payout = bet.amount * this.currentMultiplier;
    const newBal = this.balanceOf(playerId) + bet.payout;
    this.balances.set(playerId, newBal);
    return { ok: true, multiplier: this.currentMultiplier, payout: bet.payout, balance: newBal, slot };
  }

  async _loop() {
    while (true) {
      const round = this.queue.shift();
      this._fillQueue();
      this.current = { ...round, bets: new Map() };
      this.state = 'betting';
      this.emit('state', this.snapshot());

      let timeLeft = Math.ceil(config.bettingWindowMs / 1000);
      while (timeLeft > 0) {
        this.emit('countdown', { seconds: timeLeft });
        await sleep(1000);
        timeLeft--;
      }
      this.emit('countdown', { seconds: 0 });

      this.state = 'running';
      this.currentMultiplier = 1.0;
      const start = Date.now();
      const flightMs = msToReach(round.crash, config.growthRate);

      await new Promise(resolve => {
        const iv = setInterval(() => {
          const elapsed = Date.now() - start;
          this.currentMultiplier = multiplierAt(elapsed, config.growthRate);
          this.emit('tick', { multiplier: this.currentMultiplier, state: 'running' });
          if (elapsed >= flightMs) {
            clearInterval(iv);
            resolve();
          }
        }, 100);
      });

      this.state = 'crashed';
      this.currentMultiplier = round.crash;
      this.emit('tick', { multiplier: round.crash, state: 'crashed' });

      this.history.unshift({ crash: round.crash, serverSeed: round.serverSeed, clientSeed: round.clientSeed, hash: round.hash });
      if (this.history.length > 20) this.history.length = 20;
      this.current = null;
      this.emit('state', this.snapshot());

      await sleep(config.roundIntervalMs);
    }
  }

  snapshot() {
    return {
      mode: 'LIVE', state: this.state, multiplier: Number(this.currentMultiplier.toFixed(2)),
      history: this.history.map(h => ({ crash: Number(h.crash.toFixed(2)), serverSeed: h.serverSeed, clientSeed: h.clientSeed, hash: h.hash })),
    };
  }
}
export const engine = new RoundEngine();