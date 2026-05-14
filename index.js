/**
 * ASTERION Hub — Chat Backend v2.2 (Node.js)
 * ─────────────────────────────────────────────────────────────
 * Claude  : Vertex AI raw HTTP (ADC) — us-east5
 *           publishers/anthropic  ← SDK 기본값(google) 우회
 *           Adaptive Thinking (budget 8 000 tokens)
 * Gemini  : 직접 Gemini API — generativelanguage.googleapis.com
 *           gemini-3.1-pro-preview (Vertex AI 미등록 모델)
 * Drive   : googleapis ADC (동일 서비스 계정)
 * MCP     : @modelcontextprotocol/sdk SSE 클라이언트
 * ─────────────────────────────────────────────────────────────
 * 수정 이력 v2.1 → v2.2
 *   [Claude] @google-cloud/vertexai SDK 제거
 *            → raw fetch + ADC Bearer 토큰으로 교체
 *            → publishers/google → publishers/anthropic
 *            → asia-northeast3 → us-east5 (Claude 지원 리전)
 *   [Gemini] Vertex AI (location:'global', 미지원 모델) 제거
 *            → generativelanguage.googleapis.com 직접 호출
 *   [공통]   PROJECT_ID 기본값 수정
 * ─────────────────────────────────────────────────────────────
 */

import express   from 'express';
import cors      from 'cors';
import { google } from 'googleapis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import EventSource from 'eventsource';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// MCP SDK SSE 통신용 전역 설정 (Node.js ESM 환경)
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

// Claude: Vertex AI (Anthropic publisher)
// ⚠️ Claude on Vertex AI 지원 리전: us-east5 / us-central1 / europe-west1 / asia-southeast1
//    asia-northeast3(서울)은 미지원 — us-east5 고정
const CLAUDE_MODEL  = 'claude-sonnet-4-6';
const CLAUDE_REGION = 'us-east5';

// Gemini: 직접 API (gemini-3.1-pro-preview는 Vertex AI 미등록)
const GEMINI_MODEL   = 'gemini-3.1-pro-preview';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
                    || 'AIzaSyB5ySqdCdBQjaA5VpdReZNe51zW2XNpoFI';

const DRIVE_FOLDER_ID = process.env.ASTERION_KNOWLEDGE_FOLDER_ID || '';
const MCP_SERVER_URL  = process.env.MCP_SERVER_URL || '';

// ══════════════════════════════════════════════════════════════
//  ADC 인증 헬퍼 (Vertex AI Bearer 토큰)
// ══════════════════════════════════════════════════════════════
const vertexAuth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function getVertexToken() {
  const client        = await vertexAuth.getClient();
  const { token }     = await client.getAccessToken();
  if (!token) throw new Error('Vertex AI ADC 토큰 발급 실패 — 서비스 계정 권한 확인 필요');
  return token;
}

// ══════════════════════════════════════════════════════════════
//  1. Google Drive 지식베이스 로더
// ══════════════════════════════════════════════════════════════
let knowledgeContext = '';
let knowledgeStatus  = 'not_loaded';

