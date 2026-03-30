"use strict";

// ============================================================
// LOAD CONFIG — env vars override settings.json for secrets.
// Set BOT_USERNAME, AUTH_PASSWORD, MC_HOST, MC_PORT in your
// hosting dashboard. Never commit real passwords to GitHub.
// ============================================================
const { addLog, getLogs } = require("./logger");
const mineflayer         = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock }      = goals;
const express            = require("express");
const http               = require("http");
const https              = require("https");
const readline           = require("readline");

const config = require("./settings.json");

// Env-var overrides (secrets stay out of git)
config["bot-account"].username = process.env.BOT_USERNAME || config["bot-account"].username;
config["bot-account"].password = process.env.BOT_PASSWORD || config["bot-account"].password || undefined;
config.server.ip   = process.env.MC_HOST || config.server.ip;
config.server.port = Number(process.env.MC_PORT) || config.server.port;
if (config.utils["auto-auth"]) {
  config.utils["auto-auth"].password =
    process.env.AUTH_PASSWORD || config.utils["auto-auth"].password || "";
}
if (config.discord?.webhookUrl) {
  config.discord.webhookUrl = process.env.DISCORD_WEBHOOK || config.discord.webhookUrl;
}

// ============================================================
// STARTUP VALIDATION — crash early with a clear message
// ============================================================
function validateConfig() {
  const errs = [];
  if (!config.server.ip || config.server.ip === "YOUR_SERVER_IP")   errs.push("server.ip is not set");
  if (!config.server.port || config.server.port <= 0)               errs.push("server.port is invalid");
  if (!config["bot-account"].username)                              errs.push("bot-account.username is not set");
  if (errs.length) {
    errs.forEach(e => addLog(`[Config] ERROR: ${e}`));
    addLog("[Config] Fix settings.json or env vars, then restart.");
    process.exit(1);
  }
}

// ============================================================
// EXPRESS SERVER
// ============================================================
const app  = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

let botState = {
  connected:        false,
  lastActivity:     Date.now(),
  reconnectAttempts: 0,
  startTime:        Date.now(),
  errors:           [],
  wasThrottled:     false,
};

// ---- Routes ----

app.get("/",        (req, res) => res.send(dashboardHTML()));
app.get("/tutorial",(req, res) => res.send(tutorialHTML()));
app.get("/logs",    (req, res) => res.send(logsHTML()));
app.get("/ping",    (req, res) => res.send("pong"));

app.get("/health", (req, res) => {
  res.json({
    status:            botState.connected ? "connected" : "disconnected",
    uptime:            Math.floor((Date.now() - botState.startTime) / 1000),
    coords:            bot?.entity ? bot.entity.position : null,
    reconnectAttempts: botState.reconnectAttempts,
    memoryMB:          (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
  });
});

let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });
  botRunning = true;
  createBot();
  addLog("[Control] Bot started");
  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });
  botRunning = false;
  if (bot) { try { bot.end(); } catch (_) {} bot = null; }
  clearAllIntervals();
  addLog("[Control] Bot stopped");
  res.json({ success: true });
});

app.post("/command", (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });
  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help    - Show this help",
      "  /pos     - Bot coordinates",
      "  /status  - Connection status",
      "  /list    - Player list",
      "  /say <m> - Send chat message",
    ];
    lines.forEach(l => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const pos = bot?.entity?.position;
    const msg = pos
      ? `X=${Math.floor(pos.x)}  Y=${Math.floor(pos.y)}  Z=${Math.floor(pos.z)}`
      : "Position unavailable.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (cmd === "/status") {
    const up  = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `${botState.connected ? "Connected" : "Disconnected"} | ${fmtUptime(up)} | Reconnects: ${botState.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (!bot || !botState.connected) {
    const msg = "Bot is not connected — try again in a moment.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (e) {
    addLog(`[Console] Error: ${e.message}`);
    return res.json({ success: false, msg: e.message });
  }
});

// Start HTTP server
const httpServer = app.listen(PORT, "0.0.0.0", () =>
  addLog(`[Server] HTTP server started on port ${httpServer.address().port}`)
);
httpServer.on("error", err => {
  if (err.code === "EADDRINUSE") {
    const fb = PORT + 1;
    addLog(`[Server] Port ${PORT} in use — trying ${fb}`);
    httpServer.listen(fb, "0.0.0.0");
  } else {
    addLog(`[Server] Error: ${err.message}`);
  }
});

// ============================================================
// UTILITIES
// ============================================================
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function escHTML(str) {
  return str.replace(/[&<>"']/g, m =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[m]
  );
}

// ============================================================
// SELF-PING — keeps Render free tier awake
// ============================================================
function startSelfPing() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (!url) {
    addLog("[KeepAlive] No RENDER_EXTERNAL_URL/APP_URL — self-ping disabled");
    return;
  }
  setInterval(() => {
    const proto = url.startsWith("https") ? https : http;
    proto.get(`${url}/ping`, () => {}).on("error", e =>
      addLog(`[KeepAlive] Self-ping failed: ${e.message}`)
    );
  }, 10 * 60 * 1000);
  addLog("[KeepAlive] Self-ping started (every 10 min)");
}

startSelfPing();

// Memory monitor
setInterval(() => {
  addLog(`[Memory] Heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
}, 5 * 60 * 1000);

