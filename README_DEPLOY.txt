Cloudflare Pages 배포용 폴더입니다.

구성
- index.html
- _worker.js

표시 항목
- 네이버 실시간 급상승 키워드 10개
- 구글 실시간 급상승 키워드 10개
- 다음 실시간 급상승 키워드 10개

Cloudflare Pages 업로드 방법
1. Cloudflare 로그인
2. Workers & Pages
3. Create application
4. Pages
5. Drag and drop your files
6. 이 cloudflare_live_site 폴더를 그대로 업로드
7. 배포 후 생성된 pages.dev 주소 확인

도메인 연결
1. 해당 Pages 프로젝트 진입
2. Custom domains
3. Set up a custom domain
4. 구매한 도메인 입력
5. 안내되는 DNS 레코드 확인

주의
- 이 버전은 Cloudflare Pages의 _worker.js 방식을 사용합니다.
- 화면은 10분마다 /api/trends를 다시 호출합니다.
- 서버 응답도 10분 캐시되도록 설정되어 있습니다.
- 각 서비스의 원본 실시간 데이터가 보통 10개만 제공되므로 정확도를 위해 10개만 표시합니다.
- 외부 키워드 제공 페이지의 응답 방식이 바뀌면 _worker.js 수정이 필요할 수 있습니다.
