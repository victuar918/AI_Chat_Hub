/**
 * ASTERION Hub — Server-side TTS Module
 * Supertonic-TTS-2-ONNX via @huggingface/transformers
 *
 * 화자 매핑 (ASTERION VOICE_CONFIG 기준):
 *   sid 0 → 아스터 (남성, M1)
 *   sid 1 → 리언  (여성, F1)
 *   sid 2 → 나레이터 (M2)
 *
 * 엔드포인트: POST /api/tts
 * 요청: { text, sid, speed }
 * 응답: audio/wav (PCM 16bit, 44100Hz)
 */

import { pipeline } from '@huggingface/transformers';

// ─────────────────────────────────────────────
// ASTERION 화자 프리셋
// Supertonic-TTS-2-ONNX 기본 speaker embeddings 인덱스
// ─────────────────────────────────────────────
const SPEAKER_PRESETS = {
  0: { label: '아스터', gender: 'M', speakerIdx: 0 },  // M1
  1: { label: '리언',   gender: 'F', speakerIdx: 1 },  // F1
  2: { label: '나레이터', gender: 'M', speakerIdx: 2 }, // M2
};

const TTS_MODEL  = 'onnx-community/Supertonic-TTS-2-ONNX';
const SAMPLE_RATE = 44100;
const NUM_INFERENCE_STEPS = 4;  // Hub Chat 브라우저 측과 동일

let ttsPipeline = null;
let ttsStatus   = 'not_loaded';

// ─────────────────────────────────────────────
// 초기화 (서버 시작 시 1회)
// ─────────────────────────────────────────────
export async function initTTS() {
  try {
    console.log('[TTS] Supertonic-TTS-2-ONNX 로딩 중...');
    ttsPipeline = await pipeline('text-to-speech', TTS_MODEL, {
      dtype: 'fp32',
      device: 'cpu',
    });
    ttsStatus = 'ready';
    console.log('[TTS] 초기화 완료');
  } catch(e) {
    ttsStatus = `error: ${e.message}`;
    console.warn('[TTS] 초기화 실패:', e.message);
  }
}

// ─────────────────────────────────────────────
// TTS 생성 → WAV Buffer 반환
// ─────────────────────────────────────────────
export async function generateTTS(text, sid = 0, speed = 1.0) {
  if (!ttsPipeline) throw new Error('TTS 엔진 초기화 중 또는 실패');

  const preset   = SPEAKER_PRESETS[sid] ?? SPEAKER_PRESETS[0];
  const taggedText = `<ko>${text}`;  // 한국어 태그 (브라우저 TTS와 동일)

  const output = await ttsPipeline(taggedText, {
    num_inference_steps: NUM_INFERENCE_STEPS,
    speaker_embeddings: preset.speakerIdx,
    speaking_rate: speed,
  });

  // output.audio: Float32Array, output.sampling_rate: number
  const audioData = output.audio;
  const sampleRate = output.sampling_rate ?? SAMPLE_RATE;

  return float32ToWav(audioData, sampleRate);
}

export function getTTSStatus() {
  return { status: ttsStatus, model: TTS_MODEL, speakers: SPEAKER_PRESETS };
}

// ─────────────────────────────────────────────
// Float32Array → WAV Buffer 변환
// ─────────────────────────────────────────────
function float32ToWav(float32Array, sampleRate) {
  const numSamples  = float32Array.length;
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign  = numChannels * bitsPerSample / 8;
  const byteRate    = sampleRate * blockAlign;
  const dataSize    = numSamples * blockAlign;
  const bufferSize  = 44 + dataSize;

  const buffer = Buffer.alloc(bufferSize);
  let offset = 0;

  // RIFF header
  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(bufferSize - 8, offset); offset += 4;
  buffer.write('WAVE', offset); offset += 4;

  // fmt chunk
  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;           // chunk size
  buffer.writeUInt16LE(1, offset); offset += 2;            // PCM
  buffer.writeUInt16LE(numChannels, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;
  buffer.writeUInt32LE(byteRate, offset); offset += 4;
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;

  // data chunk
  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  // PCM samples (Float32 → Int16)
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    buffer.writeInt16LE(Math.round(s * 32767), offset);
    offset += 2;
  }

  return buffer;
}
