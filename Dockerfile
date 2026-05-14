1. Node.js 20 경량 이미지 사용
FROM node:20-alpine

2. 작업 디렉토리 설정
WORKDIR /usr/src/app

3. 패키지 파일 복사 및 설치
COPY package*.json ./
RUN npm install --omit=dev

4. 소스 코드 복사 (index.js 등)
COPY . .

5. Cloud Run 포트 노출
EXPOSE 8080

6. 서버 실행 명령어
CMD [ "npm", "start" ]
