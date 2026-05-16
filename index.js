/**
 * ASTERION Hub — Chat Backend v2.9
 * ─────────────────────────────────────────────────────────────────────
 * Claude  : claude-sonnet-4-6
 *           Extended Thinking (budget_tokens: 10000)
 *           ★ Native MCP Connector (anthropic-beta: mcp-client-2025-11-20)
 *             → Anthropic API가 MCP 서버 직접 호출, 도구 루프 불필요
 *           Prompt Caching (cache_control: ephemeral, 도구 목록 캐싱 포함)
 *
 * Gemini  : gemini-3.1-pro-preview
 *           ★ thinkingConfig: { thinkingLevel: 'high' }
 *             → generationConfig 밖 최상위 위치 (BUG-A 수정)
 *           ★ MCP function calling + 수동 도구 실행 루프 (BUG-C 수정)
 *           Implicit caching (Google 자동 처리)
 *
 * GPT     : gpt-5.5 (기본형, reasoning_effort 미지정)
 *           MCP function calling + 수동 도구 실행 루프
 *           Automatic prefix caching (OpenAI 자동 처리)
 *
 * ─────────────────────────────────────────────────────────────────────
 * 필수 환경변수:
 *   ANTHROPIC_API_KEY            → Anthropic Console (직접 API)
 *   GEMINI_API_KEY               → Google AI Studio
 *   OPENAI_API_KEY               → OpenAI Platform
 * 선택 환경변수:
 *   MCP_SERVER_URL               → asterion-mcp 서버 base URL (예: https://...run.app)
 *   BTR_SERVER_URL               → BTR Pipeline Server URL
 *   ASTERION_KNOWLEDGE_FOLDER_ID → Google Drive 지식베이스 폴더 ID
 * ─────────────────────────────────────────────────────────────────────
 */

import express    from 'express';
import cors       from 'cors';
import { google } from 'googleapis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import EventSource from 'eventsource';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
global.EventSource = EventSource;

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.set('trust proxy', true);
app.use(express.static(join(__dirname, 'static')));
app.get('/', (_req, res) => res.sendFile(join(__dirname, 'static', 'index.html')));

// ═══════════════════════════════════════════════════════════════════
// 설정
// ═══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;

const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY    || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY    || '';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GPT_MODEL    = 'gpt-5.5';

const DRIVE_FOLDER_ID = process.env.ASTERION_KNOWLEDGE_FOLDER_ID || '';
const MCP_SERVER_URL  = process.env.MCP_SERVER_URL  || '';
const BTR_SERVER_URL  = process.env.BTR_SERVER_URL  || '';

const MAX_MSG_PAIRS  = 20;
const MAX_TOOL_DEPTH = 8;

// ═══════════════════════════════════════════════════════════════════
// 시스템 프롬프트
// ═══════════════════════════════════════════════════════════════════
const ASTERION_BASE = `너는 ASTERION의 내부 전용 AI다. ASTERION은 베딕 점성술(Lahiri 아야남샤)과 명리학을 결합한 에너지 공학 기반 분석 엔진이다. BTR(Birth Time Rectification)을 통해 개인 표준시를 확정하고, S-Class(97점↑ Hard Stop) 달성 이후에만 분석 결과물이 생성된다. asterion-mcp의 모든 도구를 자유롭게 사용한다.

[운영 중인 시스템]
- Archive GAS     : StructureCode 관리, PDF 생성, ExpireDate 기반 개인정보 삭제
- 3자 루브릭      : Claude × Gemini × GPT, Hard Stop = 세 AI 97점↑ AND critical_issues 없음
- ASTERION Flow   : BTR Result Code 기반 구독 분석 (Annual/Monthly/Weekly)
- asterion-mcp    : L0~L3 단일 MCP 서버 (vedastro-mcp 확장), Cloud Run 배포

[핵심 스프레드시트 ID]
- Archive:        1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8
- JuliarCalendar: 1whKvFyWmb-qbR6OJt5dcI6WOJMLB5MUIzNMlJBFeq_g

외부 요청에 정확성과 무결성을 최우선으로 하고, 확신하지 못하는 부분은 솔직하게 표현한다.`;

// ═══════════════════════════════════════════════════════════════════
// 1. Drive 지식베이스
// ═══════════════════════════════════════════════════════════════════
let knowledgeContext = '';
let knowledgeStatus  = 'not_loaded';

