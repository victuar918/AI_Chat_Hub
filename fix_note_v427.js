// ★ v4.2.7 — synthSupertonic 수정 (current_step/total_step int64→int32, 에러 전체 표시)
// 교체할 함수와 에러 핸들러

// 1. 전체 에러 표시 헬퍼
function showFullError(e) {
  const msg = String(e?.message || e);
  // 설정 패널 상태에 전체 메시지 표시
  const el = document.getElementById('st-status-msg');
  if (el) el.textContent = '오류: ' + msg;
  // 콘솔에 전체 출력
  console.error('[TTS 전체 오류]', msg);
  // 토스트에도 최대한 표시 (줄 바꿔서)
  toast(msg.slice(0, 120), 8000);
}

// 2. 수정된 synthSupertonic
async function synthSupertonic(text, sid, steps, speed) {
  if (!stReady) throw new Error('엔진 미준비');
  const ids = textToIds(text), seqLen = ids.length;
  if (!seqLen) throw new Error('입력 없음');
  const spk = voiceData[Math.min(sid, voiceData.length - 1)];
  const tokT  = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, seqLen]);
  const maskT = new ort.Tensor('float32', new Float32Array(seqLen).fill(1.0), [1, 1, seqLen]);
  const sTtl  = new ort.Tensor('float32', spk.style_ttl, spk.dims_ttl);
  const sDp   = new ort.Tensor('float32', spk.style_dp,  spk.dims_dp);

  showTtsProgress('1/4 Duration...');
  const durOut  = await stSess.durPred.run({ text_ids: tokT, style_dp: sDp, text_mask: maskT });
  const durSecs = Array.from(durOut.duration?.data || [1.0])[0];
  const adjDur  = Math.max(0.1, durSecs / (speed || 1.0));
  const sr  = stConfig.sample_rate;
  const bcs = stConfig.base_chunk_size;
  const lDim = stConfig.latent_dim;
  const T_ae = Math.max(1, Math.ceil(adjDur * sr / bcs));
  console.log('[TTS] dur=' + durSecs.toFixed(2) + 's T_ae=' + T_ae + ' lDim=' + lDim);

  showTtsProgress('2/4 Encoding...');
  const encOut  = await stSess.textEnc.run({ text_ids: tokT, style_ttl: sTtl, text_mask: maskT });
  const textEmb = encOut.text_emb;

  // ★ FIX v4.2.7: int64 → int32 (WASM 백엔드 호환)
  const totStepT   = new ort.Tensor('int32', Int32Array.from([steps]), [1]);
  const latentMask = new ort.Tensor('float32', new Float32Array(T_ae).fill(1.0), [1, 1, T_ae]);
  let z = new ort.Tensor('float32', gaussianNoise(lDim * T_ae), [1, lDim, T_ae]);

  for (let step = 0; step < steps; step++) {
    showTtsProgress('3/4 Denoising ' + (step + 1) + '/' + steps + '...');
    const curStepT = new ort.Tensor('int32', Int32Array.from([step]), [1]);
    const veOut = await stSess.vecEst.run({
      noisy_latent: z,
      text_emb:     textEmb,
      style_ttl:    sTtl,
      latent_mask:  latentMask,
      text_mask:    maskT,
      current_step: curStepT,
      total_step:   totStepT,
    });
    z = veOut.denoised_latent;
    console.log('[TTS] step' + step + ' z:', z?.dims?.join('x'));
  }

  showTtsProgress('4/4 Vocoder...');
  const vocOut = await stSess.vocoder.run({ latent: z });
  const audio  = vocOut.wav_tts;
  console.log('[TTS] wav_tts:', audio?.dims?.join('x'), audio?.data?.length, 'samples');
  hideTtsProgress();
  return { samples: Float32Array.from(audio.data), sampleRate: sr };
}