/**
 * ASTERION Hub — Chat Backend v4.3
 * v4.3: /api/tts 서버 사이드 추가 (Supertonic-TTS-2-ONNX, @huggingface/transformers)
 *       Android 앱에서 POST /api/tts { text, sid, speed } → audio/wav 응답
 * v4.2: TTS → 브라우저 사이드 (Supertonic 2 ONNX, transformers.js)
 */

import express    from 'express';
import cors       from 'cors';
import { google } from 'googleapis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import EventSource from 'eventsource';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { initTTS, generateTTS, getTTSStatus } from './tts_server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
global.EventSource = EventSource;

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.set('trust proxy', true);

app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

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
const MCP_SECRET_KEY  = process.env.MCP_SECRET_KEY  || '';
const ARCHIVE_SS_ID   = '1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8';
const VIDEO_SS_ID     = '1ugWJmyLItD95Vz7Jq8Wjxn0_Ml5REjrhUxNZVFoIFmc';
const NOTIF_SHEET     = 'BTRNotifications';
const MAX_MSG_PAIRS   = 20;
const MAX_TOOL_DEPTH  = 15;

// TTS 엔진 비동기 초기화 (서버 시작 후 백그라운드)
initTTS().catch(e => console.warn('[TTS] 초기화 실패:', e.message));

async function getGCPToken() {
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers:{'Metadata-Flavor':'Google'} });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}

// ════ Drive KB ════════════════════════════════════════════════════════
const ASTERION_BASE = `너는 ASTERION의 내부 전용 AI다. ASTERION은 베딕 점성술(Lahiri 아야남샤)과 명리학을 결합한 에너지 공학 기반 분석 엔진이다. BTR(Birth Time Rectification)을 통해 개인 표준시를 확정하고, S-Class(97점↑ Hard Stop) 달성 이후에만 분석 결과물이 생성된다. asterion-mcp의 모든 도구를 자유롭게 사용한다.\n\n[운영 중인 시스템]\n- Archive GAS     : StructureCode 관리, PDF 생성, ExpireDate 기반 개인정보 삭제\n- 3자 루브릭      : Claude × Gemini × GPT, Hard Stop = 세 AI 97점↑ AND critical_issues 없음\n- ASTERION Flow   : BTR Result Code 기반 구독 분석 (Annual/Monthly/Weekly)\n- asterion-mcp    : L0~L6 단일 MCP 서버, Cloud Run 배포\n\n[핵심 스프레드시트 ID]\n- Archive:        1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8\n- VideoAuto:      1ugWJmyLItD95Vz7Jq8Wjxn0_Ml5REjrhUxNZVFoIFmc\n- JuliarCalendar: 1whKvFyWmb-qbR6OJt5dcI6WOJMLB5MUIzNMlJBFeq_g\n\n[알림 시스템]\n- BTRNotifications 시트에서 pending 알림 폴링 (5초 간격 SSE)\n\n[중요] 도구 목록을 언급할 때는 반드시 아래 [실제 연결된 MCP 도구] 섹션의 도구 이름만 사용한다.\n운영 요청에 정확성과 무결성을 최우선으로 한다.`;

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

// ════ MCP Client ════════════════════════════════════════════════════
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
    mcpClient.onclose = () => { mcpClient = null; mcpTools = []; mcpRetryTimer = setTimeout(connectMCP, 3000); };
  } catch (e) {
    console.error('[MCP] 연결 실패:', e.message);
    mcpClient = null; mcpTools = [];
    mcpRetryTimer = setTimeout(connectMCP, 10000);
  }
}
connectMCP();