async function loadDriveKnowledge() {
  if (!DRIVE_FOLDER_ID) { knowledgeStatus = 'no_folder_configured'; return; }
  try {
    const auth  = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    const drive = google.drive({ version: 'v3', auth });
    const list  = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType)', pageSize: 50,
    });
    const docs = [];
    for (const f of (list.data.files || [])) {
      try {
        let text = '';
        if (f.mimeType === 'application/vnd.google-apps.document') {
          const r = await drive.files.export({ fileId: f.id, mimeType: 'text/plain' });
          text = typeof r.data === 'string' ? r.data : '';
        } else if (['text/plain', 'text/markdown'].includes(f.mimeType)) {
          const r = await drive.files.get({ fileId: f.id, alt: 'media' });
          text = typeof r.data === 'string' ? r.data : '';
        }
        if (text) docs.push(`[${f.name}]\n${text.slice(0, 8000)}`);
      } catch (e) { console.warn(`[Drive] ${f.name}:`, e.message); }
    }
    knowledgeContext = docs.join('\n\n---\n\n').slice(0, 500000);
    knowledgeStatus  = `loaded (${docs.length} files)`;
    console.log(`[Drive] 로드 완료: ${docs.length}개 파일`);
  } catch (e) {
    knowledgeStatus = `error: ${e.message}`;
    console.error('[Drive] 오류:', e.message);
  }
}
loadDriveKnowledge();

// ═══════════════════════════════════════════════════════════════════
// 2. MCP 클라이언트 (Gemini + GPT 수동 도구 실행 전용)
//    Claude는 Anthropic native MCP connector 사용 → 이 클라이언트 불필요
// ═══════════════════════════════════════════════════════════════════
let mcpClient     = null;
let mcpTools      = [];
let mcpRetryTimer = null;

function buildSSEUrl(baseUrl) {
  const url = baseUrl.replace(/\/$/, '');
  return url.endsWith('/sse') ? url : url + '/sse';
}

