package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	updateMu   sync.RWMutex
	updateData *UpdateInfo

	messageMu   sync.RWMutex
	messageData *MessageInfo

	statsMu   sync.RWMutex
	statsData map[string]*UserRecord // uuid -> record
)

type UserRecord struct {
	Version   string `json:"v"`
	FirstSeen string `json:"first"`
	LastSeen  string `json:"last"`
}

type UpdateInfo struct {
	Version string `json:"v"`
}

type MessageInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
}

const statsFile = "stats.json"

func loadStats() {
	data, err := os.ReadFile(statsFile)
	if err != nil {
		statsMu.Lock()
		statsData = make(map[string]*UserRecord)
		statsMu.Unlock()
		return
	}
	var m map[string]*UserRecord
	if err := json.Unmarshal(data, &m); err != nil {
		log.Printf("Warning: invalid stats.json: %v", err)
		statsMu.Lock()
		statsData = make(map[string]*UserRecord)
		statsMu.Unlock()
		return
	}
	statsMu.Lock()
	statsData = m
	statsMu.Unlock()
	log.Printf("Loaded stats: %d users", len(m))
}

func saveStats() {
	statsMu.RLock()
	data, err := json.Marshal(statsData)
	statsMu.RUnlock()
	if err != nil {
		log.Printf("Warning: failed to marshal stats: %v", err)
		return
	}
	if err := os.WriteFile(statsFile, data, 0644); err != nil {
		log.Printf("Warning: failed to save stats: %v", err)
	}
}

func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return strings.SplitN(ip, ",", 2)[0]
	}
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	host, _, _ := strings.Cut(r.RemoteAddr, ":")
	return host
}

func handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	var req struct {
		Version string `json:"v"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, map[string]any{"s": "error", "m": "invalid request"})
		return
	}
	id := clientIP(r)
	now := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	statsMu.Lock()
	if rec, ok := statsData[id]; ok {
		rec.LastSeen = now
		if req.Version != "" {
			rec.Version = req.Version
		}
	} else {
		statsData[id] = &UserRecord{
			Version:   req.Version,
			FirstSeen: now,
			LastSeen:  now,
		}
	}
	statsMu.Unlock()
	updateMu.RLock()
	latest := ""
	if updateData != nil {
		latest = updateData.Version
	}
	updateMu.RUnlock()
	writeJSON(w, map[string]any{"s": "ok", "latest": latest})
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	cutoff1d := now.Add(-24 * time.Hour).Format("2006-01-02T15:04:05Z")
	cutoff7d := now.Add(-7 * 24 * time.Hour).Format("2006-01-02T15:04:05Z")
	cutoff30d := now.Add(-30 * 24 * time.Hour).Format("2006-01-02T15:04:05Z")

	versions := map[string]int{}
	total, active1d, active7d, active30d := 0, 0, 0, 0

	statsMu.RLock()
	for _, rec := range statsData {
		total++
		if rec.LastSeen >= cutoff1d {
			active1d++
			if rec.Version != "" {
				versions[rec.Version]++
			}
		}
		if rec.LastSeen >= cutoff7d {
			active7d++
		}
		if rec.LastSeen >= cutoff30d {
			active30d++
		}
	}
	statsMu.RUnlock()

	writeJSON(w, map[string]any{
		"total":      total,
		"active_1d":  active1d,
		"active_7d":  active7d,
		"active_30d": active30d,
		"lost_30d":   total - active30d,
		"versions":   versions,
	})
}

func loadMessage() {
	data, err := os.ReadFile("message.json")
	if err != nil {
		messageMu.Lock()
		messageData = nil
		messageMu.Unlock()
		return
	}
	var info MessageInfo
	if err := json.Unmarshal(data, &info); err != nil {
		log.Printf("Warning: invalid message.json: %v", err)
		return
	}
	// id 为空则视为无消息
	if info.ID == "" {
		messageMu.Lock()
		messageData = nil
		messageMu.Unlock()
		return
	}
	messageMu.Lock()
	messageData = &info
	messageMu.Unlock()
	log.Printf("Loaded message: [%s] %s", info.ID, info.Title)
}

func handleMessage(w http.ResponseWriter, r *http.Request) {
	messageMu.RLock()
	info := messageData
	messageMu.RUnlock()
	if info == nil {
		writeJSON(w, map[string]any{"s": "ok", "d": nil})
		return
	}
	writeJSON(w, map[string]any{"s": "ok", "d": info})
}

func loadUpdate() {
	data, err := os.ReadFile("update.json")
	if err != nil {
		updateMu.Lock()
		updateData = nil
		updateMu.Unlock()
		return
	}
	var info UpdateInfo
	if err := json.Unmarshal(data, &info); err != nil {
		log.Printf("Warning: invalid update.json: %v", err)
		return
	}
	updateMu.Lock()
	updateData = &info
	updateMu.Unlock()
	log.Printf("Loaded update info: v%s", info.Version)
}

func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next(w, r)
	}
}

func setNoCacheHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
}

func writeJSON(w http.ResponseWriter, v any) {
	setNoCacheHeaders(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func handleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", 405)
		return
	}
	clientVersion := ""
	if r.Method == http.MethodPost {
		var req struct {
			Version string `json:"v"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, map[string]any{"s": "error", "m": "invalid request"})
			return
		}
		clientVersion = req.Version
	} else {
		q := r.URL.Query()
		clientVersion = q.Get("v")
		if clientVersion == "" {
			clientVersion = q.Get("version")
		}
		if clientVersion == "" {
			clientVersion = q.Get("current")
		}
	}
	serveUpdateResult(w, clientVersion)
}

func serveUpdateResult(w http.ResponseWriter, clientVersion string) {
	updateMu.RLock()
	info := updateData
	updateMu.RUnlock()
	if info == nil || !isNewer(info.Version, clientVersion) {
		writeJSON(w, map[string]any{"s": "ok", "d": nil})
	} else {
		writeJSON(w, map[string]any{"s": "ok", "d": info})
	}
}

func isNewer(server, client string) bool {
	sv := parseVersion(server)
	cv := parseVersion(client)
	for i := 0; i < len(sv) || i < len(cv); i++ {
		s, c := 0, 0
		if i < len(sv) {
			s = sv[i]
		}
		if i < len(cv) {
			c = cv[i]
		}
		if s > c {
			return true
		}
		if s < c {
			return false
		}
	}
	return false
}

func parseVersion(v string) []int {
	parts := strings.Split(v, ".")
	nums := make([]int, len(parts))
	for i, p := range parts {
		n, _ := strconv.Atoi(p)
		nums[i] = n
	}
	return nums
}

func main() {
	loadUpdate()
	loadMessage()
	loadStats()

	go func() {
		for range time.Tick(60 * time.Second) {
			loadUpdate()
			loadMessage()
			saveStats()
		}
	}()

	http.HandleFunc("/version", cors(handleUpdate))
	http.HandleFunc("/message", cors(handleMessage))
	http.HandleFunc("/ping", cors(handleHeartbeat))
	http.HandleFunc("/api/v2/update", cors(handleUpdate))
	http.HandleFunc("/api/v2/message", cors(handleMessage))
	http.HandleFunc("/api/v2/heartbeat", cors(handleHeartbeat))
	http.HandleFunc("/internal/stats", handleStats)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"status": "ok"})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}
	log.Printf("app-control starting on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
