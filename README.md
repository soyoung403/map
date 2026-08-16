# 주소 엑셀 → 구글맵 지도 웹앱

엑셀(.xlsx/.xls/.csv)을 업로드하면 주소 열을 자동으로 찾아 좌표로 변환하고, 구글맵에 점(마커)으로 표시합니다.
빌드 도구·서버 코드 없이 정적 파일만으로 동작합니다.

## 실행

```
start.bat
```
또는 직접:
```
python -m http.server 8000
```
브라우저에서 http://localhost:8000 접속.

> `index.html`을 파일로 바로 열어도(file://) 대체로 동작하지만, 구글 API 키의 리퍼러 제한을 쓰려면 로컬 서버로 여는 편이 안전합니다.

## 사용 순서

1. **API 키 준비** — 아래 둘 중 하나
   - **(권장) config.js 자동 로드**: `config.example.js`를 `config.js`로 복사하고 키를 적어두면, 다음부터는 입력 없이 지도가 바로 뜹니다.
     ```
     copy config.example.js config.js
     ```
     `config.js`는 `.gitignore`에 등록되어 있어 저장소에 올라가지 않습니다. 파일이 없으면 앱은 조용히 수동 입력 UI로 넘어갑니다(브라우저 콘솔에 `config.js` 404가 한 줄 찍히는 건 정상입니다).
   - **직접 입력**: 사이드바에 키를 붙여넣고 `지도 불러오기`. `이 브라우저에 저장`을 켜두면 localStorage에 남아 다음 방문 시 자동 로드됩니다.

   키 우선순위는 **config.js → localStorage → 수동 입력** 순이며, config.js 키로 로드가 실패하면 자동으로 입력 UI가 다시 열립니다.

   > 브라우저에서 쓰는 Maps 키는 어떤 방식이든 네트워크 요청에 노출됩니다. 숨기는 것보다 **Cloud Console의 제한 설정**이 실질적인 방어선입니다: HTTP 리퍼러 제한, API 제한(Maps JavaScript + Geocoding만), 일일 할당량 상한. 이 앱은 주소 변환을 REST 엔드포인트가 아닌 JS API의 `Geocoder`로 호출하므로 리퍼러 제한이 지오코딩 요청에도 그대로 적용됩니다.

2. **키 발급이 필요하다면**
   - [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
   - **Maps JavaScript API**, **Geocoding API** 두 개를 모두 사용 설정 (하나만 켜면 주소 변환이 `REQUEST_DENIED`로 실패)
   - 사용자 인증 정보 → API 키 생성, 결제 계정 연결 필요(매월 무료 크레딧 제공)
   - 키 제한을 걸 경우: HTTP 리퍼러에 `http://localhost:*` 허용, API 제한에 위 두 API 포함
3. **엑셀 업로드** (드래그&드롭 또는 클릭)
   - 시트/주소 열/이름 열이 자동 선택되며, 드롭다운으로 바꿀 수 있습니다.
   - 위도·경도 열이 이미 있으면 지정해 두면 그 행은 지오코딩 없이 바로 찍힙니다.
4. **`지도에 표시하기`** → 진행률과 함께 마커가 하나씩 추가됩니다.
   - 목록 항목을 클릭하면 해당 지점으로 이동 + 정보창 표시
   - `결과 내보내기`로 원본 + `_위도`/`_경도`/`_정규화주소`/`_상태` 열이 붙은 엑셀 저장

## 샘플

`sample/샘플_주소.xlsx` — 서울역, 서울시청 등 전국 15개 지점.
다시 만들려면: `node tools/make-sample.js`

## 엑셀 형식

첫 행이 헤더여야 합니다. 열 이름은 자유롭게 지어도 되며 아래 단어가 들어가면 자동 인식됩니다.

| 용도 | 인식되는 헤더 예 |
|---|---|
| 주소 | 주소, 소재지, 도로명주소, 지번주소, address, location |
| 이름 | 이름, 명칭, 상호, 장소명, 지점, name, title |
| 좌표 | 위도/경도, lat/lng, latitude/longitude |

```
이름        | 주소                        | 비고
서울역      | 서울특별시 중구 한강대로 405  | KTX
서울시청    | 서울특별시 중구 세종대로 110  | 관공서
```

## 동작 방식 / 비용

- 주소 → 좌표 변환은 Google **Geocoding API** 요청 1건 = 주소 1개.
- 한 번 변환한 주소는 브라우저 localStorage에 캐시되어(최대 5,000건) 재실행 시 요청이 발생하지 않습니다. 사이드바 하단에서 캐시를 비울 수 있습니다.
- 동시 요청 5개로 제한하고, 한도 초과(`OVER_QUERY_LIMIT`) 시 지수 백오프로 재시도합니다.
- 실패 행은 사유(주소를 찾을 수 없음 / 한도 초과 / 요청 거부 등)와 함께 목록에 빨간 점으로 남습니다.

## 파일 구조

```
index.html            화면 구조
styles.css            스타일
app.js                파싱·지오코딩·마커 로직 전부
config.example.js     키 설정 템플릿 (→ config.js 로 복사해서 사용)
.gitignore            config.js 커밋 방지
vendor/xlsx.full.min.js  SheetJS (엑셀 파서, 로컬 번들)
sample/샘플_주소.xlsx     샘플 데이터
tools/make-sample.js  샘플 생성 스크립트
start.bat             로컬 서버 실행
```
