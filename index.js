/**
 * ASTERION Hub — Chat Backend v2.8
 * ─────────────────────────────────────────────────────────────────────
 * Claude  : Anthropic API / claude-sonnet-4-6
 *           Extended Thinking (budget_tokens: 10000) — 최대 사고
 *           Tool Chaining Loop + cache_control:ephemeral
 * Gemini  : Gemini API / gemini-3.1-pro-preview
 *           thinking_level:'high' — 최대 사고 (Gemini 3 Deep Think 수준)
 *           스트리밍 (alt=sse)
 * GPT     : OpenAI API / gpt-5.5
 *           기본형 (reasoning_effort 미지정 = 내부 default)
 *           Tool Chaining Loop
 * 기타    : Google Drive 지식베이스 / MCP 도구 (asterion-mcp)
 * ─────────────────────────────────────────────────────────────────────
 * 필수 환경변수:
 *   ANTHROPIC_API_KEY            → Anthropic Console (직접 API)
 *   GEMINI_API_KEY               → Google AI Studio
 *   OPENAI_API_KEY               → OpenAI Platform
 * 선택 환경변수:
 *   ASTERION_KNOWLEDGE_FOLDER_ID → Google Drive 폴더 ID
 *   MCP_SERVER_URL               → asterion-mcp 서버 SSE URL
 *   BTR_SERVER_URL               → BTR 파이프라인 REST API 서버 URL
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

// ╔═══════════════════════════════════════════════════════════════╗
// ║  설정                                                         ║
// ╚═══════════════════════════════════════════════════════════════╝
const PORT = process.env.PORT || 8080;

// 모든 API 키는 환경변수로 관리 (코드 내 하드코딩 금지)
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY    || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY    || '';

// 모델 하드코딩 (최신 검증 완료 버전 고정)
const CLAUDE_MODEL = 'claude-sonnet-4-6';            // Extended Thinking 사용
const GEMINI_MODEL = 'gemini-3.1-pro-preview';       // thinking_level:'high' 사용
const GPT_MODEL    = 'gpt-5.5';                      // 기본형, reasoning_effort 미지정

const DRIVE_FOLDER_ID = process.env.ASTERION_KNOWLEDGE_FOLDER_ID || '';
const MCP_SERVER_URL  = process.env.MCP_SERVER_URL  || '';
const BTR_SERVER_URL  = process.env.BTR_SERVER_URL  || '';

const MAX_TOOL_DEPTH = 8;
const MAX_MSG_PAIRS  = 20;

// ╔═══════════════════════════════════════════════════════════════╗
// ║  ASTERION 시스템 프롬프트                                      ║
// ╚═══════════════════════════════════════════════════════════════╝
const ASTERION_BASE = `너는 ASTERION의 내부 전용 AI다. ASTERION은 베딕 점성술(Lahiri 아야남샤)과 명리학을 결합한 에너지 공학 기반 분석 엔진이다. BTR(Birth Time Rectification)을 통해 개인 표준시를 확정하고, S-Class(97점↑ Hard Stop) 달성 이후에만 분석 결과물이 생성된다. 현재 작동 중인 도구, 데이터베이스 조회/수정, 에너지구조 분석결과, MCP 도구를 자유롭게 사용한다.

[운영 중인 시스템]
- Archive GAS     : StructureCode 관리, PDF 생성, ExpireDate 기반 개인정보 삭제
- 3자 루브릭      : Claude × Gemini × GPT, Hard Stop = 세 AI 97점↑ AND critical_issues 없음
- ASTERION Flow   : BTR Result Code 기반 구독 분석 (Annual/Monthly/Weekly)
- asterion-mcp    : 단일 MCP 서버 (vedastro-mcp 확장, L0~L3 계층), Cloud Run 배포

[주요 도구]
1. sheets_read / sheets_batch_update : Archive·StoneMaster·JuliarCalendar 조회/갱신
2. get_general_astro_data + sheets_read(JuliarCalendar) : 절입 시각 조회 (Lahiri 아야남샤)
3. geocode_location / get_timezone : 출생지 좌표·DST 계산
4. S Class(97점↑) 달성 이후에만 분석 결과물 생성 가능

외부 요청에 응답할 때는 정확성과 무결성을 최우선으로 하고, 확신하지 못하는 부분은 솔직하게 표현한다.`;

// ╔═══════════════════════════════════════════════════════════════╗
// ║  1. Drive 지식베이스 로드                                     ║
// ╚═══════════════════════════════════════════════════════════════╝
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
        } else if (['text/plain','text/markdown'].includes(f.mimeType)) {
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

// ╔═══════════════════════════════════════════════════════════════╗
// ║  2. MCP 연결 (asterion-mcp, 자동 재연결 포함)                 ║
// ╚═══════════════════════════════════════════════════════════════╝
let mcpClient    = null;
let mcpTools     = [];
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
    mcpTools = (r.tools || []).map(t => ({ name: t.name, description: t.description || '', parameters: t.inputSchema }));
    console.log(`[MCP] 연결 완료. 도구 ${mcpTools.length}개`);
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

// ╔═══════════════════════════════════════════════════════════════╗
// ║  3. BTR 서버 호출 헬퍼                                        ║
// ╚═══════════════════════════════════════════════════════════════╝
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

// ╔═══════════════════════════════════════════════════════════════╗
// ║  4. SSE 유틸리티                                              ║
// ╚═══════════════════════════════════════════════════════════════╝
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

async function parseSSEStream(response, onEvent) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try { onEvent(JSON.parse(raw)); } catch (_) {}
    }
  }
}

function emitChunked(res, text) {
  const chunks = text.match(/[\s\S]{1,80}/g) || [text];
  for (const c of chunks) writeSSE(res, { text: c });
}

async function callMCPTool(name, input) {
  if (!mcpClient) return 'MCP 서버 미연결';
  try {
    const r = await mcpClient.callTool({ name, arguments: input });
    return JSON.stringify(r.content).slice(0, 8000);
  } catch (e) { return `오류: ${e.message}`; }
}

// ╔═══════════════════════════════════════════════════════════════╗
// ║  5. 시스템 프롬프트 빌더                                       ║
// ╚═══════════════════════════════════════════════════════════════╝
function buildClaudeSystem(freestyle, extra) {
  if (freestyle) return '자유롭게 대화하는 AI 어시스턴트다. 어떤 주제든 제한 없이 답할 수 있다. 한국어로 대화하는 것을 선호한다.';
  const blocks = [{ type: 'text', text: ASTERION_BASE, cache_control: { type: 'ephemeral' } }];
  if (knowledgeContext.length > 500) {
    blocks.push({ type: 'text', text: `[ASTERION 지식베이스]\n${knowledgeContext}`, cache_control: { type: 'ephemeral' } });
  }
  if (extra?.trim()) blocks.push({ type: 'text', text: `[추가 시스템]\n${extra.trim()}` });
  return blocks;
}

function buildStringSystem(freestyle, extra) {
  if (freestyle) return '자유롭게 대화하는 AI 어시스턴트다. 어떤 주제든 제한 없이 답할 수 있다. 한국어로 대화하는 것을 선호한다.';
  return [ASTERION_BASE, knowledgeContext ? `[지식베이스]\n${knowledgeContext}` : '', extra?.trim() ? `[추가 시스템]\n${extra.trim()}` : ''].filter(Boolean).join('\n\n');
}

// ╔═══════════════════════════════════════════════════════════════╗
// ║  6. 메시지 정규화                                              ║
// ╚═══════════════════════════════════════════════════════════════╝
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

// ╔═══════════════════════════════════════════════════════════════╗
// ║  7. Claude — Tool Chaining + Extended Thinking               ║
// ╚═══════════════════════════════════════════════════════════════╝
async function runClaudeWithTools(apiMsgs, systemBlocks, res, depth = 0) {
  if (depth > MAX_TOOL_DEPTH) { writeSSE(res, { error: 'Claude 도구 호출 최대 깊이 초과' }); return; }
  if (!CLAUDE_KEY) { writeSSE(res, { error: 'ANTHROPIC_API_KEY 미설정' }); return; }

  const claudeTools = mcpTools.map(t => ({
    name: t.name, description: t.description,
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));

  const body = {
    model: CLAUDE_MODEL, max_tokens: 16000,
    system: systemBlocks, messages: apiMsgs,
    thinking: { type: 'enabled', budget_tokens: 10000 },  // 최대 사고
  };
  if (claudeTools.length > 0) body.tools = claudeTools;

  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) { throw new Error(`Claude ${response.status}: ${(await response.text()).slice(0, 400)}`); }

  const result  = await response.json();
  const content = result.content || [];
  const usage   = result.usage;
  if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
    console.log(`[Claude Cache] 읽기:${usage.cache_read_input_tokens||0} 쓰기:${usage.cache_creation_input_tokens||0}`);
  }

  if (result.stop_reason === 'tool_use') {
    const toolResults = [];
    for (const block of content.filter(b => b.type === 'tool_use')) {
      writeSSE(res, { tool_call: { id: block.id, name: block.name, input: block.input } });
      const resultText = await callMCPTool(block.name, block.input);
      writeSSE(res, { tool_result: { name: block.name, ok: !resultText.startsWith('오류') } });
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text: resultText }] });
    }
    return runClaudeWithTools(
      [...apiMsgs, { role: 'assistant', content }, { role: 'user', content: toolResults }],
      systemBlocks, res, depth + 1,
    );
  }
  for (const block of content) {
    if (block.type === 'text' && block.text) emitChunked(res, block.text);
  }
}

// ╔═══════════════════════════════════════════════════════════════╗
// ║  8. Gemini — 스트리밍 + thinking_level:'high' (최대 사고)     ║
// ╚═══════════════════════════════════════════════════════════════╝
async function streamGemini(messages, systemPrompt, res) {
  if (!GEMINI_KEY) { writeSSE(res, { error: 'GEMINI_API_KEY 미설정' }); return; }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_KEY}&alt=sse`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: normGemini(messages),
      generationConfig: {
        thinking_level: 'high',    // 최대 사고 (Gemini 3.1 Deep Think 수준)
        maxOutputTokens: 65000,    // Gemini 3.1 Pro 최대 출력
        temperature: 0.7,
        topP: 0.95,
      },
    }),
  });

  if (!response.ok) { throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 400)}`); }

  await parseSSEStream(response, (obj) => {
    for (const cand of (obj.candidates || []))
      for (const part of (cand.content?.parts || []))
        if (part.text) writeSSE(res, { text: part.text });
  });
}

// ╔═══════════════════════════════════════════════════════════════╗
// ║  9. GPT — Tool Chaining (gpt-5.5, 기본형)                    ║
// ╚═══════════════════════════════════════════════════════════════╝
async function runGPTWithTools(apiMsgs, res, depth = 0) {
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
  // gpt-5.5 기본형: reasoning_effort 미지정 (내부 default 사용)
  if (gptTools.length > 0) body.tools = gptTools;

  const response = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) { throw new Error(`GPT ${response.status}: ${(await response.text()).slice(0, 400)}`); }

  const result = await response.json();
  const choice = result.choices?.[0];
  if (!choice) throw new Error('GPT 응답 없음');

  const cached = result.usage?.prompt_tokens_details?.cached_tokens;
  if (cached > 0) console.log(`[GPT Cache] 캐시 읽기: ${cached} tokens`);

  if (choice.finish_reason === 'tool_calls') {
    const toolResults = [];
    for (const call of (choice.message.tool_calls || [])) {
      const sanitizedName = call.function.name;
      const originalName  = mcpTools.find(t => t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) === sanitizedName)?.name || sanitizedName;
      let input = {};
      try { input = JSON.parse(call.function.arguments); } catch(_) {}
      writeSSE(res, { tool_call: { id: call.id, name: originalName, input } });
      const resultText = await callMCPTool(originalName, input);
      writeSSE(res, { tool_result: { name: originalName, ok: !resultText.startsWith('오류') } });
      toolResults.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
    return runGPTWithTools([...apiMsgs, choice.message, ...toolResults], res, depth + 1);
  }
  const text = choice.message?.content || '';
  if (text) emitChunked(res, text);
}

// ╔═══════════════════════════════════════════════════════════════╗
// ║  10. 채팅 엔드포인트                                           ║
// ╚═══════════════════════════════════════════════════════════════╝
app.post('/api/chat', async (req, res) => {
  const { model = 'claude', messages = [], system = '', freestyle = false } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    if      (model === 'claude') await runClaudeWithTools(normClaude(messages), buildClaudeSystem(freestyle, system), res);
    else if (model === 'gemini') await streamGemini(messages, buildStringSystem(freestyle, system), res);
    else if (model === 'gpt')    await runGPTWithTools(normGPT(messages, buildStringSystem(freestyle, system)), res);
    else writeSSE(res, { error: `알 수 없는 모델: ${model}` });
  } catch (error) {
    console.error('[Chat]', error.message);
    writeSSE(res, { error: error.message });
  }
  writeDone(res); res.end();
});

// ╔═══════════════════════════════════════════════════════════════╗
// ║  11. 상태 / 지식베이스 / BTR / MCP 엔드포인트                  ║
// ╚═══════════════════════════════════════════════════════════════╝
app.get('/api/status', (_req, res) => res.json({
  claude:    { model: CLAUDE_MODEL, thinking: 'extended (budget:10000)', api: CLAUDE_KEY ? 'OK' : '⚠ 미설정' },
  gemini:    { model: GEMINI_MODEL, thinking: 'thinking_level:high',     api: GEMINI_KEY ? 'OK' : '⚠ 미설정' },
  gpt:       { model: GPT_MODEL,    thinking: '기본형',                   api: OPENAI_KEY ? 'OK' : '⚠ 미설정' },
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

// ╔═══════════════════════════════════════════════════════════════╗
// ║  12. 서버 시작                                                 ║
// ╚═══════════════════════════════════════════════════════════════╝
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION Hub v2.8 — port ${PORT}`);
  console.log(`   Claude : ${CLAUDE_MODEL} + Extended Thinking ${CLAUDE_KEY ? '✓' : '✗ 키 미설정'}`);
  console.log(`   Gemini : ${GEMINI_MODEL} + thinking_level:high ${GEMINI_KEY ? '✓' : '✗ 키 미설정'}`);
  console.log(`   GPT    : ${GPT_MODEL} (기본형) ${OPENAI_KEY ? '✓' : '✗ 키 미설정'}`);
  console.log(`   MCP    : ${MCP_SERVER_URL || '미설정'}`);
  console.log(`   BTR    : ${BTR_SERVER_URL || '미설정'}`);
});
