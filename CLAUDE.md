@AGENTS.md
## 언어
채팅 창에 응답은 한글로 표현

## DTCTL
MCP 서버와 함께 설치된 DTCTL 사용 가능
dtctl을 이용하여 실제 DQL 쿼리를 테스트할 수 있음

## Version 관리
배포할 때마다 app.config.json의 app.version 마지막 자리(patch)를 먼저 올릴 것
예시: 0.0.0 → 0.0.1 → 0.0.2 ...
각 작업 단위가 고유 버전으로 추적되도록 하기 위함임
