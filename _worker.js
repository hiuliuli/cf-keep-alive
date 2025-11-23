/**
 * Cloudflare Worker Keep Alive v2.0
 * Features: Auth, URL Management, Cron Trigger, Retry Logic, Logging
 * Style: Neo-Brutalism
 */

export default {
  // --- 1. HTTP 请求入口 (手动操作 & UI) ---
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // KV 检查
    if (!env.MY_KV) {
      return new Response(renderHTML({
        type: 'error',
        title: '配置错误',
        message: '未绑定 KV 数据库，变量名必须为 <b>MY_KV</b>。'
      }), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    const storedPasswordHash = await env.MY_KV.get("password");

    // 初始化流程
    if (!storedPasswordHash) {
      if (request.method === "POST" && url.pathname === "/setup") {
        return handleSetup(request, env);
      }
      return new Response(renderHTML({ type: 'setup' }), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // 验证流程
    const cookie = request.headers.get("Cookie");
    const sessionHash = cookie?.match(/auth=([^;]+)/)?.[1];

    if (sessionHash !== storedPasswordHash) {
      if (request.method === "POST" && url.pathname === "/login") {
        return handleLogin(request, env, storedPasswordHash);
      }
      return new Response(renderHTML({ type: 'login' }), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // --- 业务路由 ---

    if (url.pathname === "/logout") return handleLogout();
    if (request.method === "POST" && url.pathname === "/add-url") return handleAddUrl(request, env);
    if (request.method === "POST" && url.pathname === "/delete-url") return handleDeleteUrl(request, env);
    if (request.method === "POST" && url.pathname === "/save-settings") return handleSaveSettings(request, env);
    
    // 手动执行任务
    if (request.method === "POST" && url.pathname === "/execute") {
      await executeTasksAndSaveLogs(env, "MANUAL"); // 手动执行
      return new Response(null, { status: 302, headers: { 'Location': '/' } });
    }

    // 默认主页
    const urls = await getKVJSON(env, "urls", []);
    const logs = await getKVJSON(env, "logs", []);
    const settings = await getKVJSON(env, "settings", { retryCount: 0, retryDelay: 1 });

    return new Response(renderHTML({ 
      type: 'dashboard', 
      data: { urls, logs, settings } 
    }), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  },

  // --- 2. Cron 触发器入口 (自动执行) ---
  async scheduled(event, env, ctx) {
    // 使用 ctx.waitUntil 确保任务在 Worker 销毁前完成
    ctx.waitUntil(executeTasksAndSaveLogs(env, "CRON"));
  }
};

// --- 核心业务逻辑 ---

// 执行任务、重试逻辑与日志保存
async function executeTasksAndSaveLogs(env, triggerType) {
  const urls = await getKVJSON(env, "urls", []);
  if (urls.length === 0) return;

  const settings = await getKVJSON(env, "settings", { retryCount: 0, retryDelay: 1 });
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  
  // 并发执行所有 URL 检测
  const results = await Promise.all(urls.map(async (u) => {
    return await fetchWithRetry(u, settings.retryCount, settings.retryDelay);
  }));

  const newLog = { 
    id: Date.now(), 
    timestamp, 
    trigger: triggerType, // 标记是手动还是定时
    results 
  };
  
  // 日志管理：获取旧日志 -> 插入新日志 -> 截断保留14条 -> 保存
  let logs = await getKVJSON(env, "logs", []);
  logs.unshift(newLog);
  if (logs.length > 14) logs = logs.slice(0, 14); // 保留最新 14 条
  
  await env.MY_KV.put("logs", JSON.stringify(logs));
}

// 带重试机制的 Fetch
async function fetchWithRetry(url, maxRetries, delaySeconds) {
  let attempt = 0;
  // 确保参数合法
  const retries = Math.max(0, parseInt(maxRetries) || 0);
  const delayMs = Math.max(1, parseInt(delaySeconds) || 1) * 1000;

  while (attempt <= retries) {
    const startTime = Date.now();
    try {
      const resp = await fetch(url, { 
        method: 'GET', 
        headers: { 'User-Agent': 'Cloudflare-Keep-Alive-v2' },
        redirect: 'follow'
      });
      
      const duration = Date.now() - startTime;
      
      // 如果状态码是成功的 (2xx)，直接返回
      if (resp.ok) {
        return { url, status: resp.status, ok: true, time: duration, attempts: attempt + 1 };
      }
      
      // 如果状态码不是 2xx，抛出错误进入 catch 块进行重试判断
      throw new Error(`HTTP ${resp.status}`);
      
    } catch (e) {
      // 如果是最后一次尝试，或者遇到严重错误，返回失败结果
      if (attempt === retries) {
        return { 
          url, 
          status: 0, 
          ok: false, 
          error: e.message, 
          attempts: attempt + 1 
        };
      }
      
      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, delayMs));
      attempt++;
    }
  }
}

// --- 数据处理工具函数 ---

async function getKVJSON(env, key, defaultValue) {
  const val = await env.MY_KV.get(key);
  try { return val ? JSON.parse(val) : defaultValue; } catch (e) { return defaultValue; }
}

async function hashText(text) {
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- 请求处理函数 ---

async function handleSetup(request, env) {
  const formData = await request.formData();
  const password = formData.get("password");
  if (!password || password.length < 4) return new Response(renderHTML({ type: 'setup', error: '密码太短' }), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  const hash = await hashText(password);
  await env.MY_KV.put("password", hash);
  return redirectWithCookie('/', hash);
}

async function handleLogin(request, env, storedHash) {
  const formData = await request.formData();
  const inputHash = await hashText(formData.get("password"));
  if (inputHash === storedHash) return redirectWithCookie('/', inputHash);
  return new Response(renderHTML({ type: 'login', error: '密码错误' }), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

async function handleSaveSettings(request, env) {
  const formData = await request.formData();
  const settings = {
    retryCount: parseInt(formData.get("retryCount")),
    retryDelay: parseInt(formData.get("retryDelay"))
  };
  await env.MY_KV.put("settings", JSON.stringify(settings));
  return new Response(null, { status: 302, headers: { 'Location': '/' } });
}

function handleLogout() {
  return new Response(null, { status: 302, headers: { 'Location': '/', 'Set-Cookie': `auth=deleted; Path=/; HttpOnly; Secure; Max-Age=0` } });
}

function redirectWithCookie(loc, hash) {
  return new Response(null, { status: 302, headers: { 'Location': loc, 'Set-Cookie': `auth=${hash}; Path=/; HttpOnly; Secure; Max-Age=86400` } });
}

async function handleAddUrl(request, env) {
  const formData = await request.formData();
  const newUrl = formData.get("url");
  if (newUrl) {
    const urls = await getKVJSON(env, "urls", []);
    if (!urls.includes(newUrl)) {
      urls.push(newUrl);
      await env.MY_KV.put("urls", JSON.stringify(urls));
    }
  }
  return new Response(null, { status: 302, headers: { 'Location': '/' } });
}

async function handleDeleteUrl(request, env) {
  const formData = await request.formData();
  const targetUrl = formData.get("url");
  let urls = await getKVJSON(env, "urls", []);
  urls = urls.filter(u => u !== targetUrl);
  await env.MY_KV.put("urls", JSON.stringify(urls));
  return new Response(null, { status: 302, headers: { 'Location': '/' } });
}

// --- UI 渲染核心 ---

function renderHTML({ type, error = "", title = "", message = "", data = {} }) {
  let content = "";
  let pageTitle = "";

  const ICONS = {
    alert: '<i class="ri-alarm-warning-fill ri-3x"></i>',
    lock: '<i class="ri-lock-2-fill ri-3x"></i>',
    key: '<i class="ri-shield-keyhole-line ri-3x"></i>',
    add: '<i class="ri-add-line"></i>',
    delete: '<i class="ri-delete-bin-line"></i>',
    run: '<i class="ri-play-fill ri-xl"></i>',
    settings: '<i class="ri-settings-4-fill"></i>',
    save: '<i class="ri-save-3-line"></i>'
  };

  if (type === 'error') {
    pageTitle = "Error";
    content = `
      <div class="icon-box bounce">${ICONS.alert}</div>
      <h1 class="glitch" data-text="${title}">${title}</h1>
      <p>${message}</p>
      <button onclick="location.reload()" class="neo-btn">重试</button>
    `;
  } 
  else if (type === 'setup' || type === 'login') {
    const isSetup = type === 'setup';
    pageTitle = isSetup ? "Setup" : "Login";
    content = `
      <div class="icon-box float">${isSetup ? ICONS.key : ICONS.lock}</div>
      <h1 class="glitch" data-text="${isSetup ? '初始化设置' : '身份验证'}">${isSetup ? '初始化设置' : '身份验证'}</h1>
      <p>${isSetup ? '请设置管理员密码以保护您的数据。' : '请输入密码进入控制台。'}</p>
      <form action="/${type}" method="POST">
        <div class="input-group">
          <input type="password" name="password" placeholder="输入密码..." required autocomplete="off">
          <div class="input-shadow"></div>
        </div>
        ${error ? `<div class="error-msg shake">${error}</div>` : ''}
        <button type="submit" class="neo-btn ${isSetup ? 'primary' : 'secondary'}">
          ${isSetup ? '保存设置' : '解锁进入'} <i class="ri-arrow-right-line"></i>
        </button>
      </form>
    `;
  } 
  else if (type === 'dashboard') {
    pageTitle = "Dashboard";
    
    // URL 列表
    const urlListHtml = data.urls && data.urls.length > 0 
      ? data.urls.map(u => `
          <div class="url-item slide-in">
            <span class="url-text">${u}</span>
            <form action="/delete-url" method="POST" style="margin:0;">
              <input type="hidden" name="url" value="${u}">
              <button type="submit" class="mini-btn delete" title="删除">${ICONS.delete}</button>
            </form>
          </div>`).join('')
      : `<div class="empty-state">暂无 URL，请在下方添加。</div>`;

    // 日志展示 (只取前5条)
    const displayLogs = data.logs ? data.logs.slice(0, 5) : [];
    const logsHtml = displayLogs.length > 0
      ? displayLogs.map(log => `
          <div class="log-entry fade-in">
            <div class="log-header">
              <span class="log-time">${log.timestamp}</span>
              <span class="log-badge ${log.trigger === 'CRON' ? 'badge-cron' : 'badge-manual'}">${log.trigger || 'MANUAL'}</span>
            </div>
            <div class="log-details">
              ${log.results.map(r => `
                <div class="log-row ${r.ok ? 'success' : 'fail'}">
                  <span class="status">[${r.status || 'ERR'}]</span>
                  <span class="url">${r.url}</span>
                  <span class="attempts" title="Attempts">${r.attempts > 1 ? '(Try:'+r.attempts+')' : ''}</span>
                  <span class="time">${r.time ? r.time + 'ms' : ''} ${r.error ? ' - ' + r.error : ''}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')
      : `<div class="empty-state">暂无执行日志</div>`;

    content = `
      <div class="dashboard-header">
        <div class="header-title">
           <i class="ri-command-fill ri-xl"></i> Keep Alive v2
        </div>
        <a href="/logout" class="mini-btn outline">退出</a>
      </div>

      <!-- 1. 手动执行 -->
      <section class="section-box execution-area">
        <div class="section-label">TRIGGER</div>
        <form action="/execute" method="POST">
            <button type="submit" class="neo-btn primary huge-btn">
              ${ICONS.run} 立即执行任务
            </button>
        </form>
      </section>

      <!-- 2. 系统设置 (新增) -->
      <section class="section-box settings-area">
        <div class="section-label">SETTINGS</div>
        <form action="/save-settings" method="POST" class="settings-form">
          <div class="setting-item">
            <label>失败重试次数 (次)</label>
            <div class="input-group compact">
              <input type="number" name="retryCount" value="${data.settings.retryCount}" min="0" required>
              <div class="input-shadow"></div>
            </div>
          </div>
          <div class="setting-item">
            <label>重试延迟 (秒)</label>
            <div class="input-group compact">
              <input type="number" name="retryDelay" value="${data.settings.retryDelay}" min="1" required>
              <div class="input-shadow"></div>
            </div>
          </div>
          <button type="submit" class="neo-btn accent compact-btn">${ICONS.save} 保存</button>
        </form>
      </section>

      <!-- 3. URL 管理 -->
      <section class="section-box url-area">
        <div class="section-label">URLS</div>
        <div class="url-list">
          ${urlListHtml}
        </div>
        <form action="/add-url" method="POST" class="add-form">
          <div class="input-group compact">
            <input type="url" name="url" placeholder="https://example.com" required autocomplete="off">
            <div class="input-shadow"></div>
          </div>
          <button type="submit" class="neo-btn secondary compact-btn">${ICONS.add} 添加</button>
        </form>
      </section>

      <!-- 4. 日志区域 (显示最新的5条) -->
      <section class="section-box log-area">
        <div class="section-label">LOGS (LATEST 5)</div>
        <div class="terminal-window">
          ${logsHtml}
        </div>
      </section>
    `;
  }

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle} - Cloudflare Worker</title>
  <link rel="icon" type="image/png" href="https://raw.githubusercontent.com/hiuliuli/cf-keep-alive/refs/heads/main/favicon.png">
  <link href="https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css" rel="stylesheet">
  <style>
    :root {
      --bg: #ffffff;
      --black: #121212;
      --primary: #4f46e5; /* Indigo */
      --secondary: #db2777; /* Pink */
      --accent: #facc15; /* Yellow */
      --cyan: #06b6d4; /* Cyan */
      --success: #22c55e; 
      --error: #ef4444; 
      --gray: #f3f4f6;
      --border: 3px;
    }

    * { box-sizing: border-box; }
    
    body {
      margin: 0; padding: 0;
      font-family: 'Courier New', Courier, monospace, sans-serif;
      background-color: var(--bg);
      color: var(--black);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow-x: hidden;
    }

    /* BG Decoration */
    .bg-shape { position: absolute; border: var(--border) solid var(--black); z-index: -1; opacity: 0.6; pointer-events: none; }
    .s1 { top: 5%; left: 5%; width: 80px; height: 80px; background: var(--accent); border-radius: 50%; animation: float 6s infinite ease-in-out; }
    .s2 { bottom: 10%; right: 5%; width: 120px; height: 120px; background: var(--secondary); clip-path: polygon(0 0, 100% 0, 50% 100%); animation: float 8s reverse infinite; }
    .s3 { top: 40%; left: -40px; width: 100px; height: 100px; background: var(--cyan); transform: rotate(45deg); animation: spin 20s linear infinite; }

    /* Container */
    .container {
      width: 95%;
      max-width: ${type === 'dashboard' ? '600px' : '420px'};
      background: var(--bg);
      border: var(--border) solid var(--black);
      box-shadow: 10px 10px 0 var(--black);
      padding: 2rem;
      position: relative;
      animation: popIn 0.5s;
      margin: 2rem 0;
    }

    /* Typography */
    h1 { text-transform: uppercase; font-weight: 900; font-size: 2rem; margin: 1rem 0; }
    p { font-weight: 600; margin-bottom: 1.5rem; }

    /* Header */
    .dashboard-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; border-bottom: 3px solid var(--black); padding-bottom: 1rem; }
    .header-title { font-weight: 900; font-size: 1.2rem; display: flex; align-items: center; gap: 10px; }

    /* Sections */
    .section-box { margin-bottom: 2rem; position: relative; border: 2px solid var(--black); padding: 1.5rem; background: #fff; }
    .section-label { position: absolute; top: -12px; left: 10px; background: var(--black); color: #fff; padding: 0 8px; font-weight: bold; font-size: 0.8rem; }
    
    .execution-area { border-color: var(--primary); box-shadow: 5px 5px 0 var(--primary); }
    .settings-area { border-color: var(--cyan); box-shadow: 5px 5px 0 var(--cyan); }
    .url-area { border-color: var(--secondary); box-shadow: 5px 5px 0 var(--secondary); }
    .log-area { border-color: var(--black); box-shadow: 5px 5px 0 var(--black); }

    /* Forms */
    .input-group { position: relative; width: 100%; }
    .input-group.compact { flex-grow: 1; }
    input { width: 100%; padding: 0.8rem; font-weight: bold; border: var(--border) solid var(--black); outline: none; background: #fff; position: relative; z-index: 2; transition: 0.2s; font-family: inherit; }
    input:focus { background: #eff6ff; transform: translate(-3px, -3px); }
    .input-shadow { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: var(--black); z-index: 1; transition: 0.2s; }
    input:focus + .input-shadow { transform: translate(6px, 6px); }

    /* Settings specific */
    .settings-form { display: flex; gap: 15px; align-items: flex-end; }
    .setting-item { flex: 1; }
    .setting-item label { display: block; font-size: 0.8rem; font-weight: bold; margin-bottom: 5px; }

    /* Buttons */
    .neo-btn { display: flex; justify-content: center; align-items: center; gap: 8px; width: 100%; padding: 1rem; font-weight: 900; border: var(--border) solid var(--black); cursor: pointer; text-transform: uppercase; position: relative; transition: 0.1s; color: var(--black); }
    .neo-btn:hover { transform: translate(-2px, -2px); box-shadow: 5px 5px 0 var(--black); }
    .neo-btn:active { transform: translate(1px, 1px); box-shadow: 2px 2px 0 var(--black); }
    
    .primary { background: var(--accent); }
    .secondary { background: var(--secondary); color: #fff; }
    .accent { background: var(--cyan); color: #fff; }
    .huge-btn { font-size: 1.3rem; padding: 1.2rem; background: var(--primary); color: #fff; }
    .compact-btn { width: auto; padding: 0.8rem 1.5rem; white-space: nowrap; }
    .mini-btn { padding: 5px 10px; border: 2px solid var(--black); font-weight: bold; cursor: pointer; background: #fff; text-decoration: none; color: var(--black); display: inline-flex; align-items: center; }
    .mini-btn:hover { background: var(--black); color: #fff; }
    .mini-btn.delete:hover { background: var(--error); border-color: var(--error); }

    /* Lists & Logs */
    .url-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 1rem; }
    .url-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; border: 2px solid var(--black); background: var(--gray); font-weight: bold; font-size: 0.9rem; word-break: break-all; }
    .add-form { display: flex; gap: 10px; align-items: flex-start; }

    .terminal-window { background: var(--black); color: #33ff00; padding: 1rem; height: 300px; overflow-y: auto; border: 2px solid var(--black); font-size: 0.85rem; }
    .log-entry { border-bottom: 1px dashed #555; padding: 10px 0; }
    .log-header { display: flex; justify-content: space-between; color: #fff; margin-bottom: 5px; opacity: 0.8; }
    .log-badge { padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; color: #000; font-weight: bold; }
    .badge-cron { background: var(--accent); }
    .badge-manual { background: var(--cyan); }
    
    .log-row { display: flex; gap: 10px; margin: 2px 0; }
    .log-row.success { color: var(--success); }
    .log-row.fail { color: var(--error); }
    .status { font-weight: bold; min-width: 40px; }
    .attempts { color: var(--accent); }
    .empty-state { text-align: center; padding: 2rem; color: #666; font-style: italic; }

    /* Icons */
    .icon-box { width: 70px; height: 70px; border: 3px solid var(--black); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; background: #fff; box-shadow: 4px 4px 0 var(--black); }
    .error-msg { background: var(--error); color: #fff; padding: 10px; border: 2px solid var(--black); margin-bottom: 10px; font-weight: bold; }

    /* Animations */
    @keyframes popIn { 0% { transform: scale(0.9); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
    @keyframes float { 50% { transform: translateY(-15px); } }
    @keyframes spin { 100% { transform: rotate(405deg); } }
    @keyframes glitch { 20% { transform: translate(-2px, 2px); } 40% { transform: translate(2px, -2px); } 60% { transform: translate(0); } }
    .glitch:hover { animation: glitch 0.3s infinite; color: var(--secondary); cursor: default; }
    .shake { animation: glitch 0.4s; }
    .slide-in { animation: popIn 0.3s backwards; }
    .fade-in { animation: popIn 0.4s backwards; }

    /* Scrollbar */
    .terminal-window::-webkit-scrollbar { width: 10px; }
    .terminal-window::-webkit-scrollbar-track { background: var(--black); }
    .terminal-window::-webkit-scrollbar-thumb { background: var(--primary); border: 2px solid var(--black); }

    @media (max-width: 600px) {
      .container { padding: 1rem; width: 98%; }
      .settings-form, .add-form { flex-direction: column; align-items: stretch; }
      .log-row { flex-direction: column; gap: 0; margin-bottom: 5px; }
    }
  </style>
</head>
<body>
  <div class="bg-shape s1"></div>
  <div class="bg-shape s2"></div>
  <div class="bg-shape s3"></div>
  <div class="container">${content}</div>
  <script>
    document.querySelectorAll('form').forEach(f => {
      f.addEventListener('submit', function() {
        const btn = this.querySelector('button[type="submit"]');
        if(btn) {
            btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> ...';
            btn.style.opacity = '0.7';
            btn.style.pointerEvents = 'none';
        }
      });
    });
  </script>
</body>
</html>
  `;
}
