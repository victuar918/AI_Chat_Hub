function parseVoiceBin(buf,cfg){
  const view=new DataView(buf);
  // Header: 6 × int64 (little-endian) = 48 bytes
  // dims = [numSpk_ttl, n_ttl, d_ttl, numSpk_dp, n_dp, d_dp]
  const numSpk=view.getInt32(0, true);
  const nTtl  =view.getInt32(8, true);
  const dTtl  =view.getInt32(16,true);
  const nDp   =view.getInt32(32,true);
  const dDp   =view.getInt32(40,true);
  const ttlLen=nTtl*dTtl, dpLen=nDp*dDp;
  // ★ FIX v4.2.12: C++ 실제 레이아웃 = [모든 화자 TTL 블록] + [모든 화자 DP 블록]
  // 기존(오류): 화자별 TTL→DP 교차 읽기 → 화자 0만 TTL 정상, 나머지 전부 왜곡
  // C++ 실제:  memcpy(ttl_all, buf+48, numSpk*ttlLen*4)
  //           memcpy(dp_all,  buf+48+numSpk*ttlLen*4, numSpk*dpLen*4)
  const TTL_START=48;
  const DP_START =48+numSpk*ttlLen*4;
  console.log('[TTS voice.bin] numSpk='+numSpk+' n_ttl='+nTtl+' d_ttl='+dTtl+' n_dp='+nDp+' d_dp='+dDp);
  console.log('[TTS voice.bin] TTL_START='+TTL_START+' DP_START='+DP_START+' fileSize='+buf.byteLength);
  const speakers=[];
  for(let s=0;s<numSpk;s++){
    const tOff=TTL_START+s*ttlLen*4;
    const dOff=DP_START +s*dpLen *4;
    if(tOff+ttlLen*4>buf.byteLength||dOff+dpLen*4>buf.byteLength)break;
    speakers.push({
      style_ttl:Float32Array.from(new Float32Array(buf,tOff,ttlLen)),
      style_dp :Float32Array.from(new Float32Array(buf,dOff,dpLen)),
      dims_ttl:[1,nTtl,dTtl],dims_dp:[1,nDp,dDp]
    });
  }
  if(!speakers.length)console.error('[TTS] voice.bin 파싱 실패');
  return speakers;
}