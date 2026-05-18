/**
 * ASTERION Hub — Chat Backend v3.4
 * - 알림: Short Polling → Server-Sent Events (SSE) 방식으로 전환
 *   백엔드가 5초마다 시트를 체크, 변경 시 연결된 모든 클라이언트에 브로드캐스트
 * - 클라이언트는 EventSource 하나만 유지 (모바일 배터리 절약)
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

const PORT            = process.env.PORT || 8080;
const CLAUDE_KEY      = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY      = process.env.GEMINI_API_KEY    || '';
const OPENAI_KEY      = process.env.OPENAI_API_KEY    || '';
const CLAUDE_MODEL    = 'claude-sonnet-4-6';
const GEMINI_MODEL    = 'gemini-3.1-pro-preview';
const GPT_MODEL       = 'gpt-5.5';
const DRIVE_FOLDER_ID = process.env.ASTERION_KNOWLEDGE_FOLDER_ID || '';
const MCP_SERVER_URL  = process.env.MCP_SERVER_URL  || '';
const BTR_SERVER_URL  = process.env.BTR_SERVER_URL  || '';
const MCP_SECRET_KEY  = process.env.MCP_SECRET_KEY  || '';
const ARCHIVE_SS_ID   = '1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8';
const NOTIF_SHEET     = 'BTRNotifications';
const MAX_MSG_PAIRS   = 20;
const MAX_TOOL_DEPTH  = 8;

// ────────────────────────────────────────────────────────────
// GCP ADC 토큰
// ────────────────────────────────────────────────────────────
async function getGCPToken() {
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: {'Metadata-Flavor':'Google'} });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────
// Drive KB
// ────────────────────────────────────────────────────────────
const ASTERION_BASE = `너는 ASTERION의 내부 전용 AI다. ASTERION은 베딕 점성술(Lahiri 아야남샤)과 명리학을 결합한 에너지 공학 기반 분석 엔진이다. BTR(Birth Time Rectification)을 통해 개인 표준시를 확정하고, S-Class(97점↑ Hard Stop) 달성 이후에만 분석 결과물이 생성된다. asterion-mcp의 모든 도구를 자유롭게 사용한다.

[운영 중인 시스템]
- Archive GAS     : StructureCode 관리, PDF 생성, ExpireDate 기반 개인정보 삭제
- 3자 루브릭      : Claude × Gemini × GPT, Hard Stop = 세 AI 97점↑ AND critical_issues 없음
- ASTERION Flow   : BTR Result Code 기반 구독 분석 (Annual/Monthly/Weekly)
- asterion-mcp    : L0~L6 단일 MCP 서버 (74개 도구), Cloud Run 배포

[핵심 스프레드시트 ID]
- Archive:        1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8
- JuliarCalendar: 1whKvFyWmb-qbR6OJt5dcI6WOJMLB5MUIzNMlJBFeq_g

[중요] 도구 목록을 언급할 때는 반드시 아래 [실제 연결된 MCP 도구] 섹션의 도구 이름만 사용한다. 존재하지 않는 도구를 절대 만들어내지 않는다.

외부 요청에 정확성과 무결성을 최우선으로 하고, 확신하지 못하는 부분은 솔직하게 표현한다.`;

let knowledgeContext = '', knowledgeStatus = 'not_loaded';

async function loadDriveKnowledge() {
  if (!DRIVE_FOLDER_ID) { knowledgeStatus = 'no_folder_configured'; return; }
  try {
    const auth  = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    const drive = google.drive({ version: 'v3', auth });
    const list  = await drive.files.list({ q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`, fields: 'files(id,name,mimeType)', pageSize: 50 });
    const docs  = [];
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
  } catch (e) { knowledgeStatus = `error: ${e.message}`; }
}
loadDriveKnowledge();

// ────────────────────────────────────────────────────────────
// MCP Client
// ────────────────────────────────────────────────────────────
let mcpClient = null, mcpTools = [], mcpRetryTimer = null;
function buildSSEUrl(u) { const s = u.replace(/\/$/, ''); return s.endsWith('/sse') ? s : s + '/sse'; }

async function connectMCP() {
  if (!MCP_SERVER_URL) return;
  if (mcpRetryTimer) { clearTimeout(mcpRetryTimer); mcpRetryTimer = null; }
  try {
    const transport = new SSEClientTransport(new URL(buildSSEUrl(MCP_SERVER_URL)));
    mcpClient = new Client({ name: 'asterion-hub', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    const r = await mcpClient.listTools();
    mcpTools = (r.tools || []).map(t => ({ name: t.name, description: t.description || '', parameters: t.inputSchema || { type:'object', properties:{} } }));
    console.log(`[MCP] 연결 완료. 도구 ${mcpTools.length}개`);
    mcpClient.onclose = () => { mcpClient = null; mcpTools = []; mcpRetryTimer = setTimeout(connectMCP, 30000); };
  } catch (e) {
    console.error('[MCP] 연결 실패:', e.message);
    mcpClient = null; mcpTools = [];
    mcpRetryTimer = setTimeout(connectMCP, 60000);
  }
}
connectMCP();

async function callMCPTool(name, input) {
  if (!mcpClient) return JSON.stringify({ error: 'MCP 서버 미연결' });
  try { const r = await mcpClient.callTool({ name, arguments: input || {} }); return JSON.stringify(r.content).slice(0, 8000); }
  catch (e) { return JSON.stringify({ error: e.message }); }
}

// ────────────────────────────────────────────────────────────
// BTR Notifications — Sheets CRUD
// ────────────────────────────────────────────────────────────
async function fetchBTRNotifications() {
  const tok = await getGCPToken();
  if (!tok) return [];
  try {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(NOTIF_SHEET)}`,
      { headers: { Authorization: `Bearer ${tok}` } }
    );
    if (!r.ok) return [];
    const rows = ((await r.json()).values) || [];
    if (rows.length < 2) return [];
    return rows.slice(1)
      .map((row) => ({
        id:         row[0] || '',
        session_id: row[1] || '',
        type:       row[2] || 'info_request',
        title:      row[3] || '알림',
        content:    row[4] || '',
        status:     row[5] || 'pending',
        created_at: row[6] || '',
      }))
      .filter(n => n.id && n.status === 'pending');
  } catch(e) { console.error('[Notif GET]', e.message); return []; }
}

async function updateNotifStatus(id, status) {
  const tok = await getGCPToken();
  if (!tok) return false;
  try {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(NOTIF_SHEET)}`,
      { headers: { Authorization: `Bearer ${tok}` } }
    );
    if (!r.ok) return false;
    const rows = ((await r.json()).values) || [];
    const rowIdx = rows.findIndex((row, i) => i > 0 && row[0] === id);
    if (rowIdx < 0) return false;
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(`${NOTIF_SHEET}!F${rowIdx + 1}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[status]] }) }
    );
    return true;
  } catch(e) { console.error('[Notif UPDATE]', e.message); return false; }
}

// ────────────────────────────────────────────────────────────
// SSE 브로드캐스터 — 서버가 5초마다 시트를 체크, 변경 시 전송
// (클라이언트는 EventSource 하나만 유지 → 배터리/네트워크 절약)
// ────────────────────────────────────────────────────────────
const notifClients  = new Set();
let   lastNotifHash = '';

function sendToAll(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of notifClients) {
    try { res.write(payload); } catch(_) { notifClients.delete(res); }
  }
}

async function notifBackgroundPoll() {
  try {
    const notifs  = await fetchBTRNotifications();
    const hash    = notifs.map(n => n.id).sort().join(',');
    if (hash !== lastNotifHash) {
      lastNotifHash = hash;
      sendToAll({ notifications: notifs });
      console.log(`[Notif] 변경 감지 → ${notifs.length}건 브로드캐스트`);
    }
  } catch(_) {}
  setTimeout(notifBackgroundPoll, 5000);   // 5초마다 체크
}
notifBackgroundPoll();

// ────────────────────────────────────────────────────────────
// System Prompt Builders
// ────────────────────────────────────────────────────────────
const writeSSE  = (res, p) => res.write(`data: ${JSON.stringify(p)}\n\n`);
const writeDone = (res)    => res.write('data: [DONE]\n\n');

async function fetchWithRetry(url, options, max = 3) {
  for (let i = 0; i < max; i++) {
    const r = await fetch(url, options);
    if ((r.status === 429 || r.status === 503) && i < max - 1) { await new Promise(r => setTimeout(r, Math.pow(2,i)*1500+Math.random()*500)); continue; }
    return r;
  }
}

function pruneMessages(msgs) { const max = MAX_MSG_PAIRS*2; return msgs.length <= max ? msgs : [msgs[0], ...msgs.slice(-(max-1))]; }
function emitChunked(res, text) { for (const c of (text.match(/[\s\S]{1,80}/g) || [text])) writeSSE(res, { text: c }); }

function buildMcpToolSection() {
  if (mcpTools.length === 0) return '';
  const byLayer = {
    L0: mcpTools.filter(t => ['geocode_location','get_timezone','get_planet_positions','get_house_positions','get_navamsa_chart','get_ascendant','get_planet_in_house','get_planet_in_sign','get_current_dasha','get_dasha_timeline','get_dasha_sandhi','get_birth_nakshatra','get_planet_yogas','get_transit_planets','get_full_chart_analysis','get_horoscope_predictions','get_match_report','get_numerology_prediction','get_ashtakvarga_data','astro_check_retrograde','astro_planetary_war_check'].includes(t.name)).map(t=>t.name),
    L1: mcpTools.filter(t => ['create_btr_session','save_runtime_snapshot','get_runtime_snapshot','purge_runtime_state','save_evolution_log','get_evolution_history','validate_sclass_gate','btr_init_candidate_slots','btr_consensus_analyzer','btr_conflict_axis_finder','btr_re_eval_pivots','btr_weight_adjuster','btr_prediction_tester'].includes(t.name)).map(t=>t.name),
    L2: mcpTools.filter(t => ['gcloud_submit','cloudbuild_status','cloudrun_services','artifact_list','cloudrun_set_env','agent_registry_list','agent_registry_register'].includes(t.name)).map(t=>t.name),
    L3: mcpTools.filter(t => ['github_read_file','github_write_file','github_list_files','sheets_read','sheets_write','http_request','get_system_status','append_sheet_row'].includes(t.name)).map(t=>t.name),
    L4: mcpTools.filter(t => ['read_google_doc','create_google_doc','create_spreadsheet','export_doc_as_pdf','delete_drive_file','create_drive_folder','delete_drive_folder','list_drive_contents','list_script_projects','get_script_content','update_script_file','deploy_script_webapp','backup_script_project','delete_artifact_image','list_run_revisions','delete_run_revision','create_btr_report_doc'].includes(t.name)).map(t=>t.name),
    L5: mcpTools.filter(t => ['call_gemini','call_claude','call_gpt'].includes(t.name)).map(t=>t.name),
    L6: mcpTools.filter(t => ['report_generate_btr_code','report_generate_summary','report_add_gemstone_advice','ops_audit_log_exporter','ops_pattern_match_failure'].includes(t.name)).map(t=>t.name),
  };
  const lines = [`\n\n[실제 연결된 MCP 도구 ${mcpTools.length}개 — asterion-mcp]`];
  if (byLayer.L0.length) lines.push(`L0 VedAstro(${byLayer.L0.length}): ${byLayer.L0.join(', ')}`);
  if (byLayer.L1.length) lines.push(`L1 BTR(${byLayer.L1.length}): ${byLayer.L1.join(', ')}`);
  if (byLayer.L2.length) lines.push(`L2 GCloud(${byLayer.L2.length}): ${byLayer.L2.join(', ')}`);
  if (byLayer.L3.length) lines.push(`L3 SystemOps(${byLayer.L3.length}): ${byLayer.L3.join(', ')}`);
  if (byLayer.L4.length) lines.push(`L4 Workspace(${byLayer.L4.length}): ${byLayer.L4.join(', ')}`);
  if (byLayer.L5.length) lines.push(`L5 AI(${byLayer.L5.length}): ${byLayer.L5.join(', ')}`);
  if (byLayer.L6.length) lines.push(`L6 Report/Ops(${byLayer.L6.length}): ${byLayer.L6.join(', ')}`);
  return lines.join('\n');
}

function buildClaudeSystem(freestyle, extra) {
  if (freestyle) return '자유롭게 대화하는 AI 어시스턴트다. 어떤 주제든 제한 없이 답할 수 있다.';
  const blocks = [{ type:'text', text:ASTERION_BASE + buildMcpToolSection(), cache_control:{type:'ephemeral'} }];
  if (knowledgeContext.length > 500) blocks.push({ type:'text', text:`[지식베이스]\n${knowledgeContext}`, cache_control:{type:'ephemeral'} });
  if (extra?.trim()) blocks.push({ type:'text', text:`[추가 시스템]\n${extra.trim()}` });
  return blocks;
}
function buildStringSystem(freestyle, extra) {
  if (freestyle) return '자유롭게 대화하는 AI 어시스턴트다. 어떤 주제든 제한 없이 답할 수 있다.';
  const base = ASTERION_BASE + buildMcpToolSection();
  return [base, knowledgeContext?`[지식베이스]\n${knowledgeContext}`:'', extra?.trim()?`[추가 시스템]\n${extra.trim()}`:''].filter(Boolean).join('\n\n');
}

function normClaude(msgs) {
  const out = [];
  for (const m of pruneMessages(msgs)) {
    const text = (m.content||'').trim(); if (!text) continue;
    const role = m.role==='assistant'?'assistant':'user';
    if (out.length && out.at(-1).role===role) out.at(-1).content += '\n'+text; else out.push({ role, content:text });
  }
  if (!out.length || out[0].role!=='user') out.unshift({ role:'user', content:'(시작)' });
  return out;
}
function normGemini(msgs) {
  const out = [];
  for (const m of pruneMessages(msgs)) {
    const text = (m.content||'').trim(); if (!text) continue;
    const role = m.role==='assistant'?'model':'user';
    if (out.length && out.at(-1).role===role) out.at(-1).parts[0].text += '\n'+text; else out.push({ role, parts:[{text}] });
  }
  if (!out.length || out[0].role!=='user') out.unshift({ role:'user', parts:[{text:'(시작)'}] });
  return out;
}
function normGPTInput(msgs, sys) {
  const out = [];
  if (sys) out.push({ role:'system', content:sys });
  for (const m of pruneMessages(msgs)) {
    const text = (m.content||'').trim(); if (!text) continue;
    out.push({ role:m.role==='assistant'?'assistant':'user', content:text });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// AI Runners
// ────────────────────────────────────────────────────────────
async function runClaude(apiMsgs, systemBlocks, res) {
  if (!CLAUDE_KEY) { writeSSE(res, { error:'ANTHROPIC_API_KEY 미설정' }); return; }
  const mcpSseUrl = MCP_SERVER_URL ? buildSSEUrl(MCP_SERVER_URL) : null;
  const headers = { 'x-api-key':CLAUDE_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json', 'anthropic-beta':'mcp-client-2025-11-20' };
  const body = { model:CLAUDE_MODEL, max_tokens:16000, system:systemBlocks, messages:apiMsgs, thinking:{type:'enabled',budget_tokens:10000} };
  if (mcpSseUrl) {
    const srv = { type:'url', url:mcpSseUrl, name:'asterion-mcp' };
    if (MCP_SECRET_KEY) srv.authorization_token = MCP_SECRET_KEY;
    body.mcp_servers = [srv];
    body.tools = [{ type:'mcp_toolset', mcp_server_name:'asterion-mcp', cache_control:{type:'ephemeral'} }];
  }
  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', { method:'POST', headers, body:JSON.stringify(body) });
  if (!response.ok) throw new Error(`Claude ${response.status}: ${(await response.text()).slice(0,400)}`);
  const result = await response.json();
  const usage  = result.usage;
  if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0)
    console.log(`[Claude Cache] 읽기:${usage.cache_read_input_tokens||0} 쓰기:${usage.cache_creation_input_tokens||0}`);
  for (const b of (result.content||[])) {
    if (b.type==='mcp_tool_use')    writeSSE(res, { tool_call:  { id:b.id, name:b.name, input:b.input } });
    if (b.type==='mcp_tool_result') writeSSE(res, { tool_result:{ name:b.name||'tool', ok:!b.is_error } });
  }
  for (const b of (result.content||[])) { if (b.type==='text' && b.text) emitChunked(res, b.text); }
}

async function runGemini(messages, systemPrompt, res) {
  if (!GEMINI_KEY) { writeSSE(res, { error:'GEMINI_API_KEY 미설정' }); return; }
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const tools = mcpTools.length > 0 ? [{ functionDeclarations: mcpTools.map(t=>({ name:t.name, description:t.description, parameters:t.parameters })) }] : undefined;
  let contents = normGemini(messages), depth = 0;
  while (depth < MAX_TOOL_DEPTH) {
    const bodyObj = { systemInstruction:{ parts:[{text:systemPrompt}] }, contents, generationConfig:{ maxOutputTokens:65000, temperature:0.7, topP:0.95 } };
    if (tools) bodyObj.tools = tools;
    const response = await fetchWithRetry(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(bodyObj) });
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0,400)}`);
    const result    = await response.json();
    const candidate = result.candidates?.[0];
    if (!candidate) throw new Error('Gemini 응답 없음');
    const parts = candidate.content?.parts || [];
    const calls = parts.filter(p => p.functionCall);
    if (calls.length === 0) { for (const p of parts) { if (p.text) emitChunked(res, p.text); } break; }
    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      writeSSE(res, { tool_call:{ name, input:args } });
      const r = await callMCPTool(name, args||{});
      writeSSE(res, { tool_result:{ name, ok:!r.includes('"error"') } });
      responses.push({ functionResponse:{ name, response:{ result:r } } });
    }
    contents = [...contents, { role:'model', parts }, { role:'user', parts:responses }];
    depth++;
  }
  if (depth >= MAX_TOOL_DEPTH) writeSSE(res, { text:'\n[Gemini 도구 최대 깊이 초과]' });
}

async function runGPT(inputMsgs, res) {
  if (!OPENAI_KEY) { writeSSE(res, { error:'OPENAI_API_KEY 미설정' }); return; }
  const mcpSseUrl = MCP_SERVER_URL ? buildSSEUrl(MCP_SERVER_URL) : null;
  const body = { model:GPT_MODEL, input:inputMsgs, reasoning:{ effort:'medium' } };
  if (mcpSseUrl) {
    const tool = { type:'mcp', server_label:'asterion-mcp', server_description:'ASTERION BTR 분석 및 Archive 관리 도구', server_url:mcpSseUrl, require_approval:'never' };
    if (MCP_SECRET_KEY) tool.authorization = { type:'bearer', token:MCP_SECRET_KEY };
    body.tools = [tool];
  }
  const response = await fetchWithRetry('https://api.openai.com/v1/responses', {
    method:'POST', headers:{'Authorization':`Bearer ${OPENAI_KEY}`,'Content-Type':'application/json'}, body:JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GPT ${response.status}: ${(await response.text()).slice(0,400)}`);
  const result = await response.json();
  for (const item of (result.output||[])) {
    if (item.type==='message') { for (const c of (item.content||[])) { if (c.type==='text'&&c.text) emitChunked(res, c.text); } }
    if (item.type==='mcp_call')   writeSSE(res, { tool_call:{ name:item.name, input:item.arguments } });
    if (item.type==='mcp_result') writeSSE(res, { tool_result:{ name:item.name||'tool', ok:!item.error } });
  }
}

// ────────────────────────────────────────────────────────────
// API Routes
// ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { model='claude', messages=[], system='', freestyle=false } = req.body;
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  try {
    if      (model==='claude') await runClaude(normClaude(messages), buildClaudeSystem(freestyle,system), res);
    else if (model==='gemini') await runGemini(messages, buildStringSystem(freestyle,system), res);
    else if (model==='gpt')    await runGPT(normGPTInput(messages, buildStringSystem(freestyle,system)), res);
    else writeSSE(res, { error:`알 수 없는 모델: ${model}` });
  } catch (error) { console.error('[Chat]', error.message); writeSSE(res, { error:error.message }); }
  writeDone(res); res.end();
});

// ★ 알림 SSE 스트림 (클라이언트는 EventSource로 연결, 서버가 변경 시에만 전송)
app.get('/api/notifications/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // 연결 즉시 현재 알림 목록 전송
  fetchBTRNotifications().then(notifs => {
    res.write(`data: ${JSON.stringify({ notifications: notifs })}\n\n`);
    lastNotifHash = notifs.map(n => n.id).sort().join(',');
  }).catch(()=>{ res.write('data: {"notifications":[]}\n\n'); });
  notifClients.add(res);
  req.on('close', () => notifClients.delete(res));
  console.log(`[NotifSSE] 클라이언트 연결 (총 ${notifClients.size}개)`);
});

// 폴백: 일회성 GET (EventSource 미지원 환경용)
app.get('/api/notifications', async (_req, res) => {
  res.json({ notifications: await fetchBTRNotifications() });
});

app.post('/api/notifications/:id/respond', async (req, res) => {
  const ok = await updateNotifStatus(req.params.id, 'responded');
  if (ok) {
    // 즉시 브로드캐스트 트리거
    const notifs = await fetchBTRNotifications();
    lastNotifHash = notifs.map(n => n.id).sort().join(',');
    sendToAll({ notifications: notifs });
  }
  res.json({ success: ok });
});

app.delete('/api/notifications/:id', async (req, res) => {
  const ok = await updateNotifStatus(req.params.id, 'dismissed');
  if (ok) {
    const notifs = await fetchBTRNotifications();
    lastNotifHash = notifs.map(n => n.id).sort().join(',');
    sendToAll({ notifications: notifs });
  }
  res.json({ success: ok });
});

app.get('/api/status', (_req, res) => res.json({
  claude:    { model:CLAUDE_MODEL, thinking:'extended(10k)', mcp:'native-API-connector', api:CLAUDE_KEY?'OK':'⚠ 미설정' },
  gemini:    { model:GEMINI_MODEL, thinking:'기본값', mcp:`manual(${mcpTools.length}tools)`, api:GEMINI_KEY?'OK':'⚠ 미설정' },
  gpt:       { model:GPT_MODEL, thinking:'reasoning:medium', mcp:'native-Responses-API', api:OPENAI_KEY?'OK':'⚠ 미설정' },
  drive:     { status:knowledgeStatus, chars:knowledgeContext.length },
  mcp:       { connected:!!mcpClient, tools:mcpTools.length, url:MCP_SERVER_URL||'미설정', secretKey:MCP_SECRET_KEY?'✓':'미설정' },
  notifClients: notifClients.size,
}));

app.post('/api/reload-knowledge', async (_req, res) => {
  knowledgeContext=''; knowledgeStatus='loading...';
  await loadDriveKnowledge();
  res.json({ status:knowledgeStatus });
});

app.post('/api/reconnect-mcp', async (_req, res) => {
  mcpClient=null; mcpTools=[];
  await connectMCP();
  res.json({ connected:!!mcpClient, tools:mcpTools.length });
});

// ────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION Hub v3.4 — port ${PORT}`);
  console.log(`   알림: SSE 브로드캐스트 방식 (5초 서버 체크 → 변경 시에만 전송)`);
  console.log(`   Claude : ${CLAUDE_MODEL} | Native MCP ${CLAUDE_KEY?'✓':'✗'}`);
  console.log(`   Gemini : ${GEMINI_MODEL} | Function Calling ${GEMINI_KEY?'✓':'✗'}`);
  console.log(`   MCP    : ${MCP_SERVER_URL||'미설정'} | tools:${mcpTools.length}`);
});
