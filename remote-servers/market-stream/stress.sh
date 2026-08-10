#!/bin/bash
CONNECTIONS=1000
URL="http://127.0.0.1:8082/stream"
DURATION=30

echo "建立 $CONNECTIONS 个SSE连接，持续 ${DURATION}s..."

for i in $(seq 1 $CONNECTIONS); do
  curl -s -N --max-time $DURATION "$URL" > /dev/null &
done

echo "等待 5s 后查看状态..."
sleep 5

echo "--- 连接数 ---"
curl -s http://127.0.0.1:8082/connections

echo ""
echo "--- 容器资源 ---"
docker stats market-stream --no-stream --format "CPU: {{.CPUPerc}}  MEM: {{.MemUsage}}  NET: {{.NetIO}}"

echo ""
echo "--- 每秒网络流量（采样10s）---"
for i in $(seq 1 10); do
  rx1=$(cat /proc/net/dev | grep eth0 | awk '{print $10}')
  tx1=$(cat /proc/net/dev | grep eth0 | awk '{print $2}')
  sleep 1
  rx2=$(cat /proc/net/dev | grep eth0 | awk '{print $10}')
  tx2=$(cat /proc/net/dev | grep eth0 | awk '{print $2}')
  echo "TX: $(( (tx2 - tx1) / 1024 )) KB/s  RX: $(( (rx2 - rx1) / 1024 )) KB/s"
done

wait
echo "压测结束"