// ============================================================
// BOT STATE
// ============================================================
let bot               = null;
let activeIntervals   = [];
let reconnectTimer    = null;
let connectionTimer   = null;
let isReconnecting    = false;

function clearTimers() {
  if (reconnectTimer)  { clearTimeout(reconnectTimer);  reconnectTimer  = null; }
  if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
}

function clearAllIntervals() {
  addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function addInterval(cb, ms) {
  const id = setInterval(cb, ms);
  activeIntervals.push(id);
  return id;
}

function pushError(type, msg) {
  botState.errors.push({ type, msg, time: Date.now() });
  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const d = 60000 + Math.floor(Math.random() * 60000);
    addLog(`[Bot] Throttle delay: ${(d/1000).toFixed(0)}s`);
    return d;
  }
  const base = config.utils["auto-reconnect-delay"] || 3000;
  const max  = config.utils["max-reconnect-delay"]  || 120000;
  const d    = Math.min(base * Math.pow(2, botState.reconnectAttempts), max);
  return d + Math.floor(Math.random() * 2000);
}

// ============================================================
// BOT CREATION
// ============================================================
function createBot() {
  if (!botRunning || isReconnecting) return;

  if (bot) {
    clearAllIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (_) {}
    bot = null;
  }

  addLog(`[Bot] Creating bot instance...`);
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    const version = config.server.version && String(config.server.version).trim() !== "" && config.server.version !== false
      ? config.server.version
      : false;

    bot = mineflayer.createBot({
      username:             config["bot-account"].username,
      password:             config["bot-account"].password,
      auth:                 config["bot-account"].type,
      host:                 config.server.ip,
      port:                 config.server.port,
      version,
      hideErrors:           false,
      checkTimeoutInterval: 600000,
    });

    bot.loadPlugin(pathfinder);

    // Aternos can take 90-120s to fully spawn a player
    clearTimers();
    connectionTimer = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout (150s) — retrying");
        try { bot.removeAllListeners(); bot.end(); } catch (_) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;
      clearTimers();
      botState.connected         = true;
      botState.lastActivity      = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting             = false;

      addLog(`[Bot] [+] Spawned! Version: ${bot.version}`);
      sendDiscord(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);

      const mcData     = require("minecraft-data")(bot.version);
      const defMoves   = new Movements(bot, mcData);
      defMoves.allowFreeMotion = false;
      defMoves.canDig          = false;
      defMoves.liquidCost      = 1000;
      defMoves.fallDamageCost  = 1000;

      initModules(bot, mcData, defMoves);

      if (config.server["try-creative"]) {
        setTimeout(() => {
          if (bot && botState.connected) bot.chat("/gamemode creative");
        }, 3000);
      }
    });

    bot.on("kicked", reason => {
      const r = typeof reason === "object" ? JSON.stringify(reason) : reason;
      addLog(`[Bot] Kicked: ${r}`);
      botState.connected = false;
      pushError("kicked", r);
      clearAllIntervals();
      if (/throttl|wait before reconnect|too fast/i.test(String(r))) {
        botState.wasThrottled = true;
        addLog("[Bot] Throttle kick — extended delay will apply");
      }
      sendDiscord(`[!] **Kicked**: ${r}`, 0xff0000);
      // 'end' fires right after and triggers reconnect
    });

    bot.on("end", reason => {
      addLog(`[Bot] Disconnected: ${reason || "unknown"}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;
      sendDiscord(`[-] **Disconnected**: ${reason || "unknown"}`, 0xf87171);
      scheduleReconnect();
    });

    bot.on("error", err => {
      addLog(`[Bot] Error: ${err.message}`);
      pushError("error", err.message);
      // 'end' handles reconnect after this
    });

  } catch (err) {
    addLog(`[Bot] Failed to create: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!botRunning) return;
  clearTimers();
  if (isReconnecting) {
    addLog("[Bot] Reconnect already scheduled.");
    return;
  }
  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${(delay/1000).toFixed(1)}s (attempt #${botState.reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initModules(bot, mcData, defMoves) {
  addLog("[Modules] Initializing...");
  const cfg = config;

  // Auto-auth
  if (cfg.utils["auto-auth"]?.enabled) {
    const pw = cfg.utils["auto-auth"].password;
    if (!pw) {
      addLog("[Auth] WARNING: auto-auth enabled but password is empty");
    } else {
      let done = false;
      const tryAuth = type => {
        if (done || !botState.connected) return;
        done = true;
        if (type === "register") {
          bot.chat(`/register ${pw} ${pw}`);
          addLog("[Auth] Sent /register");
        } else {
          bot.chat(`/login ${pw}`);
          addLog("[Auth] Sent /login");
        }
      };
      bot.on("messagestr", msg => {
        if (done) return;
        const m = msg.toLowerCase();
        if (m.includes("/register") || m.includes("register ")) tryAuth("register");
        else if (m.includes("/login") || m.includes("login "))   tryAuth("login");
      });
      // Failsafe: if no prompt in 10s, send /login anyway
      setTimeout(() => {
        if (!done && bot && botState.connected) {
          addLog("[Auth] No prompt after 10s — /login failsafe");
          bot.chat(`/login ${pw}`);
          done = true;
        }
      }, 10000);
    }
  }

  // Chat messages
  if (cfg.utils["chat-messages"]?.enabled) {
    const msgs  = cfg.utils["chat-messages"].messages || [];
    const delay = (cfg.utils["chat-messages"]["repeat-delay"] || 120) * 1000;
    if (msgs.length && cfg.utils["chat-messages"].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(msgs[i]);
          i = (i + 1) % msgs.length;
          botState.lastActivity = Date.now();
        }
      }, delay);
    }
  }

  // Navigate to fixed position (disabled if circle-walk is on — they conflict)
  const circleOn = cfg.movement?.["circle-walk"]?.enabled;
  if (cfg.position?.enabled && !circleOn) {
    bot.pathfinder.setMovements(defMoves);
    bot.pathfinder.setGoal(new GoalBlock(cfg.position.x, cfg.position.y, cfg.position.z));
    addLog("[Position] Navigating to configured position...");
  }

  // Anti-AFK actions
  if (cfg.utils["anti-afk"]?.enabled) {
    // Swing arm
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try { bot.swingArm(); } catch (_) {}
    }, 10000 + Math.floor(Math.random() * 50000));

    // Hotbar slot
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (_) {}
    }, 30000 + Math.floor(Math.random() * 90000));

    // Teabag (sneak bursts, 10% chance each tick)
    addInterval(() => {
      if (!bot || !botState.connected || Math.random() > 0.9) return;
      let n = 2 + Math.floor(Math.random() * 4);
      const tb = () => {
        if (--n < 0 || !bot) return;
        try {
          bot.setControlState("sneak", true);
          setTimeout(() => { if (bot) bot.setControlState("sneak", false); setTimeout(tb, 150); }, 150);
        } catch (_) {}
      };
      tb();
    }, 120000 + Math.floor(Math.random() * 180000));

    // Micro-walk (only when circle-walk isn't handling movement)
    if (!circleOn) {
      addInterval(() => {
        if (!bot || !botState.connected) return;
        try {
          bot.look(Math.random() * Math.PI * 2, 0, true);
          bot.setControlState("forward", true);
          setTimeout(() => { if (bot) bot.setControlState("forward", false); },
            500 + Math.floor(Math.random() * 1500));
          botState.lastActivity = Date.now();
        } catch (e) { addLog(`[AntiAFK] ${e.message}`); }
      }, 120000 + Math.floor(Math.random() * 360000));
    }

    if (cfg.utils["anti-afk"].sneak) {
      try { bot.setControlState("sneak", true); } catch (_) {}
    }
  }

  // Movement modules
  if (cfg.movement?.enabled !== false) {
    if (circleOn)                                               startCircleWalk(bot, defMoves);
    if (cfg.movement?.["random-jump"]?.enabled && !circleOn)   startRandomJump(bot);
    if (cfg.movement?.["look-around"]?.enabled)                startLookAround(bot);
  }

  // Optional modules
  if (cfg.modules.avoidMobs && !cfg.modules.combat) modAvoidMobs(bot);
  if (cfg.modules.combat)                           modCombat(bot, mcData);
  if (cfg.modules.beds)                             modBeds(bot);
  if (cfg.modules.chat)                             modChat(bot);

  addLog("[Modules] All initialized!");
}

