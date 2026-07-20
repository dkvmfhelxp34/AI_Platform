# 국토지리정보원 발표 대시보드 (정적 슬라이드)

2026.07.20 국토지리정보원 발표용 HTML 슬라이드 17페이지. DB·백엔드·빌드 과정 없는 순수 정적 파일이며,
모든 리소스를 상대경로로 참조하므로 폴더째 옮기면 어느 경로/포트에서도 동작한다.

이 폴더는 AI_Platform 본체(`backend/`, `frontend/`)와 무관한 별도 발표자료다.

## 구성

```text
presentation/
  web/
    index.html        # 슬라이드 본체 (CSS/JS 인라인, 단일 파일)
    assets/           # 이미지·폰트·영상
  scripts/
    start_server.sh   # Linux 실행 (python3 http.server, nohup)
    stop_server.sh    # Linux 중지
    start_server.ps1  # Windows 실행
  이식방법.md          # 원본 이식 명세서
```

## 실행

```bash
cd presentation/scripts
chmod +x start_server.sh stop_server.sh
./start_server.sh 8787
```

`http://<서버IP>:8787/` 접속. 중지는 `./stop_server.sh 8787`.

python3만 있으면 되고, nginx 등 다른 정적 웹서버로 `web/`을 서빙해도 무방하다.

## 주의: 표지 배경영상이 저장소에 없다

표지 슬라이드가 참조하는 `web/assets/cover_buoy_loop_10s.mp4`는 **102MB로 GitHub 파일당 100MB 한도를
초과해 저장소에서 제외**했다(`.gitignore` 등록). 저장소를 클론하면 **표지 배경영상만 재생되지 않고,
나머지 16페이지와 슬라이드 동작은 모두 정상**이다.

영상이 필요하면 서버 배포본에서 직접 복사한다:

```bash
scp <서버>:/home/data3/krma/ngii_dashboard/web/assets/cover_buoy_loop_10s.mp4 \
    presentation/web/assets/
```

같은 폴더의 `cover.mp4`, `cover_ngii_loop_10s.mp4`는 `index.html`이 참조하지 않는 잔여 파일이다.

## 라이브 데모 슬라이드 (8·12페이지)

두 페이지는 iframe으로 외부 시스템을 직접 띄운다. 슬라이드 진입 시마다 `?_ts=타임스탬프`를 붙여
자동 리로드된다(`reloadDemos()`).

| 페이지 | 대상 | 접근성 |
|---|---|---|
| 8 | QC 시계열 브라우저 `112.121.26.163:8020` | 공인 IP |
| 12 | 취수구 해수온도 예측 시스템 `112.121.26.163:8010` | 공인 IP |

두 서비스는 **같은 장비**에서 돌고 있다. 그 장비는 NAT 뒤의 `192.168.2.78`이지만 공인 IP
`112.121.26.163`으로 포트가 포워딩되어 있어 외부에서도 접근된다.

이 URL은 **대시보드 서버가 아니라 발표 PC 브라우저가 직접 접속**한다. 발표장 방화벽이 해당 포트
아웃바운드를 막으면 iframe이 빈 화면으로 표시되며, 이는 대시보드 자체의 오류가 아니다.

> **8페이지 QC 브라우저(8020)에는 인증이 없다.** `/api/download/values`, `/api/download/flags`로
> 관측 데이터가 그대로 조회·다운로드된다. 발표 종료 후 서비스를 내리거나 내부망 전용으로
> 재기동(`--host 192.168.2.78`)할 것.
>
> **12페이지 로그인 계정은 임시 비보안 계정(test/test)이며 슬라이드에 표기되어 있다.**
> 발표 종료 후 서비스 담당자에게 계정 정리를 요청할 것.

## 조작

| 키 | 동작 |
|---|---|
| `→` `Space` `PageDown` | 다음 |
| `←` `PageUp` | 이전 |
| `Home` / `End` | 처음 / 마지막 |
| `F` | 전체화면 토글 |

화면 하단 좌우 버튼으로도 이동 가능하며, 우하단에 `현재 / 17` 카운터가 표시된다.

## 알아둘 점

- `web/` 내용물은 완성된 발표자료다. 특히 `index.html`의 iframe URL과 QR 이미지는 임의로 수정하지 않는다.
- python `http.server`는 Range 요청을 지원하지 않아 영상 탐색(seek)이 불가하다. 표지 영상은 자동재생
  루프라 발표에는 지장이 없으나, 탐색이 필요하면 nginx로 서빙한다.
- 폰트(Pretendard woff2)가 `assets/`에 포함되어 있어 외부 인터넷 연결이 필요 없다.
