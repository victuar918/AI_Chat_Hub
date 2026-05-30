/**
 * ASTERION Hub — Server-side TTS Module v2.1
 * Supertonic-TTS-3-ONNX via @huggingface/transformers
 * 출력: MP3 (lamejs) or WAV fallback
 */

import { pipeline } from '@huggingface/transformers';
import { createRequire } from 'module';

// lamejs CJS 안전 로드
let lamejs = null;
try {
  const require = createRequire(import.meta.url);
  lamejs = require('lamejs');
  console.log('[TTS] lamejs 로드 성공');
} catch(e) {
  console.warn('[TTS] lamejs 로드 실패 — WAV fallback 모드:', e.message);
}

// 화자 매핑
const SPEAKER_PRESETS = {
  0: { label: '아스터',   gender: 'M', speakerIdx: 0, speed: 1.0  },
  1: { label: '리언',   gender: 'F', speakerIdx: 1, speed: 0.95 },
  2: { label: '나레이터', gender: 'M', speakerIdx: 2, speed: 1.05 },
};

const TTS_MODEL           = 'onnx-community/Supertonic-TTS-3-ONNX';
const NUM_INFERENCE_STEPS = 4;
const MP3_BITRATE         = 128;

let ttsPipeline = null;
let ttsStatus   = 'not_loaded';

export async function initTTS() {
  try {
    console.log('[TTS] Supertonic-TTS-3-ONNX 로딩 중...');
    ttsPipeline = await pipeline('text-to-speech', TTS_MODEL, {
      dtype: 'fp32', device: 'cpu',
    });
    ttsStatus = 'ready';
    console.log('[TTS] 준비 완료 — Supertonic 3 (31개 언어)');
  } catch(e) {
    ttsStatus = `error: ${e.message}`;
    console.warn('[TTS] 실패:', e.message);
  }
}

export async function generateTTS(text, sid = 0, speed = null, format = 'mp3') {
  if (!ttsPipeline) throw new Error('TTS 엔진 미준비');
  const preset   = SPEAKER_PRESETS[sid] ?? SPEAKER_PRESETS[0];
  const spkSpeed = speed ?? preset.speed;

  const output = await ttsPipeline(`<ko>${text}`, {
    num_inference_steps: NUM_INFERENCE_STEPS,
    speaker_embeddings:  preset.speakerIdx,
    speaking_rate:       spkSpeed,
  });

  const audioData  = output.audio;
  const sampleRate = output.sampling_rate ?? 44100;

  // MP3 시도, lamejs 없으면 WAV fallback
  if (format === 'mp3' && lamejs) {
    try {
      return { buffer: float32ToMp3(audioData, sampleRate), mimeType: 'audio/mpeg' };
    } catch(e) {
      console.warn('[TTS] MP3 변환 실패, WAV fallback:', e.message);
    }
  }
  return { buffer: float32ToWav(audioData, sampleRate), mimeType: 'audio/wav' };
}

export function getTTSStatus() {
  return { status: ttsStatus, model: TTS_MODEL, version: 3, mp3: !!lamejs, speakers: SPEAKER_PRESETS };
}

function float32ToMp3(float32Array, sampleRate) {
  const mp3enc = new lamejs.Mp3Encoder(1, sampleRate, MP3_BITRATE);
  const BLOCK  = 1152;
  const chunks = [];
  const int16  = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++)
    int16[i] = Math.round(Math.max(-1, Math.min(1, float32Array[i])) * 32767);
  for (let i = 0; i < int16.length; i += BLOCK) {
    const enc = mp3enc.encodeBuffer(int16.subarray(i, i + BLOCK));
    if (enc.length > 0) chunks.push(Buffer.from(enc));
  }
  const flush = mp3enc.flush();
  if (flush.length > 0) chunks.push(Buffer.from(flush));
  return Buffer.concat(chunks);
}

function float32ToWav(float32Array, sampleRate) {
  const ns  = float32Array.length;
  const ds  = ns * 2;
  const buf = Buffer.alloc(44 + ds);
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(36 + ds, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(16, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(sampleRate * 2, o); o += 4;
  buf.writeUInt16LE(2, o); o += 2;
  buf.writeUInt16LE(16, o); o += 2;
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(ds, o); o += 4;
  for (let i = 0; i < ns; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, float32Array[i])) * 32767), o);
    o += 2;
  }
  return buf;
}
