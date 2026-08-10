FROM golang:1.21-alpine AS builder
WORKDIR /app
ENV GOPROXY=https://goproxy.cn,direct
COPY go.mod ./
COPY main.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o worker .

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/worker .
EXPOSE 8082
CMD ["./worker"]
