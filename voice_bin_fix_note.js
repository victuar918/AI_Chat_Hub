// ★ parseVoiceBin 완전 교체 — tts.json 값 무시, voice.bin 파일크기로만 계산
// 에러 확정값: n_style=8, style_dim=16 (index:2 Expected:16)
function parseVoiceBin(buf, cfg) {
  const view   = new DataView(buf);
  let   offset = 0;
  const numSpk = view.getInt32(offset, true); offset += 4;

  // voice.bin 파일 크기가 유일한 ground truth (tts.json 값은 신뢰하지 않음)
  const totalF  = (buf.byteLength - 4) / 4;
  const perSpkF = totalF / numSpk;

  // n_style=8 확정 (ONNX 모델 에러에서 Expected:8 확인)
  // 두 컴포넌트(TTL, DP)가 동일한 n과 d를 사용한다고 가정:
  //   d = perSpkFloats / (nTtl + nDp) = perSpkFloats / 16
  const nTtl = 8, nDp = 8;
  const d    = Math.round(perSpkF / (nTtl + nDp));
  const dTtl = d, dDp = d;

  const ttlLen = nTtl * dTtl;   // 8*16 = 128
  const dpLen  = nDp  * dDp;    // 8*16 = 128

  console.log(`[TTS voice.bin] numSpk=${numSpk}, fileSize=${buf.byteLength}, ` +
              `perSpkF=${perSpkF.toFixed(0)}, d=${d}, ` +
              `ttl=[1,${nTtl},${dTtl}], dp=[1,${nDp},${dDp}]`);

  const speakers = [];
  for (let s = 0; s < numSpk && offset + (ttlLen + dpLen) * 4 <= buf.byteLength; s++) {
    const st = new Float32Array(buf, offset, ttlLen); offset += ttlLen * 4;
    const sd = new Float32Array(buf, offset, dpLen);  offset += dpLen  * 4;
    speakers.push({
      style_ttl: Float32Array.from(st),
      style_dp:  Float32Array.from(sd),
      dims_ttl:  [1, nTtl, dTtl],
      dims_dp:   [1, nDp,  dDp],
    });
  }
  if (speakers.length === 0) {
    console.error('[TTS] voice.bin 파싱 실패 — expected per-spk bytes:', (ttlLen+dpLen)*4,
                  'actual per-spk floats:', perSpkF.toFixed(0));
  }
  return speakers;
}