// ============================================================
// MOVEMENT
// ============================================================
function startCircleWalk(bot, defMoves) {
  const { radius, speed } = config.movement["circle-walk"];
  let angle = 0, lastPath = 0;
  addInterval(() => {
    if (!bot || !botState.connected) return;
    const now = Date.now();
    if (now - lastPath < 2000) return;
    lastPath = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(defMoves);
      bot.pathfinder.setGoal(new GoalBlock(
        Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)
      ));
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) { addLog(`[CircleWalk] ${e.message}`); }
  }, speed);
}

function startRandomJump(bot) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      bot.setControlState("jump", true);
      setTimeout(() => { if (bot) bot.setControlState("jump", false); }, 300);
      botState.lastActivity = Date.now();
    } catch (e) { addLog(`[Jump] ${e.message}`); }
  }, config.movement["random-jump"].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      bot.look(
        Math.random() * Math.PI * 2 - Math.PI,
        (Math.random() * Math.PI) / 2 - Math.PI / 4,
        false
      );
      botState.lastActivity = Date.now();
    } catch (e) { addLog(`[Look] ${e.message}`); }
  }, config.movement["look-around"].interval);
}

// ============================================================
// OPTIONAL MODULES
// ============================================================
function modAvoidMobs(bot) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      const close = Object.values(bot.entities).find(e =>
        (e.type === "mob" || (e.type === "player" && e.username !== bot.username)) &&
        e.position && bot.entity.position.distanceTo(e.position) < 5
      );
      if (close) {
        bot.setControlState("back", true);
        setTimeout(() => { if (bot) bot.setControlState("back", false); }, 500);
      }
    } catch (e) { addLog(`[AvoidMobs] ${e.message}`); }
  }, 2000);
}