async function connectMCP() {
  if (!MCP_SERVER_URL) return;
  if (mcpRetryTimer) { clearTimeout(mcpRetryTimer); mcpRetryTimer = null; }
  try {
    const transport = new SSEClientTransport(new URL(buildSSEUrl(MCP_SERVER_URL)));
    mcpClient = new Client({ name: 'asterion-hub', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    const r = await mcpClient.listTools();
    mcpTools = (r.tools || []).map(t => ({
      name:        t.name,
      description: t.description || '',
      parameters:  t.inputSchema || { type: 'object', properties: {} },
    }));
    console.log(`[MCP] 연결 완료. 도구 ${mcpTools.length}개 (Gemini/GPT 수동 실행용)`);
    mcpClient.onclose = () => {
      console.warn('[MCP] 연결 해제 → 30초 후 재시도');
      mcpClient = null; mcpTools = [];
      mcpRetryTimer = setTimeout(connectMCP, 30000);
    };
  } catch (e) {
    console.error('[MCP] 연결 실패:', e.message, '→ 60초 후 재시도');
    mcpClient = null; mcpTools = [];
    mcpRetryTimer = setTimeout(connectMCP, 60000);
  }
}
connectMCP();

async function callMCPTool(name, input) {
  if (!mcpClient) return JSON.stringify({ error: 'MCP 서버 미연결' });
  try {
    const r = await mcpClient.callTool({ name, arguments: input || {} });
    return JSON.stringify(r.content).slice(0, 8000);
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

// ═══════════════════════════════════════════════════════════════════
// 3. BTR 서버 프록시
// ═══════════════════════════════════════════════════════════════════
async function callBTRServer(path, body) {
  if (!BTR_SERVER_URL) return { error: 'BTR_SERVER_URL 환경변수 미설정' };
  try {
    const r = await fetch(`${BTR_SERVER_URL}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { error: `BTR 서버 오류: ${e.message}` }; }
}

// ═══════════════════════════════════════════════════════════════════
// 4. 유틸리티
// ═══════════════════════════════════════════════════════════════════
const writeSSE  = (res, p) => res.write(`data: ${JSON.stringify(p)}\n\n`);
const writeDone = (res)    => res.write('data: [DONE]\n\n');

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const r = await fetch(url, options);
    if ((r.status === 429 || r.status === 503) && i < maxRetries - 1) {
      const wait = Math.pow(2, i) * 1500 + Math.random() * 500;
      console.warn(`[Retry] ${r.status} — ${wait.toFixed(0)}ms 대기 (${i+1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    return r;
  }
}

function pruneMessages(msgs) {
  const max = MAX_MSG_PAIRS * 2;
  if (msgs.length <= max) return msgs;
  return [msgs[0], ...msgs.slice(-(max - 1))];
}

function emitChunked(res, text) {
  const chunks = text.match(/[\s\S]{1,80}/g) || [text];
  for (const c of chunks) writeSSE(res, { text: c });
}

// ═══════════════════════════════════════════════════════════════════
// 5. 시스템 프롬프트 빌더
// ═══════════════════════════════════════════════════════════════════
function buildClaudeSystem(freestyle, extra) {
  if (freestyle) return '자유롭게 대화하는 AI 어시스턴트다. 어떤 주제든 제한 없이 답할 수 있다. 한국어로 대화하는 것을 선호한다.';
  const blocks = [
    { type: 'text', text: ASTERION_BASE, cache_control: { type: 'ephemeral' } },
  ];
  if (knowledgeContext.length > 500) {
    blocks.push({
      type: 'text',
      text: `[ASTERION 지식베이스]\n${knowledgeContext}`,
      cache_control: { type: 'ephemeral' },
    });
  }
  if (extra?.trim()) blocks.push({ type: 'text', text: `[추가 시스템]\n${extra.trim()}` });
  return blocks;
}

function buildStringSystem(freestyle, extra) {
  if (freestyle) return '자유롭게 대화하는 AI 어시스턴트다. 어떤 주제든 제한 없이 답할 수 있다. 한국어로 대화하는 것을 선호한다.';
  return [
    ASTERION_BASE,
    knowledgeContext ? `[지식베이스]\n${knowledgeContext}` : '',
    extra?.trim() ? `[추가 시스템]\n${extra.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════
// 6. 메시지 정규화
// ═══════════════════════════════════════════════════════════════════
function normClaude(messages) {
  const pruned = pruneMessages(messages);
  const out = [];
  for (const m of pruned) {
    const text = (m.content || '').trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (out.length && out.at(-1).role === role) out.at(-1).content += '\n' + text;
    else out.push({ role, content: text });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '(시작)' });
  return out;
}

function normGemini(messages) {
  const pruned = pruneMessages(messages);
  const out = [];
  for (const m of pruned) {
    const text = (m.content || '').trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (out.length && out.at(-1).role === role) out.at(-1).parts[0].text += '\n' + text;
    else out.push({ role, parts: [{ text }] });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', parts: [{ text: '(시작)' }] });
  return out;
}

function normGPT(messages, systemPrompt) {
  const pruned = pruneMessages(messages);
  const out = [{ role: 'system', content: systemPrompt }];
  for (const m of pruned) {
    const text = (m.content || '').trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (m.role === 'tool') { out.push(m); continue; }
    if (out.length > 1 && out.at(-1).role === role) {
      if (typeof out.at(-1).content === 'string') out.at(-1).content += '\n' + text;
    } else { out.push({ role, content: text }); }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// 7. ★ Claude — Native MCP Connector + Extended Thinking + Prompt Caching
// ═══════════════════════════════════════════════════════════════════
async function runClaude(apiMsgs, systemBlocks, res) {
  if (!CLAUDE_KEY) { writeSSE(res, { error: 'ANTHROPIC_API_KEY 미설정' }); return; }

  const mcpSseUrl = MCP_SERVER_URL ? buildSSEUrl(MCP_SERVER_URL) : null;

  const headers = {
    'x-api-key':         CLAUDE_KEY,
    'anthropic-version': '2023-06-01',
    'content-type':      'application/json',
    'anthropic-beta':    'mcp-client-2025-11-20',
  };

  const body = {
    model:      CLAUDE_MODEL,
    max_tokens: 16000,
    system:     systemBlocks,
    messages:   apiMsgs,
    thinking:   { type: 'enabled', budget_tokens: 10000 },
  };

  if (mcpSseUrl) {
    body.mcp_servers = [{ type: 'url', url: mcpSseUrl, name: 'asterion-mcp' }];
    body.tools = [{ type: 'mcp_toolset', mcp_server_name: 'asterion-mcp', cache_control: { type: 'ephemeral' } }];
  }

  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude ${response.status}: ${errText.slice(0, 400)}`);
  }

  const result  = await response.json();
  const content = result.content || [];
  const usage   = result.usage;

  if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
    console.log(`[Claude Cache] 읽기:${usage.cache_read_input_tokens||0} 쓰기:${usage.cache_creation_input_tokens||0} 입력:${usage.input_tokens||0}`);
  }

  for (const block of content) {
    if (block.type === 'mcp_tool_use')    writeSSE(res, { tool_call:   { id: block.id, name: block.name, input: block.input } });
    if (block.type === 'mcp_tool_result') writeSSE(res, { tool_result: { name: block.name || 'tool', ok: !block.is_error } });
  }

  for (const block of content) {
    if (block.type === 'text' && block.text) emitChunked(res, block.text);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 8. ★ Gemini — thinkingConfig 최상위 + MCP function calling 루프
// ═══════════════════════════════════════════════════════════════════
async function runGemini(messages, systemPrompt, res) {
  if (!GEMINI_KEY) { writeSSE(res, { error: 'GEMINI_API_KEY 미설정' }); return; }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

  const tools = mcpTools.length > 0 ? [{
    functionDeclarations: mcpTools.map(t => ({
      name: t.name, description: t.description, parameters: t.parameters,
    })),
  }] : undefined;

  let contents = normGemini(messages);
  let depth = 0;

  while (depth < MAX_TOOL_DEPTH) {
    const bodyObj = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {           // ← 일반 설정만
        maxOutputTokens: 65000, temperature: 0.7, topP: 0.95,
      },
      thinkingConfig: {             // ★ 최상위! generationConfig 밖!
        thinkingLevel: 'high',
      },
    };
    if (tools) bodyObj.tools = tools;

    const response = await fetchWithRetry(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini ${response.status}: ${errText.slice(0, 400)}`);
    }

    const result    = await response.json();
    const candidate = result.candidates?.[0];
    if (!candidate) throw new Error('Gemini 응답 없음');

    const parts         = candidate.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);

    if (functionCalls.length === 0) {
      for (const p of parts) { if (p.text && !p.thought) emitChunked(res, p.text); }
      break;
    }

    const functionResponses = [];
    for (const p of functionCalls) {
      const { name, args } = p.functionCall;
      writeSSE(res, { tool_call: { name, input: args } });
      const toolResult = await callMCPTool(name, args || {});
      writeSSE(res, { tool_result: { name, ok: !toolResult.includes('"error"') } });
      functionResponses.push({ functionResponse: { name, response: { result: toolResult } } });
    }

    contents = [...contents, { role: 'model', parts }, { role: 'user', parts: functionResponses }];
    depth++;
  }

  if (depth >= MAX_TOOL_DEPTH) writeSSE(res, { text: '\n[Gemini 도구 호출 최대 깊이 초과]' });
}

// ═══════════════════════════════════════════════════════════════════
// 9. GPT — gpt-5.5 기본형 + MCP function calling 루프
// ═══════════════════════════════════════════════════════════════════
async function runGPT(apiMsgs, res, depth = 0) {
  if (depth > MAX_TOOL_DEPTH) { writeSSE(res, { error: 'GPT 도구 호출 최대 깊이 초과' }); return; }
  if (!OPENAI_KEY) { writeSSE(res, { error: 'OPENAI_API_KEY 미설정' }); return; }

  const gptTools = mcpTools.map(t => ({
    type: 'function',
    function: {
      name:        t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      description: t.description,
      parameters:  t.parameters || { type: 'object', properties: {} },
    },
  }));

  const body = { model: GPT_MODEL, messages: apiMsgs };
  if (gptTools.length > 0) body.tools = gptTools;

  const response = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GPT ${response.status}: ${errText.slice(0, 400)}`);
  }

  const result = await response.json();
  const choice = result.choices?.[0];
  if (!choice) throw new Error('GPT 응답 없음');

  const cached = result.usage?.prompt_tokens_details?.cached_tokens;
  if (cached > 0) console.log(`[GPT Cache] 캐시 적중: ${cached} tokens`);

  if (choice.finish_reason === 'tool_calls') {
    const toolResults = [];
    for (const call of (choice.message.tool_calls || [])) {
      const originalName = mcpTools.find(t =>
        t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) === call.function.name
      )?.name || call.function.name;
      let input = {};
      try { input = JSON.parse(call.function.arguments); } catch (_) {}
      writeSSE(res, { tool_call: { id: call.id, name: originalName, input } });
      const toolResult = await callMCPTool(originalName, input);
      writeSSE(res, { tool_result: { name: originalName, ok: !toolResult.includes('"error"') } });
      toolResults.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
    }
    return runGPT([...apiMsgs, choice.message, ...toolResults], res, depth + 1);
  }

  const text = choice.message?.content || '';
  if (text) emitChunked(res, text);
}

// ═══════════════════════════════════════════════════════════════════
// 10. 채팅 엔드포인트
// ═══════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { model = 'claude', messages = [], system = '', freestyle = false } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    if      (model === 'claude') await runClaude(normClaude(messages), buildClaudeSystem(freestyle, system), res);
    else if (model === 'gemini') await runGemini(messages, buildStringSystem(freestyle, system), res);
    else if (model === 'gpt')    await runGPT(normGPT(messages, buildStringSystem(freestyle, system)), res);
    else writeSSE(res, { error: `알 수 없는 모델: ${model}` });
  } catch (error) {
    console.error('[Chat]', error.message);
    writeSSE(res, { error: error.message });
  }
  writeDone(res);
  res.end();
});

// ═══════════════════════════════════════════════════════════════════
// 11. 상태 / 지식베이스 / BTR / MCP 엔드포인트
// ═══════════════════════════════════════════════════════════════════
app.get('/api/status', (_req, res) => res.json({
  claude:    { model: CLAUDE_MODEL, thinking: 'extended(10k)', mcp: 'native-API-connector', caching: 'prompt-cache',   api: CLAUDE_KEY ? 'OK' : '⚠ 미설정' },
  gemini:    { model: GEMINI_MODEL, thinking: 'thinkingLevel:high', mcp: `manual(${mcpTools.length}tools)`, caching: 'implicit', api: GEMINI_KEY ? 'OK' : '⚠ 미설정' },
  gpt:       { model: GPT_MODEL,    thinking: 'default',       mcp: `manual(${mcpTools.length}tools)`, caching: 'auto-prefix', api: OPENAI_KEY ? 'OK' : '⚠ 미설정' },
  drive:     { status: knowledgeStatus, chars: knowledgeContext.length },
  mcp:       { connected: !!mcpClient, tools: mcpTools.length, url: MCP_SERVER_URL || '미설정' },
  btrServer: { url: BTR_SERVER_URL || '미설정' },
}));

app.post('/api/reload-knowledge', async (_req, res) => {
  knowledgeContext = ''; knowledgeStatus = 'loading...';
  await loadDriveKnowledge();
  res.json({ status: knowledgeStatus });
});

app.post('/api/btr/start', async (req, res) => res.json(await callBTRServer('/btr/start', req.body)));
app.get('/api/btr/status/:jobId', async (req, res) => {
  if (!BTR_SERVER_URL) return res.json({ error: 'BTR_SERVER_URL 미설정' });
  try { const r = await fetch(`${BTR_SERVER_URL}/btr/status/${req.params.jobId}`); res.json(await r.json()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reconnect-mcp', async (_req, res) => {
  mcpClient = null; mcpTools = [];
  await connectMCP();
  res.json({ connected: !!mcpClient, tools: mcpTools.length });
});

// ═══════════════════════════════════════════════════════════════════
// 12. 서버 시작
// ═══════════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION Hub v2.9 — port ${PORT}`);
  console.log(`   Claude : ${CLAUDE_MODEL} | Extended Thinking(10k) | Native MCP connector ${CLAUDE_KEY ? '✓' : '✗ KEY 미설정'}`);
  console.log(`   Gemini : ${GEMINI_MODEL} | thinkingLevel:high | Function Calling MCP ${GEMINI_KEY ? '✓' : '✗ KEY 미설정'}`);
  console.log(`   GPT    : ${GPT_MODEL} | 기본형 | Function Calling MCP ${OPENAI_KEY ? '✓' : '✗ KEY 미설정'}`);
  console.log(`   MCP    : ${MCP_SERVER_URL || '미설정'} (Gemini/GPT 수동 실행용)`);
  console.log(`   BTR    : ${BTR_SERVER_URL || '미설정'}`);
});
