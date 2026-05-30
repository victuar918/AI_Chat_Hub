/**
 * ASTERION Hub — Server-side TTS Module v2
 * Supertonic-TTS-3-ONNX via @huggingface/transformers
 * 출력: MP3 (lamejs 사용, 브라우저 호환성 최상)
 *
 * 화자 매핑 (ASTERION VOICE_CONFIG 기준):
 *   sid 0 → 아스터 (남성, M1) | speed 1.0
 *   sid 1 → 리언  (여성, F1) | speed 0.95
 *   sid 2 → 나레이터 (M2)   | speed 1.05
 *
 * 엔드포인트:
 *   POST /api/tts         { text, sid, speed, format? }  → audio/mpeg or audio/wav
 *   GET  /api/tts/status  → { status, model, speakers }
 */

import { pipeline } from '@huggingface/transformers';
import lamejs from 'lamejs';

// ─────────────────────────────────────────────
const SPEAKER_PRESETS = {
  0: { label: '아스터',   gender: 'M', speakerIdx: 0, speed: 1.0  },
  1: { label: '리언',   gender: 'F', speakerIdx: 1, speed: 0.95 },
  2: { label: '나레이터', gender: 'M', speakerIdx: 2, speed: 1.05 },
};

// ★ Supertonic 3 (31개 언어, v2 호환 ONNX)
const TTS_MODEL          = 'onnx-community/Supertonic-TTS-3-ONNX';
const NUM_INFERENCE_STEPS = 4;
const MP3_BITRATE         = 128; // kbps

let ttsPipeline = null;
let ttsStatus   = 'not_loaded';

// ─────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────
export async function initTTS() {
  try {
    console.log('[TTS] Supertonic-TTS-3-ONNX 로딩 중...');
    ttsPipeline = await pipeline('text-to-speech', TTS_MODEL, {
      dtype: 'fp32',
      device: 'cpu',
    });
    ttsStatus = 'ready';
    console.log('[TTS] 초기화 완료 — Supertonic 3 (31개 언어)');
  } catch(e) {
    ttsStatus = `error: ${e.message}`;
    console.warn('[TTS] 초기화 실패:', e.message);
  }
}

// ─────────────────────────────────────────────
// TTS 생성 → MP3 (default) or WAV Buffer
// ─────────────────────────────────────────────
export async function generateTTS(text, sid = 0, speed = null, format = 'mp3') {
  if (!ttsPipeline) throw new Error('TTS 엔진 초기화 중 또는 실패');

  const preset     = SPEAKER_PRESETS[sid] ?? SPEAKER_PRESETS[0];
  const spkSpeed   = speed ?? preset.speed;
  const taggedText = `<ko>${text}`;  // 한국어 태그

  const output = await ttsPipeline(taggedText, {
    num_inference_steps: NUM_INFERENCE_STEPS,
    speaker_embeddings:  preset.speakerIdx,
    speaking_rate:       spkSpeed,
  });

  const audioData  = output.audio;            // Float32Array
  const sampleRate = output.sampling_rate ?? 44100;

  if (format === 'wav') {
    return { buffer: float32ToWav(audioData, sampleRate), mimeType: 'audio/wav' };
  }

  // 기본: MP3
  return { buffer: float32ToMp3(audioData, sampleRate), mimeType: 'audio/mpeg' };
}

export function getTTSStatus() {
  return { status: ttsStatus, model: TTS_MODEL, version: 3, speakers: SPEAKER_PRESETS };
}

// ─────────────────────────────────────────────
// Float32Array → MP3 (lamejs)
// ─────────────────────────────────────────────
function float32ToMp3(float32Array, sampleRate) {
  const mp3Encoder = new lamejs.Mp3Encoder(1, sampleRate, MP3_BITRATE);
  const BLOCK_SIZE  = 1152;
  const chunks      = [];

  // Float32 → Int16 변환
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    int16[i] = Math.round(Math.max(-1, Math.min(1, float32Array[i])) * 32767);
  }

  // 블록 단위로 인코딩
  for (let i = 0; i < int16.length; i += BLOCK_SIZE) {
    const chunk   = int16.subarray(i, i + BLOCK_SIZE);
    const encoded = mp3Encoder.encodeBuffer(chunk);
    if (encoded.length > 0) chunks.push(Buffer.from(encoded));
  }

  // 플러시
  const flushed = mp3Encoder.flush();
  if (flushed.length > 0) chunks.push(Buffer.from(flushed));

  return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────
// Float32Array → WAV Buffer (fallback)
// ─────────────────────────────────────────────
function float32ToWav(float32Array, sampleRate) {
  const numSamples  = float32Array.length;
  const blockAlign  = 2;
  const dataSize    = numSamples * blockAlign;
  const bufferSize  = 44 + dataSize;
  const buffer      = Buffer.alloc(bufferSize);
  let offset = 0;

  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(bufferSize - 8, offset); offset += 4;
  buffer.write('WAVE', offset); offset += 4;
  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;
  buffer.writeUInt16LE(1, offset); offset += 2;
  buffer.writeUInt16LE(1, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;
  buffer.writeUInt32LE(sampleRate * blockAlign, offset); offset += 4;
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(16, offset); offset += 2;
  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    buffer.writeInt16LE(Math.round(s * 32767), offset);
    offset += 2;
  }
  return buffer;
}
