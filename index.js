const http = require('http');
const https = require('https');

let SteamUser = null;
let steamTotp = null;

try {
  SteamUser = require('steam-user');
  steamTotp = require('steam-totp');
} catch (error) {
  console.warn('Steam packages are not installed. Dashboard will run in preview mode.');
}

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DEFAULT_GAMES = [730, 440, 570, 10, 1172470];
const PERSONA = {
  online: 1,
  invisible: 7
};

const gameCatalog = new Map([
  [730, 'Counter-Strike 2'],
  [440, 'Team Fortress 2'],
  [570, 'Dota 2'],
  [10, 'Counter-Strike'],
  [1172470, 'Apex Legends']
]);

const state = {
  startedAt: Date.now(),
  accounts: loadAccounts(),
  dependenciesReady: Boolean(SteamUser && steamTotp)
};

function loadAccounts() {
  if (process.env.ACCOUNTS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ACCOUNTS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((account, index) => createAccount(account, index));
      }
    } catch (error) {
      console.warn('ACCOUNTS_JSON is not valid JSON:', error.message);
    }
  }

  const accounts = [];
  let index = 1;

  while (process.env[`username${index === 1 ? '' : index}`]) {
    const suffix = index === 1 ? '' : index;
    accounts.push(createAccount({
      username: process.env[`username${suffix}`],
      password: process.env[`password${suffix}`],
      shared: process.env[`shared${suffix}`],
      games: readGameList(process.env[`games${suffix}`]),
      persona: process.env[`persona${suffix}`]
    }, index - 1));
    index += 1;
  }

  if (accounts.length > 0) return accounts;

  return [
    createAccount({ username: 'DemoAccount1', games: DEFAULT_GAMES }, 0),
    createAccount({ username: 'DemoAccount2', games: DEFAULT_GAMES }, 1)
  ];
}

function createAccount(account, index) {
  const games = Array.isArray(account.games) && account.games.length > 0
    ? account.games.map(Number).filter(Number.isFinite)
    : DEFAULT_GAMES;

  games.forEach((appId) => {
    if (account.gameNames && account.gameNames[appId]) {
      gameCatalog.set(appId, account.gameNames[appId]);
    }
  });

  return {
    id: String(index + 1),
    label: account.label || account.username || `Account ${index + 1}`,
    username: account.username,
    password: account.password,
    shared: account.shared,
    persona: normalizePersona(account.persona),
    games,
    connected: false,
    status: 'Waiting',
    error: null,
    startedAt: null,
    lastLoginAt: null,
    lastUpdateAt: Date.now(),
    steamGuard: null,
    client: null
  };
}

function readGameList(value) {
  if (!value) return null;
  return String(value)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter(Number.isFinite);
}

function normalizePersona(value) {
  if (Number(value) === PERSONA.invisible || String(value).toLowerCase() === 'invisible') {
    return PERSONA.invisible;
  }

  return PERSONA.online;
}

function startSteamClients() {
  state.accounts.forEach(startSteamClient);
}

