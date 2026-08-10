package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	mrand "math/rand"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

var bjLoc = time.FixedZone("CST", 8*3600)

type Item struct {
	Regex    string `json:"r"`
	JSONPath string `json:"j"`
	Name     string `json:"n"`
	Currency string `json:"c"`
	Key      string `json:"k"`
}

type Source struct {
	URL     string            `json:"u"`
	Method  string            `json:"m"`
	Headers map[string]string `json:"h"`
	Body    string            `json:"b"`
	Enc     string            `json:"e"`
	Items   []Item            `json:"i"`
}

var pbKeys = []string{"comex", "lbma", "autd", "lbma_jd", "sge", "cnh", "cmbc", "czbank", "icbc", "xag", "oil"}

var (
	priceMu sync.RWMutex
	prices  map[string]float64

	payloadMu   sync.RWMutex
	activeSlot  int
	ssePayloads [2][]byte

	clientsMu sync.Mutex
	clients   = make(map[*sseClient]struct{})

	scheduleCh = make(chan struct{}, 1)

	fieldsJSON []byte
)

const (
	defaultBatchSize   = 64
	batchInterval      = 10 * time.Millisecond
	broadcastWindow    = 350 * time.Millisecond
	sseWriteTimeout    = 2 * time.Second
	cosTodayJitterMax  = 4 * time.Second
	cosRecentJitterMax = 6 * time.Second
	cosFullJitterMax   = 8 * time.Second
	clientErrorLimit   = 3
)

type sseClient struct {
	mu           sync.Mutex
	notify       chan struct{}
	pendingSlot  int
	lastSeenSlot int
	isSending    bool
	errors       int
}

func addClient(client *sseClient) {
	clientsMu.Lock()
	clients[client] = struct{}{}
	clientsMu.Unlock()
}

func removeClient(client *sseClient) {
	clientsMu.Lock()
	delete(clients, client)
	clientsMu.Unlock()
}

func getActivePayload() (int, []byte) {
	payloadMu.RLock()
	defer payloadMu.RUnlock()
	slot := activeSlot
	return slot, append([]byte(nil), ssePayloads[slot]...)
}

func getPayloadForSlot(slot int) []byte {
	payloadMu.RLock()
	defer payloadMu.RUnlock()
	if slot < 0 || slot > 1 {
		slot = activeSlot
	}
	return append([]byte(nil), ssePayloads[slot]...)
}

func publishPayload(data []byte) {
	payloadMu.Lock()
	nextSlot := 1 - activeSlot
	ssePayloads[nextSlot] = append(ssePayloads[nextSlot][:0], data...)
	activeSlot = nextSlot
	payloadMu.Unlock()

	select {
	case scheduleCh <- struct{}{}:
	default:
	}
}

func (c *sseClient) queueSlot(slot int) {
	c.mu.Lock()
	c.pendingSlot = slot
	if c.isSending {
		c.mu.Unlock()
		return
	}
	c.isSending = true
	c.mu.Unlock()

	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *sseClient) completeSend() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pendingSlot != c.lastSeenSlot {
		select {
		case c.notify <- struct{}{}:
		default:
		}
		return true
	}
	c.isSending = false
	return false
}

func (c *sseClient) currentPendingSlot() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pendingSlot
}

func (c *sseClient) markSent(slot int) {
	c.mu.Lock()
	c.lastSeenSlot = slot
	c.errors = 0
	c.mu.Unlock()
}

func (c *sseClient) markError() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.errors++
	return c.errors
}

func schedulerLoop() {
	for range scheduleCh {
		clientsMu.Lock()
		batch := make([]*sseClient, 0, len(clients))
		for client := range clients {
			batch = append(batch, client)
		}
		clientsMu.Unlock()

		if len(batch) == 0 {
			continue
		}

		batchSize := computeBatchSize(len(batch))
		for start := 0; start < len(batch); start += batchSize {
			slot, _ := getActivePayload()
			end := start + batchSize
			if end > len(batch) {
				end = len(batch)
			}
			for _, client := range batch[start:end] {
				client.queueSlot(slot)
			}
			if end < len(batch) {
				time.Sleep(batchInterval)
			}
		}
	}
}

