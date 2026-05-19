function parseTtsJson(text) {
  try {
    const j = JSON.parse(text);
    console.log('[TTS] tts.json 내용:', JSON.stringify(j).slice(0, 500));
    return {
      sample_rate:           j.sample_rate         || j.sampleRate         || 24000,
      num_speakers:          j.num_speakers         || j.numSpeakers         || 10,
      latent_dim:            j.latent_dim           || j.latentDim           || 8,
      chunk_compress_factor: j.chunk_compress_factor|| j.chunkCompressFactor || 4,
      base_chunk_size:       j.base_chunk_size      || j.baseChunkSize      || 512,
      // n_style: 에러에서 Expected: 8 확인 → 기본값 8
      n_style_ttl:  j.ttl?.style_encoder?.style_token_layer?.num_heads || j.n_style_ttl  || 8,
      style_dim_ttl: j.ttl?.style_encoder?.style_token_layer?.head_size|| j.style_dim_ttl|| null,
      n_style_dp:   j.dp?.style_encoder?.style_token_layer?.num_heads  || j.n_style_dp   || 8,
      style_dim_dp:  j.dp?.style_encoder?.style_token_layer?.head_size || j.style_dim_dp || null,
      _raw: j,
    };
  } catch {
    return { sample_rate:24000, num_speakers:10, latent_dim:8, chunk_compress_factor:4,
             base_chunk_size:512, n_style_ttl:8, style_dim_ttl:null, n_style_dp:8, style_dim_dp:null };
  }
}

function parseVoiceBin(buf, cfg) {
  const view    = new DataView(buf);
  let   offset  = 0;
  const numSpk  = view.getInt32(offset, true); offset += 4;

  // ★ 에러 분석: index:1 Expected:8 → n_style=8 확정
  //   index:2 Got:256 Expected:? → style_dim을 파일 크기로 자동 감지
  const totalFloats   = (buf.byteLength - 4) / 4;
  const perSpkFloats  = totalFloats / numSpk;

  const nTtl = cfg.n_style_ttl || 8;
  const nDp  = cfg.n_style_dp  || 8;

  // tts.json에 값이 없으면 파일 크기로 자동 감지
  let dTtl = cfg.style_dim_ttl;
  let dDp  = cfg.style_dim_dp;

  if (!dTtl || !dDp) {
    // perSpkFloats = nTtl*dTtl + nDp*dDp
    // dTtl == dDp 가정:  d = perSpkFloats / (nTtl + nDp)
    const d = Math.round(perSpkFloats / (nTtl + nDp));
    dTtl = dDp = d;
  }

  console.log(`[TTS voice.bin] numSpk=${numSpk}, perSpkFloats=${perSpkFloats.toFixed(0)}, ` +
              `style_ttl=[1,${nTtl},${dTtl}], style_dp=[1,${nDp},${dDp}]`);

  const ttlLen   = nTtl * dTtl;
  const dpLen    = nDp  * dDp;
  const speakers = [];

  for (let s = 0; s < numSpk && offset + (ttlLen + dpLen) * 4 <= buf.byteLength; s++) {
    const style_ttl = new Float32Array(buf, offset, ttlLen); offset += ttlLen * 4;
    const style_dp  = new Float32Array(buf, offset, dpLen);  offset += dpLen  * 4;
    speakers.push({
      style_ttl: Float32Array.from(style_ttl),
      style_dp:  Float32Array.from(style_dp),
      dims_ttl:  [1, nTtl, dTtl],
      dims_dp:   [1, nDp,  dDp],
    });
  }

  if (speakers.length === 0) {
    console.warn('[TTS] voice.bin 파싱 실패 — 파일 크기:', buf.byteLength);
  }
  return speakers;
}