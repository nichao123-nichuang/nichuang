// ============================================================
//  Ni创·AI文游平台 - 后端服务
//  所有API密钥存储在后端，前端通过session token请求AI调用
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3210;

// 中间件
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 静态文件服务 - 前端HTML
app.use(express.static(path.join(__dirname, '..', 'avatars'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));

// ============================================================
//  数据存储（JSON文件持久化）
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(filename, defaultValue) {
  const fp = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { console.error(`Load ${filename} error:`, e.message); }
  return defaultValue;
}

function saveJSON(filename, data) {
  const fp = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error(`Save ${filename} error:`, e.message); }
}

// 管理员配置（API密钥存储在这里）
let adminConfig = loadJSON('admin.json', {
  password: 'nichuang_admin_2024',  // 可通过管理面板修改
  platforms: [
    { id: 0, name: 'DeepSeek',       url: 'https://api.deepseek.com',                    model: 'deepseek-chat' },
    { id: 1, name: 'DeepSeek(R1)',   url: 'https://api.deepseek.com',                    model: 'deepseek-reasoner' },
    { id: 2, name: 'OpenAI',         url: 'https://api.openai.com/v1',                   model: 'gpt-4o-mini' },
    { id: 3, name: 'OpenAI(GPT4o)',  url: 'https://api.openai.com/v1',                   model: 'gpt-4o' },
    { id: 4, name: '通义千问',        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
    { id: 5, name: '智谱GLM',        url: 'https://open.bigmodel.cn/api/paas/v4',        model: 'glm-4-flash' },
    { id: 6, name: '月之暗面',        url: 'https://api.moonshot.cn/v1',                  model: 'moonshot-v1-8k' },
    { id: 7, name: '硅基流动',        url: 'https://api.siliconflow.cn/v1',               model: 'deepseek-ai/DeepSeek-V3' },
    { id: 8, name: '百炼',           url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 9, name: '自定义',         url: '',                                            model: '' },
  ],
  defaultPlatform: 0,
  defaultApiKey: '',  // 默认API密钥
  defaultCustomUrl: '',
  defaultCustomModel: ''
});

// 兑换码数据库
let redeemCodes = loadJSON('redeem_codes.json', {});  // { code: { platformId, apiKey, customUrl, customModel, totalTurns, usedTurns, activatedBy, createdAt } }

// Session存储（内存中，重启后需重新兑换）
let sessions = {};  // { sessionToken: { code, platformId, apiUrl, model, remaining, totalTurns, usedTurns, createdAt } }

// 管理员session（持久化到文件，重启不丢失）
let adminSession = loadJSON('admin_session.json', null);

// 健康检查端点
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', codes: Object.keys(redeemCodes).length });
});

// ============================================================
//  工具函数
// ============================================================
const SHORT_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateShortCode() {
  const arr = crypto.randomBytes(8);
  let code = 'NC';
  for (let i = 0; i < 8; i++) {
    code += SHORT_CODE_CHARS[arr[i] % SHORT_CODE_CHARS.length];
    if (i === 3) code += '-';
  }
  return code; // NC-XXXX-XXXX
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getPlatformConfig(platformId) {
  return adminConfig.platforms.find(p => p.id === platformId) || adminConfig.platforms[9];
}

function getApiUrlAndModel(platformId, customUrl, customModel) {
  if (platformId === 9 || platformId === undefined) {
    return {
      apiUrl: customUrl || adminConfig.defaultCustomUrl,
      model: customModel || adminConfig.defaultCustomModel || 'deepseek-chat'
    };
  }
  const platform = getPlatformConfig(platformId);
  return { apiUrl: platform.url, model: platform.model };
}

function cleanExpiredSessions() {
  const now = Date.now();
  const MAX_AGE = 24 * 60 * 60 * 1000; // 24小时过期
  let cleaned = 0;
  for (const [token, sess] of Object.entries(sessions)) {
    if (now - sess.createdAt > MAX_AGE) {
      delete sessions[token];
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`Cleaned ${cleaned} expired sessions`);
}

// 每30分钟清理过期session
setInterval(cleanExpiredSessions, 30 * 60 * 1000);

// ============================================================
//  API 路由 - 玩家端
// ============================================================

// 1. 兑换码激活 → 返回session token
app.post('/api/redeem', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '请输入兑换码' });

  const cleanCode = code.trim().toUpperCase().replace(/[-\s]/g, '');
  // 尝试多种格式匹配
  const tryKeys = [
    cleanCode,
    'NC-' + cleanCode.slice(2, 6) + '-' + cleanCode.slice(6),
    cleanCode.replace(/^NC/, 'NC-').replace(/(.{7})/, '$1-')
  ];

  let codeData = null;
  let matchedKey = null;
  for (const key of tryKeys) {
    if (redeemCodes[key]) {
      codeData = redeemCodes[key];
      matchedKey = key;
      break;
    }
  }

  if (!codeData) {
    return res.status(404).json({ error: '无效的兑换码，请检查是否输入正确' });
  }

  // 检查是否已用完
  if (codeData.totalTurns > 0 && codeData.usedTurns >= codeData.totalTurns) {
    return res.status(410).json({ error: '此兑换码已用完', remaining: 0 });
  }

  // 创建session
  const { apiUrl, model } = getApiUrlAndModel(codeData.platformId, codeData.customUrl, codeData.customModel);
  const sessionToken = generateSessionToken();
  const remaining = codeData.totalTurns > 0 ? codeData.totalTurns - codeData.usedTurns : -1; // -1表示无限

  sessions[sessionToken] = {
    code: matchedKey,
    platformId: codeData.platformId,
    apiKey: codeData.apiKey,
    apiUrl,
    model,
    totalTurns: codeData.totalTurns,
    usedTurns: codeData.usedTurns,
    remaining,
    createdAt: Date.now()
  };

  // 标记兑换码已被激活
  redeemCodes[matchedKey].activatedBy = true;
  saveJSON('redeem_codes.json', redeemCodes);

  res.json({
    success: true,
    sessionToken,
    remaining,
    totalTurns: codeData.totalTurns,
    platformName: getPlatformConfig(codeData.platformId)?.name || '自定义'
  });
});

