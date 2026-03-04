FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm ci

COPY . .

ENV NODE_ENV=production
ENV LOGIN_SERVER_PORT=3456

EXPOSE 3456

CMD ["npm", "run", "server"]