function modCombat(bot, mcData) {
  let lastSwing = 0, target = null, targetExp = 0;
  bot.on("physicsTick", () => {
    if (!bot || !botState.connected || !config.combat["attack-mobs"]) return;
    const now = Date.now();
    if (now - lastSwing < 620) return;
    try {
      if (target && now < targetExp && bot.entities[target.id]?.position) {
        if (bot.entity.position.distanceTo(target.position) < 4) {
          bot.attack(target); lastSwing = now; return;
        }
        target = null;
      }
      const mob = Object.values(bot.entities).find(e =>
        e.type === "mob" && e.position && bot.entity.position.distanceTo(e.position) < 4
      );
      if (mob) { target = mob; targetExp = now + 3000; bot.attack(mob); lastSwing = now; }
    } catch (e) { addLog(`[Combat] ${e.message}`); }
  });

  bot.on("health", () => {
    if (!config.combat["auto-eat"] || bot.food >= 14) return;
    try {
      const food = bot.inventory.items().find(i => i.foodPoints > 0);
      if (food) bot.equip(food, "hand").then(() => bot.consume()).catch(e => addLog(`[AutoEat] ${e.message}`));
    } catch (e) { addLog(`[AutoEat] ${e.message}`); }
  });
}

function modBeds(bot) {
  let sleeping = false;
  addInterval(async () => {
    if (!bot || !botState.connected || !config.beds["place-night"] || sleeping) return;
    try {
      if (bot.time.timeOfDay < 12500 || bot.time.timeOfDay > 23500) return;
      const bed = bot.findBlock({ matching: b => b.name.includes("bed"), maxDistance: 8 });
      if (!bed) return;
      sleeping = true;
      try { await bot.sleep(bed); addLog("[Bed] Sleeping..."); }
      catch (_) {}
      finally { sleeping = false; }
    } catch (e) { sleeping = false; addLog(`[Bed] ${e.message}`); }
  }, 10000);
}

function modChat(bot) {
  bot.on("chat", (username, message) => {
    if (!bot || username === bot.username) return;
    try {
      if (config.discord?.events?.chat) sendDiscord(`💬 **${username}**: ${message}`, 0x7289da);
      if (!config.chat?.respond) return;
      const m = message.toLowerCase();
      if (m.includes("hello") || m.includes("hi")) bot.chat(`Hey ${username}!`);
      if (message.startsWith("!tp ")) {
        const t = message.split(" ")[1];
        if (t) bot.chat(`/tp ${t}`);
      }
    } catch (e) { addLog(`[Chat] ${e.message}`); }
  });
}

// ============================================================
// DISCORD WEBHOOK
// ============================================================
let lastDiscord = 0;
function sendDiscord(content, color = 0x0099ff) {
  if (!config.discord?.enabled || !config.discord?.webhookUrl ||
      config.discord.webhookUrl.includes("YOUR_DISCORD")) return;
  if (!(config.discord.events?.connect || config.discord.events?.disconnect)) return;
  const now = Date.now();
  if (now - lastDiscord < 5000) return;
  lastDiscord = now;

  const payload = JSON.stringify({
    username: config.name,
    embeds: [{ description: content, color, timestamp: new Date().toISOString(), footer: { text: "AFK Bot" } }],
  });
  try {
    const u     = new URL(config.discord.webhookUrl);
    const proto = config.discord.webhookUrl.startsWith("https") ? https : http;
    const req   = proto.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload, "utf8") },
    });
    req.on("error", e => addLog(`[Discord] ${e.message}`));
    req.write(payload);
    req.end();
  } catch (e) { addLog(`[Discord] ${e.message}`); }
}