// 2. 查询session状态
app.get('/api/session/:token', (req, res) => {
  const sess = sessions[req.params.token];
  if (!sess) return res.status(404).json({ error: '会话不存在或已过期' });

  res.json({
    remaining: sess.totalTurns > 0 ? sess.totalTurns - sess.usedTurns : -1,
    totalTurns: sess.totalTurns,
    usedTurns: sess.usedTurns,
    platformName: getPlatformConfig(sess.platformId)?.name || '自定义'
  });
});

// 3. AI代理调用 - 核心接口
app.post('/api/chat', async (req, res) => {
  const { sessionToken, messages, maxTokens, temperature } = req.body;
  if (!sessionToken) return res.status(401).json({ error: '缺少会话令牌' });

  const sess = sessions[sessionToken];
  if (!sess) return res.status(401).json({ error: '会话不存在或已过期，请重新兑换' });

  // 检查剩余回合
  if (sess.totalTurns > 0 && sess.usedTurns >= sess.totalTurns) {
    return res.status(403).json({ error: '兑换码已用完', remaining: 0 });
  }

  // 构建API请求
  let apiUrl = sess.apiUrl.trim();
  if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
  if (!apiUrl.endsWith('/chat/completions')) apiUrl += '/chat/completions';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sess.apiKey
      },
      body: JSON.stringify({
        model: sess.model || 'deepseek-chat',
        messages: messages,
        stream: false,
        max_tokens: maxTokens || 4096,
        temperature: temperature || 0.85
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('AI API error:', resp.status, errText.substring(0, 200));
      return res.status(resp.status).json({ error: `AI服务请求失败(${resp.status})`, detail: errText.substring(0, 200) });
    }

    const data = await resp.json();
    let aiText = '';
    if (data.choices && data.choices[0]) {
      aiText = data.choices[0].message?.content || data.choices[0].text || '';
    } else if (data.response) {
      aiText = data.response;
    } else if (data.result) {
      aiText = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }

    if (!aiText) {
      return res.status(502).json({ error: 'AI返回了空内容' });
    }

    // 消耗1回合
    sess.usedTurns++;
    const remaining = sess.totalTurns > 0 ? sess.totalTurns - sess.usedTurns : -1;

    // 同步回兑换码数据库
    if (redeemCodes[sess.code]) {
      redeemCodes[sess.code].usedTurns = sess.usedTurns;
      saveJSON('redeem_codes.json', redeemCodes);
    }

    res.json({
      success: true,
      content: aiText,
      remaining
    });

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: '请求超时，请检查网络' });
    }
    console.error('Chat proxy error:', err);
    res.status(500).json({ error: '服务内部错误: ' + err.message });
  }
});

// 4. 测试API连通性（管理面板用）
app.post('/api/test-connection', async (req, res) => {
  const { apiUrl, apiKey, model } = req.body;
  if (!apiUrl || !apiKey) return res.status(400).json({ error: '缺少参数' });

  let url = apiUrl.trim();
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (!url.endsWith('/chat/completions')) url += '/chat/completions';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (resp.ok) {
      res.json({ success: true, message: '连接成功' });
    } else {
      const t = await resp.text().catch(() => '');
      res.json({ success: false, message: `失败(${resp.status}): ${t.substring(0, 100)}` });
    }
  } catch (e) {
    res.json({ success: false, message: '连接失败: ' + e.message });
  }
});

// ============================================================
//  API 路由 - 管理员端
// ============================================================

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== adminConfig.password) {
    return res.status(403).json({ error: '密码错误' });
  }
  adminSession = generateSessionToken();
  saveJSON('admin_session.json', adminSession);
  res.json({ success: true, adminToken: adminSession });
});

// 管理员鉴权中间件
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (!token || token !== adminSession) {
    return res.status(401).json({ error: '请先登录管理后台' });
  }
  next();
}

