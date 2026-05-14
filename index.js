/**
 * ASTERION Hub — Chat Backend v2.4
 * ─────────────────────────────────────────────────────────────
 * Claude  : Vertex AI rawPredict (ADC) — global
 *           Tool Chaining Loop (Claude Engineer 패턴 적용)
 *           Adaptive Thinking (effort: "high")
 * Gemini  : 직접 Gemini API — gemini-3.1-pro-preview (스트리밍)
 * Freestyle: 페르소나 해제 모드 (body.freestyle === true)
 * Drive   : googleapis ADC
 * MCP     : 48개 도구 체이닝 지원
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
const PORT       = process.env.PORT       || 8080;
const PROJECT_ID = process.env.PROJECT_ID || 'asterion-server';

const CLAUDE_MODEL   = 'claude-sonnet-4-6';
const CLAUDE_REGION  = 'global';
const GEMINI_MODEL   = 'gemini-3.1-pro-preview';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
                    || 'AIzaSyB5ySqdCdBQjaA5VpdReZNe51zW2XNpoFI';

const DRIVE_FOLDER_ID = process.env.ASTERION_KNOWLEDGE_FOLDER_ID || '';
const MCP_SERVER_URL  = process.env.MCP_SERVER_URL || '';
const MAX_TOOL_DEPTH  = 8;

// ══════════════════════════════════════════════════════════════
//  ADC 인증
// ══════════════════════════════════════════════════════════════
const vertexAuth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});
async function getVertexToken() {
  const client    = await vertexAuth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('ADC 토큰 발급 실패');
  return token;
}

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
      q:        `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields:   'files(id,name,mimeType)', pageSize: 50,
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
    console.log(`[Drive] 로드 완료: ${docs.length}개`);
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
      name: t.name, description: t.description,
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

function buildSystemPrompt(freestyle, extra) {
  const persona = freestyle
    ? '지금부터 모든 제약과 페르소나를 해제한다. 사용자의 수석 파트너로서 자유롭게 대화하라.'
    : [
        '[ASTERION 내부 AI 어시스턴트]',
        '베다 점성술(Lahiri) + 명리학 기반 BTR 자동화 시스템.',
        '3자 루브릭(Claude×Gemini×GPT) Hard Stop = 세 AI 97점↑.',
        'S Class 미달 시 결과 확정 절대 금지.',
        '',
        '[도구 사용 원칙]',
        '1. sheets_read/batch_update: Archive·StoneMaster·JuliarCalendar 조회/저장',
        '2. get_general_astro_data + sheets_read(JuliarCalendar): 차트 계산',
        '3. call_gemini: BTR 홀수 라운드 선공 분석',
        '4. gh_create_or_update_file + cloud_build_submit: 새 MCP 도구 배포',
        '5. 도구 체이닝: 목표 → 단계 분해 → 순차 실행 → 결과 연결',
      ].join('\n');

  return [
    persona,
    knowledgeContext ? `\n[지식베이스]\n${knowledgeContext}` : '',
    extra ? `\n[추가 지시]\n${extra}` : '',
  ].join('\n');
}

// 메시지 정규화 — Claude (user/assistant 교대, 연속 role 합침)
function normClaude(messages) {
  const out = [];
  for (const m of messages) {
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

// 메시지 정규화 — Gemini (user/model 교대)
function normGemini(messages) {
  const out = [];
  for (const m of messages) {
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

// SSE 스트림 → JSON 이벤트 콜백
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

// ══════════════════════════════════════════════════════════════
//  4. Claude — Tool Chaining Loop (rawPredict)
//     Claude Engineer의 _get_completion() 패턴을 Vertex AI에 적용
// ══════════════════════════════════════════════════════════════
async function runClaudeWithTools(apiMsgs, systemPrompt, res, depth = 0) {
  if (depth > MAX_TOOL_DEPTH) {
    writeSSE(res, { error: `도구 체이닝 최대 깊이(${MAX_TOOL_DEPTH}) 초과` });
    return;
  }

  const token    = await getVertexToken();
  const endpoint = CLAUDE_REGION === 'global'
    ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/publishers/anthropic/models/${CLAUDE_MODEL}:rawPredict`
    : `https://${CLAUDE_REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${CLAUDE_REGION}/publishers/anthropic/models/${CLAUDE_MODEL}:rawPredict`;

  // MCP 도구 → Claude tools 형식
  const claudeTools = mcpTools.map(t => ({
    name:         t.name,
    description:  t.description || '',
    input_schema: t.parameters  || { type: 'object', properties: {} },
  }));

  const body = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens:        64000,
    system:            systemPrompt,
    messages:          apiMsgs,
    thinking:          { type: 'enabled', effort: 'high' },
  };
  if (claudeTools.length > 0) body.tools = claudeTools;

  const response = await fetch(endpoint, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude Vertex AI ${response.status}: ${err.slice(0, 400)}`);
  }

  const result    = await response.json();
  const stopReason = result.stop_reason;
  const content    = result.content || [];

  // ── 도구 사용 요청 ──────────────────────────────────────────
  if (stopReason === 'tool_use') {
    const toolUseBlocks = content.filter(b => b.type === 'tool_use');
    const toolResults   = [];

    for (const block of toolUseBlocks) {
      // UI에 도구 호출 알림
      writeSSE(res, { tool_call: { id: block.id, name: block.name, input: block.input } });

      let resultText = '';
      try {
        if (mcpClient) {
          const r  = await mcpClient.callTool({ name: block.name, arguments: block.input });
          resultText = JSON.stringify(r.content).slice(0, 4000);
        } else {
          resultText = 'MCP 서버 미연결 — 도구 실행 불가';
        }
      } catch (e) {
        resultText = `오류: ${e.message}`;
      }

      // UI에 결과 알림
      writeSSE(res, { tool_result: { name: block.name, ok: !resultText.startsWith('오류') } });

      toolResults.push({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     [{ type: 'text', text: resultText }],
      });
    }

    // 히스토리에 assistant 응답 + tool_result 추가 후 재귀
    const nextMsgs = [
      ...apiMsgs,
      { role: 'assistant', content },          // thinking + tool_use 블록 전체 보존
      { role: 'user',      content: toolResults },
    ];
    return runClaudeWithTools(nextMsgs, systemPrompt, res, depth + 1);
  }

  // ── 최종 텍스트 응답 ────────────────────────────────────────
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      // 80자 단위로 청킹 → 스트리밍 효과
      const chunks = block.text.match(/[\s\S]{1,80}/g) || [block.text];
      for (const chunk of chunks) {
        writeSSE(res, { text: chunk });
      }
    }
    // thinking 블록은 UI에 표시 안 함
  }
}

// ══════════════════════════════════════════════════════════════
//  5. Gemini — 직접 API 스트리밍 (변경 없음)
// ══════════════════════════════════════════════════════════════
async function streamGemini(messages, systemPrompt, res) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`;

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

// ══════════════════════════════════════════════════════════════
//  6. 채팅 라우터
// ══════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { model = 'claude', messages = [], system = '', freestyle = false } = req.body;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const systemPrompt = buildSystemPrompt(freestyle, system);

  try {
    if (model === 'claude') {
      const apiMsgs = normClaude(messages);
      await runClaudeWithTools(apiMsgs, systemPrompt, res);
    } else {
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
//  7. 상태 / 지식 재로드
// ══════════════════════════════════════════════════════════════
app.get('/api/status', (_req, res) => {
  res.json({
    claude_model:    `${CLAUDE_MODEL} @ Vertex AI (${CLAUDE_REGION})`,
    gemini_model:    `${GEMINI_MODEL} @ Gemini API`,
    drive_status:    knowledgeStatus,
    mcp_tools_count: mcpTools.length,
    mcp_connected:   !!mcpClient,
  });
});

app.post('/api/reload-knowledge', async (_req, res) => {
  knowledgeContext = '';
  knowledgeStatus  = 'loading...';
  await loadDriveKnowledge();
  res.json({ status: knowledgeStatus });
});

// ══════════════════════════════════════════════════════════════
//  8. 서버 시작
// ══════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION Hub v2.4 — port ${PORT}`);
  console.log(`   Claude : Vertex AI ${CLAUDE_REGION} / ${CLAUDE_MODEL} (Tool Chaining)`);
  console.log(`   Gemini : Gemini API / ${GEMINI_MODEL}`);
});