function startSteamClient(account) {
  if (!state.dependenciesReady) {
    account.status = 'Preview mode';
    account.error = 'Run npm install before starting real Steam sessions.';
    account.lastUpdateAt = Date.now();
    return;
  }

  if (!account.username || !account.password) {
    account.status = 'Missing credentials';
    account.error = 'Set username/password/shared environment variables or log in from the dashboard.';
    account.lastUpdateAt = Date.now();
    return;
  }

  if (account.client) {
    account.client.logOff();
    account.client.removeAllListeners();
  }

  const client = new SteamUser();
  account.client = client;
  account.connected = false;
  account.steamGuard = null;
  account.status = 'Connecting';
  account.error = null;
  account.startedAt = Date.now();
  account.lastUpdateAt = Date.now();

  client.on('debug', (message) => {
    console.log(`${account.label} debug: ${message}`);
  });

  client.on('steamGuard', (domain, callback, lastCodeWrong) => {
    account.connected = false;
    account.steamGuard = {
      domain,
      callback,
      lastCodeWrong: Boolean(lastCodeWrong),
      requestedAt: Date.now()
    };
    account.status = domain ? 'Steam Guard email required' : 'Steam Guard app code required';
    account.error = lastCodeWrong
      ? 'The last Steam Guard code was rejected. Wait for a fresh code and submit it again.'
      : domain
        ? `Enter the Steam Guard code sent to your email ending in ${domain}.`
        : 'Enter the current Steam Guard code from your mobile authenticator.';
    account.lastUpdateAt = Date.now();
  });

  client.on('loggedOn', () => {
    account.connected = true;
    account.steamGuard = null;
    account.status = 'Online';
    account.error = null;
    account.lastLoginAt = Date.now();
    account.lastUpdateAt = Date.now();
    client.setPersona(account.persona);
    client.gamesPlayed(account.games);
    console.log(`${account.label} logged on and idling ${account.games.length} games.`);
  });

  client.on('error', (error) => {
    account.connected = false;
    account.steamGuard = null;
    account.status = 'Error';
    account.error = error.message || String(error);
    account.lastUpdateAt = Date.now();
    console.error(`${account.label}:`, account.error);
  });

  client.on('disconnected', (eresult, msg) => {
    account.connected = false;
    account.status = 'Disconnected';
    account.error = msg || `Disconnected (${eresult})`;
    account.lastUpdateAt = Date.now();
  });

  try {
    client.logOn({
      accountName: account.username,
      password: account.password,
      twoFactorCode: account.shared ? steamTotp.generateAuthCode(account.shared) : undefined
    });
  } catch (error) {
    account.connected = false;
    account.status = 'Login setup error';
    account.error = error.message || String(error);
    account.lastUpdateAt = Date.now();
  }
}

function nextAccountIndex() {
  return state.accounts.reduce((max, account) => {
    return Math.max(max, Number(account.id) || 0);
  }, 0);
}

function submitSteamGuardCode(account, code) {
  if (!account.steamGuard || typeof account.steamGuard.callback !== 'function') {
    throw new Error('Steam Guard code is not requested for this account right now.');
  }

  const callback = account.steamGuard.callback;
  account.steamGuard = null;
  account.status = 'Connecting';
  account.error = 'Steam Guard code submitted. Waiting for Steam.';
  account.lastUpdateAt = Date.now();
  callback(code);
}

function updateAccountGames(account, games) {
  account.games = games;
  account.lastUpdateAt = Date.now();

  if (account.client && account.connected) {
    account.client.gamesPlayed(account.games);
  }
}

function publicAccount(account) {
  const now = Date.now();

  return {
    id: account.id,
    label: account.label,
    connected: account.connected,
    status: account.status,
    error: account.error,
    persona: account.persona === PERSONA.invisible ? 'Invisible' : 'Online',
    steamGuardRequired: Boolean(account.steamGuard),
    steamGuardType: account.steamGuard
      ? account.steamGuard.domain ? 'email' : 'app'
      : null,
    steamGuardDomain: account.steamGuard ? account.steamGuard.domain : null,
    steamGuardLastCodeWrong: account.steamGuard ? account.steamGuard.lastCodeWrong : false,
    games: account.games.map((appId) => ({
      appId,
      name: gameCatalog.get(appId) || `App ${appId}`
    })),
    totalIdleSeconds: account.lastLoginAt ? Math.floor((now - account.lastLoginAt) / 1000) : 0,
    sessionSeconds: account.startedAt ? Math.floor((now - account.startedAt) / 1000) : 0,
    lastUpdateAt: account.lastUpdateAt
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHtml(res) {
  const body = renderPage();
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body is too large.'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'user-agent': 'steam-hourse-dashboard/1.0' },
      timeout: 8000
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('Steam search timed out.')));
    request.on('error', reject);
  });
}

