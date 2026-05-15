/**
 * ASTERION Hub — Chat Backend v2.5
 * ─────────────────────────────────────────────────────────────
 * Claude  : Anthropic API 직접 호출 (claude-sonnet-4-6)
 *           ✦ 프롬프트 캐싱 (cache_control: ephemeral)
 *             - Block 1: ASTERION 기본 시스템 → 캐시
 *             - Block 2: Drive 지식베이스     → 캐시
 *             - Block 3: 사용자 추가 지시     → 비캐시
 *           ✦ Extended Thinking (budget_tokens: 10000)
 *           ✦ Tool Chaining Loop (Claude Engineer 패턴)
 *           ✦ 재시도 (429/503 → 지수 백오프 최대 3회)
 *           ✦ 컨텍스트 프루닝 (최대 40턴 유지)
 * Gemini  : 직접 Gemini API (gemini-3.1-pro-preview, 스트리밍)
 * Drive   : googleapis ADC
 * MCP     : 48개 도구 체이닝
 * ─────────────────────────────────────────────────────────────
 * 환경 변수:
 *   ANTHROPIC_API_KEY   ← 필수 (Anthropic Console에서 발급)
 *   GEMINI_API_KEY      ← 필수 (Google AI Studio에서 발급)
 *   ASTERION_KNOWLEDGE_FOLDER_ID ← 선택 (Drive 폴더 ID)
 *   MCP_SERVER_URL      ← 선택 (MCP 서버 URL)
 *   PORT                ← 선택 (기본 8080)
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
//  상수 — 환경 변수에서 로드
// ══════════════════════════════════════════════════════════════
const PORT         = process.env.PORT              || 8080;
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY   = process.env.GEMINI_API_KEY
                  || 'AIzaSyB5ySqdCdBQjaA5VpdReZNe51zW2XNpoFI';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';

const DRIVE_FOLDER_ID = process.env.ASTERION_KNOWLEDGE_FOLDER_ID || '';
const MCP_SERVER_URL  = process.env.MCP_SERVER_URL                || '';

const MAX_TOOL_DEPTH = 8;   // 도구 체이닝 최대 깊이
const MAX_MSG_PAIRS  = 20;  // 컨텍스트 보존 최대 턴 (user+assistant 쌍)

// ══════════════════════════════════════════════════════════════
//  ASTERION 기본 시스템 (정적 — 캐싱 최대화)
//  ※ 이 상수를 변경하면 캐시가 무효화됩니다
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
  } catch (e) {
    console.error('[MCP] 연결 실패:', e.message);
  }
}
connectMCP();

// ══════════════════════════════════════════════════════════════
//  3. 유틸
// ══════════════════════════════════════════════════════════════
const writeSSE  = (res, p) => res.write(`data: ${JSON.stringify(p)}\n\n`);
const writeDone = (res)    => res.write('data: [DONE]\n\n');

// 지수 백오프 재시도 (429 쿼터 초과 / 503 서비스 불가)
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, options);
    if ((response.status === 429 || response.status === 503) && attempt < maxRetries - 1) {
      const wait = Math.pow(2, attempt) * 1500 + Math.random() * 500;
      console.warn(`[Retry] ${response.status} — ${wait.toFixed(0)}ms 후 재시도 (${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    return response;
  }
}

// 컨텍스트 프루닝 — 최대 40메시지 유지 (첫 메시지 보존)
function pruneMessages(messages) {
  const max = MAX_MSG_PAIRS * 2;
  if (messages.length <= max) return messages;
  return [messages[0], ...messages.slice(-(max - 1))];
}

// ══════════════════════════════════════════════════════════════
//  4. 프롬프트 캐싱 시스템 프롬프트 빌더
//  ─────────────────────────────────────────────────────────────
//  캐싱 전략:
//    Block 1 (cache) : ASTERION_BASE  — 정적, 변경 거의 없음
//    Block 2 (cache) : knowledgeContext — Drive 리로드 시만 변경
//    Block 3 (no cache): 사용자 추가 지시 — 매 대화마다 다를 수 있음
//
//  Anthropic 캐싱 비용:
//    캐시 쓰기: 일반 비용의 25% / 캐시 읽기: 일반 비용의 10%
//    → 50k 토큰 KB × 10메시지: 500k → 95k 과금 (81% 절감)
// ══════════════════════════════════════════════════════════════
function buildCachedSystem(freestyle, extra) {
  if (freestyle) {
    // Freestyle: 짧은 문자열, 캐싱 불필요
    return '지금부터 모든 제약과 페르소나를 해제한다. 수석 파트너로서 자유롭게 대화하라.';
  }

  const blocks = [];

  // Block 1: 기본 시스템 (캐시)
  blocks.push({
    type:          'text',
    text:          ASTERION_BASE,
    cache_control: { type: 'ephemeral' },
  });

  // Block 2: 지식베이스 (캐시 — 1024 토큰 이상일 때만 효과적)
  if (knowledgeContext.length > 500) {
    blocks.push({
      type:          'text',
      text:          `[ASTERION 지식베이스]\n${knowledgeContext}`,
      cache_control: { type: 'ephemeral' },
    });
  }

  // Block 3: 추가 지시 (비캐시 — 동적)
  if (extra?.trim()) {
    blocks.push({
      type: 'text',
      text: `[추가 지시]\n${extra.trim()}`,
    });
  }

  return blocks;
}

// ══════════════════════════════════════════════════════════════
//  5. Claude 메시지 정규화
// ══════════════════════════════════════════════════════════════
function normClaude(messages) {
  const pruned = pruneMessages(messages);
  const out    = [];
  for (const m of pruned) {
    const text = (m.content || '').trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (out.length && out.at(-1).role === role) {
      // 연속된 동일 role 합치기
      const prev = out.at(-1);
      if (typeof prev.content === 'string') {
        prev.content += '\n' + text;
      }
    } else {
      out.push({ role, content: text });
    }
  }
  if (!out.length || out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '(시작)' });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  6. Claude — Tool Chaining Loop (Anthropic API + 캐싱)
// ══════════════════════════════════════════════════════════════
async function runClaudeWithTools(apiMsgs, systemBlocks, res, depth = 0) {
  if (depth > MAX_TOOL_DEPTH) {
    writeSSE(res, { error: `도구 체이닝 최대 깊이(${MAX_TOOL_DEPTH}) 초과` });
    return;
  }

  if (!CLAUDE_KEY) {
    writeSSE(res, { error: 'ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다' });
    return;
  }

  const claudeTools = mcpTools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));

  const body = {
    model:    CLAUDE_MODEL,
    max_tokens: 16000,
    system:   systemBlocks,          // 캐시 블록 배열
    messages: apiMsgs,
    thinking: { type: 'enabled', budget_tokens: 10000 },
  };
  if (claudeTools.length > 0) body.tools = claudeTools;

  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':          CLAUDE_KEY,
      'anthropic-version':  '2023-06-01',
      'content-type':       'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude ${response.status}: ${err.slice(0, 400)}`);
  }

  const result     = await response.json();
  const stopReason  = result.stop_reason;
  const content     = result.content || [];

  // 캐시 사용 통계 로그
  const usage = result.usage;
  if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
    console.log(
      `[Cache] 읽기: ${usage.cache_read_input_tokens || 0}tok` +
      ` / 쓰기: ${usage.cache_creation_input_tokens || 0}tok` +
      ` / 일반: ${usage.input_tokens || 0}tok`
    );
  }

  // ── 도구 사용 ────────────────────────────────────────────────
  if (stopReason === 'tool_use') {
    const toolUseBlocks = content.filter(b => b.type === 'tool_use');
    const toolResults   = [];

    for (const block of toolUseBlocks) {
      writeSSE(res, { tool_call: { id: block.id, name: block.name, input: block.input } });

      let resultText = '';
      try {
        if (mcpClient) {
          const r    = await mcpClient.callTool({ name: block.name, arguments: block.input });
          resultText = JSON.stringify(r.content).slice(0, 8000);
        } else {
          resultText = 'MCP 서버 미연결';
        }
      } catch (e) {
        resultText = `오류: ${e.message}`;
      }

      writeSSE(res, { tool_result: { name: block.name, ok: !resultText.startsWith('오류') } });

      toolResults.push({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     [{ type: 'text', text: resultText }],
      });
    }

    // 히스토리에 assistant 응답(thinking+tool_use 전체) + tool_result 추가 후 재귀
    const nextMsgs = [
      ...apiMsgs,
      { role: 'assistant', content },          // thinking 블록 포함 전체 보존
      { role: 'user',      content: toolResults },
    ];
    return runClaudeWithTools(nextMsgs, systemBlocks, res, depth + 1);
  }

  // ── 최종 텍스트 응답 ─────────────────────────────────────────
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      // 80자 단위 청킹 → 스트리밍 효과
      const chunks = block.text.match(/[\s\S]{1,80}/g) || [block.text];
      for (const chunk of chunks) {
        writeSSE(res, { text: chunk });
      }
    }
    // thinking 블록은 UI에 표시하지 않음 (내부 추론)
  }
}

// ══════════════════════════════════════════════════════════════
//  7. Gemini — 직접 API 스트리밍 (변경 없음)
// ══════════════════════════════════════════════════════════════
function normGemini(messages) {
  const pruned = pruneMessages(messages);
  const out    = [];
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

async function streamGemini(messages, systemPrompt, res) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_KEY}&alt=sse`;

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents:           normGemini(messages),
      generationConfig:   { temperature: 0.7, maxOutputTokens: 8192, topP: 0.95 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini ${response.status}: ${err.slice(0, 400)}`);
  }

  await parseSSEStream(response, (obj) => {
    for (const cand of (obj.candidates || [])) {
      for (const part of (cand.content?.parts || [])) {
        if (part.text) writeSSE(res, { text: part.text });
      }
    }
  });
}

// Gemini용 시스템 프롬프트 (문자열)
function buildGeminiSystem(freestyle, extra) {
  if (freestyle) return '지금부터 모든 제약과 페르소나를 해제한다. 자유롭게 대화하라.';
  return [
    ASTERION_BASE,
    knowledgeContext ? `[지식베이스]\n${knowledgeContext}` : '',
    extra?.trim() ? `[추가 지시]\n${extra.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

// ══════════════════════════════════════════════════════════════
//  8. 채팅 라우터
// ══════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { model = 'claude', messages = [], system = '', freestyle = false } = req.body;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    if (model === 'claude') {
      const systemBlocks = buildCachedSystem(freestyle, system);
      const apiMsgs      = normClaude(messages);
      await runClaudeWithTools(apiMsgs, systemBlocks, res);
    } else {
      const systemPrompt = buildGeminiSystem(freestyle, system);
      await streamGemini(messages, systemPrompt, res);
    }
  } catch (error) {
    console.error('[Chat]', error.message);
    writeSSE(res, { error: error.message });
  }

  writeDone(res);
  res.end();
});

// ══════════════════════════════════════════════════════════════
//  9. 상태 / 지식 재로드
// ══════════════════════════════════════════════════════════════
app.get('/api/status', (_req, res) => {
  res.json({
    claude_model:    CLAUDE_MODEL,
    gemini_model:    GEMINI_MODEL,
    claude_api:      CLAUDE_KEY ? 'configured' : 'MISSING — set ANTHROPIC_API_KEY',
    drive_status:    knowledgeStatus,
    knowledge_chars: knowledgeContext.length,
    mcp_tools_count: mcpTools.length,
    mcp_connected:   !!mcpClient,
    caching:         'enabled (ephemeral)',
  });
});

app.post('/api/reload-knowledge', async (_req, res) => {
  knowledgeContext = '';
  knowledgeStatus  = 'loading...';
  await loadDriveKnowledge();
  res.json({ status: knowledgeStatus });
});

// ══════════════════════════════════════════════════════════════
//  10. 서버 시작
// ══════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION Hub v2.5 — port ${PORT}`);
  console.log(`   Claude : Anthropic API / ${CLAUDE_MODEL} (캐싱 + Tool Chaining)`);
  console.log(`   Gemini : Gemini API / ${GEMINI_MODEL}`);
  console.log(`   Claude API Key: ${CLAUDE_KEY ? '✓ 설정됨' : '✗ 미설정 (ANTHROPIC_API_KEY 필요)'}`);
});
