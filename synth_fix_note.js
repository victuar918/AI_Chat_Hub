// ★ PATCH v4.2.5 — 실제 모델 입출력 이름 기반 완전 수정
// vecEst in: noisy_latent,text_emb,style_ttl,latent_mask,text_mask,current_step,total_step
//        out: denoised_latent
// vocoder in: latent  out: wav_tts

async function synthSupertonic_v4_2_5(text,sid,steps,speed){
  if(!stReady)throw new Error('엔진 미준비');
  const ids=textToIds(text),seqLen=ids.length;if(!seqLen)throw new Error('입력 없음');
  const spk=voiceData[Math.min(sid,voiceData.length-1)];
  const tokT =new ort.Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,seqLen]);
  const maskT=new ort.Tensor('float32',new Float32Array(seqLen).fill(1.0),[1,1,seqLen]);
  const sTtl =new ort.Tensor('float32',spk.style_ttl,spk.dims_ttl);
  const sDp  =new ort.Tensor('float32',spk.style_dp, spk.dims_dp);

  showTtsProgress('1/4 Duration...');
  const durOut=await stSess.durPred.run({text_ids:tokT,style_dp:sDp,text_mask:maskT});
  const durSecs=Array.from(durOut.duration?.data||[1.0])[0];
  const adjDur=Math.max(0.1,durSecs/(speed||1.0));
  const hop=stConfig.hop_samples,lCh=stConfig.latent_channels,sr=stConfig.sample_rate;
  const T=Math.max(1,Math.ceil(adjDur*sr/hop));
  console.log('[TTS] dur='+durSecs.toFixed(2)+'s T='+T+' lCh='+lCh+' hop='+hop+' sr='+sr);

  showTtsProgress('2/4 Encoding...');
  const encOut=await stSess.textEnc.run({text_ids:tokT,style_ttl:sTtl,text_mask:maskT});
  const textEmb=encOut.text_emb;
  console.log('[TTS] textEmb:',textEmb?.dims?.join('x'));

  // latent_mask: same time dimension as z, shape [1,1,T]
  const latentMask=new ort.Tensor('float32',new Float32Array(T).fill(1.0),[1,1,T]);
  // noisy_latent: Gaussian noise, shape [1,lCh,T]
  let z=new ort.Tensor('float32',gaussianNoise(lCh*T),[1,lCh,T]);
  // total_step as int64
  const totStepT=new ort.Tensor('int64',BigInt64Array.from([BigInt(steps)]),[1]);

  for(let step=0;step<steps;step++){
    showTtsProgress('3/4 Denoising '+(step+1)+'/'+steps+'...');
    // current_step as int64
    const curStepT=new ort.Tensor('int64',BigInt64Array.from([BigInt(step)]),[1]);
    const veOut=await stSess.vecEst.run({
      noisy_latent: z,
      text_emb:     textEmb,
      style_ttl:    sTtl,
      latent_mask:  latentMask,
      text_mask:    maskT,
      current_step: curStepT,
      total_step:   totStepT,
    });
    // denoised_latent을 다음 스텝의 z로 직접 사용
    z=veOut.denoised_latent;
    console.log('[TTS] step'+step+' denoised_latent:',z?.dims?.join('x'));
  }

  showTtsProgress('4/4 Vocoder...');
  const vocOut=await stSess.vocoder.run({latent:z});
  const audio=vocOut.wav_tts;
  console.log('[TTS] wav_tts:',audio?.dims?.join('x'),audio?.data?.length,'samples');
  hideTtsProgress();
  return{samples:Float32Array.from(audio.data),sampleRate:sr};
}