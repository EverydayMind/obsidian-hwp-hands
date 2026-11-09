# HWP Hands

[English](README.md)

Obsidian 데스크톱에서 한글 HWP·HWPX 문서를 열고 편집합니다. 문서 해석·조판·저장은 함께 들어 있는 RHWP WebAssembly 엔진이 내 컴퓨터에서 처리하며, 문서가 밖으로 나가지 않습니다.

## 기능

- 파일 탐색기나 링크로 `.hwp`·`.hwpx` 파일을 열고, 쪽 위의 본문·표 셀·누름틀을 눌러 바로 입력합니다.
- 문단·글자 서식 편집, 표 삽입, 찾기·바꾸기, 여러 문단·구역·셀 블록에 걸친 범위 서식을 지원합니다.
- 명령 팔레트에서 새 HWPX 문서를 만듭니다.
- 링크로 쪽이나 문단을 가리킬 수 있습니다. `[[계획.hwpx#page=3]]`은 3쪽으로, `[요약](계획.hwp#요약)`은 그 텍스트가 있는 첫 문단으로 이동합니다.
- `![[계획.hwpx]]`, `![[계획.hwpx#page=3]]` 같은 임베드는 한 쪽을 정화된 읽기 전용 미리보기로 보여 주고, 편집기로 여는 버튼을 둡니다.
- `.hwp`·`.hwpx`로 다른 이름 저장. 다시 읽어 검사했을 때 내용·서식·자원이 빠지면 사본 생성을 거절하고 원본은 그대로 둡니다.
- 안전장치: 저장 전마다 원본을 백업하고(문서별 최근 3개 보관), 저장하지 않은 편집은 기록해 두었다가 재시작 뒤 복구하며, 열린 파일을 외부 프로그램이 바꿔도 저장하지 않은 편집을 덮어쓰지 않습니다.
- 선택 기능 검색 인덱스: 본문·중첩 표 셀·누름틀·글상자·머리말/꼬리말·각주/미주를 담은 Markdown 투영(`.index.md`)을 저장 뒤 다시 만듭니다. 인덱스를 고쳐도 HWP/HWPX 원본은 바뀌지 않습니다.
- 다른 플러그인용 API(아래).

## 설치

커뮤니티 플러그인에서 **HWP Hands**를 설치합니다. 수동 설치는 릴리스의 `main.js`, `manifest.json`, `styles.css`를 `.obsidian/plugins/hwp-hands/`에 복사한 뒤 플러그인을 켭니다.

## 사용법

HWP나 HWPX 파일을 엽니다. 쪽을 눌러 입력하면 문서 모델에 바로 반영됩니다. 저장 버튼이나 `Ctrl+S`로 저장합니다.

명령(명령 팔레트): HWP/HWPX 문서 열기, 새 HWPX 문서 만들기, 현재 한글 문서 저장, Markdown 인덱스 생성, 미적용 입력 복구, 현재 HWP 엔진 작업 취소, HWP Hands 보관 파일 정리.

설정: HWP/HWPX 기본 열기(다른 플러그인이 이 파일을 열게 하려면 끔), 편집 화면 도구 표시, 입력 미리보기, 저장 전 원본 백업, 검색 인덱스 자동 생성, 문서 최대 크기, 문서 전체 AI 비공개.

## 다른 플러그인용 API

```ts
const api = app.plugins.plugins['hwp-hands']?.api;
if (api?.version === 1) {
  const lease = await api.documents.acquire('문서/보고서.hwpx');
  try {
    const tree = await api.query.tree('문서/보고서.hwpx');
    const receipt = await api.edit.transaction('문서/보고서.hwpx', [
      { type: 'replaceText', query: '검토 예정', replacement: '검토 완료' },
    ], { expectedRevision: tree.state.revision });
    await api.documents.save('문서/보고서.hwpx', { expectedRevision: receipt.revision });
  } finally {
    await lease.release();
  }
}
```

API는 편집기와 같은 문서 세션을 쓰므로 사람과 다른 플러그인이 같은 상태를 봅니다. 쓰기는 기대하는 revision을 밝혀야 하며, 오래된 revision이면 더 새로운 편집을 덮어쓰지 않고 거절합니다.

## 한계

- 데스크톱 전용입니다.
- HWP/HWPX의 모든 기능을 편집할 수는 없고, 일부는 보존만 합니다. 저장할 때 나오는 경고를 확인하고 중요한 문서는 백업해 두세요.
- 쪽 모양은 컴퓨터에 설치된 글꼴에 따라 달라집니다.

## 공개 사항

- **파일:** Vault에서 연 HWP/HWPX 문서를 읽고 쓰며, 검색 인덱스를 켜면 `.index.md` 파일을 씁니다. 백업, 복구 기록, 저장하지 않은 입력 초안은 플러그인 폴더에 둡니다.
- **네트워크:** 쓰지 않습니다. 네트워크 요청을 하지 않고 원격 코드를 내려받거나 실행하지 않습니다.
- **내장 엔진:** `main.js`에 RHWP WebAssembly 엔진과 워커가 들어 있습니다. 엔진은 RHWP 0.8.7에 로컬 패치를 더해 빌드했으며, 출처·패치·빌드 방법은 [vendor/rhwp-core/UPSTREAM.md](vendor/rhwp-core/UPSTREAM.md)에 있습니다. 엔진을 시작하기 전에 SHA-256을 확인합니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 보세요. 제3자 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)와 `main.js` 앞부분에 있습니다.

---

이 플러그인과 함께 동작하는 Obsidian용 AI 에이전트 플러그인 **Verbex**를 앞으로 공개할 예정입니다.