// 获取管理配置
app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    platforms: adminConfig.platforms,
    defaultPlatform: adminConfig.defaultPlatform,
    defaultApiKey: adminConfig.defaultApiKey ? adminConfig.defaultApiKey.substring(0, 8) + '...' : '',
    defaultCustomUrl: adminConfig.defaultCustomUrl,
    defaultCustomModel: adminConfig.defaultCustomModel,
    hasApiKey: !!adminConfig.defaultApiKey
  });
});

// 更新管理配置（保存API密钥）
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { platformId, apiKey, customUrl, customModel, password } = req.body;

  if (platformId !== undefined) adminConfig.defaultPlatform = platformId;
  if (apiKey) adminConfig.defaultApiKey = apiKey;
  if (customUrl !== undefined) adminConfig.defaultCustomUrl = customUrl;
  if (customModel !== undefined) adminConfig.defaultCustomModel = customModel;
  if (password && password.length >= 4) adminConfig.password = password;

  saveJSON('admin.json', adminConfig);
  res.json({ success: true });
});

// 批量生成兑换码
app.post('/api/admin/generate-codes', requireAdmin, (req, res) => {
  const { platformId, apiKey, customUrl, customModel, turns, count } = req.body;

  if (!apiKey && !adminConfig.defaultApiKey) {
    return res.status(400).json({ error: '请填写API密钥' });
  }
  if (!turns || turns < 1) {
    return res.status(400).json({ error: '回合数至少为1' });
  }
  const pid = platformId !== undefined ? platformId : adminConfig.defaultPlatform;
  const key = apiKey || adminConfig.defaultApiKey;

  const total = Math.min(count || 1, 500);
  const codes = [];

  for (let i = 0; i < total; i++) {
    let shortCode;
    // 确保不重复
    do {
      shortCode = generateShortCode();
    } while (redeemCodes[shortCode]);

    redeemCodes[shortCode] = {
      platformId: pid,
      apiKey: key,
      customUrl: pid === 9 ? (customUrl || '') : '',
      customModel: pid === 9 ? (customModel || '') : '',
      totalTurns: turns,
      usedTurns: 0,
      activatedBy: null,
      createdAt: Date.now()
    };

    codes.push(shortCode);
  }

  // 同步更新admin配置中的默认API密钥
  if (key) adminConfig.defaultApiKey = key;
  saveJSON('admin.json', adminConfig);
  saveJSON('redeem_codes.json', redeemCodes);

  res.json({ success: true, codes, count: codes.length });
});

// 获取兑换码列表
app.get('/api/admin/codes', requireAdmin, (req, res) => {
  const list = Object.entries(redeemCodes).map(([code, data]) => ({
    code,
    platformId: data.platformId,
    platformName: getPlatformConfig(data.platformId)?.name || '自定义',
    totalTurns: data.totalTurns,
    usedTurns: data.usedTurns,
    remaining: data.totalTurns > 0 ? data.totalTurns - data.usedTurns : -1,
    activatedBy: data.activatedBy ? '已激活' : '未使用',
    createdAt: new Date(data.createdAt).toLocaleString('zh-CN')
  }));

  // 按创建时间倒序
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// 删除兑换码
app.delete('/api/admin/codes/:code', requireAdmin, (req, res) => {
  const code = req.params.code.toUpperCase().replace(/[-\s]/g, '');
  // 尝试带前缀格式
  const tryKeys = [
    code,
    'NC-' + code.slice(2, 6) + '-' + code.slice(6)
  ];
  let deleted = false;
  for (const key of tryKeys) {
    if (redeemCodes[key]) {
      delete redeemCodes[key];
      deleted = true;
      break;
    }
  }
  if (deleted) {
    saveJSON('redeem_codes.json', redeemCodes);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '兑换码不存在' });
  }
});

// 清空所有兑换码
app.post('/api/admin/clear-codes', requireAdmin, (req, res) => {
  redeemCodes = {};
  saveJSON('redeem_codes.json', redeemCodes);
  res.json({ success: true });
});

// 修改管理员密码
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (oldPassword !== adminConfig.password) return res.status(403).json({ error: '当前密码错误' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: '新密码至少4位' });
  adminConfig.password = newPassword;
  saveJSON('admin.json', adminConfig);
  res.json({ success: true });
});

// 获取统计信息
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalCodes = Object.keys(redeemCodes).length;
  const usedCodes = Object.values(redeemCodes).filter(c => c.usedTurns > 0).length;
  const activeSessions = Object.keys(sessions).length;

  res.json({ totalCodes, usedCodes, activeSessions });
});

// ============================================================
//  启动服务
// ============================================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  🎮 Ni创·AI文游 后端服务已启动       ║
║  📍 http://localhost:${PORT}            ║
║  📋 管理后台: 前端页面 → 管理员入口   ║
╚══════════════════════════════════════╝
  `);

  // 显示配置状态
  if (adminConfig.defaultApiKey) {
    console.log(`✅ 默认API密钥已配置 (${adminConfig.defaultApiKey.substring(0, 8)}...)`);
  } else {
    console.log('⚠️  尚未配置默认API密钥，请登录管理后台设置');
  }
  console.log(`📦 兑换码数量: ${Object.keys(redeemCodes).length}`);
});
