# Node.js 20 경량 이미지
FROM node:20-alpine

# 작업 디렉토리 설정
WORKDIR /usr/src/app

# 패키지 파일 먼저 복사 (레이어 캐시 활용)
COPY package*.json ./

# 운영 의존성만 설치
RUN npm install --omit=dev

# 소스 코드 복사
# 필수 구조:
#   ./index.js
#   ./static/index.html   ← index.html 은 반드시 static/ 폴더 안에 위치
COPY . .

# Cloud Run 포트 노출
EXPOSE 8080

# 서버 실행
CMD ["npm", "start"]
