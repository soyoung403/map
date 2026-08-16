/* 주소 엑셀 → 구글맵 플로터
 * - 엑셀/CSV 파싱: SheetJS (vendor/xlsx.full.min.js)
 * - 좌표 변환: Google Maps Geocoding (JS API)
 * 외부 빌드 도구 없이 정적 파일로 동작합니다.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- 상수/상태

  var LS_KEY = "gmap-plotter:apiKey";
  var LS_MAPID = "gmap-plotter:mapId";
  var LS_CACHE = "gmap-plotter:geocache:v1";
  var CACHE_LIMIT = 5000;
  var CONCURRENCY = 5; // 동시 지오코딩 요청 수
  var MAX_RETRY = 4;

  var ADDR_HINTS = ["주소", "소재지", "도로명", "지번", "address", "addr", "location", "위치", "장소", "소재", "residence", "street"];
  var NAME_HINTS = ["이름", "명칭", "상호", "장소명", "시설명", "지점", "고객", "업체", "name", "title", "label", "point"];
  var LAT_HINTS = ["위도", "lat", "latitude", "y좌표", "y"];
  var LNG_HINTS = ["경도", "lon", "lng", "long", "longitude", "x좌표", "x"];

  var state = {
    maps: null,        // google.maps 네임스페이스
    map: null,
    geocoder: null,
    infoWindow: null,
    AdvancedMarker: null,
    markers: [],       // { marker, row, index }
    rows: [],          // 파싱된 원본 행
    headers: [],
    workbook: null,
    fileMetaBase: "",
    configLoaded: false,
    results: [],       // { index, name, address, lat, lng, formatted, status, cached }
    cancelled: false,
    running: false,
    activeIndex: -1,
    cache: loadCache()
  };

  // ---------------------------------------------------------------- 유틸

  function $(id) { return document.getElementById(id); }

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.toggle("err", !!isError);
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { hide(t); }, isError ? 6000 : 3200);
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function normalize(s) {
    return String(s == null ? "" : s).trim().replace(/\s+/g, " ");
  }

  function loadCache() {
    try {
      return JSON.parse(localStorage.getItem(LS_CACHE) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  var cacheSaveTimer = null;
  function saveCache() {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(function () {
      try {
        var keys = Object.keys(state.cache);
        if (keys.length > CACHE_LIMIT) {
          // 오래된 것부터 잘라냄 (삽입 순서 기준)
          var trimmed = {};
          keys.slice(keys.length - CACHE_LIMIT).forEach(function (k) {
            trimmed[k] = state.cache[k];
          });
          state.cache = trimmed;
        }
        localStorage.setItem(LS_CACHE, JSON.stringify(state.cache));
      } catch (e) {
        /* 용량 초과 등은 무시 */
      }
      renderCacheInfo();
    }, 400);
  }

  function renderCacheInfo() {
    var n = Object.keys(state.cache).length;
    $("cache-info").textContent = "좌표 캐시 " + n + "건";
  }

  // ---------------------------------------------------------------- 로컬 설정(config.js)

  /**
   * config.js 가 있으면 window.APP_CONFIG 로 키를 읽어온다.
   * 파일이 없어도(404) 조용히 null 을 돌려주고 수동 입력 UI로 넘어간다.
   */
  function loadLocalConfig() {
    return new Promise(function (resolve) {
      if (window.APP_CONFIG) { resolve(window.APP_CONFIG); return; }

      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        resolve(v);
      }

      var s = document.createElement("script");
      s.src = "config.js";
      s.onload = function () { finish(window.APP_CONFIG || null); };
      s.onerror = function () { finish(null); };
      document.head.appendChild(s);

      setTimeout(function () { finish(window.APP_CONFIG || null); }, 3000);
    });
  }

  // ---------------------------------------------------------------- 구글맵 로딩

  function loadMapsApi(key) {
    return new Promise(function (resolve, reject) {
      if (window.google && window.google.maps) { resolve(window.google.maps); return; }

      var cbName = "__gmapsReady_" + Date.now();
      var settled = false;

      window.gm_authFailure = function () {
        if (settled) {
          toast("Google Maps 인증 실패: API 키 또는 키 제한 설정을 확인하세요.", true);
          return;
        }
        settled = true;
        reject(new Error("API 키 인증에 실패했습니다. 키 값과 리퍼러/API 제한을 확인하세요."));
      };

      window[cbName] = function () {
        settled = true;
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        resolve(window.google.maps);
      };

      var s = document.createElement("script");
      s.src =
        "https://maps.googleapis.com/maps/api/js" +
        "?key=" + encodeURIComponent(key) +
        "&callback=" + cbName +
        "&libraries=marker,geocoding" +
        "&language=ko&region=KR&loading=async&v=weekly";
      s.async = true;
      s.onerror = function () {
        if (settled) return;
        settled = true;
        reject(new Error("Google Maps 스크립트를 불러오지 못했습니다. 네트워크를 확인하세요."));
      };
      document.head.appendChild(s);
    });
  }

  async function initMap(key, mapId) {
    var maps = await loadMapsApi(key);
    state.maps = maps;

    state.map = new maps.Map($("map"), {
      center: { lat: 37.5665, lng: 126.978 }, // 서울시청
      zoom: 11,
      mapId: mapId || "DEMO_MAP_ID",
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false
    });

    state.geocoder = new maps.Geocoder();
    state.infoWindow = new maps.InfoWindow();

    try {
      var markerLib = await maps.importLibrary("marker");
      state.AdvancedMarker = markerLib.AdvancedMarkerElement;
    } catch (e) {
      state.AdvancedMarker = null; // 구형 Marker로 대체
    }

    hide($("map-placeholder"));
  }

  // ---------------------------------------------------------------- 엑셀 파싱

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error("파일을 읽지 못했습니다.")); };
      fr.readAsArrayBuffer(file);
    });
  }

  async function handleFile(file) {
    if (!file) return;
    var data;
    try {
      data = await readFile(file);
    } catch (e) {
      toast(e.message, true);
      return;
    }

    var wb;
    try {
      wb = XLSX.read(data, { type: "array", cellDates: true, raw: false });
    } catch (e) {
      toast("엑셀 파일을 해석하지 못했습니다: " + e.message, true);
      return;
    }

    if (!wb.SheetNames.length) {
      toast("시트가 없는 파일입니다.", true);
      return;
    }

    state.workbook = wb;

    state.fileMetaBase =
      "<b>" + escapeHtml(file.name) + "</b><br />" +
      (file.size / 1024).toFixed(1) + " KB · 시트 " + wb.SheetNames.length + "개";
    show($("file-meta"));

    var sheetSel = $("sheet-select");
    sheetSel.innerHTML = "";
    wb.SheetNames.forEach(function (n) {
      var o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      sheetSel.appendChild(o);
    });

    show($("mapping"));
    loadSheet(wb.SheetNames[0]);
  }

  function loadSheet(sheetName) {
    var ws = state.workbook.Sheets[sheetName];
    var rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });

    // 헤더가 비어있는(제목 행이 위에 있는) 경우 대비: 열 이름이 __EMPTY 뿐이면 안내
    state.rows = rows;
    state.headers = collectHeaders(rows);

    $("file-meta").innerHTML =
      (state.fileMetaBase || "") +
      '<br /><span class="mono">' + rows.length + "행 · " + state.headers.length + "열</span>";

    if (!rows.length) {
      toast("선택한 시트에 데이터가 없습니다.", true);
      $("run-btn").disabled = true;
      return;
    }
    $("run-btn").disabled = false;

    fillColumnSelect("addr-select", state.headers, pickColumn(state.headers, rows, ADDR_HINTS, true), false);
    fillColumnSelect("name-select", state.headers, pickColumn(state.headers, rows, NAME_HINTS, false), true);
    fillColumnSelect("lat-select", state.headers, pickColumn(state.headers, rows, LAT_HINTS, false), true);
    fillColumnSelect("lng-select", state.headers, pickColumn(state.headers, rows, LNG_HINTS, false), true);
  }

  /** 행마다 키가 다를 수 있으므로 전체(최대 200행)에서 열 이름을 모음 */
  function collectHeaders(rows) {
    var seen = [];
    rows.slice(0, 200).forEach(function (r) {
      Object.keys(r).forEach(function (k) {
        if (seen.indexOf(k) === -1) seen.push(k);
      });
    });
    return seen;
  }

  function fillColumnSelect(id, headers, selected, allowNone) {
    var sel = $(id);
    sel.innerHTML = "";
    if (allowNone) {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "— 사용 안 함 —";
      sel.appendChild(none);
    }
    headers.forEach(function (h) {
      var o = document.createElement("option");
      o.value = h;
      o.textContent = h;
      sel.appendChild(o);
    });
    sel.value = selected || "";
    if (!allowNone && !sel.value && headers.length) sel.value = headers[0];
  }

  /** 헤더명 + 값 패턴으로 열 자동 선택 */
  function pickColumn(headers, rows, hints, isAddress) {
    var sample = rows.slice(0, 30);
    var best = null;
    var bestScore = 0;

    headers.forEach(function (h) {
      var score = 0;
      var low = String(h).toLowerCase().replace(/\s/g, "");

      hints.forEach(function (hint, i) {
        var hl = hint.toLowerCase();
        if (low === hl) score += 60 - i;
        else if (low.indexOf(hl) !== -1) score += 40 - i;
      });

      if (isAddress) {
        // 값이 주소처럼 보이는지 (시/도/구/로/길/번지 등)
        var hits = 0;
        sample.forEach(function (r) {
          var v = normalize(r[h]);
          if (v.length >= 5 && /(시|도|군|구|읍|면|동|로|길|번지|가|street|st\.|ave|road)/i.test(v)) hits++;
        });
        if (sample.length) score += Math.round((hits / sample.length) * 35);
      } else if (hints === LAT_HINTS || hints === LNG_HINTS) {
        var numeric = 0;
        sample.forEach(function (r) {
          var v = parseFloat(r[h]);
          if (!isNaN(v) && Math.abs(v) <= 180) numeric++;
        });
        if (sample.length && numeric / sample.length > 0.8) score += 20;
        else score -= 20;
      }

      if (score > bestScore) { bestScore = score; best = h; }
    });

    return bestScore >= 20 ? best : (isAddress ? best : null);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------------------------------------------------------------- 지오코딩

  function geocodeOnce(address) {
    return new Promise(function (resolve) {
      state.geocoder.geocode(
        { address: address, region: "KR" },
        function (results, status) { resolve({ results: results, status: status }); }
      );
    });
  }

  async function geocode(address) {
    var key = address;
    if (state.cache[key]) {
      var c = state.cache[key];
      return { ok: true, lat: c.lat, lng: c.lng, formatted: c.formatted, cached: true };
    }

    var delay = 500;
    for (var attempt = 0; attempt <= MAX_RETRY; attempt++) {
      var res = await geocodeOnce(address);

      if (res.status === "OK" && res.results && res.results.length) {
        var loc = res.results[0].geometry.location;
        var out = {
          lat: typeof loc.lat === "function" ? loc.lat() : loc.lat,
          lng: typeof loc.lng === "function" ? loc.lng() : loc.lng,
          formatted: res.results[0].formatted_address
        };
        state.cache[key] = out;
        saveCache();
        return { ok: true, lat: out.lat, lng: out.lng, formatted: out.formatted, cached: false };
      }

      if (res.status === "OVER_QUERY_LIMIT" || res.status === "UNKNOWN_ERROR") {
        await sleep(delay);
        delay = Math.min(delay * 2, 8000);
        continue;
      }

      return { ok: false, status: res.status };
    }
    return { ok: false, status: "OVER_QUERY_LIMIT" };
  }

  // ---------------------------------------------------------------- 실행

  async function run() {
    if (!state.map) { toast("먼저 API 키를 입력해 지도를 불러오세요.", true); return; }
    if (!state.rows.length) { toast("먼저 엑셀 파일을 업로드하세요.", true); return; }
    if (state.running) return;

    var addrCol = $("addr-select").value;
    var nameCol = $("name-select").value;
    var latCol = $("lat-select").value;
    var lngCol = $("lng-select").value;

    if (!addrCol && !(latCol && lngCol)) {
      toast("주소 열을 선택하거나 위도/경도 열을 지정하세요.", true);
      return;
    }

    clearMarkers();
    state.results = [];
    state.cancelled = false;
    state.running = true;
    $("run-btn").disabled = true;

    var items = state.rows.map(function (r, i) {
      return {
        index: i,
        name: nameCol ? normalize(r[nameCol]) : "",
        address: addrCol ? normalize(r[addrCol]) : "",
        lat: latCol ? parseFloat(r[latCol]) : NaN,
        lng: lngCol ? parseFloat(r[lngCol]) : NaN,
        row: r
      };
    });

    show($("progress-wrap"));
    show($("stats"));
    show($("result-actions"));
    $("result-list").innerHTML = "";

    var done = 0;
    var counts = { ok: 0, fail: 0, cache: 0 };

    function tick() {
      done++;
      var pct = Math.round((done / items.length) * 100);
      $("bar-fill").style.width = pct + "%";
      $("progress-text").textContent = done + " / " + items.length + " (" + pct + "%)";
      $("stat-ok").textContent = counts.ok;
      $("stat-fail").textContent = counts.fail;
      $("stat-cache").textContent = counts.cache;
    }

    async function processItem(item) {
      if (state.cancelled) return;

      var result = {
        index: item.index,
        name: item.name,
        address: item.address,
        row: item.row
      };

      if (!isNaN(item.lat) && !isNaN(item.lng)) {
        result.lat = item.lat;
        result.lng = item.lng;
        result.formatted = item.address;
        result.status = "COORD";
        counts.ok++;
      } else if (!item.address) {
        result.status = "EMPTY";
        counts.fail++;
      } else {
        var g = await geocode(item.address);
        if (state.cancelled) return;
        if (g.ok) {
          result.lat = g.lat;
          result.lng = g.lng;
          result.formatted = g.formatted;
          result.status = "OK";
          result.cached = g.cached;
          counts.ok++;
          if (g.cached) counts.cache++;
        } else {
          result.status = g.status || "FAILED";
          counts.fail++;
        }
      }

      state.results.push(result);
      if (result.status === "OK" || result.status === "COORD") addMarker(result);
      appendResultRow(result);
      tick();
    }

    // 동시 실행 워커 풀
    var cursor = 0;
    async function worker() {
      while (cursor < items.length && !state.cancelled) {
        var item = items[cursor++];
        await processItem(item);
      }
    }

    var workers = [];
    for (var w = 0; w < Math.min(CONCURRENCY, items.length); w++) workers.push(worker());
    await Promise.all(workers);

    state.running = false;
    $("run-btn").disabled = false;

    // 동시 처리라 완료 순서가 섞이므로 원본 행 순서로 다시 그림
    state.results.sort(function (a, b) { return a.index - b.index; });
    $("result-list").innerHTML = "";
    state.results.forEach(appendResultRow);

    if (state.cancelled) {
      toast("중단했습니다. " + counts.ok + "건 표시됨");
    } else {
      $("progress-text").textContent = "완료 · " + items.length + "건 처리";
      toast("완료: 성공 " + counts.ok + "건, 실패 " + counts.fail + "건");
    }
    fitToMarkers();
  }

  // ---------------------------------------------------------------- 마커

  function addMarker(result) {
    var pos = { lat: result.lat, lng: result.lng };
    var marker;

    if (state.AdvancedMarker) {
      var el = document.createElement("div");
      el.className = "pin";
      marker = new state.AdvancedMarker({
        map: state.map,
        position: pos,
        content: el,
        title: result.name || result.address
      });
      result._el = el;
    } else {
      marker = new state.maps.Marker({
        map: state.map,
        position: pos,
        title: result.name || result.address
      });
    }

    marker.addListener("click", function () { focusResult(result.index, false); });
    result._marker = marker;
    state.markers.push(marker);
  }

  function clearMarkers() {
    state.markers.forEach(function (m) { m.map = null; if (m.setMap) m.setMap(null); });
    state.markers = [];
    if (state.infoWindow) state.infoWindow.close();
    state.activeIndex = -1;
  }

  function fitToMarkers() {
    var pts = state.results.filter(function (r) { return r._marker; });
    if (!pts.length || !state.maps) return;
    if (pts.length === 1) {
      state.map.setCenter({ lat: pts[0].lat, lng: pts[0].lng });
      state.map.setZoom(16);
      return;
    }
    var bounds = new state.maps.LatLngBounds();
    pts.forEach(function (r) { bounds.extend({ lat: r.lat, lng: r.lng }); });
    state.map.fitBounds(bounds, 60);
  }

  function focusResult(index, pan) {
    var r = state.results.find(function (x) { return x.index === index; });
    if (!r || !r._marker) return;

    state.results.forEach(function (x) { if (x._el) x._el.classList.remove("active"); });
    if (r._el) r._el.classList.add("active");
    state.activeIndex = index;

    Array.prototype.forEach.call($("result-list").children, function (li) {
      li.classList.toggle("active", li.dataset.index === String(index));
    });

    if (pan !== false) {
      state.map.panTo({ lat: r.lat, lng: r.lng });
      if (state.map.getZoom() < 14) state.map.setZoom(15);
    }

    var html =
      '<div class="iw">' +
      "<b>" + escapeHtml(r.name || r.address || "(이름 없음)") + "</b>" +
      '<div class="iw-addr">' + escapeHtml(r.formatted || r.address || "") + "</div>" +
      '<div class="iw-coord">' + r.lat.toFixed(6) + ", " + r.lng.toFixed(6) + "</div>" +
      "</div>";
    state.infoWindow.setContent(html);
    state.infoWindow.open({ map: state.map, anchor: r._marker });
  }

  // ---------------------------------------------------------------- 결과 목록

  var STATUS_TEXT = {
    ZERO_RESULTS: "주소를 찾을 수 없음",
    EMPTY: "주소 값이 비어 있음",
    OVER_QUERY_LIMIT: "요청 한도 초과",
    REQUEST_DENIED: "요청 거부 (Geocoding API 사용 설정/키 제한 확인)",
    INVALID_REQUEST: "잘못된 요청",
    UNKNOWN_ERROR: "알 수 없는 오류",
    FAILED: "변환 실패"
  };

  function appendResultRow(r) {
    var li = document.createElement("li");
    li.dataset.index = String(r.index);
    var ok = r.status === "OK" || r.status === "COORD";

    var sub = ok
      ? (r.formatted || r.address)
      : (STATUS_TEXT[r.status] || r.status) + (r.address ? " · " + r.address : "");

    li.className = ok ? "" : "err";
    li.innerHTML =
      '<span class="dot' + (ok ? "" : " err") + '"></span>' +
      '<span class="li-body">' +
      '<span class="li-title">' + escapeHtml(r.name || r.address || "(빈 값)") + "</span>" +
      '<span class="li-sub">' + escapeHtml(sub) + "</span>" +
      "</span>" +
      '<span class="li-idx">' + (r.index + 2) + "</span>"; // 엑셀 행 번호(헤더 포함)

    if (ok) {
      li.addEventListener("click", function () { focusResult(r.index, true); });
    }
    $("result-list").appendChild(li);
  }

  // ---------------------------------------------------------------- 내보내기

  function exportResults() {
    if (!state.results.length) { toast("내보낼 결과가 없습니다.", true); return; }
    var rows = state.results.slice().sort(function (a, b) { return a.index - b.index; }).map(function (r) {
      var base = Object.assign({}, r.row);
      base["_위도"] = r.lat != null && !isNaN(r.lat) ? r.lat : "";
      base["_경도"] = r.lng != null && !isNaN(r.lng) ? r.lng : "";
      base["_정규화주소"] = r.formatted || "";
      base["_상태"] = r.status === "OK" || r.status === "COORD" ? "성공" : (STATUS_TEXT[r.status] || r.status);
      return base;
    });
    var ws = XLSX.utils.json_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "결과");
    XLSX.writeFile(wb, "지오코딩_결과.xlsx");
  }

  // ---------------------------------------------------------------- 이벤트 바인딩

  function bind() {
    // --- API 키
    var savedKey = localStorage.getItem(LS_KEY);
    var savedMapId = localStorage.getItem(LS_MAPID);
    if (savedKey) $("api-key").value = savedKey;
    if (savedMapId) $("map-id").value = savedMapId;

    $("key-reveal").addEventListener("click", function () {
      var i = $("api-key");
      i.type = i.type === "password" ? "text" : "password";
    });

    $("key-help-toggle").addEventListener("click", function () {
      var d = $("key-help");
      d.open = !d.open;
    });

    $("key-save").addEventListener("click", async function () {
      var key = $("api-key").value.trim();
      var mapId = $("map-id").value.trim();
      if (!key) { toast("API 키를 입력하세요.", true); return; }

      if (state.map) {
        toast("이미 지도가 로드되었습니다. 키를 바꾸려면 페이지를 새로고침하세요.");
        return;
      }

      var btn = this;
      btn.disabled = true;
      btn.textContent = "불러오는 중...";
      try {
        await initMap(key, mapId);
        if ($("key-remember").checked) {
          localStorage.setItem(LS_KEY, key);
          if (mapId) localStorage.setItem(LS_MAPID, mapId);
        } else {
          localStorage.removeItem(LS_KEY);
        }
        btn.textContent = "지도 로드됨 ✓";
        toast("지도를 불러왔습니다.");
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "지도 불러오기";
        // config.js 키가 거부된 경우엔 수동 입력 UI를 다시 열어준다
        showManualKeyUi();
        toast(e.message, true);
      }
    });

    $("key-manual-toggle").addEventListener("click", showManualKeyUi);

    // --- 파일
    var dz = $("dropzone");
    var fi = $("file-input");

    dz.addEventListener("click", function () { fi.click(); });
    dz.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); }
    });
    fi.addEventListener("change", function () {
      if (fi.files && fi.files[0]) handleFile(fi.files[0]);
    });

    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("over"); });
    });
    dz.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    // 창 전체에 드롭해도 열리도록
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    $("sheet-select").addEventListener("change", function () {
      loadSheet(this.value);
    });

    // --- 실행/결과
    $("run-btn").addEventListener("click", run);
    $("cancel-btn").addEventListener("click", function () {
      state.cancelled = true;
      toast("중단 요청됨...");
    });
    $("fit-btn").addEventListener("click", fitToMarkers);
    $("export-btn").addEventListener("click", exportResults);
    $("clear-btn").addEventListener("click", function () {
      clearMarkers();
      state.results = [];
      $("result-list").innerHTML = "";
      hide($("stats"));
      hide($("progress-wrap"));
      hide($("result-actions"));
      $("bar-fill").style.width = "0";
    });

    $("cache-clear").addEventListener("click", function () {
      state.cache = {};
      localStorage.removeItem(LS_CACHE);
      renderCacheInfo();
      toast("좌표 캐시를 비웠습니다.");
    });

    renderCacheInfo();

    // 키 우선순위: config.js > localStorage > 수동 입력
    // (리스너 등록을 모두 마친 뒤 비동기로 처리 — config.js 가 없어도 UI는 즉시 동작)
    loadLocalConfig().then(function (cfg) {
      if (cfg && cfg.apiKey) {
        state.configLoaded = true;
        $("api-key").value = String(cfg.apiKey).trim();
        if (cfg.mapId) $("map-id").value = String(cfg.mapId).trim();
        $("key-remember").checked = false; // config.js 가 항상 최신이므로 별도 저장 안 함
        $("key-note-text").textContent = "config.js 의 키로 지도를 불러왔습니다.";
        show($("key-note"));
        hide($("key-manual"));
        $("key-save").click();
        return;
      }
      if (savedKey) $("key-save").click();
    });
  }

  function showManualKeyUi() {
    show($("key-manual"));
    if (state.configLoaded) {
      $("key-note-text").textContent = "config.js 의 키를 사용 중입니다.";
    } else {
      hide($("key-note"));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