func computeBatchSize(total int) int {
	if total <= defaultBatchSize {
		return total
	}
	maxBatches := int(broadcastWindow / batchInterval)
	if maxBatches < 1 {
		maxBatches = 1
	}
	required := int(math.Ceil(float64(total) / float64(maxBatches)))
	if required < defaultBatchSize {
		return defaultBatchSize
	}
	return required
}

func jitterDuration(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	return time.Duration(mrand.Int63n(int64(max)))
}

func sleepUntilWithJitter(target time.Time, jitterMax time.Duration) {
	wait := time.Until(target)
	if wait > 0 {
		time.Sleep(wait)
	}
	if jitter := jitterDuration(jitterMax); jitter > 0 {
		time.Sleep(jitter)
	}
}

func buildSSE(p map[string]float64) []byte {
	parts := make([]string, len(pbKeys))
	for i, k := range pbKeys {
		parts[i] = strconv.FormatFloat(p[k], 'f', -1, 32)
	}
	return []byte("data: " + strings.Join(parts, ",") + "\n\n")
}

func loadSources() []Source {
	data, err := os.ReadFile("sources.json")
	if err != nil {
		log.Fatalf("cannot read sources.json: %v", err)
	}
	var sources []Source
	if err := json.Unmarshal(data, &sources); err != nil {
		log.Fatalf("invalid sources.json: %v", err)
	}
	return sources
}

func fetchURL(src Source) ([]byte, error) {
	method := "GET"
	if src.Method != "" {
		method = src.Method
	}
	url := strings.ReplaceAll(src.URL, "{ts}", strconv.FormatInt(time.Now().UnixMilli(), 10))

	var bodyReader io.Reader
	if src.Body != "" {
		bodyReader = strings.NewReader(src.Body)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return nil, err
	}
	for k, v := range src.Headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if strings.ToLower(src.Enc) == "gbk" {
		decoded, _, err := transform.Bytes(simplifiedchinese.GBK.NewDecoder(), body)
		if err == nil {
			body = decoded
		}
	}

	return body, nil
}

func extractJSON(body []byte, path string) (float64, bool) {
	var root any
	if err := json.Unmarshal(body, &root); err != nil {
		return 0, false
	}
	parts := strings.Split(path, ".")
	cur := root
	for _, p := range parts {
		switch v := cur.(type) {
		case map[string]any:
			cur = v[p]
		case []any:
			idx, err := strconv.Atoi(p)
			if err != nil || idx < 0 || idx >= len(v) {
				return 0, false
			}
			cur = v[idx]
		default:
			return 0, false
		}
	}
	switch val := cur.(type) {
	case float64:
		return val, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
		if err == nil {
			return f, true
		}
	}
	return 0, false
}

func fetchAll(sources []Source) map[string]float64 {
	result := make(map[string]float64)
	var wg sync.WaitGroup
	var mu sync.Mutex

	for _, src := range sources {
		wg.Add(1)
		go func(s Source) {
			defer wg.Done()
			body, err := fetchURL(s)
			if err != nil {
				log.Printf("fetch %s error: %v", s.URL[:min(60, len(s.URL))], err)
				return
			}
			text := string(body)
			for _, item := range s.Items {
				var val float64
				var found bool
				if item.Regex != "" {
					re, err := regexp.Compile(item.Regex)
					if err != nil {
						continue
					}
					m := re.FindStringSubmatch(text)
					if len(m) >= 2 {
						val, err = strconv.ParseFloat(strings.TrimSpace(m[1]), 64)
						if err == nil {
							found = true
						}
					}
				} else if item.JSONPath != "" {
					val, found = extractJSON(body, item.JSONPath)
				}
				if found {
					mu.Lock()
					result[item.Key] = val
					mu.Unlock()
				}
			}
		}(src)
	}
	wg.Wait()
	return result
}

