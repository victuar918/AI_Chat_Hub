function getTypeLabel(t){
  // v5.8 알림 재설계: info_request(추가정보 요청), phase_confirm(Phase 구간 확인)만 사용
  // sclass_reached·rubric_held 제거 (관리자 개입 불필요)
  return {
    info_request:  '추가정보 요청',
    phase_confirm: 'Phase 구간 확인',
  }[t] || t;
}