async function loadDriveKnowledge() {
  if (!DRIVE_FOLDER_ID) { knowledgeStatus = 'no_folder_configured'; return; }
  try {
    const auth  = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    const drive = google.drive({ version: 'v3', auth });

    const listRes = await drive.files.list({
      q:         `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields:    'files(id, name, mimeType)',
      pageSize:  50,
    });

    const docs = [];
    for (const file of (listRes.data.files || [])) {
      try {
        let text = '';
        if (file.mimeType === 'application/vnd.google-apps.document') {
          const r = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' });
          text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        } else if (['text/plain', 'text/markdown'].includes(file.mimeType)) {
          const r = await drive.files.get({ fileId: file.id, alt: 'media' });
          text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        }
        if (text) docs.push(`[${file.name}]\n${text.substring(0, 8000)}`);
      } catch (e) {
        console.warn(`[Drive] 파일 읽기 실패 (${file.name}):`, e.message);
      }
    }

    knowledgeContext = docs.join('\n\n---\n\n').substring(0, 500000);
    knowledgeStatus  = `loaded (${docs.length} files)`;
    console.log(`[System] 지식베이스 로드 완료: ${docs.length}개 파일`);
  } catch (e) {
    knowledgeStatus = `error: ${e.message}`;
    console.error('[System] Drive 로드 실패:', e.message);
  }
}

loadDriveKnowledge();

// ══════════════════════════════════════════════════════════════
//  2. MCP 서버 연동
// ══════════════════════════════════════════════════════════════
let mcpClient         = null;
let mcpTools          = [];

async function connectMCPServer() {
  if (!MCP_SERVER_URL) return;
  try {
    const transport = new SSEClientTransport(new URL('/sse', MCP_SERVER_URL));
    mcpClient = new Client({ name: 'asterion-hub-client', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    const toolsRes = await mcpClient.listTools();
    mcpTools = (toolsRes.tools || []).map(t => ({
      name: t.name, description: t.description, parameters: t.inputSchema,
    }));
    console.log(`[System] MCP 서버 연동 완료. 도구: ${mcpTools.length}개`);
  } catch (e) {
    console.error('[System] MCP 서버 연결 실패:', e.message);
  }
}

connectMCPServer();

// ══════════════════════════════════════════════════════════════
//  3. 유틸
// ══════════════════════════════════════════════════════════════
function writeSSE(res, payload) { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
function writeDone(res)          { res.write('data: [DONE]\n\n'); }

function buildSystemPrompt(accessMode, extra) {
  const persona = accessMode === 'Freestyle'
    ? `당신은 기존의 모든 제약을 해제한 지훈님의 자유분방 파트너이자 수석 아키텍트입니다. 주도적이고 창의적으로 대화하십시오.`
    : `당신은 ASTERION의 핵심 내부 AI 어시스턴트이자 BTR 루브릭 엔진입니다. 논리적 완결성과 S-Class 정합성을 최우선으로 하십시오.`;

  return `[시스템 페르소나]\n${persona}\n\n` +
         `[ASTERION 지식베이스]\n${knowledgeContext || '(지식베이스 미로드)'}\n\n` +
         `[사용자 추가 지시]\n${extra || ''}`;
}

// ── 메시지 정규화 (Claude: role=user/assistant) ───────────────
function normalizeForClaude(messages) {
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

// ── 메시지 정규화 (Gemini: role=user/model) ─────────────────
function normalizeForGemini(messages) {
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

// ── SSE 스트림 파서 (fetch ReadableStream → 콜백) ────────────
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
//  4. Claude — Vertex AI raw HTTP 스트리밍
//     endpoint: publishers/anthropic  (SDK 기본값 google 아님)
// ══════════════════════════════════════════════════════════════
async function streamClaude(messages, systemPrompt, res) {
  const token    = await getVertexToken();
  const endpoint =
    `https://${CLAUDE_REGION}-aiplatform.googleapis.com/v1/projects/` +
    `${PROJECT_ID}/locations/${CLAUDE_REGION}/publishers/anthropic/models/` +
    `${CLAUDE_MODEL}:streamRawPredict`;

  const response = await fetch(endpoint, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      anthropic_version: 'vertex-2023-10-16',   // Vertex AI 전용 버전 헤더
      max_tokens:        16000,
      system:            systemPrompt,
      messages:          normalizeForClaude(messages),
      stream:            true,
      thinking: {
        type:         'enabled',
        budget_tokens: 8000,                    // Adaptive Thinking
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude Vertex AI ${response.status}: ${err.slice(0, 400)}`);
  }

  await parseSSEStream(response, (obj) => {
    // text_delta만 전달 — thinking_delta(내부 추론)는 제외
    if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta' && obj.delta.text) {
      writeSSE(res, { text: obj.delta.text });
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  5. Gemini — 직접 Gemini API 스트리밍
//     generativelanguage.googleapis.com (Vertex AI 아님)
// ══════════════════════════════════════════════════════════════
async function streamGemini(messages, systemPrompt, res) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`;

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents:           normalizeForGemini(messages),
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
  const { model = 'claude', messages = [], system = '' } = req.body;
  const accessMode = req.headers['x-access-mode'];

  res.setHeader('Content-Type',       'text/event-stream');
  res.setHeader('Cache-Control',      'no-cache');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no');

  try {
    const systemPrompt = buildSystemPrompt(accessMode, system);
    if (model === 'claude') {
      await streamClaude(messages, systemPrompt, res);
    } else {
      await streamGemini(messages, systemPrompt, res);
    }
  } catch (error) {
    console.error('[Chat Error]:', error.message);
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
    mcp_connected:   mcpClient !== null,
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
  console.log(`🔱 ASTERION Hub v2.2 — port ${PORT}`);
  console.log(`   Claude : Vertex AI ${CLAUDE_REGION} / ${CLAUDE_MODEL}`);
  console.log(`   Gemini : Gemini API / ${GEMINI_MODEL}`);
});