func buildFieldsJSON(sources []Source) []byte {
	itemMap := make(map[string]Item)
	for _, src := range sources {
		for _, item := range src.Items {
			itemMap[item.Key] = item
		}
	}
	reCode := regexp.MustCompile(`hq_str_(\w+)`)
	reJD := regexp.MustCompile(`([\w\-\(\)\+]+)`)
	buf := strings.Builder{}
	buf.WriteString("{")
	first := true
	for _, k := range pbKeys {
		item, ok := itemMap[k]
		if !ok {
			continue
		}
		var code string
		currency := item.Currency
		name := item.Name
		if item.Regex != "" {
			if m := reCode.FindStringSubmatch(item.Regex); len(m) >= 2 {
				code = m[1]
			} else if m2 := reJD.FindStringSubmatch(item.Regex); len(m2) >= 2 {
				code = m2[1]
			} else {
				code = k
			}
		} else if item.JSONPath != "" {
			code = item.JSONPath
		} else {
			code = k
		}
		if !first {
			buf.WriteString(",")
		}
		first = false
		entry, _ := json.Marshal([]string{code, name, currency})
		buf.WriteString(`"` + k + `":` + string(entry))
	}
	buf.WriteString("}")
	return []byte(buf.String())
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func getCosConfig() (host, secretID, secretKey string) {
	host = strings.TrimSpace(os.Getenv("COS_HOST"))
	secretID = strings.TrimSpace(os.Getenv("COS_SECRET_ID"))
	secretKey = strings.TrimSpace(os.Getenv("COS_SECRET_KEY"))
	return
}

func hmacSHA1(key, data string) string {
	mac := hmac.New(sha1.New, []byte(key))
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

func sha1Hex(data string) string {
	h := sha1.New()
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

func cosPut(key string, data []byte, cacheMaxAge int) error {
	cosHost, cosSecretID, cosSecretKey := getCosConfig()
	if cosHost == "" || cosSecretID == "" || cosSecretKey == "" {
		return fmt.Errorf("missing COS configuration")
	}
	now := time.Now().Unix()
	keyTime := fmt.Sprintf("%d;%d", now, now+3600)
	signKey := hmacSHA1(cosSecretKey, keyTime)
	httpStr := fmt.Sprintf("put\n/%s\n\nhost=%s\n", key, cosHost)
	strToSign := fmt.Sprintf("sha1\n%s\n%s\n", keyTime, sha1Hex(httpStr))
	sig := hmacSHA1(signKey, strToSign)
	auth := fmt.Sprintf("q-sign-algorithm=sha1&q-ak=%s&q-sign-time=%s&q-key-time=%s&q-header-list=host&q-url-param-list=&q-signature=%s",
		cosSecretID, keyTime, keyTime, sig)

	req, _ := http.NewRequest("PUT", "https://"+cosHost+"/"+key, bytes.NewReader(data))
	req.Header.Set("Host", cosHost)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cache-Control", fmt.Sprintf("max-age=%d", cacheMaxAge))
	req.Header.Set("Authorization", auth)
	req.ContentLength = int64(len(data))

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("COS PUT %s: %d", key, resp.StatusCode)
	}
	return nil
}

func saveLocal(key string, data []byte) {
	path := "klineData/" + key
	if idx := strings.LastIndex(path, "/"); idx > 0 {
		os.MkdirAll(path[:idx], 0755)
	}
	os.WriteFile(path, data, 0644)
}

func loadLocal(key string) []KBar {
	data, err := os.ReadFile("klineData/" + key)
	if err != nil {
		return nil
	}
	var bars []KBar
	json.Unmarshal(data, &bars)
	return bars
}

func pushJSON(key string, bars []KBar, cacheMaxAge int) {
	if bars == nil {
		bars = []KBar{}
	}
	data, _ := json.Marshal(bars)
	saveLocal(key, data)
	if err := cosPut(key, data, cacheMaxAge); err != nil {
		log.Printf("COS %s err: %v", key, err)
	} else {
		log.Printf("COS %s ok %dB", key, len(data))
	}
}

func saveDailyNew(ks *KlineState, key string, csvCount int) {
	daily := ks.getDaily()
	if len(daily) <= csvCount {
		return
	}
	data, _ := json.Marshal(daily[csvCount:])
	saveLocal(key, data)
}

func restoreKline(ks *KlineState, market string) {
	if bars := loadLocal("kline/" + market + "/daily_new.json"); len(bars) > 0 {
		ks.daily = append(ks.daily, bars...)
		log.Printf("restored %s daily_new: %d", market, len(bars))
	}
	if bars := loadLocal("kline/" + market + "/recent.json"); len(bars) > 0 {
		ks.recent1h = bars
		log.Printf("restored %s recent: %d", market, len(bars))
	}
	if bars := loadLocal("kline/" + market + "/today.json"); len(bars) > 0 {
		cutoff := time.Now().In(bjLoc).Add(-24 * time.Hour).Format("2006-01-02 15:04")
		i := 0
		for i < len(bars) && bars[i][0].(string) < cutoff {
			i++
		}
		if i < len(bars) {
			ks.today5m = bars[i:]
			log.Printf("restored %s today: %d", market, len(ks.today5m))
		}
	}
}

type KBar [6]interface{}

type ohlc struct{ o, h, l, c float64 }

func (v *ohlc) update(p float64) {
	if p > v.h {
		v.h = p
	}
	if p < v.l {
		v.l = p
	}
	v.c = p
}

type KlineState struct {
	mu       sync.RWMutex
	today5m  []KBar
	cur5m    *ohlc
	last5m   string
	recent1h []KBar
	curHour  *ohlc
	lastHour string
	daily    []KBar
	curDay   *ohlc
	lastDay  string
}

func (ks *KlineState) feed(price float64, now time.Time) {
	if price <= 0 {
		return
	}
	t := now.In(bjLoc)
	dayT := t
	if dayT.Hour() < 6 {
		dayT = dayT.AddDate(0, 0, -1)
	}
	day := dayT.Format("2006-01-02")
	hour := t.Truncate(time.Hour).In(bjLoc).Format("2006-01-02 15:04")
	m5 := t.Truncate(5 * time.Minute).In(bjLoc).Format("2006-01-02 15:04")

	ks.mu.Lock()
	defer ks.mu.Unlock()

	if ks.last5m != m5 {
		if ks.cur5m != nil {
			n := len(ks.today5m)
			if n == 0 || ks.cur5m.o != ks.cur5m.c || ks.cur5m.h != ks.cur5m.l || (n > 0 && ks.today5m[n-1][4].(float64) != ks.cur5m.c) {
				ks.today5m = append(ks.today5m, KBar{ks.last5m, ks.cur5m.o, ks.cur5m.h, ks.cur5m.l, ks.cur5m.c, 0})
			} else if n > 0 {
				ks.today5m[n-1][0] = ks.last5m
			}
			cutoff := t.Add(-24 * time.Hour).Format("2006-01-02 15:04")
			i := 0
			for i < len(ks.today5m) && ks.today5m[i][0].(string) < cutoff {
				i++
			}
			if i > 0 {
				ks.today5m = ks.today5m[i:]
			}
		}
		ks.cur5m = &ohlc{price, price, price, price}
		ks.last5m = m5
	} else if ks.cur5m != nil {
		ks.cur5m.update(price)
	}

	if ks.lastHour != hour {
		if ks.curHour != nil {
			n := len(ks.recent1h)
			if n == 0 || ks.curHour.o != ks.curHour.c || ks.curHour.h != ks.curHour.l || (n > 0 && ks.recent1h[n-1][4].(float64) != ks.curHour.c) {
				ks.recent1h = append(ks.recent1h, KBar{ks.lastHour, ks.curHour.o, ks.curHour.h, ks.curHour.l, ks.curHour.c, 0})
			} else if n > 0 {
				ks.recent1h[n-1][0] = ks.lastHour
			}
			if len(ks.recent1h) > 168 {
				ks.recent1h = ks.recent1h[len(ks.recent1h)-168:]
			}
		}
		ks.curHour = &ohlc{price, price, price, price}
		ks.lastHour = hour
	} else if ks.curHour != nil {
		ks.curHour.update(price)
	}

	if ks.lastDay != day {
		if ks.curDay != nil {
			ks.daily = append(ks.daily, KBar{ks.lastDay, ks.curDay.o, ks.curDay.h, ks.curDay.l, ks.curDay.c, 0})
		}
		ks.curDay = &ohlc{price, price, price, price}
		ks.lastDay = day
	} else if ks.curDay != nil {
		ks.curDay.update(price)
	}
}

func (ks *KlineState) getToday() []KBar {
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	t := time.Now().In(bjLoc)
	if t.Hour() < 6 {
		t = t.AddDate(0, 0, -1)
	}
	today := t.Format("2006-01-02") + " 06:00"
	var out []KBar
	for _, b := range ks.today5m {
		if b[0].(string) >= today {
			out = append(out, b)
		}
	}
	return out
}

func (ks *KlineState) getRecent() []KBar {
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	out := make([]KBar, len(ks.recent1h))
	copy(out, ks.recent1h)
	return out
}

func (ks *KlineState) getDaily() []KBar {
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	out := make([]KBar, len(ks.daily))
	copy(out, ks.daily)
	return out
}

func loadDailyCSV(path string) []KBar {
	f, err := os.Open(path)
	if err != nil {
		log.Printf("cannot open %s: %v", path, err)
		return nil
	}
	defer f.Close()
	var bars []KBar
	scanner := bufio.NewScanner(f)
	scanner.Scan()
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), ",")
		if len(fields) < 5 {
			continue
		}
		date := strings.Split(fields[0], " ")[0]
		o, _ := strconv.ParseFloat(fields[1], 64)
		h, _ := strconv.ParseFloat(fields[2], 64)
		l, _ := strconv.ParseFloat(fields[3], 64)
		c, _ := strconv.ParseFloat(fields[4], 64)
		bars = append(bars, KBar{date, o, h, l, c, 0})
	}
	return bars
}