async function callMCPTool(name, input) {
  let lastErr = 'unavailable';
  for (let att = 0; att < 3; att++) {
    if (!mcpClient) { try { await connectMCP(); } catch (_) {} }
    if (mcpClient) {
      try { const r = await mcpClient.callTool({ name, arguments: input || {} }); return JSON.stringify(r.content).slice(0, 8000); }
      catch (e) { lastErr = e.message; mcpClient = null; }
    }
    await new Promise(w => setTimeout(w, 1200));
  }
  return JSON.stringify({ error: 'MCP retry failed: ' + lastErr });
}
async function callMCPToolLegacy(name, input) {
  if (!mcpClient) return JSON.stringify({ error: 'MCP 서버 미연결' });
  try { const r = await mcpClient.callTool({ name, arguments: input || {} }); return JSON.stringify(r.content).slice(0, 8000); }
  catch (e) { return JSON.stringify({ error: e.message }); }
}

// ════ BTR Notifications ════════════════════════════════════════════
async function fetchBTRNotifications() {
  const tok = await getGCPToken(); if (!tok) return [];
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(NOTIF_SHEET)}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return [];
    const rows = ((await r.json()).values) || []; if (rows.length < 2) return [];
    return rows.slice(1).map(row => ({ id:row[0]||'', session_id:row[1]||'', type:row[2]||'info_request', title:row[3]||'알림', content:row[4]||'', status:row[5]||'pending', created_at:row[6]||'' })).filter(n => n.id && n.status === 'pending');
  } catch(e) { return []; }
}
async function updateNotifStatus(id, status) {
  const tok = await getGCPToken(); if (!tok) return false;
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(NOTIF_SHEET)}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return false;
    const rows = ((await r.json()).values) || [];
    const rowIdx = rows.findIndex((row, i) => i > 0 && row[0] === id); if (rowIdx < 0) return false;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(`${NOTIF_SHEET}!F${rowIdx + 1}`)}?valueInputOption=RAW`, { method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[status]] }) });
    return true;
  } catch(e) { return false; }
}

const notifClients = new Set(); let lastNotifHash = '';
function sendToAll(data) { const p = `data: ${JSON.stringify(data)}\n\n`; for (const res of notifClients) { try{res.write(p);}catch(_){notifClients.delete(res);} } }
async function notifBackgroundPoll() { try { const n=await fetchBTRNotifications(); const h=n.map(x=>x.id).sort().join(','); if(h!==lastNotifHash){lastNotifHash=h;sendToAll({notifications:n});} } catch(_){} setTimeout(notifBackgroundPoll,5000); }
notifBackgroundPoll();

// ════ AI Runners ════════════════════════════════════════════════════
const writeSSE  = (res, p) => res.write(`data: ${JSON.stringify(p)}\n\n`);
const writeDone = (res)    => res.write('data: [DONE]\n\n');
async function fetchWithRetry(url, options, max = 3) { for (let i = 0; i < max; i++) { const r = await fetch(url, options); if ((r.status===429||r.status===503) && i<max-1) { await new Promise(r=>setTimeout(r,Math.pow(2,i)*1500+Math.random()*500)); continue; } return r; } }
function pruneMessages(msgs) { const max=MAX_MSG_PAIRS*2; return msgs.length<=max?msgs:[msgs[0],...msgs.slice(-(max-1))]; }
function emitChunked(res, text) { for (const c of (text.match(/[\s\S]{1,80}/g)||[text])) writeSSE(res,{text:c}); }

function buildMcpToolSection() {
  if (mcpTools.length===0) return '';
  const L0=['geocode_location','get_timezone','get_planet_positions','get_house_positions','get_navamsa_chart','get_ascendant','get_planet_in_house','get_planet_in_sign','get_current_dasha','get_dasha_timeline','get_dasha_sandhi','get_birth_nakshatra','get_planet_yogas','get_transit_planets','get_full_chart_analysis','get_horoscope_predictions','get_match_report','get_numerology_prediction','get_ashtakvarga_data','astro_check_retrograde','astro_planetary_war_check'];
  const L1=['create_btr_session','save_runtime_snapshot','get_runtime_snapshot','purge_runtime_state','save_evolution_log','get_evolution_history','validate_sclass_gate','btr_init_candidate_slots','btr_consensus_analyzer','btr_conflict_axis_finder','btr_re_eval_pivots','btr_weight_adjuster','btr_prediction_tester','btr_write_notification','btr_finalize_confirmed','btr_finalize_held','init_btr_sheets','video_init_sheets','video_create_script','video_read_script','video_update_row_status','video_delete_script'];
  const L2=['gcloud_submit','cloudbuild_status','cloudrun_services','artifact_list','cloudrun_set_env','agent_registry_list','agent_registry_register'];
  const L3=['github_read_file','github_write_file','github_list_files','gh_push_files','github_patch_file','sheets_read','sheets_write','sheets_update_row','http_request','get_system_status','append_sheet_row'];
  const L4=['read_google_doc','create_google_doc','docs_patch','create_spreadsheet','export_doc_as_pdf','delete_drive_file','create_drive_folder','delete_drive_folder','list_drive_contents','list_script_projects','get_script_content','update_script_file','deploy_script_webapp','backup_script_project','delete_artifact_image','list_run_revisions','delete_run_revision','create_btr_report_doc'];
  const L5=['call_gemini','call_claude','call_gpt'];
  const L6=['report_generate_btr_code','report_generate_summary','report_add_gemstone_advice','ops_audit_log_exporter','ops_pattern_match_failure'];
  const f=(names)=>mcpTools.filter(t=>names.includes(t.name)).map(t=>t.name);
  const by={L0:f(L0),L1:f(L1),L2:f(L2),L3:f(L3),L4:f(L4),L5:f(L5),L6:f(L6)};
  const lines=[`\n\n[실제 연결된 MCP 도구 ${mcpTools.length}개 — asterion-mcp]`];
  if(by.L0.length)lines.push(`L0 VedAstro(${by.L0.length}): ${by.L0.join(', ')}`);
  if(by.L1.length)lines.push(`L1 BTR+Video(${by.L1.length}): ${by.L1.join(', ')}`);
  if(by.L2.length)lines.push(`L2 GCloud(${by.L2.length}): ${by.L2.join(', ')}`);
  if(by.L3.length)lines.push(`L3 SystemOps(${by.L3.length}): ${by.L3.join(', ')}`);
  if(by.L4.length)lines.push(`L4 Workspace(${by.L4.length}): ${by.L4.join(', ')}`);
  if(by.L5.length)lines.push(`L5 AI(${by.L5.length}): ${by.L5.join(', ')}`);
  if(by.L6.length)lines.push(`L6 Report/Ops(${by.L6.length}): ${by.L6.join(', ')}`);
  return lines.join('\n');
}

function buildClaudeSystem(freestyle,extra){
  if(freestyle)return '자유롭게 대화하는 AI 어시스턴트다.';
  const blocks=[{type:'text',text:ASTERION_BASE+buildMcpToolSection()+'\n\n[작업 지속성]\n작업을 요청받으면 완료될 때까지 필요한 도구를 스스로 계속 호출하며 다음 단계를 이어간다. 중간 상태만 보고하고 멈추지 않는다. 더 이상 수행할 단계가 없을 때만 최종 답변한다. 불확실하면 사용자에게 되묻기 전에 도구로 먼저 검증하고 진행한다. 여러 단계가 필요한 작업은 한 번의 응답 안에서 끝까지 처리한다.',cache_control:{type:'ephemeral'}}];
  if(knowledgeContext.length>500)blocks.push({type:'text',text:`[지식베이스]\n${knowledgeContext}`,cache_control:{type:'ephemeral'}});
  if(extra?.trim())blocks.push({type:'text',text:`[추가 시스템]\n${extra.trim()}`});
  return blocks;
}
function buildStringSystem(freestyle,extra){
  if(freestyle)return '자유롭게 대화하는 AI 어시스턴트다.';
  const base=ASTERION_BASE+buildMcpToolSection()+'\n\n[작업 지속성]\n작업을 요청받으면 완료될 때까지 필요한 도구를 스스로 계속 호출하며 다음 단계를 이어간다. 중간 상태만 보고하고 멈추지 않는다. 더 이상 수행할 단계가 없을 때만 최종 답변한다. 불확실하면 사용자에게 되묻기 전에 도구로 먼저 검증하고 진행한다. 여러 단계가 필요한 작업은 한 번의 응답 안에서 끝까지 처리한다.';
  return [base,knowledgeContext?`[지식베이스]\n${knowledgeContext}`:'',extra?.trim()?`[추가 시스템]\n${extra.trim()}`:''].filter(Boolean).join('\n\n');
}

function normClaude(msgs){const out=[];for(const m of pruneMessages(msgs)){const text=(m.content||'').trim();if(!text)continue;const role=m.role==='assistant'?'assistant':'user';if(out.length&&out.at(-1).role===role)out.at(-1).content+='\n'+text;else out.push({role,content:text});}if(!out.length||out[0].role!=='user')out.unshift({role:'user',content:'(시작)'});return out;}
function normGemini(msgs){const out=[];for(const m of pruneMessages(msgs)){const text=(m.content||'').trim();if(!text)continue;const role=m.role==='assistant'?'model':'user';if(out.length&&out.at(-1).role===role)out.at(-1).parts[0].text+='\n'+text;else out.push({role,parts:[{text}]});}if(!out.length||out[0].role!=='user')out.unshift({role:'user',parts:[{text:'(시작)'}]});return out;}
function normGPTInput(msgs,sys){const out=[];if(sys)out.push({role:'system',content:sys});for(const m of pruneMessages(msgs)){const text=(m.content||'').trim();if(!text)continue;out.push({role:m.role==='assistant'?'assistant':'user',content:text});}return out;}

async function runClaude(apiMsgs,systemBlocks,res){
  if(!CLAUDE_KEY){writeSSE(res,{error:'ANTHROPIC_API_KEY 미설정'});return;}
  const mcpSseUrl=MCP_SERVER_URL?buildSSEUrl(MCP_SERVER_URL):null;
  const headers={'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json','anthropic-beta':'mcp-client-2025-11-20'};
  const body={model:CLAUDE_MODEL,max_tokens:16000,system:systemBlocks,messages:apiMsgs,thinking:{type:'enabled',budget_tokens:10000}};
  if(mcpSseUrl){const srv={type:'url',url:mcpSseUrl,name:'asterion-mcp'};if(MCP_SECRET_KEY)srv.authorization_token=MCP_SECRET_KEY;body.mcp_servers=[srv];body.tools=[{type:'mcp_toolset',mcp_server_name:'asterion-mcp',cache_control:{type:'ephemeral'}}];}
  const response=await fetchWithRetry('https://api.anthropic.com/v1/messages',{method:'POST',headers,body:JSON.stringify(body)});
  if(!response.ok)throw new Error(`Claude ${response.status}: ${(await response.text()).slice(0,400)}`);
  const result=await response.json();
  const usage=result.usage;
  if(usage?.cache_read_input_tokens>0||usage?.cache_creation_input_tokens>0)console.log(`[Cache] 읽기:${usage.cache_read_input_tokens||0} 쓰기:${usage.cache_creation_input_tokens||0}`);
  for(const b of(result.content||[])){if(b.type==='mcp_tool_use')writeSSE(res,{tool_call:{id:b.id,name:b.name,input:b.input}});if(b.type==='mcp_tool_result')writeSSE(res,{tool_result:{name:b.name||'tool',ok:!b.is_error}});}
  for(const b of(result.content||[])){if(b.type==='text'&&b.text)emitChunked(res,b.text);}
}
async function runGemini(messages,systemPrompt,res){
  if(!GEMINI_KEY){writeSSE(res,{error:'GEMINI_API_KEY 미설정'});return;}
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const tools=mcpTools.length>0?[{functionDeclarations:mcpTools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))}]:undefined;
  let contents=normGemini(messages),depth=0;
  while(depth<MAX_TOOL_DEPTH){
    const bodyObj={systemInstruction:{parts:[{text:systemPrompt}]},contents,generationConfig:{maxOutputTokens:65000,temperature:0.7,topP:0.95}};
    if(tools)bodyObj.tools=tools;
    const response=await fetchWithRetry(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(bodyObj)});
    if(!response.ok)throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0,400)}`);
    const result=await response.json();
    const candidate=result.candidates?.[0];
    if(!candidate)throw new Error('Gemini 응답 없음');
    const parts=candidate.content?.parts||[];
    const calls=parts.filter(p=>p.functionCall);
    if(calls.length===0){for(const p of parts){if(p.text)emitChunked(res,p.text);}break;}
    const responses=[];
    for(const p of calls){
      const{name,args}=p.functionCall;
      writeSSE(res,{tool_call:{name,input:args}});
      const r=await callMCPTool(name,args||{});
      writeSSE(res,{tool_result:{name,ok:!r.includes('"error"')}});
      responses.push({functionResponse:{name,response:{result:r}}});
    }
    contents=[...contents,{role:'model',parts},{role:'user',parts:responses}];
    depth++;
  }
}
async function runGPT(inputMsgs,res){
  if(!OPENAI_KEY){writeSSE(res,{error:'OPENAI_API_KEY 미설정'});return;}
  const mcpSseUrl=MCP_SERVER_URL?buildSSEUrl(MCP_SERVER_URL):null;
  const body={model:GPT_MODEL,input:inputMsgs,reasoning:{effort:'medium'}};
  if(mcpSseUrl){const tool={type:'mcp',server_label:'asterion-mcp',server_description:'ASTERION 도구',server_url:mcpSseUrl,require_approval:'never'};if(MCP_SECRET_KEY)tool.authorization={type:'bearer',token:MCP_SECRET_KEY};body.tools=[tool];}
  const response=await fetchWithRetry('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':`Bearer ${OPENAI_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)throw new Error(`GPT ${response.status}: ${(await response.text()).slice(0,400)}`);
  const result=await response.json();
  for(const item of(result.output||[])){if(item.type==='message'){for(const c of(item.content||[])){if(c.type==='text'&&c.text)emitChunked(res,c.text);}}if(item.type==='mcp_call')writeSSE(res,{tool_call:{name:item.name,input:item.arguments}});if(item.type==='mcp_result')writeSSE(res,{tool_result:{name:item.name||'tool',ok:!item.error}});}
}

async function runDeepSeek(messages,systemPrompt,res){const key=process.env.DEEPSEEK_API_KEY;if(!key){writeSSE(res,{error:'DEEPSEEK_API_KEY 미설정'});return;}const tools=mcpTools.length>0?mcpTools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})):undefined;const msgs=[{role:'system',content:systemPrompt},...normGPTInput(messages,'')];let depth=0;while(depth<MAX_TOOL_DEPTH){const body={model:'deepseek-v4-pro',messages:msgs,thinking:{type:'enabled'},reasoning_effort:'high',stream:false};if(tools){body.tools=tools;body.tool_choice='auto';}const _ac=new AbortController();const _to=setTimeout(()=>_ac.abort(),600000);let response;try{response=await fetchWithRetry('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:_ac.signal});}catch(_e){clearTimeout(_to);if(_e.name==='AbortError')throw new Error('deepseek-v4-pro 응답 시간초과(600s): 무거운 요청 또는 엔드포인트 지연');throw _e;}clearTimeout(_to);if(!response.ok)throw new Error('deepseek-v4-pro '+response.status+': '+(await response.text()).slice(0,400));const result=await response.json();const msg=result.choices?.[0]?.message;if(!msg)throw new Error('deepseek-v4-pro 응답 없음');const calls=msg.tool_calls||[];if(calls.length===0){if(msg.content)emitChunked(res,msg.content);break;}msgs.push({role:'assistant',content:msg.content||'',tool_calls:calls});for(const tc of calls){let args={};try{args=JSON.parse(tc.function.arguments||'{}');}catch(_){}writeSSE(res,{tool_call:{name:tc.function.name,input:args}});const r=await callMCPTool(tc.function.name,args);writeSSE(res,{tool_result:{name:tc.function.name,ok:!r.includes('"error"')}});msgs.push({role:'tool',tool_call_id:tc.id,content:r});}depth++;}}

async function runNvidia(messages,systemPrompt,res,model,enableThinking){const key=process.env.NVIDIA_API_KEY;if(!key){writeSSE(res,{error:'NVIDIA_API_KEY 미설정'});return;}const tools=mcpTools.length>0?mcpTools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})):undefined;const msgs=[{role:'system',content:systemPrompt},...normGPTInput(messages,'')];let depth=0;while(depth<MAX_TOOL_DEPTH){const body={model,messages:msgs,max_tokens:16000,temperature:0.6,top_p:0.95,stream:false};if(tools){body.tools=tools;body.tool_choice='auto';}if(model.indexOf('nemotron')>=0)body.chat_template_kwargs={enable_thinking:!!enableThinking,force_nonempty_content:true};const _ac=new AbortController();const _to=setTimeout(()=>_ac.abort(),600000);let response;try{response=await fetchWithRetry('https://integrate.api.nvidia.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:_ac.signal});}catch(_e){clearTimeout(_to);if(_e.name==='AbortError')throw new Error(model+' 응답 시간초과(600s): 도구 많은 무거운 요청 또는 엔드포인트 지연');throw _e;}clearTimeout(_to);if(!response.ok)throw new Error(model+' '+response.status+': '+(await response.text()).slice(0,400));const result=await response.json();const msg=result.choices?.[0]?.message;if(!msg)throw new Error(model+' 응답 없음');const calls=msg.tool_calls||[];if(calls.length===0){if(msg.content)emitChunked(res,msg.content);break;}msgs.push({role:'assistant',content:msg.content||'',tool_calls:calls});for(const tc of calls){let args={};try{args=JSON.parse(tc.function.arguments||'{}');}catch(_){}writeSSE(res,{tool_call:{name:tc.function.name,input:args}});const r=await callMCPTool(tc.function.name,args);writeSSE(res,{tool_result:{name:tc.function.name,ok:!r.includes('"error"')}});msgs.push({role:'tool',tool_call_id:tc.id,content:r});}depth++;}}

// ════ API Routes ════════════════════════════════════════════════════

// ── Chat Route ──
app.post('/api/chat', async (req, res) => {
  const { model='claude', messages=[], system='', freestyle=false } = req.body;
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');
  try {
    if      (model==='claude') await runClaude(normClaude(messages), buildClaudeSystem(freestyle,system), res);
    else if (model==='gemini') await runNvidia(messages, buildStringSystem(freestyle,system), res, 'nvidia/nemotron-3-ultra-550b-a55b', true);
    else if (model==='gpt')    await runDeepSeek(messages, buildStringSystem(freestyle,system), res);
    else writeSSE(res, { error:`알 수 없는 모델: ${model}` });
  } catch(error) { console.error('[Chat]', error.message); writeSSE(res, { error:error.message }); }
  writeDone(res); res.end();
});

// ── TTS Route (서버 사이드 Supertonic-TTS-2-ONNX) ──
// Android 앱 호출: POST /api/tts { text, sid, speed }
// sid: 0=아스터(남성), 1=리언(여성), 2=나레이터
// 응답: audio/wav (PCM 16bit mono 44100Hz)
app.post('/api/tts', async (req, res) => {
  const { text = '', sid = 0, speed = 1.0 } = req.body;
  if (!text.trim()) return res.status(400).json({ error: 'text 필수' });
  try {
    const wavBuffer = await generateTTS(text, Number(sid), Number(speed));
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', wavBuffer.length);
    res.setHeader('X-TTS-Model', 'Supertonic-TTS-2-ONNX');
    res.setHeader('X-TTS-Speaker', String(sid));
    res.send(wavBuffer);
  } catch(e) {
    console.error('[TTS]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// TTS 상태 확인
app.get('/api/tts/status', (_req, res) => res.json(getTTSStatus()));

// ── SOURCE_FILES 자동 동기화 ──
app.post('/api/sync-source-files', async (req, res) => {
  const { bgv=[], bgm=[], spreadsheet_id=VIDEO_SS_ID } = req.body;
  const tok = await getGCPToken();
  if (!tok) return res.json({ success:false, error:'GCP ADC 실패' });
  const today = new Date().toISOString().slice(0,10);
  const rows = [['Type','Filename','Duration_Sec','Category','Tags','Notes','Last_Sync'],...bgv.map(f=>['BGV',f,'','background-video','','',today]),...bgm.map(f=>['BGM',f,'','background-music','','',today])];
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet_id}/values/${encodeURIComponent('SOURCE_FILES!A1')}?valueInputOption=USER_ENTERED`, { method:'PUT', headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'}, body:JSON.stringify({values:rows}) });
    if (!r.ok) return res.json({ success:false, error:`Sheets ${r.status}` });
    return res.json({ success:true, bgv_count:bgv.length, bgm_count:bgm.length, total_files:bgv.length+bgm.length, synced_at:today });
  } catch(e) { return res.json({ success:false, error:e.message }); }
});

