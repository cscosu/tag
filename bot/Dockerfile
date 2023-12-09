FROM oven/bun:1-slim

WORKDIR /app
COPY package.json bun.lockb ./

RUN bun install

COPY index.ts .

CMD ["bun", "start"]
