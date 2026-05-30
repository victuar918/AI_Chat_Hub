# Debian slim (Alpine 대신 - sharp/onnx 네이티브 바이너리 호환)
FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080
CMD ["npm", "start"]