// ── Notification Routes ──
app.get('/api/notifications/stream', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');
  fetchBTRNotifications().then(n=>{res.write(`data: ${JSON.stringify({notifications:n})}\n\n`);lastNotifHash=n.map(x=>x.id).sort().join(',');}).catch(()=>res.write('data: {"notifications":[]}\n\n'));
  notifClients.add(res);req.on('close',()=>notifClients.delete(res));
});
app.get('/api/notifications', async (_req, res) => res.json({ notifications: await fetchBTRNotifications() }));
app.post('/api/notifications/:id/respond', async (req, res) => {
  const ok=await updateNotifStatus(req.params.id,'responded');
  if(ok){const n=await fetchBTRNotifications();lastNotifHash=n.map(x=>x.id).sort().join(',');sendToAll({notifications:n});}
  res.json({success:ok});
});
app.delete('/api/notifications/:id', async (req, res) => {
  const ok=await updateNotifStatus(req.params.id,'dismissed');
  if(ok){const n=await fetchBTRNotifications();lastNotifHash=n.map(x=>x.id).sort().join(',');sendToAll({notifications:n});}
  res.json({success:ok});
});

// ── Status / Utility ──
app.get('/api/status', (_req, res) => res.json({
  claude:     {model:CLAUDE_MODEL,api:CLAUDE_KEY?'OK':'⚠ 미설정'},
  gemini:     {model:GEMINI_MODEL,api:GEMINI_KEY?'OK':'⚠ 미설정'},
  gpt:        {model:GPT_MODEL,api:OPENAI_KEY?'OK':'⚠ 미설정'},
  tts:        getTTSStatus(),
  drive:      {status:knowledgeStatus,chars:knowledgeContext.length},
  mcp:        {connected:!!mcpClient,tools:mcpTools.length,url:MCP_SERVER_URL||'미설정'},
  notifClients: notifClients.size,
  video_ss:   VIDEO_SS_ID,
}));
app.post('/api/reload-knowledge', async (_req, res) => { knowledgeContext=''; knowledgeStatus='loading...'; await loadDriveKnowledge(); res.json({status:knowledgeStatus}); });
app.post('/api/reconnect-mcp', async (_req, res) => { mcpClient=null; mcpTools=[]; await connectMCP(); res.json({connected:!!mcpClient,tools:mcpTools.length}); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION Hub v4.3 — port ${PORT}`);
  console.log(`   TTS    : POST /api/tts (Supertonic-TTS-2-ONNX, 서버 사이드)`);
  console.log(`   Claude : ${CLAUDE_MODEL} ${CLAUDE_KEY?'✓':'✗'}`);
  console.log(`   MCP    : ${MCP_SERVER_URL||'미설정'} | tools:${mcpTools.length}`);
});