func lttbSample(bars []KBar, target int) []KBar {
	n := len(bars)
	if n <= target {
		return bars
	}
	result := make([]KBar, 0, target)
	result = append(result, bars[0])
	every := float64(n-2) / float64(target-2)
	aIdx := 0
	for i := 0; i < target-2; i++ {
		bStart := int(float64(i+1)*every) + 1
		bEnd := int(float64(i+2)*every) + 1
		if bEnd > n-1 {
			bEnd = n - 1
		}
		var avgC float64
		for j := bStart; j < bEnd; j++ {
			avgC += bars[j][4].(float64)
		}
		avgC /= float64(bEnd - bStart)
		cStart := int(float64(i)*every) + 1
		cEnd := bStart
		aC := bars[aIdx][4].(float64)
		maxArea := -1.0
		maxIdx := cStart
		for j := cStart; j < cEnd; j++ {
			jC := bars[j][4].(float64)
			area := math.Abs(float64(aIdx-j)*(jC-avgC) - (aC-avgC)*float64(aIdx-(bStart+bEnd)/2))
			if area > maxArea {
				maxArea = area
				maxIdx = j
			}
		}
		result = append(result, bars[maxIdx])
		aIdx = maxIdx
	}
	result = append(result, bars[n-1])
	return result
}

