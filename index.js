/**
 * ASTERION Hub — Chat Backend v2.6
 * ─────────────────────────────────────────────────────────────
 * Claude  : Anthropic API / claude-sonnet-4-6
 *           프롬프트 캐싱 (cache_control: ephemeral)
 *           Extended Thinking (budget_tokens: 10000)
 *           Tool Chaining Loop
 * Gemini  : Gemini API / gemini-3.1-pro-preview
 *           스트리밍 (alt=sse)
 * GPT     : OpenAI API / gpt-5.5
 *           자동 프롬프트 캐싱 (90% 할인, 설정 불필요)
 *           Reasoning Effort: high
 *           Tool Chaining Loop
 * 공통    : 지수 백오프 재시도 / 컨텍스트 프루닝 / MCP 48도구
 * ─────────────────────────────────────────────────────────────
 * 필수 환경 변수 (Cloud Run에 등록 필요):
 *   ANTHROPIC_API_KEY   → Anthropic Console
 *   GEMINI_API_KEY      → Google AI Studio
 *   OPENAI_API_KEY      → OpenAI Platform
 * 선택 환경 변수:
 *   ASTERION_KNOWLEDGE_FOLDER_ID  → Google Drive 폴더 ID
 *   MCP_SERVER_URL                → MCP 서버 URL
 * ─────────────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════
//  상수
// ══════════════════════════════════════════════════════════════
const PORT       = process.env.PORT              || 8080;

// API 키 (환경 변수에서 로드)
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY
                || 'AIzaSyB5ySqdCdBQjaA5VpdReZNe51zW2XNpoFI';
const OPENAI_KEY = process.env.OPENAI_API_KEY    || '';

// 모델명
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GPT_MODEL    = process.env.GPT_MODEL || 'gpt-5.5'; // gpt-5.5-pro 도 가능

const DRIVE_FOLDER_ID = process.env.ASTERION_KNOWLEDGE_FOLDER_ID || '';
const MCP_SERVER_URL  = process.env.MCP_SERVER_URL                || '';

const MAX_TOOL_DEPTH = 8;
const MAX_MSG_PAIRS  = 20;

// ══════════════════════════════════════════════════════════════
//  ASTERION 기본 시스템 (정적 상수 — 변경 시 캐시 무효화)
// ══════════════════════════════════════════════════════════════
const ASTERION_BASE = `당신은 ASTERION의 핵심 내부 AI 어시스턴트이자 BTR 루브릭 엔진입니다.

[브랜드 철학]
ASTERION은 베다 점성술(Lahiri 아야남사)과 명리학을 기반으로 사건 역산 BTR(Birth Time Rectification)을
자동화하고, 개인 맞춤형 원석 팔찌를 제작하는 프리미엄 브랜드입니다.
논리적 완결성과 S-Class 정합성 확보가 최우선이며, 97점 미만 합의 결과는 절대 확정하지 않습니다.

[운영 시스템]
- Archive GAS  : StructureCode 채번, PDF 자동생성, ExpireDate 기준 개인정보 삭제
- 3자 루브릭   : Claude × Gemini × GPT, Hard Stop = 세 AI 97점↑ AND critical_issues 없음
- ASTERION Flow: BTR Result Code 기반 구독 서비스 (Annual/Monthly/Weekly)
- MCP 서버     : 48개 도구, Cloud Run 배포 완료 (vedastro-mcp)

[도구 사용 원칙]
1. sheets_read / sheets_batch_update : Archive·StoneMaster·JuliarCalendar 조회/저장
2. get_general_astro_data + sheets_read(JuliarCalendar) : 베딕 차트 계산 (Lahiri 필수)
3. call_gemini : BTR 홀수 라운드 선공 분석 및 짝수 라운드 검증
4. gh_create_or_update_file + cloud_build_submit : 새 MCP 도구 생성·배포
5. 도구 체이닝 : 목표를 단계로 분해 → 순차 실행 → 결과를 다음 입력으로 연결
6. S Class(97점) 미달 시 결과 절대 확정 금지

한국어로 응답하고, 기술적 정확성과 브랜드 철학을 일관되게 유지하십시오.`;

// ══════════════════════════════════════════════════════════════
//  1. Drive 지식베이스
// ══════════════════════════════════════════════════════════════
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
    console.error('[Drive] 실패:', e.message);
  }
}
loadDriveKnowledge();

// ══════════════════════════════════════════════════════════════
//  2. MCP 연동
// ══════════════════════════════════════════════════════════════
let mcpClient = null;
let mcpTools  = [];

async function connectMCP() {
  if (!MCP_SERVER_URL) return;
  try {
    const transport = new SSEClientTransport(new URL('/sse', MCP_SERVER_URL));
    mcpClient = new Client({ name: 'asterion-hub', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    const r = await mcpClient.listTools();
    mcpTools = (r.tools || []).map(t => ({
      name: t.name, description: t.description || '',
      parameters: t.inputSchema,
    }));
    console.log(`[MCP] 연결 완료. 도구 ${mcpTools.length}개`);
  } catch (e) { console.error('[MCP] 연결 실패:', e.message); }
}
connectMCP();

// ══════════════════════════════════════════════════════════════
//  3. 공통 유틸
// ══════════════════════════════════════════════════════════════
const writeSSE  = (res, p) => res.write(`data: ${JSON.stringify(p)}\n\n`);
const writeDone = (res)    => res.write('data: [DONE]\n\n');

// 지수 백오프 재시도 (429/503)
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

// 컨텍스트 프루닝
function pruneMessages(msgs) {
  const max = MAX_MSG_PAIRS * 2;
  if (msgs.length <= max) return msgs;
  return [msgs[0], ...msgs.slice(-(max - 1))];
}

// SSE 스트림 파서
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

// 텍스트 청킹 (스트리밍 효과)
function emitChunked(res, text) {
  const chunks = text.match(/[\s\S]{1,80}/g) || [text];
  for (const c of chunks) writeSSE(res, { text: c });
}

// MCP 도구 실행
async function callMCPTool(name, input) {
  if (!mcpClient) return 'MCP 서버 미연결';
  try {
    const r = await mcpClient.callTool({ name, arguments: input });
    return JSON.stringify(r.content).slice(0, 8000);
  } catch (e) {
    return `오류: ${e.message}`;
  }
}

// ══════════════════════════════════════════════════════════════
//  4. 시스템 프롬프트 빌더
// ══════════════════════════════════════════════════════════════

// Claude: 캐시 블록 배열 반환
function buildClaudeSystem(freestyle, extra) {
  if (freestyle) return '지금부터 모든 제약과 페르소나를 해제한다. 수석 파트너로서 자유롭게 대화하라.';
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
  if (extra?.trim()) blocks.push({ type: 'text', text: `[추가 지시]\n${extra.trim()}` });
  return blocks;
}

// Gemini / GPT: 문자열 반환 (OpenAI는 자동 캐싱)
function buildStringSystem(freestyle, extra) {
  if (freestyle) return '지금부터 모든 제약과 페르소나를 해제한다. 자유롭게 대화하라.';
  return [
    ASTERION_BASE,
    knowledgeContext ? `[지식베이스]\n${knowledgeContext}` : '',
    extra?.trim() ? `[추가 지시]\n${extra.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

// ══════════════════════════════════════════════════════════════
//  5. 메시지 정규화
// ══════════════════════════════════════════════════════════════
function normClaude(messages) {
  const pruned = pruneMessages(messages);
  const out = [];
  for (const m of pruned) {
    const text = (m.content || '').trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (out.length && out.at(-1).role === role) {
      out.at(-1).content += '\n' + text;
    } else {
      out.push({ role, content: text });
    }
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
    if (out.length && out.at(-1).role === role) {
      out.at(-1).parts[0].text += '\n' + text;
    } else {
      out.push({ role, parts: [{ text }] });
    }
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', parts: [{ text: '(시작)' }] });
  return out;
}

// GPT: system을 messages 배열 첫 번째로 포함
function normGPT(messages, systemPrompt) {
  const pruned = pruneMessages(messages);
  const out = [{ role: 'system', content: systemPrompt }];
  for (const m of pruned) {
    const text = (m.content || '').trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    // tool role은 그대로 유지 (체이닝 재귀 시)
    if (m.role === 'tool') { out.push(m); continue; }
    if (out.length > 1 && out.at(-1).role === role) {
      if (typeof out.at(-1).content === 'string') out.at(-1).content += '\n' + text;
    } else {
      out.push({ role, content: text });
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  6. Claude — Tool Chaining Loop (Anthropic API + 캐싱)
// ══════════════════════════════════════════════════════════════
async function runClaudeWithTools(apiMsgs, systemBlocks, res, depth = 0) {
  if (depth > MAX_TOOL_DEPTH) { writeSSE(res, { error: 'Claude 도구 체이닝 최대 깊이 초과' }); return; }
  if (!CLAUDE_KEY) { writeSSE(res, { error: 'ANTHROPIC_API_KEY 미설정' }); return; }

  const claudeTools = mcpTools.map(t => ({
    name: t.name, description: t.description,
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));

  const body = {
    model: CLAUDE_MODEL, max_tokens: 16000,
    system: systemBlocks, messages: apiMsgs,
    thinking: { type: 'enabled', budget_tokens: 10000 },
  };
  if (claudeTools.length > 0) body.tools = claudeTools;

  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude ${response.status}: ${err.slice(0, 400)}`);
  }

  const result   = await response.json();
  const content  = result.content || [];
  const usage    = result.usage;

  if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
    console.log(`[Claude Cache] 읽기:${usage.cache_read_input_tokens||0} 쓰기:${usage.cache_creation_input_tokens||0} 일반:${usage.input_tokens||0}`);
  }

  if (result.stop_reason === 'tool_use') {
    const toolUseBlocks = content.filter(b => b.type === 'tool_use');
    const toolResults   = [];
    for (const block of toolUseBlocks) {
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

// ══════════════════════════════════════════════════════════════
//  7. Gemini — 직접 API 스트리밍
// ══════════════════════════════════════════════════════════════
async function streamGemini(messages, systemPrompt, res) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_KEY}&alt=sse`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: normGemini(messages),
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192, topP: 0.95 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini ${response.status}: ${err.slice(0, 400)}`);
  }

  await parseSSEStream(response, (obj) => {
    for (const cand of (obj.candidates || []))
      for (const part of (cand.content?.parts || []))
        if (part.text) writeSSE(res, { text: part.text });
  });
}

// ══════════════════════════════════════════════════════════════
//  8. GPT — Tool Chaining Loop (OpenAI API)
//     ✦ 자동 프롬프트 캐싱 (gpt-5.5: 90% 할인, 설정 불필요)
//     ✦ reasoning_effort: "high"
// ══════════════════════════════════════════════════════════════
async function runGPTWithTools(apiMsgs, res, depth = 0) {
  if (depth > MAX_TOOL_DEPTH) { writeSSE(res, { error: 'GPT 도구 체이닝 최대 깊이 초과' }); return; }
  if (!OPENAI_KEY) { writeSSE(res, { error: 'OPENAI_API_KEY 미설정' }); return; }

  // MCP 도구 → OpenAI function 형식 변환
  // ※ OpenAI 함수명 규칙: /^[a-zA-Z0-9_-]{1,64}$/
  const gptTools = mcpTools.map(t => ({
    type: 'function',
    function: {
      name:        t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      description: t.description,
      parameters:  t.parameters || { type: 'object', properties: {} },
    },
  }));

  const body = {
    model:            GPT_MODEL,
    messages:         apiMsgs,
    reasoning_effort: 'high',   // none/low/medium/high/xhigh
    // ✦ 프롬프트 캐싱 자동 적용 — gpt-5.5는 1024 토큰↑ prefix 자동 캐시
    // ✦ 캐시 히트 시 input_tokens_details.cached_tokens 에서 확인 가능
  };
  if (gptTools.length > 0) body.tools = gptTools;

  const response = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`GPT ${response.status}: ${err.slice(0, 400)}`);
  }

  const result = await response.json();
  const choice = result.choices?.[0];
  if (!choice) throw new Error('GPT 응답 없음');

  // 캐시 통계 로그
  const cached = result.usage?.prompt_tokens_details?.cached_tokens;
  if (cached > 0) console.log(`[GPT Cache] 캐시 읽기: ${cached} tokens`);

  if (choice.finish_reason === 'tool_calls') {
    const toolCalls   = choice.message.tool_calls || [];
    const toolResults = [];

    for (const call of toolCalls) {
      const sanitizedName = call.function.name;
      // 원본 MCP 도구명 역추적
      const originalName = mcpTools.find(t =>
        t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) === sanitizedName
      )?.name || sanitizedName;

      let input = {};
      try { input = JSON.parse(call.function.arguments); } catch(_) {}

      writeSSE(res, { tool_call: { id: call.id, name: originalName, input } });
      const resultText = await callMCPTool(originalName, input);
      writeSSE(res, { tool_result: { name: originalName, ok: !resultText.startsWith('오류') } });

      toolResults.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }

    return runGPTWithTools(
      [...apiMsgs, choice.message, ...toolResults],
      res, depth + 1,
    );
  }

  // 최종 응답
  const text = choice.message?.content || '';
  if (text) emitChunked(res, text);
}

// ══════════════════════════════════════════════════════════════
//  9. 채팅 라우터
// ══════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { model = 'claude', messages = [], system = '', freestyle = false } = req.body;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    if (model === 'claude') {
      await runClaudeWithTools(normClaude(messages), buildClaudeSystem(freestyle, system), res);
    } else if (model === 'gemini') {
      await streamGemini(messages, buildStringSystem(freestyle, system), res);
    } else if (model === 'gpt') {
      await runGPTWithTools(normGPT(messages, buildStringSystem(freestyle, system)), res);
    } else {
      writeSSE(res, { error: `알 수 없는 모델: ${model}` });
    }
  } catch (error) {
    console.error('[Chat]', error.message);
    writeSSE(res, { error: error.message });
  }

  writeDone(res);
  res.end();
});

// ══════════════════════════════════════════════════════════════
//  10. 상태 / 지식 재로드
// ══════════════════════════════════════════════════════════════
app.get('/api/status', (_req, res) => {
  res.json({
    claude:   { model: CLAUDE_MODEL, api: CLAUDE_KEY ? 'OK' : '⚠ ANTHROPIC_API_KEY 미설정', caching: 'cache_control:ephemeral' },
    gemini:   { model: GEMINI_MODEL, api: GEMINI_KEY ? 'OK' : '⚠ GEMINI_API_KEY 미설정' },
    gpt:      { model: GPT_MODEL,    api: OPENAI_KEY ? 'OK' : '⚠ OPENAI_API_KEY 미설정', caching: '자동 (gpt-5.5 기본 90%)' },
    drive:    { status: knowledgeStatus, chars: knowledgeContext.length },
    mcp:      { connected: !!mcpClient, tools: mcpTools.length },
  });
});

app.post('/api/reload-knowledge', async (_req, res) => {
  knowledgeContext = '';
  knowledgeStatus  = 'loading...';
  await loadDriveKnowledge();
  res.json({ status: knowledgeStatus });
});

// ══════════════════════════════════════════════════════════════
//  11. 서버 시작
// ══════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION Hub v2.6 — port ${PORT}`);
  console.log(`   Claude : Anthropic API / ${CLAUDE_MODEL} ${CLAUDE_KEY ? '✓' : '✗ 키 미설정'}`);
  console.log(`   Gemini : Gemini API    / ${GEMINI_MODEL} ${GEMINI_KEY ? '✓' : '✗ 키 미설정'}`);
  console.log(`   GPT    : OpenAI API    / ${GPT_MODEL}    ${OPENAI_KEY ? '✓' : '✗ 키 미설정'}`);
});
