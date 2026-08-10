FROM golang:1.22-alpine AS builder
WORKDIR /app
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=sum.golang.google.cn
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o ticket-center .

FROM alpine:3.20
WORKDIR /app
COPY --from=builder /app/ticket-center .
COPY --from=builder /app/static ./static
RUN mkdir -p /app/data
ENV PORT=8082
EXPOSE 8082
CMD ["./ticket-center"]
