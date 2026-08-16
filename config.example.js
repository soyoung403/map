/* 이 파일을 같은 폴더에 config.js 로 복사한 뒤 키를 채워 넣으세요.
 * config.js 가 있으면 앱이 자동으로 읽어 키 입력 없이 바로 지도를 띄웁니다.
 *
 *   copy config.example.js config.js        (Windows)
 *
 * config.js 는 .gitignore 에 등록되어 있어 저장소에 올라가지 않습니다.
 * 다만 브라우저에서 쓰는 키는 원리상 공개될 수밖에 없으므로,
 * Google Cloud Console에서 반드시 HTTP 리퍼러 제한 + API 제한 + 할당량 상한을 걸어두세요.
 */
window.APP_CONFIG = {
  // Maps JavaScript API + Geocoding API 가 모두 사용 설정된 키
  apiKey: "",

  // 선택: 클라우드 기반 지도 스타일을 쓸 때만. 비워두면 DEMO_MAP_ID 사용
  mapId: ""
};