async function searchSteam(term) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
  const data = await requestJson(url);

  return (data.items || []).slice(0, 8).map((item) => {
    gameCatalog.set(Number(item.id), item.name);
    return {
      appId: Number(item.id),
      name: item.name,
      image: item.tiny_image || null
    };
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!isAuthorized(req)) {
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': 'Basic realm="Steam Idler Dashboard"'
    });
    res.end('Authentication required.');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      ready: state.dependenciesReady,
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000)
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, {
      ready: state.dependenciesReady,
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
      accounts: state.accounts.map(publicAccount)
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const term = (url.searchParams.get('q') || '').trim();
    if (term.length < 2) {
      sendJson(res, 200, { results: [] });
      return;
    }

    try {
      sendJson(res, 200, { results: await searchSteam(term) });
    } catch (error) {
      sendJson(res, 502, { error: error.message || 'Steam search failed.' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/accounts') {
    try {
      const body = JSON.parse(await readBody(req));
      const username = String(body.username || '').trim();
      const password = String(body.password || '');

      if (!username || !password) {
        sendJson(res, 400, { error: 'Login and password are required.' });
        return;
      }

      const games = Array.isArray(body.games)
        ? body.games.map(Number).filter(Number.isFinite)
        : readGameList(body.games);

      const account = createAccount({
        label: String(body.label || username).trim(),
        username,
        password,
        shared: String(body.shared || '').trim(),
        games: games && games.length > 0 ? games : DEFAULT_GAMES,
        persona: body.persona
      }, nextAccountIndex());

      state.accounts.push(account);
      startSteamClient(account);
      sendJson(res, 201, { account: publicAccount(account) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return;
  }

  const guardMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/steamguard$/);
  if (req.method === 'POST' && guardMatch) {
    const account = state.accounts.find((item) => item.id === guardMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: 'Account not found.' });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const code = String(body.code || '').trim();

      if (code.length < 3) {
        sendJson(res, 400, { error: 'Enter the Steam Guard code.' });
        return;
      }

      submitSteamGuardCode(account, code);
      sendJson(res, 200, { account: publicAccount(account) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return;
  }

  const gamesMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/games$/);
  if (req.method === 'POST' && gamesMatch) {
    const account = state.accounts.find((item) => item.id === gamesMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: 'Account not found.' });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const games = Array.isArray(body.games)
        ? body.games.map(Number).filter(Number.isFinite)
        : [];

      if (games.length === 0) {
        sendJson(res, 400, { error: 'Select at least one game.' });
        return;
      }

      (body.names || []).forEach((game) => {
        if (game && Number.isFinite(Number(game.appId)) && game.name) {
          gameCatalog.set(Number(game.appId), String(game.name));
        }
      });

      updateAccountGames(account, games.slice(0, 32));
      sendJson(res, 200, { account: publicAccount(account) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
}

function isAuthorized(req) {
  if (!DASHBOARD_PASSWORD) return true;

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return false;

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return username === DASHBOARD_USER && password === DASHBOARD_PASSWORD;
  } catch (error) {
    return false;
  }
}

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Steam Idler Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101820;
      --panel: #182536;
      --panel-2: #223957;
      --line: #416084;
      --text: #f5f7fb;
      --muted: #9fb0c8;
      --accent: #62d2a2;
      --accent-2: #7aa7ff;
      --danger: #ff705c;
      --warning: #f8c66f;
      --chip: #0e1a28;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(98, 210, 162, .16), transparent 34rem),
        linear-gradient(135deg, #101820 0%, #15243a 55%, #102034 100%);
      color: var(--text);
      font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    button, input, select {
      font: inherit;
    }

    button {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #102034;
      color: var(--text);
      cursor: pointer;
      padding: .55rem .8rem;
    }

    button:hover { border-color: var(--accent-2); }

    button.primary {
      border-color: rgba(98, 210, 162, .65);
      background: #143427;
    }

    .shell {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 40px 0 28px;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 26px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .logo {
      display: grid;
      place-items: center;
      width: 46px;
      height: 46px;
      border-radius: 8px;
      background: linear-gradient(135deg, #1d6bff, #7937e8);
      font-size: 24px;
    }

    h1, p {
      margin: 0;
    }

    h1 {
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1;
      letter-spacing: 0;
    }

    .subtitle {
      color: var(--muted);
      margin-top: 8px;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: .45rem .75rem;
      color: var(--muted);
      background: rgba(16, 32, 52, .72);
      white-space: nowrap;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 99px;
      background: var(--accent);
      box-shadow: 0 0 18px var(--accent);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
    }

    .account {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(34, 57, 87, .86);
      padding: 22px;
      min-height: 372px;
    }

    .account-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 20px;
    }

    .identity {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .avatar {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 48px;
      height: 48px;
      border-radius: 7px;
      background: #15263d;
      font-size: 24px;
    }

    .name {
      font-weight: 800;
      font-size: 17px;
      overflow-wrap: anywhere;
    }

    .meta {
      color: var(--muted);
      font-size: 13px;
    }

    .connection {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 18px;
      border-radius: 999px;
      padding: .38rem .72rem;
      background: rgba(16, 24, 32, .76);
      color: var(--muted);
    }

    .connection.connected .dot { background: var(--accent); }
    .connection.error .dot { background: var(--danger); box-shadow: 0 0 18px var(--danger); }
    .connection.waiting .dot { background: var(--warning); box-shadow: 0 0 18px var(--warning); }

    .stats {
      display: grid;
      gap: 8px;
      margin: 0 0 18px;
    }

    .row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid rgba(159, 176, 200, .22);
      padding-bottom: 8px;
      color: var(--muted);
    }

    .row strong {
      color: var(--text);
    }

    .section-label {
      margin: 18px 0 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }

    .chip {
      border: 1px solid #4e75a3;
      border-radius: 5px;
      background: var(--chip);
      color: var(--text);
      padding: .24rem .48rem;
      font-size: 12px;
    }

    .error-box {
      margin-top: 18px;
      border-radius: 6px;
      background: rgba(141, 29, 29, .58);
      color: #ffb5aa;
      padding: .7rem .8rem;
      overflow-wrap: anywhere;
    }

    .guard-box {
      display: grid;
      gap: 10px;
      margin-top: 18px;
      border: 1px solid rgba(248, 198, 111, .5);
      border-radius: 7px;
      background: rgba(248, 198, 111, .12);
      padding: .85rem;
    }

    .guard-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
    }

    .footer {
      text-align: center;
      color: var(--muted);
      margin-top: 30px;
    }

    dialog {
      width: min(620px, calc(100vw - 28px));
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #132033;
      color: var(--text);
      padding: 0;
    }

    dialog::backdrop {
      background: rgba(0, 0, 0, .68);
    }

    .modal {
      padding: 24px;
    }

    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 18px;
    }

    .modal h2 {
      margin: 0;
      font-size: 22px;
    }

    .search-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      margin-bottom: 16px;
    }

    input, select {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #0f1b2c;
      color: var(--text);
      padding: .65rem .8rem;
    }

    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .field {
      display: grid;
      gap: 6px;
    }

    .field.full {
      grid-column: 1 / -1;
    }

    label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .form-error {
      min-height: 20px;
      margin-top: 14px;
      color: #ffb5aa;
    }

    .results, .selected {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }

    .game-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      border: 1px solid rgba(159, 176, 200, .25);
      border-radius: 7px;
      padding: .7rem;
      background: rgba(255, 255, 255, .03);
    }

    .game-item span {
      color: var(--muted);
      font-size: 12px;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 22px;
    }

    @media (max-width: 640px) {
      .shell { width: min(100% - 20px, 1180px); padding-top: 22px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .top-actions { justify-content: stretch; width: 100%; }
      .top-actions button, .top-actions .status-pill { width: 100%; justify-content: center; }
      .account-head, .search-row, .form-grid { grid-template-columns: 1fr; }
      .account-head { flex-direction: column; }
      .account-head button { width: 100%; }
      .guard-row { grid-template-columns: 1fr; }
      .field.full { grid-column: auto; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo">ID</div>
        <div>
          <h1>Steam Idler</h1>
          <p class="subtitle">Live account dashboard</p>
        </div>
      </div>
      <div class="top-actions">
        <button id="login-open" class="primary" type="button">Add konto</button>
        <div class="status-pill"><span class="dot"></span><span id="global-status">Starting</span></div>
      </div>
    </header>

    <section id="accounts" class="grid"></section>
    <p class="footer">Auto-refreshes every 10 seconds</p>
  </main>

  <dialog id="login-dialog">
    <form method="dialog" class="modal">
      <div class="modal-head">
        <div>
          <h2>Add konto</h2>
          <p class="subtitle">Dane logowania sa trzymane tylko w pamieci dzialajacego serwera.</p>
        </div>
        <button value="cancel" aria-label="Close">Close</button>
      </div>

      <div class="form-grid">
        <div class="field">
          <label for="login-label">Nazwa konta</label>
          <input id="login-label" type="text" placeholder="Glowne konto" autocomplete="off">
        </div>
        <div class="field">
          <label for="login-persona">Persona</label>
          <select id="login-persona">
            <option value="online">Online</option>
            <option value="invisible">Invisible</option>
          </select>
        </div>
        <div class="field">
          <label for="login-username">Login Steam</label>
          <input id="login-username" type="text" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="login-password">Haslo</label>
          <input id="login-password" type="password" autocomplete="current-password" required>
        </div>
        <div class="field full">
          <label for="login-shared">Shared secret / 2FA secret</label>
          <input id="login-shared" type="password" autocomplete="one-time-code" placeholder="Optional">
        </div>
        <div class="field full">
          <label for="login-games">Games AppIDs</label>
          <input id="login-games" type="text" value="730,440,570,10,1172470">
        </div>
      </div>

      <div id="login-error" class="form-error"></div>

      <div class="actions">
        <button value="cancel">Cancel</button>
        <button id="login-submit" class="primary" type="button">Dodaj i zaloguj</button>
      </div>
    </form>
  </dialog>

  <dialog id="editor">
    <form method="dialog" class="modal">
      <div class="modal-head">
        <div>
          <h2 id="editor-title">Edit games</h2>
          <p class="subtitle">Search Steam and update the selected AppIDs.</p>
        </div>
        <button value="cancel" aria-label="Close">Close</button>
      </div>

      <div class="search-row">
        <input id="search-input" type="search" placeholder="Counter-Strike, Dota, Apex..." autocomplete="off">
        <button id="search-button" type="button">Search</button>
      </div>

      <div>
        <div class="section-label">Selected</div>
        <div id="selected-games" class="selected"></div>
      </div>

      <div>
        <div class="section-label">Results</div>
        <div id="search-results" class="results"></div>
      </div>

      <div class="actions">
        <button value="cancel">Cancel</button>
        <button id="save-button" type="button">Save games</button>
      </div>
    </form>
  </dialog>

  <script>
    const accountsNode = document.querySelector('#accounts');
    const globalStatus = document.querySelector('#global-status');
    const loginOpen = document.querySelector('#login-open');
    const loginDialog = document.querySelector('#login-dialog');
    const loginForm = loginDialog.querySelector('form');
    const loginLabel = document.querySelector('#login-label');
    const loginPersona = document.querySelector('#login-persona');
    const loginUsername = document.querySelector('#login-username');
    const loginPassword = document.querySelector('#login-password');
    const loginShared = document.querySelector('#login-shared');
    const loginGames = document.querySelector('#login-games');
    const loginError = document.querySelector('#login-error');
    const loginSubmit = document.querySelector('#login-submit');
    const editor = document.querySelector('#editor');
    const editorTitle = document.querySelector('#editor-title');
    const searchInput = document.querySelector('#search-input');
    const searchButton = document.querySelector('#search-button');
    const searchResults = document.querySelector('#search-results');
    const selectedGames = document.querySelector('#selected-games');
    const saveButton = document.querySelector('#save-button');

    let accounts = [];
    let editingAccount = null;
    let selected = [];

    function formatDuration(seconds) {
      if (!seconds) return '0m';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (hours > 0) return hours + 'h ' + minutes + 'm';
      return minutes + 'm';
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function renderAccounts() {
      accountsNode.innerHTML = accounts.map((account) => {
        const statusClass = account.connected ? 'connected' : account.error ? 'error' : 'waiting';
        const chips = account.games.map((game) => '<span class="chip">' + escapeHtml(game.name) + '</span>').join('');
        const guardText = account.steamGuardType === 'email'
          ? 'Kod z emaila konczacego sie na ' + escapeHtml(account.steamGuardDomain || '')
          : 'Kod z aplikacji Steam Guard';
        const guardBox = account.steamGuardRequired
          ? '<div class="guard-box">' +
              '<div><strong>Steam Guard wymagany</strong><br><span class="meta">' + guardText + '</span></div>' +
              (account.steamGuardLastCodeWrong ? '<div class="error-box">Poprzedni kod zostal odrzucony. Poczekaj na nowy kod.</div>' : '') +
              '<div class="guard-row">' +
                '<input type="text" maxlength="10" placeholder="Kod Steam Guard" data-guard-code="' + escapeHtml(account.id) + '" autocomplete="one-time-code">' +
                '<button type="button" data-guard-submit="' + escapeHtml(account.id) + '">Wyslij kod</button>' +
              '</div>' +
            '</div>'
          : '';

        return '<article class="account">' +
          '<div class="account-head">' +
            '<div class="identity">' +
              '<div class="avatar">ST</div>' +
              '<div><div class="name">' + escapeHtml(account.label) + '</div><div class="meta">Account #' + escapeHtml(account.id) + ' - ' + escapeHtml(account.persona) + '</div></div>' +
            '</div>' +
            '<button type="button" data-edit="' + escapeHtml(account.id) + '">Edit games</button>' +
          '</div>' +
          '<div class="connection ' + statusClass + '"><span class="dot"></span>' + escapeHtml(account.status) + '</div>' +
          '<div class="stats">' +
            '<div class="row"><span>Total idled</span><strong>' + formatDuration(account.totalIdleSeconds) + '</strong></div>' +
            '<div class="row"><span>This session</span><strong>' + formatDuration(account.sessionSeconds) + '</strong></div>' +
            '<div class="row"><span>Games idling</span><strong>' + account.games.length + '</strong></div>' +
          '</div>' +
          '<div class="section-label">Games</div>' +
          '<div class="chips">' + chips + '</div>' +
          guardBox +
          (account.error ? '<div class="error-box">' + escapeHtml(account.error) + '</div>' : '') +
        '</article>';
      }).join('');

      document.querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => openEditor(button.dataset.edit));
      });

      document.querySelectorAll('[data-guard-submit]').forEach((button) => {
        button.addEventListener('click', () => submitGuard(button.dataset.guardSubmit));
      });

      document.querySelectorAll('[data-guard-code]').forEach((input) => {
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitGuard(input.dataset.guardCode);
          }
        });
      });
    }

    async function loadStatus() {
      const response = await fetch('/api/status');
      const data = await response.json();
      accounts = data.accounts;
      globalStatus.textContent = data.ready ? 'Steam runtime ready' : 'Preview mode';
      renderAccounts();
    }

    function openLogin() {
      loginError.textContent = '';
      loginSubmit.disabled = false;
      loginDialog.showModal();
      loginUsername.focus();
    }

    async function submitLogin() {
      const username = loginUsername.value.trim();
      const password = loginPassword.value;

      if (!username || !password) {
        loginError.textContent = 'Wpisz login Steam i haslo.';
        return;
      }

      loginSubmit.disabled = true;
      loginError.textContent = 'Laczenie...';

      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: loginLabel.value.trim() || username,
          username,
          password,
          shared: loginShared.value.trim(),
          persona: loginPersona.value,
          games: loginGames.value
        })
      });

      const data = await response.json();

      if (!response.ok) {
        loginSubmit.disabled = false;
        loginError.textContent = data.error || 'Nie udalo sie rozpoczac logowania.';
        return;
      }

      loginPassword.value = '';
      loginShared.value = '';
      loginError.textContent = '';
      loginDialog.close();
      await loadStatus();
    }

    async function submitGuard(id) {
      const input = document.querySelector('[data-guard-code="' + CSS.escape(id) + '"]');
      const code = input ? input.value.trim() : '';

      if (!code) {
        if (input) input.focus();
        return;
      }

      const response = await fetch('/api/accounts/' + encodeURIComponent(id) + '/steamguard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
      });

      if (!response.ok) {
        const data = await response.json();
        alert(data.error || 'Kod Steam Guard nie zostal przyjety.');
        return;
      }

      await loadStatus();
    }

    function openEditor(id) {
      editingAccount = accounts.find((account) => account.id === id);
      selected = editingAccount.games.map((game) => ({ ...game }));
      editorTitle.textContent = 'Edit games - ' + editingAccount.label;
      searchInput.value = '';
      searchResults.innerHTML = '';
      renderSelected();
      editor.showModal();
    }

    function renderSelected() {
      selectedGames.innerHTML = selected.map((game) => (
        '<div class="game-item">' +
          '<div><strong>' + escapeHtml(game.name) + '</strong><br><span>AppID ' + escapeHtml(game.appId) + '</span></div>' +
          '<button type="button" data-remove="' + escapeHtml(game.appId) + '">Remove</button>' +
        '</div>'
      )).join('') || '<p class="subtitle">No games selected.</p>';

      selectedGames.querySelectorAll('[data-remove]').forEach((button) => {
        button.addEventListener('click', () => {
          selected = selected.filter((game) => String(game.appId) !== button.dataset.remove);
          renderSelected();
        });
      });
    }

    function renderResults(results) {
      searchResults.innerHTML = results.map((game) => (
        '<div class="game-item">' +
          '<div><strong>' + escapeHtml(game.name) + '</strong><br><span>AppID ' + escapeHtml(game.appId) + '</span></div>' +
          '<button type="button" data-add="' + escapeHtml(game.appId) + '" data-name="' + escapeHtml(game.name) + '">Add</button>' +
        '</div>'
      )).join('') || '<p class="subtitle">No results.</p>';

      searchResults.querySelectorAll('[data-add]').forEach((button) => {
        button.addEventListener('click', () => {
          const appId = Number(button.dataset.add);
          if (!selected.some((game) => game.appId === appId)) {
            selected.push({ appId, name: button.dataset.name });
            renderSelected();
          }
        });
      });
    }

    async function searchGames() {
      const q = searchInput.value.trim();
      if (q.length < 2) return;
      searchResults.innerHTML = '<p class="subtitle">Searching...</p>';

      const response = await fetch('/api/search?q=' + encodeURIComponent(q));
      const data = await response.json();
      renderResults(data.results || []);
    }

    async function saveGames() {
      if (!editingAccount || selected.length === 0) return;

      const response = await fetch('/api/accounts/' + editingAccount.id + '/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          games: selected.map((game) => game.appId),
          names: selected
        })
      });

      if (response.ok) {
        editor.close();
        await loadStatus();
      }
    }

    loginOpen.addEventListener('click', openLogin);
    loginSubmit.addEventListener('click', submitLogin);
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitLogin();
    });
    searchButton.addEventListener('click', searchGames);
    saveButton.addEventListener('click', saveGames);
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchGames();
      }
    });

    loadStatus();
    setInterval(loadStatus, 10000);
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    sendJson(res, 500, { error: 'Internal server error.' });
  });
});

server.on('error', (error) => {
  console.error(`HTTP server failed on ${HOST}:${PORT}:`, error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Steam Idler dashboard running on http://${HOST}:${PORT}`);
});

startSteamClients();