// ============================================================
// STDIN CONSOLE
// ============================================================
readline.createInterface({ input: process.stdin, terminal: false })
  .on("line", line => {
    const cmd = line.trim();
    if (!bot || !botState.connected) { addLog("[Console] Bot not connected"); return; }
    try {
      if (cmd.startsWith("say "))    bot.chat(cmd.slice(4));
      else if (cmd.startsWith("cmd ")) bot.chat("/" + cmd.slice(4));
      else if (cmd === "status")      addLog(`Up: ${fmtUptime(Math.floor((Date.now() - botState.startTime) / 1000))} | Reconnects: ${botState.reconnectAttempts}`);
      else                            bot.chat(cmd);
    } catch (e) { addLog(`[Console] ${e.message}`); }
  });

// ============================================================
// CRASH RECOVERY
// ============================================================
const NETWORK_RE = /PartialReadError|ECONNRESET|EPIPE|ETIMEDOUT|write after end|socket has been ended/i;

process.on("uncaughtException", err => {
  addLog(`[FATAL] Uncaught: ${err.message}`);
  pushError("uncaught", err.message);
  clearAllIntervals();
  botState.connected = false;
  if (isReconnecting) {
    isReconnecting = false;
    clearTimers();
  }
  setTimeout(() => scheduleReconnect(), NETWORK_RE.test(err.message) ? 5000 : 10000);
});

process.on("unhandledRejection", reason => {
  const msg = String(reason);
  addLog(`[FATAL] Unhandled rejection: ${msg}`);
  pushError("rejection", msg);
  if (NETWORK_RE.test(msg) && !isReconnecting) {
    clearAllIntervals();
    botState.connected = false;
    if (bot) { try { bot.end(); } catch (_) {} bot = null; }
    scheduleReconnect();
  }
});

