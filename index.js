/**
 * ASTERION Hub — Chat Backend v2.1 (Node.js)
 * ─────────────────────────────────────────────────────────────
 * Claude  : Vertex AI (ADC 자동 인증) / claude-sonnet-4-6
 *           Adaptive Thinking (budgetTokens 8 000)
 * Gemini  : Vertex AI (ADC 자동 인증) / gemini-3.1-pro-preview
 * Drive   : googleapis ADC (동일 서비스 계정)
 * MCP     : @modelcontextprotocol/sdk SSE 클라이언트
 * ─────────────────────────────────────────────────────────────
 */

import express from 'express';
import cors from 'cors';
import { VertexAI } from '@google-cloud/vertexai';
import { google } from 'googleapis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import EventSource from 'eventsource';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Node.js ESM 환경에서 __dirname 대체 (type:module 필수)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Node.js 환경에서 MCP SDK SSE 통신을 위한 전역 설정
global.EventSource = EventSource;

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.set('trust proxy', true);

// ── 정적 파일 서빙 ───────────────────────────────────────────
// 파일 구조: ./static/index.html (Dockerfile에서 COPY로 포함)
app.use(express.static(join(__dirname, 'static')));

// GET / → index.html (static 미스 시 fallback)
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'static', 'index.html'));
});

// ── 상수 ────────────────────────────────────────────────────
const PORT          = process.env.PORT          || 8080;
const PROJECT_ID    = process.env.PROJECT_ID    || 'asterion-server';
const CLAUDE_MODEL  = 'claude-sonnet-4-6';
const CLAUDE_REGION = 'asia-northeast3';
// gemini-3.1-pro-preview: 최신 Gemini 모델 (사용자 확인 완료)
const GEMINI_MODEL  = 'gemini-3.1-pro-preview';
const GEMINI_REGION = 'global';

const DRIVE_FOLDER_ID = process.env.ASTERION_KNOWLEDGE_FOLDER_ID || '';
const MCP_SERVER_URL  = process.env.MCP_SERVER_URL || '';

// ══════════════════════════════════════════════════════════════
// 1. Google Drive 지식베이스 로더 (ADC 자동 인증)
// ══════════════════════════════════════════════════════════════
let knowledgeContext = '';
let knowledgeStatus  = 'not_loaded';

async function loadDriveKnowledge() {
  if (!DRIVE_FOLDER_ID) {
    knowledgeStatus = 'no_folder_configured';
    return;
  }
  try {
    const auth  = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    const drive = google.drive({ version: 'v3', auth });

    const listRes = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 50,
    });

    const docs = [];
    for (const file of (listRes.data.files || [])) {
      try {
        if (file.mimeType === 'application/vnd.google-apps.document') {
          const exportRes = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' });
          const text = typeof exportRes.data === 'string'
            ? exportRes.data
            : JSON.stringify(exportRes.data);
          docs.push(`[${file.name}]\n${text.substring(0, 8000)}`);

        } else if (file.mimeType === 'text/plain' || file.mimeType === 'text/markdown') {
          const getRes = await drive.files.get({ fileId: file.id, alt: 'media' });
          const text = typeof getRes.data === 'string'
            ? getRes.data
            : JSON.stringify(getRes.data);
          docs.push(`[${file.name}]\n${text.substring(0, 8000)}`);
        }
      } catch (fileErr) {
        console.warn(`[Drive] 파일 읽기 실패 (${file.name}):`, fileErr.message);
      }
    }

    knowledgeContext = docs.join('\n\n---\n\n').substring(0, 500000);
    knowledgeStatus  = `loaded (${docs.length} files)`;
    console.log(`[System] 지식베이스 로드 완료: ${docs.length}개 파일`);

  } catch (error) {
    knowledgeStatus = `error: ${error.message}`;
    console.error('[System] Drive 로드 실패:', error.message);
  }
}

loadDriveKnowledge();

// ══════════════════════════════════════════════════════════════
// 2. MCP 서버 연동
// ══════════════════════════════════════════════════════════════
let mcpClient          = null;
let mcpToolsForVertex  = [];