func buildFull(ks *KlineState) []KBar {
	daily := ks.getDaily()
	if len(daily) == 0 {
		return daily
	}
	cutoff := time.Now().In(bjLoc).AddDate(-10, 0, 0).Format("2006-01-02")
	for i, b := range daily {
		if b[0].(string) >= cutoff {
			return daily[i:]
		}
	}
	return daily
}

var (
	klineUSD    = &KlineState{}
	klineCNY    = &KlineState{}
	csvCountUSD int
	csvCountCNY int
)

func main() {
	mrand.Seed(time.Now().UnixNano())

	sources := loadSources()
	fieldsJSON = buildFieldsJSON(sources)
	prices = make(map[string]float64)

	klineUSD.daily = loadDailyCSV("historyPrice/gold_kline_usd.csv")
	csvCountUSD = len(klineUSD.daily)
	klineCNY.daily = loadDailyCSV("historyPrice/gold_kline_cny.csv")
	csvCountCNY = len(klineCNY.daily)
	restoreKline(klineUSD, "usd")
	restoreKline(klineCNY, "cny")
	log.Printf("kline usd=%d cny=%d", len(klineUSD.daily), len(klineCNY.daily))

	update := func() {
		p := fetchAll(sources)
		sse := buildSSE(p)
		priceMu.Lock()
		prices = p
		priceMu.Unlock()
		publishPayload(sse)

		now := time.Now()
		if v, ok := p["lbma"]; ok {
			klineUSD.feed(v, now)
		}
		if v, ok := p["autd"]; ok {
			klineCNY.feed(v, now)
		}
	}

	update()

	go schedulerLoop()

	go func() {
		pushJSON("kline/usd/today.json", klineUSD.getToday(), 900)
		pushJSON("kline/cny/today.json", klineCNY.getToday(), 900)
		pushJSON("kline/usd/recent.json", klineUSD.getRecent(), 3600)
		pushJSON("kline/cny/recent.json", klineCNY.getRecent(), 3600)
		pushJSON("kline/usd/full.json", buildFull(klineUSD), 86400)
		pushJSON("kline/cny/full.json", buildFull(klineCNY), 86400)
		log.Println("initial COS push done")
	}()

	go func() {
		for range time.Tick(3 * time.Second) {
			update()
		}
	}()

	go func() {
		for {
			now := time.Now()
			next := now.Truncate(15 * time.Minute).Add(15*time.Minute + 10*time.Second)
			sleepUntilWithJitter(next, cosTodayJitterMax)
			pushJSON("kline/usd/today.json", klineUSD.getToday(), 900)
			pushJSON("kline/cny/today.json", klineCNY.getToday(), 900)
		}
	}()

	go func() {
		for {
			now := time.Now()
			next := now.Truncate(time.Hour).Add(time.Hour + 30*time.Second)
			sleepUntilWithJitter(next, cosRecentJitterMax)
			pushJSON("kline/usd/recent.json", klineUSD.getRecent(), 3600)
			pushJSON("kline/cny/recent.json", klineCNY.getRecent(), 3600)
			saveDailyNew(klineUSD, "kline/usd/daily_new.json", csvCountUSD)
			saveDailyNew(klineCNY, "kline/cny/daily_new.json", csvCountCNY)
		}
	}()

	go func() {
		for {
			now := time.Now().In(bjLoc)
			next := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 30, 0, bjLoc)
			if !now.Before(next) {
				next = next.AddDate(0, 0, 1)
			}
			sleepUntilWithJitter(next, cosFullJitterMax)
			pushJSON("kline/usd/full.json", buildFull(klineUSD), 86400)
			pushJSON("kline/cny/full.json", buildFull(klineCNY), 86400)
		}
	}()

	http.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", 500)
			return
		}

		client := &sseClient{
			notify:       make(chan struct{}, 1),
			pendingSlot:  -1,
			lastSeenSlot: -1,
		}
		addClient(client)
		defer removeClient(client)

		schema := "event: schema\ndata: " + strings.Join(pbKeys, ",") + "\n\n"
		controller := http.NewResponseController(w)
		_ = controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
		if _, err := w.Write([]byte(schema)); err != nil {
			return
		}
		flusher.Flush()

		slot, initial := getActivePayload()
		_ = controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
		if _, err := w.Write(initial); err != nil {
			return
		}
		flusher.Flush()
		client.markSent(slot)

		for {
			select {
			case <-client.notify:
				pendingSlot := client.currentPendingSlot()
				data := getPayloadForSlot(pendingSlot)
				_ = controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
				if _, err := w.Write(data); err != nil {
					if client.markError() >= clientErrorLimit {
						return
					}
					return
				}
				flusher.Flush()
				client.markSent(pendingSlot)
				client.completeSend()
			case <-r.Context().Done():
				return
			}
		}
	})

	http.HandleFunc("/fields", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write(fieldsJSON)
	})

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})

	http.HandleFunc("/connections", func(w http.ResponseWriter, r *http.Request) {
		clientsMu.Lock()
		n := len(clients)
		clientsMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"connections":%d}`, n)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}
	log.Printf("market-stream starting on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
