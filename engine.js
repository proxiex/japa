/* JAPA - game engine. Pure logic, no DOM, so it can be tested in Node and later
   moved server-side (server-authoritative economy) without a rewrite.
   All state lives in one plain object `g` so it saves to localStorage as JSON. */
(function (root) {
  'use strict';

  var MAX_MONTHS = 36;
  var START_RATE = 1500; // naira per dollar

  var JOBS = {
    nurse:  { name: 'Nurse', icon: '🩺', blurb: 'Steady pay, high demand abroad',
              salary: 170000, living: 100000, skill: 38, ielts: 20, docs: 15, network: 10, hope: 70 },
    dev:    { name: 'Software dev', icon: '💻', blurb: 'Best pay, remote gigs',
              salary: 340000, living: 120000, skill: 42, ielts: 28, docs: 12, network: 18, hope: 65 },
    acct:   { name: 'Accountant', icon: '📊', blurb: 'Decent pay, solid skills',
              salary: 185000, living: 100000, skill: 35, ielts: 24, docs: 14, network: 12, hope: 68 },
    corper: { name: 'Fresh grad (NYSC)', icon: '🎓', blurb: 'Hard mode. Low pay, lives at home',
              salary: 90000, living: 45000, skill: 15, ielts: 25, docs: 10, network: 5, hope: 85 }
  };

  // Fictional game values. Not immigration advice.
  var ROUTES = {
    uk: { name: 'UK',      flag: '🇬🇧', blurb: 'Sponsored job route',   level: 'Medium', ielts: 50, skill: 55, docs: 75, network: 30, funds: 2000, fee: 1800 },
    ca: { name: 'Canada',  flag: '🇨🇦', blurb: 'Points-based route',    level: 'Hard', ielts: 62, skill: 60, docs: 80, network: 0,  funds: 4000, fee: 1200 },
    de: { name: 'Germany', flag: '🇩🇪', blurb: 'Skilled-worker route',  level: 'Easier', ielts: 38, skill: 65, docs: 70, network: 20, funds: 2500, fee: 900 },
    us: { name: 'USA',     flag: '🇺🇸', blurb: 'Study + scholarship',   level: 'Brutal', ielts: 55, skill: 65, docs: 82, network: 40, funds: 6000, fee: 2200 }
  };

  /* ---------- random: mulberry32 with its state stored on g so saves are reproducible ---------- */
  function rnd(g) {
    g.s = (g.s + 0x6D2B79F5) | 0;
    var t = g.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function between(g, lo, hi) { return Math.round(lo + rnd(g) * (hi - lo)); }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /* ---------- formatting ---------- */
  function fmtN(n) {
    var a = Math.abs(n), sign = n < 0 ? '-' : '';
    if (a >= 1e6) return sign + '₦' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (a >= 1e3) return sign + '₦' + Math.round(a / 1e3) + 'k';
    return sign + '₦' + Math.round(a);
  }
  function fmtUsd(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function band(prep) { return (4.5 + prep / 100 * 4).toFixed(1); }

  /* ---------- state ---------- */
  function newGame(jobId, routeId, seed) {
    var j = JOBS[jobId];
    var g = {
      s: (seed == null ? Math.floor(Math.random() * 4294967296) : seed) | 0,
      month: 1, job: jobId, route: routeId,
      naira: 200000, usd: 0, rate: START_RATE, lastRate: START_RATE,
      salary: j.salary, living: j.living,
      skill: j.skill, ielts: j.ielts, docs: j.docs, network: j.network, hope: j.hope,
      ap: 2, feeMult: 1, pending: null, event: null, lastEvent: null, flags: {},
      log: [], over: null,
      stats: { scams: 0, avoided: 0, applications: 0, refused: 0 }
    };
    g.log.push('Month 1. Japa don dey call you. Make we start.');
    return g;
  }

  function say(g, msg) { g.log.push(msg); if (g.log.length > 40) g.log.shift(); }

  function applyFx(g, fx) {
    var k;
    for (k in fx) {
      if (!Object.prototype.hasOwnProperty.call(fx, k)) continue;
      if (k === 'rate') g.rate = Math.round(g.rate * (1 + fx.rate));
      else if (k === 'salary') g.salary = Math.round(g.salary * (1 + fx.salary));
      else if (k === 'naira' || k === 'usd') g[k] += fx[k];
      else g[k] = clamp(g[k] + fx[k], 0, 100);
    }
    if (g.naira < 0) g.naira = 0;
    if (g.usd < 0) g.usd = 0;
  }

  /* ---------- requirements ---------- */
  function feeOf(g, r) { return Math.round(r.fee * g.feeMult); }
  function requirements(g, routeId) {
    var r = ROUTES[routeId || g.route], fee = feeOf(g, r);
    return [
      { key: 'ielts',   label: 'IELTS ' + band(r.ielts),      have: band(g.ielts),  ok: g.ielts >= r.ielts,   pct: Math.min(1, g.ielts / r.ielts) },
      { key: 'skill',   label: 'Skill ' + r.skill,            have: String(Math.round(g.skill)), ok: g.skill >= r.skill, pct: Math.min(1, g.skill / r.skill) },
      { key: 'docs',    label: 'Documents ' + r.docs + '%',   have: Math.round(g.docs) + '%', ok: g.docs >= r.docs, pct: Math.min(1, g.docs / r.docs) },
      { key: 'network', label: 'Connections ' + r.network,    have: String(Math.round(g.network)), ok: g.network >= r.network, pct: r.network ? Math.min(1, g.network / r.network) : 1 },
      { key: 'usd',     label: fmtUsd(r.funds + fee) + ' in dollars', have: fmtUsd(g.usd), ok: g.usd >= r.funds + fee, pct: Math.min(1, g.usd / (r.funds + fee)) }
    ];
  }
  function canApply(g) {
    if (g.over || g.event || g.pending) return false;
    return requirements(g).every(function (q) { return q.ok; });
  }

  /* ---------- actions (1 action point each, 2 per month) ---------- */
  var ACTIONS = {
    hustle:  { label: 'Side hustle',      icon: '💼', cost: 0,     hint: 'Earn extra naira',
               run: function (g) {
                 var gain = Math.round(between(g, 70000, 130000) * (1 + g.skill / 150));
                 applyFx(g, { naira: gain, hope: -3, skill: 1 });
                 return 'Side hustle paid ' + fmtN(gain) + '. Body dey tire small.';
               } },
    ielts:   { label: 'Study IELTS',      icon: '📚', cost: 15000, hint: 'Raise your English band',
               run: function (g) {
                 var gain = between(g, 8, 12) + (g.hope >= 50 ? 2 : 0);
                 applyFx(g, { naira: -15000, ielts: gain, hope: -2 });
                 return 'IELTS practice done. Band now ' + band(g.ielts) + '.';
               } },
    upskill: { label: 'Upskill',          icon: '🧠', cost: 20000, hint: 'Courses and certificates',
               run: function (g) {
                 applyFx(g, { naira: -20000, skill: between(g, 6, 9), hope: -2 });
                 return 'New certificate unlocked. Skill now ' + Math.round(g.skill) + '.';
               } },
    docs:    { label: 'Process documents', icon: '📄', cost: 30000, hint: 'Passport, transcripts, police report',
               run: function (g) {
                 applyFx(g, { naira: -30000, docs: between(g, 9, 13), hope: -3 });
                 return 'Queue wahala, but papers moved. Documents ' + Math.round(g.docs) + '%.';
               } },
    network: { label: 'Network',          icon: '🤝', cost: 5000,  hint: 'Japa groups, referrals, Spaces',
               run: function (g) {
                 applyFx(g, { naira: -5000, network: between(g, 8, 12), hope: 1 });
                 return 'You show face in the right group chats. Connections ' + Math.round(g.network) + '.';
               } },
    rest:    { label: 'Rest and recharge', icon: '😴', cost: 10000, hint: 'Win back your hope',
               run: function (g) {
                 applyFx(g, { naira: -10000, hope: between(g, 11, 15) });
                 return 'You rest. Hope dey rise small: ' + Math.round(g.hope) + '%.';
               } }
  };

  function canAct(g, id) {
    return !g.over && !g.event && g.ap > 0 && g.naira >= ACTIONS[id].cost;
  }
  function act(g, id) {
    if (!canAct(g, id)) return false;
    g.ap -= 1;
    say(g, ACTIONS[id].run(g));
    checkBurnout(g);
    return true;
  }

  /* ---------- money ---------- */
  var SPREAD = 0.02;
  function swapToUsd(g, nairaAmount) {
    var spend = Math.min(nairaAmount, g.naira);
    if (spend < 1000) return false;
    var got = spend / (g.rate * (1 + SPREAD));
    g.naira -= spend; g.usd += got;
    say(g, 'Bought ' + fmtUsd(got) + ' at ₦' + g.rate + '/$.');
    return true;
  }
  function buyUsd(g, nairaAmount) {
    if (g.over || g.event) return false;
    return swapToUsd(g, nairaAmount);
  }
  function sellUsd(g, usdAmount) {
    var amt = Math.min(usdAmount, g.usd);
    if (g.over || g.event || amt < 1) return false;
    g.usd -= amt; g.naira += amt * g.rate * (1 - SPREAD);
    say(g, 'Sold ' + fmtUsd(amt) + ' at ₦' + g.rate + '/$.');
    return true;
  }

  /* ---------- application ---------- */
  function apply(g) {
    if (!canApply(g)) return false;
    var r = ROUTES[g.route], fee = feeOf(g, r);
    g.usd -= fee;
    g.pending = { route: g.route, due: g.month + 2 };
    g.stats.applications += 1;
    say(g, 'Application submitted for ' + r.name + '. Fee paid: ' + fmtUsd(fee) + '. Result in 2 months. Pray.');
    return true;
  }

  function resolveApplication(g) {
    var p = g.pending, r = ROUTES[p.route];
    g.pending = null;
    if (g.usd < r.funds) {
      g.stats.refused += 1;
      applyFx(g, { hope: -12, docs: -10 });
      say(g, 'Refused: your proof of funds fell below ' + fmtUsd(r.funds) + '. Rebuild your dollars and apply again.');
      return;
    }
    var prob = clamp(0.45 + (g.docs - r.docs) / 100 + (g.skill - r.skill) / 200 + g.network / 400, 0.35, 0.92);
    if (rnd(g) < prob) {
      g.over = { kind: 'win', month: g.month, route: p.route };
      say(g, 'APPROVED! ' + r.name + ' visa don land.');
    } else {
      g.stats.refused += 1;
      applyFx(g, { hope: -12, docs: -10 });
      say(g, 'Refused. The letter was vague, as usual. Tighten your papers and apply again.');
    }
  }

  /* ---------- events ---------- */
  var EVENTS = [
    { id: 'plug', w: 3, title: 'The Visa Plug',
      text: 'An Instagram "consultant" promises a guaranteed visa in 3 weeks. Processing fee: ₦300k. His page has 40k followers and a Lambo photo.',
      choices: [
        { label: 'Pay ₦300k, no stress', need: { naira: 300000 },
          roll: { p: 0.12,
                  win: { fx: { naira: -300000, docs: 14, hope: 8 }, text: 'Shocker: he was legit and the document review actually helped.' },
                  lose: { fx: { naira: -300000, hope: -18 }, flag: 'scams', text: 'He blocked you. The Lambo was rented. Lesson expensive.' } } },
        { label: 'Ignore and block', fx: { hope: 1 }, text: 'You block him. Wise.' },
        { label: 'Ask your japa group to verify', req: { network: 25 }, fx: { network: 3, hope: 4 }, flag: 'avoided',
          text: 'Group chat exposes him in 4 minutes. You are a legend.' }
      ] },
    { id: 'nepa', w: 3, title: 'No light for 4 days',
      text: 'Light don go. IELTS mock test is tomorrow and your power bank is dead.',
      choices: [
        { label: 'Pay ₦25k for a generator and data café', need: { naira: 25000 }, fx: { naira: -25000, ielts: 5 }, text: 'You study in the café. Small stress, small gain.' },
        { label: 'Study by candle and phone torch', fx: { hope: -6, ielts: 2 }, text: 'You push through. Eyes dey pain you.' }
      ] },
    { id: 'family', w: 3, title: 'Family emergency',
      text: 'Mum calls. A relative is in hospital and the bill is ₦200k. Everyone is looking at you.',
      choices: [
        { label: 'Pay the full ₦200k', need: { naira: 200000 }, fx: { naira: -200000, hope: 5 }, text: 'You pay. Your heart is heavy but clean.' },
        { label: 'Send ₦50k and explain', need: { naira: 50000 }, fx: { naira: -50000, hope: -6 }, text: 'They understand, mostly. The guilt stays.' },
        { label: 'Say you will call back', fx: { hope: -14 }, text: 'You avoid the call. It follows you for weeks.' }
      ] },
    { id: 'buddy', w: 3, title: 'Your friend just landed',
      text: 'A friend you used to hustle with posts "Finally in London 🇬🇧". They message you directly.',
      choices: [
        { label: 'Ask for a referral and advice', fx: { network: 12, hope: 4 }, text: 'They connect you to two recruiters and a Telegram group.' },
        { label: 'Mute them for your peace', fx: { hope: -4 }, text: 'Out of sight, out of mind, but not really.' }
      ] },
    { id: 'passport', w: 3, title: 'Passport office wahala',
      text: '"System is down." The officer hints that the queue can move faster for ₦40k.',
      choices: [
        { label: 'Pay the ₦40k "processing"', need: { naira: 40000 }, fx: { naira: -40000, docs: 8 }, text: 'Suddenly the system is working.' },
        { label: 'Wait in the sun like a patriot', fx: { docs: 4, hope: -6 }, text: 'Nine hours later you get one stamp.' }
      ] },
    { id: 'remote', w: 3, title: 'Remote gig appears', when: function (g) { return g.skill >= 40; },
      text: 'A client abroad needs help for two weeks. They pay in dollars and ask for a fast reply.',
      choices: [
        { label: 'Take it (+$150)', fx: { usd: 150, hope: 6, skill: 2, network: 3 }, text: 'Two hard weeks. Dollars in your account. You sleep well.' },
        { label: 'Decline, you are too busy', fx: {}, text: 'You decline. The client moves on.' }
      ] },
    { id: 'salary', w: 2, title: 'Salary delayed',
      text: 'HR says payment will "reflect soon". Your landlord says soon is not a date.',
      choices: [
        { label: 'Borrow ₦80k from a friend', fx: { naira: 80000, hope: -4 }, text: 'You borrow and promise to pay in two weeks. Pride damaged.' },
        { label: 'Manage, and tighten belt', fx: { naira: -30000, hope: -7 }, text: 'Indomie diet begins.' }
      ] },
    { id: 'rate', w: 3, title: 'Dollar scatters',
      text: 'Overnight, the naira loses ground. Your WhatsApp status is full of people crying.',
      choices: [
        { label: 'Buy dollars now with ₦150k', need: { naira: 150000 }, fx: { rate: 0.07 }, buyNow: 150000, text: 'You buy before it climbs again. The rate still jumped.' },
        { label: 'Wait it out', fx: { rate: 0.07 }, text: 'The rate jumps 7%. Your savings buy less dollars.' }
      ] },
    { id: 'rate_down', w: 2, title: 'Naira bounces back',
      text: 'A new policy reaches the market and the naira gains small strength. This could be your window.',
      choices: [
        { label: 'Buy dollars with ₦200k', need: { naira: 200000 }, fx: { rate: -0.05 }, buyNow: 200000, text: 'You buy dollars at a better rate. Wow.' },
        { label: 'Hold your naira', fx: { rate: -0.05 }, text: 'The rate improves 5%. You hold your naira.' }
      ] },
    { id: 'ielts_scam', w: 2, title: 'IELTS "guaranteed 7.0"',
      text: 'A man at the test centre offers a "special arrangement" for ₦150k. Another table sells an official mock for ₦12k.',
      choices: [
        { label: 'Take the special arrangement', need: { naira: 150000 },
          roll: { p: 0.1, win: { fx: { naira: -150000, ielts: 10 }, text: 'Somehow it was a real tutor. You got extra coaching.' },
                  lose: { fx: { naira: -150000, hope: -14 }, flag: 'scams', text: 'He collected the cash and disappeared.' } } },
        { label: 'Buy the official mock for ₦12k', need: { naira: 12000 }, fx: { naira: -12000, ielts: 7 }, text: 'Real practice. Real progress.' }
      ] },
    { id: 'wedding', w: 2, title: 'Aso-ebi demand',
      text: 'Your cousin is getting married. The group admin wants ₦60k for aso-ebi and gift contributions.',
      choices: [
        { label: 'Pay and show up', need: { naira: 60000 }, fx: { naira: -60000, hope: 9, network: 3 }, text: 'Good jollof, good vibes, and you remembered why you love home.' },
        { label: 'Send an apology', fx: { hope: -5 }, text: 'You miss it. Your aunt will mention it for 10 years.' }
      ] },
    { id: 'embassy', w: 2, title: 'New forms, again',
      text: 'The visa portal changes its checklist overnight. A "document specialist" can fix it for ₦50k, or you can DIY.',
      choices: [
        { label: 'Hire the specialist', need: { naira: 50000 }, fx: { naira: -50000, docs: 3 }, text: 'Smooth. Your file is now neat.' },
        { label: 'DIY and suffer', fx: { docs: -6, hope: -4 }, text: 'You lose a page here, a signature there.' }
      ] },
    { id: 'promo', w: 2, title: 'Promotion?', when: function (g) { return g.skill >= 50 && !g.flags.promo; },
      text: 'Your boss mentions a role upgrade. Your salary could rise, but the workload doubles.',
      choices: [
        { label: 'Take the promotion', fx: { salary: 0.15, hope: -3 }, flag: 'promo', text: 'More money, more stress, same bus.' },
        { label: 'Stay focused on japa', fx: { hope: 2 }, text: 'You keep your energy for the plan.' }
      ] },
    { id: 'webinar', w: 2, title: 'Free scholarship webinar',
      text: 'A friend shares a webinar link with real recruiters on the call.',
      choices: [
        { label: 'Attend with your camera on', fx: { network: 9, skill: 2, hope: 3 }, text: 'You ask one smart question and a recruiter remembers you.' },
        { label: 'Watch the recording later', fx: { network: 2 }, text: 'You never watch the recording.' }
      ] },
    { id: 'fee', w: 1, title: 'Visa fees increase',
      text: 'The government announces higher fees. Your target route costs more now.',
      choices: [
        { label: 'Accept it, and stay focused', fx: { hope: -4 }, text: 'You sigh. The goalpost moved again.' }
      ] },
    { id: 'december', w: 0, title: 'Detty December',
      text: 'It is December. Flights, parties, cousins and cold beer are everywhere. Your friends want you to come out.',
      choices: [
        { label: 'Go out and enjoy (₦80k)', need: { naira: 80000 }, fx: { naira: -80000, hope: 18, network: 4 }, text: 'You dance until 5am. Your bank account weeps.' },
        { label: 'Stay in and save', fx: { hope: -5 }, text: 'You stay home. The group chat is lively without you.' }
      ] }
  ];

  function pickEvent(g) {
    if (g.month % 12 === 0) return 'december';
    if (rnd(g) > 0.75) return null;
    var pool = EVENTS.filter(function (e) { return e.w > 0 && e.id !== g.lastEvent && (!e.when || e.when(g)); });
    var total = pool.reduce(function (a, e) { return a + e.w; }, 0), pick = rnd(g) * total, i;
    for (i = 0; i < pool.length; i++) { pick -= pool[i].w; if (pick <= 0) return pool[i].id; }
    return pool[pool.length - 1].id;
  }
  function eventById(id) { return EVENTS.filter(function (e) { return e.id === id; })[0]; }

  function meets(g, c) {
    var k;
    if (c.need) for (k in c.need) if (g[k] < c.need[k]) return false;
    if (c.req) for (k in c.req) if (g[k] < c.req[k]) return false;
    return true;
  }
  function choiceEnabled(g, c) { return meets(g, c); }

  function choose(g, idx) {
    if (!g.event || g.over) return null;
    var ev = eventById(g.event), c = ev.choices[idx];
    if (!c || !meets(g, c)) return null;
    var result = { text: c.text, kind: 'neutral' };
    if (c.roll) {
      var out = rnd(g) < c.roll.p ? c.roll.win : c.roll.lose;
      applyFx(g, out.fx);
      result.text = out.text;
      if (out.flag === 'scams') { g.stats.scams += 1; result.kind = 'bad'; } else result.kind = 'good';
    } else {
      if (c.buyNow) swapToUsd(g, c.buyNow);
      if (c.fx) applyFx(g, c.fx);
      if (c.flag === 'avoided') g.stats.avoided += 1;
      if (c.flag === 'promo') g.flags.promo = true;
    }
    if (ev.id === 'fee') g.feeMult = Math.round(g.feeMult * 110) / 100;
    say(g, result.text);
    g.lastEvent = g.event;
    g.event = null;
    checkBurnout(g);
    return result;
  }

  /* ---------- turn ---------- */
  function checkBurnout(g) {
    if (!g.over && g.hope <= 0) {
      g.over = { kind: 'burnout', month: g.month };
      say(g, 'Hope don finish. You take a break from the whole japa plan.');
    }
  }

  function endMonth(g) {
    if (g.over || g.event) return false;
    var income = Math.round(g.salary * (1 + g.skill / 200));
    g.naira += income - g.living;
    if (g.naira < 0) { g.naira = 0; applyFx(g, { hope: -8 }); say(g, 'Money short. You borrowed from friends and your hope took a hit.'); }
    applyFx(g, { hope: -3 });
    say(g, 'Month ' + g.month + ' ends. Salary ' + fmtN(income) + ', bills ' + fmtN(g.living) + '.');
    if (g.pending && g.month + 1 >= g.pending.due) resolveApplication(g);
    checkBurnout(g);
    if (g.over) return true;

    g.month += 1;
    if (g.month > MAX_MONTHS) {
      g.over = { kind: 'timeout', month: MAX_MONTHS };
      say(g, 'Three years gone. You are still in Naija, wiser and tired.');
      return true;
    }
    g.ap = 2;
    g.lastRate = g.rate;
    g.rate = Math.round(g.rate * (1 + (rnd(g) - 0.35) * 0.05));
    g.living = Math.round(g.living * 1.02);
    g.event = pickEvent(g);
    return true;
  }

  function title(g) {
    var o = g.over;
    if (!o) return '';
    if (o.kind === 'win') {
      if (o.month <= 14) return 'Japa Legend';
      if (o.month <= 24) return 'Japa Pro';
      if (o.month <= 36) return 'Japa Survivor';
      return 'Late but Landed';
    }
    return o.kind === 'burnout' ? 'Japa Casualty' : 'Still in Naija';
  }

  var API = {
    MAX_MONTHS: MAX_MONTHS, JOBS: JOBS, ROUTES: ROUTES, ACTIONS: ACTIONS, EVENTS: EVENTS,
    newGame: newGame, act: act, canAct: canAct, buyUsd: buyUsd, sellUsd: sellUsd,
    apply: apply, canApply: canApply, requirements: requirements, feeOf: feeOf,
    choose: choose, choiceEnabled: choiceEnabled, eventById: eventById, endMonth: endMonth,
    title: title, band: band, fmtN: fmtN, fmtUsd: fmtUsd, rnd: rnd
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.Japa = API;
})(typeof window !== 'undefined' ? window : this);
