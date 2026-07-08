FROM node:20-alpine AS build
WORKDIR /app

ARG NEOTALK_API_URL
ARG NEOTALK_API_KEY
ENV NEOTALK_API_URL=$NEOTALK_API_URL
ENV NEOTALK_API_KEY=$NEOTALK_API_KEY

COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG NEOTALK_API_URL
ARG NEOTALK_API_KEY
ENV NEOTALK_API_URL=$NEOTALK_API_URL
ENV NEOTALK_API_KEY=$NEOTALK_API_KEY

COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