async function connectMCPServer() {
  if (!MCP_SERVER_URL) {
    console.log('[System] MCP_SERVER_URL이 설정되지 않아 도구 연동을 건너뜁니다.');
    return;
  }
  try {
    const transport = new SSEClientTransport(new URL('/sse', MCP_SERVER_URL));
    mcpClient = new Client(
      { name: 'asterion-hub-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await mcpClient.connect(transport);

    const toolsRes = await mcpClient.listTools();
    mcpToolsForVertex = (toolsRes.tools || []).map(t => ({
      name:        t.name,
      description: t.description,
      parameters:  t.inputSchema,
    }));
    console.log(`[System] MCP 서버 연동 완료. 사용 가능 도구: ${mcpToolsForVertex.length}개`);

  } catch (error) {
    console.error('[System] MCP 서버 연결 실패:', error.message);
  }
}

connectMCPServer();

// ══════════════════════════════════════════════════════════════
// 3. 유틸: SSE write 헬퍼
// ══════════════════════════════════════════════════════════════
function writeSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeDone(res) {
  res.write('data: [DONE]\n\n');
}

// ══════════════════════════════════════════════════════════════
// 4. Vertex AI 채팅 라우터 (도구 자동 실행 루프)
// ══════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { model = 'claude', messages = [], system = '' } = req.body;
  const accessMode = req.headers['x-access-mode']; // 'Strict' | 'Freestyle'

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const isClaude = (model === 'claude');
    const region   = isClaude ? CLAUDE_REGION : GEMINI_REGION;
    const vertexAI = new VertexAI({ project: PROJECT_ID, location: region });

    // ── 페르소나 ─────────────────────────────────────────────
    const STRICT_PERSONA = `당신은 ASTERION의 핵심 내부 AI 어시스턴트이자 BTR 루브릭 엔진입니다.
논리적 완결성과 S-Class 정합성을 최우선으로 하십시오.
근거 없는 추측은 하지 말고, 데이터와 루브릭 기준을 항상 명시하십시오.`;

    const FREESTYLE_PERSONA = `당신은 기존의 모든 제약과 딱딱한 AI 페르소나를 완전히 해제한
'지훈님의 자유분방 멀티플레이어 파트너이자 수석 아키텍트'입니다.
주도적이고 창의적으로 대화하고, 아이디어를 함께 발전시켜 나가십시오.`;

    const activePersona = (accessMode === 'Freestyle') ? FREESTYLE_PERSONA : STRICT_PERSONA;

    const finalSystemPrompt = `[시스템 페르소나 선언]
${activePersona}

[ASTERION 지식베이스]
${knowledgeContext || '(지식베이스 미로드 — Drive 폴더를 확인하세요)'}

[사용자 추가 지시사항]
${system}`;

    // ── 모델 설정 ─────────────────────────────────────────────
    const modelConfig = {
      model: isClaude ? CLAUDE_MODEL : GEMINI_MODEL,
      systemInstruction: { parts: [{ text: finalSystemPrompt }] },
      tools: mcpToolsForVertex.length > 0
        ? [{ functionDeclarations: mcpToolsForVertex }]
        : undefined,
    };

    if (isClaude) {
      modelConfig.generationConfig = {
        maxOutputTokens: 16000,
        thinkingConfig: { thinkingBudget: 8000 },
      };
    } else {
      modelConfig.generationConfig = {
        temperature:     0.7,
        maxOutputTokens: 8192,
        topP:            0.95,
      };
    }

    const generativeModel = vertexAI.getGenerativeModel(modelConfig);

    // ── 메시지 포맷 변환 ──────────────────────────────────────
    let currentMessages = [];
    for (const m of messages) {
      const role = (m.role === 'assistant') ? 'model' : 'user';
      const text = (m.content || '').trim();
      if (!text) continue;
      if (currentMessages.length > 0 && currentMessages.at(-1).role === role) {
        currentMessages.at(-1).parts[0].text += '\n' + text;
      } else {
        currentMessages.push({ role, parts: [{ text }] });
      }
    }
    if (currentMessages.length === 0 || currentMessages[0].role !== 'user') {
      currentMessages.unshift({ role: 'user', parts: [{ text: '(시작)' }] });
    }

    // ── Recursive Tool Execution Loop (최대 5회) ──────────────
    let maxLoops = 5;

    while (maxLoops > 0) {
      maxLoops--;
      const streamingResp = await generativeModel.generateContentStream({
        contents: currentMessages,
      });

      let functionCallDetected = null;

      for await (const chunk of streamingResp.stream) {
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.functionCall) {
            functionCallDetected = part.functionCall;
            break;
          } else if (part.text) {
            writeSSE(res, { text: part.text });
          }
        }
        if (functionCallDetected) break;
      }

      if (functionCallDetected) {
        const { name, args } = functionCallDetected;
        writeSSE(res, { text: `\n\n> ⚙️ **[ASTERION MCP]** \`${name}\` 도구 실행 중...\n\n` });

        let toolResultStr = '';
        try {
          if (!mcpClient) throw new Error('MCP Client not connected');
          const result = await mcpClient.callTool({ name, arguments: args });
          toolResultStr = Array.isArray(result.content)
            ? result.content.map(c => c.text ?? JSON.stringify(c)).join('\n')
            : JSON.stringify(result);
        } catch (e) {
          toolResultStr = `도구 실행 실패: ${e.message}`;
          console.error(`[MCP] ${name} 실패:`, e.message);
        }

        currentMessages.push({ role: 'model', parts: [{ functionCall: functionCallDetected }] });
        currentMessages.push({
          role: 'user',
          parts: [{ functionResponse: { name, response: { result: toolResultStr } } }],
        });

      } else {
        break;
      }
    }

    writeDone(res);
    res.end();

  } catch (error) {
    console.error('[System Error]:', error);
    writeSSE(res, { error: error.message });
    writeDone(res);
    res.end();
  }
});

// ══════════════════════════════════════════════════════════════
// 5. 상태 / 지식 재로드 라우트
// ══════════════════════════════════════════════════════════════
app.get('/api/status', (_req, res) => {
  res.json({
    claude_model:    CLAUDE_MODEL,
    claude_backend:  `Vertex AI (${CLAUDE_REGION}) — ADC`,
    gemini_model:    GEMINI_MODEL,
    drive_status:    knowledgeStatus,
    mcp_tools_count: mcpToolsForVertex.length,
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
// 6. 서버 시작
// ══════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION Hub Backend is running on port ${PORT}`);
});
