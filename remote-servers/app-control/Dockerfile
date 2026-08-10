FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o server .

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/server .
COPY update.json .
COPY message.json .
EXPOSE 8081
CMD ["./server"]