// Graceful shutdown — Render sends SIGTERM before killing the process
process.on("SIGTERM", () => {
  addLog("[System] SIGTERM — shutting down gracefully");
  if (bot) { try { bot.end(); } catch (_) {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

process.on("SIGINT", () => {
  addLog("[System] SIGINT — stopping");
  if (bot) { try { bot.end(); } catch (_) {} }
  process.exit(0);
});

// ============================================================
// HTML TEMPLATES (kept in index.js for single-file deploy)
// ============================================================
const GFONT = `<link rel="stylesheet" media="print" onload="this.media='all'" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">`;
const CSS = `
*,*::before,*::after{box-sizing:border-box}
body{font-family:'Inter',-apple-system,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:40px 24px}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.back{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500;color:#8b949e;background:#161b22;border:1px solid #21262d;border-radius:8px;padding:7px 14px;margin-bottom:32px;transition:background .2s,color .2s}
.back:hover{background:#21262d;color:#c9d1d9}
h1{font-size:26px;font-weight:700;color:#f0f6fc;margin:0}
.sub{font-size:14px;color:#8b949e;margin:6px 0 0}
`;

function dashboardHTML() {
  return `<!DOCTYPE html><html lang="en">
<head><title>${config.name} Dashboard</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${GFONT}
<style>${CSS}
body{display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px}
main{width:100%;max-width:400px}header{margin-bottom:28px}
.sb{border-radius:12px;padding:20px 24px;margin-bottom:16px;display:flex;align-items:center;gap:16px;transition:background .3s,border-color .3s}
.sb.on{background:#0d2218;border:2px solid #238636}.sb.off{background:#200d0d;border:2px solid #da3633}
.si{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.si.on{background:#238636}.si.off{background:#da3633}
.sl{font-size:18px;font-weight:700}.sl.on{color:#3fb950}.sl.off{color:#f85149}
.sd{font-size:13px;color:#8b949e;margin-top:3px}
.card{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:16px 20px;margin-bottom:10px}
dt{font-size:12px;color:#8b949e;font-weight:600;margin-bottom:4px}dd{margin:0;font-size:17px;font-weight:600;color:#e6edf3}
.note{margin:4px 0 0;font-size:11px;color:#6e7681}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.btn{min-height:44px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;transition:filter .2s}.btn:hover{filter:brightness(1.1)}
.btn.go{border:2px solid #238636;background:#0d2218;color:#3fb950}.btn.st{border:2px solid #da3633;background:#200d0d;color:#f85149}
.lnk{min-height:44px;border-radius:10px;border:1px solid #21262d;background:#161b22;color:#8b949e;font-size:13px;display:flex;align-items:center;justify-content:center;transition:background .2s,color .2s}
.lnk:hover{background:#21262d;color:#c9d1d9;text-decoration:none}
footer{margin-top:20px;text-align:center}footer p{font-size:12px;color:#484f58;margin:0}
</style></head>
<body><main>
<header><h1>AFK Bot Dashboard</h1><p class="sub">Minecraft server bot · Live status</p></header>
<div id="sb" class="sb off"><div id="si" class="si off">✗</div><div><div id="sl" class="sl off">Connecting…</div><div id="sd" class="sd">Establishing connection</div></div></div>
<dl>
  <div class="card"><dt>Uptime</dt><dd id="up">—</dd><p class="note">Since last connection</p></div>
  <div class="card"><dt>Coordinates</dt><dd id="xy">Searching…</dd><p class="note">Bot's in-game position</p></div>
  <div class="card"><dt>Server</dt><dd>${config.server.ip}</dd><p class="note">Minecraft hostname</p></div>
</dl>
<div class="g2">
  <button class="btn go" onclick="ctrl('/start')">Start</button>
  <button class="btn st" onclick="ctrl('/stop')">Stop</button>
</div>
<div class="g2">
  <a href="/tutorial" class="lnk">Setup guide</a>
  <a href="/logs" class="lnk">View logs</a>
</div>
<footer><p>Updates every 5 seconds</p></footer>
</main>
<script>
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return h?h+'h '+m+'m '+sec+'s':m?m+'m '+sec+'s':sec+'s';}
async function tick(){
  try{const d=await fetch('/health').then(r=>r.json()),on=d.status==='connected';
  document.getElementById('sb').className='sb '+(on?'on':'off');
  document.getElementById('si').className='si '+(on?'on':'off');
  document.getElementById('si').textContent=on?'✓':'✗';
  document.getElementById('sl').className='sl '+(on?'on':'off');
  document.getElementById('sl').textContent=on?'Connected':'Disconnected';
  document.getElementById('sd').textContent=on?'Bot is active':'Attempting to reconnect';
  document.getElementById('up').textContent=fmt(d.uptime);
  if(d.coords){const p=d.coords;document.getElementById('xy').textContent='X '+Math.floor(p.x)+' Y '+Math.floor(p.y)+' Z '+Math.floor(p.z);}
  }catch(e){document.getElementById('sl').textContent='Unreachable';}
}
async function ctrl(url){const d=await fetch(url,{method:'POST'}).then(r=>r.json());alert(d.success?'Done!':d.msg);tick();}
setInterval(tick,5000);tick();
</script></body></html>`;
}

function tutorialHTML() {
  return `<!DOCTYPE html><html lang="en">
<head><title>Setup Guide</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${GFONT}
<style>${CSS}
main{max-width:560px;margin:0 auto}header{margin-bottom:32px}
.card{background:#161b22;border:1px solid #21262d;border-radius:12px;padding:24px;margin-bottom:16px}
.ch{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.num{width:32px;height:32px;border-radius:50%;background:#0d2218;border:2px solid #238636;color:#3fb950;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
h2{font-size:16px;font-weight:700;color:#f0f6fc;margin:0}
ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
li{font-size:14px;color:#8b949e;line-height:1.6;padding-left:20px;position:relative}
li::before{content:"·";position:absolute;left:6px;color:#3fb950;font-weight:700}
li strong{color:#e6edf3}code{background:#21262d;border:1px solid #30363d;padding:2px 7px;border-radius:5px;font-size:12px;font-family:monospace}
footer{margin-top:32px;text-align:center}footer p{font-size:12px;color:#484f58}
</style></head>
<body><main>
<a href="/" class="back">← Back</a>
<header><h1>Setup Guide</h1><p class="sub">Get running in under 15 minutes</p></header>
<div class="card"><div class="ch"><div class="num">1</div><h2>Configure Aternos</h2></div>
<ul>
  <li>Go to <strong>Aternos → Options</strong></li>
  <li>Set <strong>online-mode</strong> → <strong>false</strong> (cracked/offline mode)</li>
  <li>Enable <strong>whitelist</strong> and add your bot's username</li>
  <li>If your server version mismatches, install <code>ViaVersion</code></li>
</ul></div>
<div class="card"><div class="ch"><div class="num">2</div><h2>Set credentials via env vars</h2></div>
<ul>
  <li>Set <code>MC_HOST</code> and <code>MC_PORT</code> for your server</li>
  <li>Set <code>BOT_USERNAME</code> to any offline username</li>
  <li>Set <code>AUTH_PASSWORD</code> if using auto-auth plugin</li>
  <li><strong>Never commit passwords to a public GitHub repo</strong></li>
</ul></div>
<div class="card"><div class="ch"><div class="num">3</div><h2>Deploy free on Fly.io (recommended)</h2></div>
<ul>
  <li>Install <code>flyctl</code>, run <code>fly launch</code> in project folder</li>
  <li>Set secrets: <code>fly secrets set AUTH_PASSWORD=xxx</code></li>
  <li>Deploy: <code>fly deploy</code></li>
  <li>Free tier: 256MB RAM VMs, no sleep, no time limits</li>
</ul></div>
<div class="card"><div class="ch"><div class="num">4</div><h2>Or deploy on Render (alternative)</h2></div>
<ul>
  <li>Connect GitHub repo → New Web Service → set env vars in dashboard</li>
  <li>Set <code>RENDER_EXTERNAL_URL</code> to your Render service URL</li>
  <li>Self-ping keeps it awake every 10 min</li>
  <li>Free tier: 750 hrs/month — just enough for 24/7 single service</li>
</ul></div>
<footer><p>AFK Bot · ${config.name}</p></footer>
</main></body></html>`;
}

function logsHTML() {
  const logs  = getLogs();
  const items = logs.length === 0
    ? `<div style="text-align:center;padding:40px;color:#484f58;font-size:13px">No logs yet.</div>`
    : logs.map(l => {
        const e = escHTML(l), lo = l.toLowerCase();
        let c = "df";
        if (/error|fail|fatal/.test(lo))          c = "er";
        else if (lo.includes("warn"))             c = "wa";
        else if (/\[control\]|\[console\]/.test(lo)) c = "ct";
        else if (/spawn|connect|\[\+\]/.test(lo)) c = "ok";
        return `<span class="le ${c}">${e}</span>`;
      }).join("");

  return `<!DOCTYPE html><html lang="en">
<head><title>${config.name} - Logs</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${GFONT}
<style>${CSS}
main{max-width:760px;margin:0 auto}
.ph{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px}
.badge{font-size:12px;font-weight:600;color:#8b949e;background:#161b22;border:1px solid #21262d;border-radius:20px;padding:4px 12px}
.lc{background:#0d1117;border:1px solid #21262d;border-radius:12px;overflow:hidden}
.lh{background:#161b22;border-bottom:1px solid #21262d;padding:12px 18px;display:flex;align-items:center;gap:8px}
.d{width:10px;height:10px;border-radius:50%}.dr{background:#ff5f57}.dy{background:#ffbd2e}.dg{background:#28c840}
.lt{font-size:12px;color:#484f58;margin-left:4px}
.lb{padding:16px 18px;max-height:560px;overflow-y:auto;font-family:'SF Mono','Fira Code',monospace;font-size:12.5px;line-height:1.7}
.le{display:block;padding:1px 0;white-space:pre-wrap;word-break:break-all}
.er{color:#ff7b72}.wa{color:#e3b341}.ok{color:#3fb950}.ct{color:#58a6ff}.df{color:#8b949e}
.cw{position:relative}
.sg{display:none;position:absolute;bottom:calc(100% + 6px);left:0;right:0;background:#161b22;border:1px solid #30363d;border-radius:10px;overflow:hidden;z-index:10}
.sg.show{display:block}
.si2{display:flex;align-items:baseline;gap:12px;padding:9px 16px;cursor:pointer;border-bottom:1px solid #21262d;transition:background .12s}
.si2:last-child{border:none}.si2:hover,.si2.act{background:#21262d}
.sn{font-family:monospace;font-size:12.5px;font-weight:700;color:#3fb950;min-width:90px;flex-shrink:0}
.sd2{font-size:12px;color:#6e7681}
.cr{display:flex;align-items:center;border-top:1px solid #21262d;background:#0d1117;padding:10px 18px;gap:10px}
.pr{font-family:monospace;font-size:13px;color:#3fb950;font-weight:700;flex-shrink:0;user-select:none}
.ci{flex:1;background:transparent;border:none;outline:none;font-family:monospace;font-size:12.5px;color:#e6edf3;caret-color:#3fb950}
.ci::placeholder{color:#484f58}
.cs{background:#0d2218;border:1px solid #238636;color:#3fb950;font-size:12px;font-weight:600;padding:5px 14px;border-radius:6px;cursor:pointer;font-family:inherit}
.cs:hover{background:#122d1a}.cs:disabled{opacity:.5;cursor:default}
.rf{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:12px;font-size:12px;color:#484f58}
.pulse{width:7px;height:7px;border-radius:50%;background:#3fb950;animation:p 2s infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
footer{margin-top:32px;text-align:center}footer p{font-size:12px;color:#484f58}
</style></head>
<body><main>
<a href="/" class="back">← Back to Dashboard</a>
<div class="ph"><div><h1>Bot Logs</h1><p class="sub">Live output</p></div><span class="badge">${logs.length} ${logs.length===1?"entry":"entries"}</span></div>
<div class="lc">
  <div class="lh"><span class="d dr"></span><span class="d dy"></span><span class="d dg"></span><span class="lt">bot.log</span></div>
  <div class="lb" id="lb">${items}</div>
  <div class="cw">
    <div class="sg" id="sg"></div>
    <div class="cr">
      <span class="pr">&gt;</span>
      <input id="ci" class="ci" type="text" placeholder="/ for commands or any message…" autocomplete="off" spellcheck="false">
      <button id="cs" class="cs">Send</button>
    </div>
  </div>
</div>
<div class="rf"><span class="pulse"></span><span id="rl">Auto-refreshing every 5 seconds</span></div>
<footer><p>AFK Bot · ${config.name}</p></footer>
</main>
<script>
(function(){
var lb=document.getElementById('lb'),ci=document.getElementById('ci'),cs=document.getElementById('cs'),rl=document.getElementById('rl'),sg=document.getElementById('sg');
var CMDS=[{n:'/help',d:'Show commands'},{n:'/pos',d:'Bot coordinates'},{n:'/status',d:'Status & uptime'},{n:'/list',d:'Player list'},{n:'/say',d:'Send chat'}];
var typing=false,rt=null,ai=-1;
function sb(){lb.scrollTop=lb.scrollHeight}
function sched(){if(!typing)rt=setTimeout(()=>location.reload(),5000)}
function add(t,c){var s=document.createElement('span');s.className='le '+(c||'ct');s.textContent=t;lb.appendChild(s);sb()}
function hide(){sg.classList.remove('show');sg.innerHTML='';ai=-1}
function show(v){
  var m=CMDS.filter(c=>c.n.startsWith(v.toLowerCase()));
  if(!m.length){hide();return}
  sg.innerHTML=m.map(c=>'<div class="si2" data-c="'+c.n+'"><span class="sn">'+c.n+'</span><span class="sd2">'+c.d+'</span></div>').join('');
  sg.querySelectorAll('.si2').forEach(el=>el.addEventListener('mousedown',e=>{e.preventDefault();ci.value=el.dataset.c+' ';hide();ci.focus()}));
  ai=-1;sg.classList.add('show');
}
ci.addEventListener('input',()=>{ci.value.startsWith('/')?show(ci.value):hide()});
ci.addEventListener('keydown',function(e){
  var it=sg.querySelectorAll('.si2');
  if(sg.classList.contains('show')&&it.length){
    if(e.key==='ArrowDown'){e.preventDefault();ai=Math.min(ai+1,it.length-1);it.forEach((el,i)=>el.classList.toggle('act',i===ai));return}
    if(e.key==='ArrowUp'){e.preventDefault();ai=Math.max(ai-1,0);it.forEach((el,i)=>el.classList.toggle('act',i===ai));return}
    if(e.key==='Tab'||(e.key==='Enter'&&ai>=0)){e.preventDefault();ci.value=it[Math.max(ai,0)].dataset.c+' ';hide();return}
    if(e.key==='Escape'){hide();return}
  }
  if(e.key==='Enter')send();
});
function send(){
  var cmd=ci.value.trim();if(!cmd)return;
  hide();ci.value='';cs.disabled=true;add('> '+cmd,'ct');
  fetch('/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:cmd})})
  .then(r=>r.json()).then(d=>{if(d.msg)d.msg.split('\\n').forEach(l=>add(l,d.success?'df':'er'))})
  .catch(()=>add('Failed.','er'))
  .finally(()=>{cs.disabled=false;ci.focus();sched()});
}
cs.addEventListener('click',send);
ci.addEventListener('focus',()=>{typing=true;clearTimeout(rt);rl.textContent='Auto-refresh paused while typing'});
ci.addEventListener('blur',()=>setTimeout(()=>{hide();typing=false;rl.textContent='Auto-refreshing every 5 seconds';sched()},150));
sb();sched();
})();
</script></body></html>`;
}

// ============================================================
// START
// ============================================================
addLog("=".repeat(50));
addLog("  Minecraft AFK Bot v2.6");
addLog("=".repeat(50));
addLog(`Server:  ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version || "auto-detect"}`);
addLog(`Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled"}`);
addLog("=".repeat(50));

validateConfig();
createBot();
