package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

const (
	maxRequestBytes = 7 * 1024 * 1024
	maxLogBytes     = 1 * 1024 * 1024
	maxImageBytes   = int64(1572864)
	maxImageCount   = 3
	sessionTTL      = 7 * 24 * time.Hour
)

var allowedImageMimes = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/webp": ".webp",
}

type app struct {
	db              *pgxpool.Pool
	dataDir         string
	adminUsername   string
	adminPassword   string
	adminName       string
	adminStaticPath string
}

type apiResponse struct {
	Status  string      `json:"s"`
	Data    interface{} `json:"d,omitempty"`
	Message string      `json:"m,omitempty"`
}

type ticketListItem struct {
	ID          int64       `json:"id"`
	TicketNo    string      `json:"ticket_no"`
	Title       string      `json:"title"`
	Status      string      `json:"status"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
	LatestReply *replyBrief `json:"latest_reply,omitempty"`
}

type replyBrief struct {
	Name      string    `json:"name"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"created_at"`
}

type fileMeta struct {
	ID       int64  `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"filename"`
	Mime     string `json:"mime"`
	Size     int64  `json:"size"`
	Download string `json:"download,omitempty"`
}

type ticketDetail struct {
	ID          int64       `json:"id"`
	TicketNo    string      `json:"ticket_no"`
	Title       string      `json:"title"`
	Email       string      `json:"email"`
	Content     string      `json:"content"`
	Status      string      `json:"status"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
	ClientID    string      `json:"install_id,omitempty"`
	AppVersion  string      `json:"app_version,omitempty"`
	AdminNote   string      `json:"admin_note,omitempty"`
	LatestReply *replyBrief `json:"latest_reply,omitempty"`
	Files       []fileMeta  `json:"files,omitempty"`
}

type messageItem struct {
	ID         int64     `json:"id"`
	AuthorType string    `json:"author_type"`
	Name       string    `json:"name"`
	Message    string    `json:"message"`
	CreatedAt  time.Time `json:"created_at"`
}

func main() {
	port := envOr("PORT", "8082")
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	dataDir := envOr("DATA_DIR", "./data/files")
	if err := os.MkdirAll(filepath.Join(dataDir, "tickets"), 0o755); err != nil {
		log.Fatalf("create data dir: %v", err)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect db: %v", err)
	}
	defer pool.Close()

	svc := &app{
		db:              pool,
		dataDir:         dataDir,
		adminUsername:   envOr("ADMIN_USERNAME", "admin"),
		adminPassword:   envOr("ADMIN_PASSWORD", "change-me-admin-password"),
		adminName:       envOr("ADMIN_NAME", "Lucas"),
		adminStaticPath: filepath.Join(".", "static"),
	}

	if err := svc.migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if err := svc.ensureAdmin(ctx); err != nil {
		log.Fatalf("ensure admin: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/admin/", svc.withRecover(svc.withRequestLog(svc.adminStatic())))
	mux.Handle("/admin/api/login", svc.withRecover(svc.withRequestLog(svc.cors(http.HandlerFunc(svc.handleAdminLogin)))))
	mux.Handle("/admin/api/logout", svc.withRecover(svc.withRequestLog(svc.cors(svc.withAdmin(http.HandlerFunc(svc.handleAdminLogout))))))
	mux.Handle("/admin/api/session", svc.withRecover(svc.withRequestLog(svc.cors(svc.withAdmin(http.HandlerFunc(svc.handleAdminSession))))))
	mux.Handle("/admin/api/tickets", svc.withRecover(svc.withRequestLog(svc.cors(svc.withAdmin(http.HandlerFunc(svc.handleAdminTickets))))))
	mux.Handle("/admin/api/tickets/", svc.withRecover(svc.withRequestLog(svc.cors(svc.withAdmin(http.HandlerFunc(svc.handleAdminTicketRoutes))))))

	mux.Handle("/api/tickets", svc.withRecover(svc.withRequestLog(svc.cors(http.HandlerFunc(svc.handleCreateTicket)))))
	mux.Handle("/api/client/tickets", svc.withRecover(svc.withRequestLog(svc.cors(http.HandlerFunc(svc.handleClientTickets)))))
	mux.Handle("/api/client/tickets/", svc.withRecover(svc.withRequestLog(svc.cors(http.HandlerFunc(svc.handleClientTicketRoutes)))))
	mux.Handle("/health", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"status": "ok"}})
	}))

	log.Printf("ticket-center starting on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

func (a *app) migrate(ctx context.Context) error {
	stmts := []string{
		`create table if not exists clients (
			id bigserial primary key,
			install_id text not null unique,
			legacy_client_id text,
			first_seen_at timestamptz not null default now(),
			last_seen_at timestamptz not null default now(),
			app_version text not null default ''
		)`,
		`create table if not exists users (
			id bigserial primary key,
			username text unique,
			password_hash text,
			created_at timestamptz not null default now()
		)`,
		`create table if not exists admins (
			id bigserial primary key,
			name text not null,
			username text not null unique,
			password_hash text not null,
			created_at timestamptz not null default now()
		)`,
		`create table if not exists admin_sessions (
			id bigserial primary key,
			admin_id bigint not null references admins(id) on delete cascade,
			token_hash text not null unique,
			expires_at timestamptz not null,
			created_at timestamptz not null default now()
		)`,
		`create table if not exists tickets (
			id bigserial primary key,
			ticket_no text not null unique,
			client_id bigint not null references clients(id) on delete restrict,
			user_id bigint references users(id) on delete set null,
			title text not null,
			email text not null,
			content text not null,
			status text not null default 'pending',
			ip text not null default '',
			admin_note text not null default '',
			created_at timestamptz not null default now(),
			updated_at timestamptz not null default now()
		)`,
		`create table if not exists ticket_files (
			id bigserial primary key,
			ticket_id bigint not null references tickets(id) on delete cascade,
			kind text not null,
			filename text not null,
			path text not null,
			mime text not null,
			size bigint not null,
			created_at timestamptz not null default now()
		)`,
		`create table if not exists ticket_messages (
			id bigserial primary key,
			ticket_id bigint not null references tickets(id) on delete cascade,
			author_type text not null,
			author_name text not null,
			message text not null,
			created_at timestamptz not null default now()
		)`,
		`create index if not exists idx_tickets_client_id on tickets(client_id)`,
		`create index if not exists idx_ticket_messages_ticket_id on ticket_messages(ticket_id)`,
	}
	for _, stmt := range stmts {
		if _, err := a.db.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) ensureAdmin(ctx context.Context) error {
	var id int64
	err := a.db.QueryRow(ctx, `select id from admins where username=$1`, a.adminUsername).Scan(&id)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) && !strings.Contains(err.Error(), "no rows") {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(a.adminPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(ctx,
		`insert into admins (name, username, password_hash) values ($1,$2,$3) on conflict (username) do nothing`,
		a.adminName, a.adminUsername, string(hash),
	)
	return err
}

func (a *app) handleCreateTicket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{Status: "error", Message: "method not allowed"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if err := r.ParseMultipartForm(maxRequestBytes); err != nil {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid multipart form"})
		return
	}

	title := strings.TrimSpace(r.FormValue("title"))
	email := strings.TrimSpace(r.FormValue("email"))
	content := strings.TrimSpace(r.FormValue("content"))
	installID := strings.TrimSpace(r.FormValue("install_id"))
	legacyID := strings.TrimSpace(r.FormValue("legacy_client_id"))
	appVersion := strings.TrimSpace(r.FormValue("app_version"))
	if title == "" || email == "" || content == "" || installID == "" {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "missing required fields"})
		return
	}
	if len([]rune(content)) > 400 {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "content too long"})
		return
	}
	if !isValidEmail(email) {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid contact"})
		return
	}

	ctx := r.Context()
	clientID, err := a.upsertClient(ctx, installID, legacyID, appVersion)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "create client failed"})
		return
	}

	now := time.Now().UTC()
	ticketNo := fmt.Sprintf("GP-%s-%06d", now.Format("20060102"), now.UnixNano()%1000000)
	var ticketID int64
	err = a.db.QueryRow(ctx,
		`insert into tickets (ticket_no, client_id, title, email, content, status, ip, created_at, updated_at)
		 values ($1,$2,$3,$4,$5,'pending',$6,$7,$7) returning id`,
		ticketNo, clientID, title, email, content, clientIP(r), now,
	).Scan(&ticketID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "create ticket failed"})
		return
	}

	if _, err := a.db.Exec(ctx,
		`insert into ticket_messages (ticket_id, author_type, author_name, message, created_at) values ($1,'client','用户',$2,$3)`,
		ticketID, content, now,
	); err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "create message failed"})
		return
	}

	ticketDir := filepath.Join(a.dataDir, "tickets", strconv.FormatInt(ticketID, 10))
	if err := os.MkdirAll(ticketDir, 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "create attachment dir failed"})
		return
	}

	files := r.MultipartForm.File["images"]
	if len(files) > maxImageCount {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "too many images"})
		return
	}
	for i, header := range files {
		if err := a.saveImage(ctx, ticketID, i, header); err != nil {
			writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: err.Error()})
			return
		}
	}
	if logHeader := firstFile(r.MultipartForm.File["log"]); logHeader != nil {
		if err := a.saveLogFile(ctx, ticketID, logHeader); err != nil {
			writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: err.Error()})
			return
		}
	}

	writeJSON(w, http.StatusOK, apiResponse{
		Status: "ok",
		Data: map[string]interface{}{
			"id":     ticketID,
			"ticket": ticketNo,
			"status": "pending",
		},
	})
}

func (a *app) handleClientTickets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{Status: "error", Message: "method not allowed"})
		return
	}
	installID := strings.TrimSpace(r.URL.Query().Get("install_id"))
	if installID == "" {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "install_id required"})
		return
	}
	rows, err := a.db.Query(r.Context(), `
		select
			t.id, t.ticket_no, t.title, t.status, t.created_at, t.updated_at,
			m.author_name, m.message, m.created_at
		from tickets t
		join clients c on c.id = t.client_id
		left join lateral (
			select author_name, message, created_at
			from ticket_messages
			where ticket_id = t.id and author_type = 'admin'
			order by created_at desc
			limit 1
		) m on true
		where c.install_id = $1
		order by t.updated_at desc
	`, installID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "query tickets failed"})
		return
	}
	defer rows.Close()

	items := make([]ticketListItem, 0)
	for rows.Next() {
		var item ticketListItem
		var name, msg sql.NullString
		var created sql.NullTime
		if err := rows.Scan(&item.ID, &item.TicketNo, &item.Title, &item.Status, &item.CreatedAt, &item.UpdatedAt, &name, &msg, &created); err != nil {
			writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "scan tickets failed"})
			return
		}
		if name.Valid && msg.Valid && created.Valid {
			item.LatestReply = &replyBrief{Name: name.String, Message: msg.String, CreatedAt: created.Time}
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: items})
}

func (a *app) handleClientTicketRoutes(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/client/tickets/")
	if strings.HasSuffix(path, "/messages") {
		idStr := strings.TrimSuffix(path, "/messages")
		id, err := strconv.ParseInt(strings.Trim(idStr, "/"), 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid ticket id"})
			return
		}
		a.handleClientMessages(w, r, id)
		return
	}
	http.NotFound(w, r)
}

func (a *app) handleClientMessages(w http.ResponseWriter, r *http.Request, ticketID int64) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{Status: "error", Message: "method not allowed"})
		return
	}
	installID := strings.TrimSpace(r.URL.Query().Get("install_id"))
	if installID == "" {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "install_id required"})
		return
	}

	var exists bool
	if err := a.db.QueryRow(r.Context(),
		`select exists(
			select 1 from tickets t
			join clients c on c.id = t.client_id
			where t.id = $1 and c.install_id = $2
		)`, ticketID, installID,
	).Scan(&exists); err != nil || !exists {
		writeJSON(w, http.StatusForbidden, apiResponse{Status: "error", Message: "ticket not found"})
		return
	}

	rows, err := a.db.Query(r.Context(),
		`select id, author_type, author_name, message, created_at from ticket_messages where ticket_id=$1 order by created_at asc`,
		ticketID,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "query messages failed"})
		return
	}
	defer rows.Close()

	items := make([]messageItem, 0)
	for rows.Next() {
		var item messageItem
		if err := rows.Scan(&item.ID, &item.AuthorType, &item.Name, &item.Message, &item.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "scan messages failed"})
			return
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: items})
}

func (a *app) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{Status: "error", Message: "method not allowed"})
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid request"})
		return
	}
	var adminID int64
	var name, hash string
	err := a.db.QueryRow(r.Context(),
		`select id, name, password_hash from admins where username=$1`, strings.TrimSpace(req.Username),
	).Scan(&adminID, &name, &hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		writeJSON(w, http.StatusUnauthorized, apiResponse{Status: "error", Message: "invalid credentials"})
		return
	}
	rawToken, tokenHash, err := newSessionToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "create session failed"})
		return
	}
	expiresAt := time.Now().UTC().Add(sessionTTL)
	if _, err := a.db.Exec(r.Context(),
		`insert into admin_sessions (admin_id, token_hash, expires_at) values ($1,$2,$3)`,
		adminID, tokenHash, expiresAt,
	); err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "save session failed"})
		return
	}
	setSessionCookie(w, rawToken, expiresAt)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"name": name}})
}

func (a *app) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{Status: "error", Message: "method not allowed"})
		return
	}
	if cookie, err := r.Cookie("ticket_admin_session"); err == nil {
		_, _ = a.db.Exec(r.Context(), `delete from admin_sessions where token_hash=$1`, hashToken(cookie.Value))
	}
	clearSessionCookie(w)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok"})
}

func (a *app) handleAdminSession(w http.ResponseWriter, r *http.Request) {
	admin, ok := adminFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, apiResponse{Status: "error", Message: "unauthorized"})
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"name": admin.Name}})
}

func (a *app) handleAdminTickets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{Status: "error", Message: "method not allowed"})
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	page := max(1, atoiDefault(r.URL.Query().Get("page"), 1))
	pageSize := 20
	offset := (page - 1) * pageSize

	clauses := []string{"1=1"}
	args := []interface{}{}
	if status != "" {
		args = append(args, status)
		clauses = append(clauses, fmt.Sprintf("t.status=$%d", len(args)))
	}
	if q != "" {
		args = append(args, "%"+q+"%")
		clauses = append(clauses, fmt.Sprintf("(t.ticket_no ilike $%d or t.title ilike $%d or t.email ilike $%d)", len(args), len(args), len(args)))
	}
	args = append(args, pageSize, offset)

	query := `
		select t.id, t.ticket_no, t.title, t.status, t.created_at, t.updated_at,
		       m.author_name, m.message, m.created_at
		from tickets t
		left join lateral (
			select author_name, message, created_at
			from ticket_messages
			where ticket_id = t.id and author_type='admin'
			order by created_at desc
			limit 1
		) m on true
		where ` + strings.Join(clauses, " and ") + `
		order by t.updated_at desc
		limit $` + strconv.Itoa(len(args)-1) + ` offset $` + strconv.Itoa(len(args))

	rows, err := a.db.Query(r.Context(), query, args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "query tickets failed"})
		return
	}
	defer rows.Close()
	items := make([]ticketListItem, 0)
	for rows.Next() {
		var item ticketListItem
		var name, msg sql.NullString
		var created sql.NullTime
		if err := rows.Scan(&item.ID, &item.TicketNo, &item.Title, &item.Status, &item.CreatedAt, &item.UpdatedAt, &name, &msg, &created); err != nil {
			writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "scan tickets failed"})
			return
		}
		if name.Valid && msg.Valid && created.Valid {
			item.LatestReply = &replyBrief{Name: name.String, Message: msg.String, CreatedAt: created.Time}
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: items})
}

func (a *app) handleAdminTicketRoutes(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/admin/api/tickets/")
	path = strings.Trim(path, "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	ticketID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid ticket id"})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		a.handleAdminTicketDetail(w, r, ticketID)
		return
	}
	if len(parts) == 2 && parts[1] == "status" && r.Method == http.MethodPost {
		a.handleAdminTicketStatus(w, r, ticketID)
		return
	}
	if len(parts) == 2 && parts[1] == "messages" && r.Method == http.MethodPost {
		a.handleAdminTicketMessage(w, r, ticketID)
		return
	}
	if len(parts) == 3 && parts[1] == "files" && r.Method == http.MethodGet {
		fileID, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid file id"})
			return
		}
		a.handleAdminTicketFile(w, r, ticketID, fileID)
		return
	}
	http.NotFound(w, r)
}

func (a *app) handleAdminTicketDetail(w http.ResponseWriter, r *http.Request, ticketID int64) {
	row := a.db.QueryRow(r.Context(), `
		select t.id, t.ticket_no, t.title, t.email, t.content, t.status, t.created_at, t.updated_at, c.install_id, c.app_version, t.admin_note
		from tickets t
		join clients c on c.id = t.client_id
		where t.id = $1
	`, ticketID)
	var detail ticketDetail
	if err := row.Scan(&detail.ID, &detail.TicketNo, &detail.Title, &detail.Email, &detail.Content, &detail.Status, &detail.CreatedAt, &detail.UpdatedAt, &detail.ClientID, &detail.AppVersion, &detail.AdminNote); err != nil {
		writeJSON(w, http.StatusNotFound, apiResponse{Status: "error", Message: "ticket not found"})
		return
	}
	filesRows, err := a.db.Query(r.Context(),
		`select id, kind, filename, mime, size from ticket_files where ticket_id=$1 order by created_at asc`, ticketID,
	)
	if err == nil {
		defer filesRows.Close()
		for filesRows.Next() {
			var f fileMeta
			if err := filesRows.Scan(&f.ID, &f.Kind, &f.Name, &f.Mime, &f.Size); err == nil {
				f.Download = fmt.Sprintf("/admin/api/tickets/%d/files/%d", ticketID, f.ID)
				detail.Files = append(detail.Files, f)
			}
		}
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: detail})
}

func (a *app) handleAdminTicketStatus(w http.ResponseWriter, r *http.Request, ticketID int64) {
	var req struct {
		Status    string `json:"status"`
		AdminNote string `json:"admin_note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid request"})
		return
	}
	if !isValidStatus(req.Status) {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid status"})
		return
	}
	if _, err := a.db.Exec(r.Context(),
		`update tickets set status=$2, admin_note=$3, updated_at=now() where id=$1`,
		ticketID, req.Status, strings.TrimSpace(req.AdminNote),
	); err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "update ticket failed"})
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok"})
}

func (a *app) handleAdminTicketMessage(w http.ResponseWriter, r *http.Request, ticketID int64) {
	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "invalid request"})
		return
	}
	req.Message = strings.TrimSpace(req.Message)
	if req.Message == "" {
		writeJSON(w, http.StatusBadRequest, apiResponse{Status: "error", Message: "message required"})
		return
	}
	admin, _ := adminFromContext(r.Context())
	if _, err := a.db.Exec(r.Context(),
		`insert into ticket_messages (ticket_id, author_type, author_name, message, created_at) values ($1,'admin',$2,$3,now())`,
		ticketID, admin.Name, req.Message,
	); err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "send message failed"})
		return
	}
	if _, err := a.db.Exec(r.Context(), `update tickets set updated_at=now() where id=$1`, ticketID); err != nil {
		writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "touch ticket failed"})
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok"})
}

func (a *app) handleAdminTicketFile(w http.ResponseWriter, r *http.Request, ticketID, fileID int64) {
	var relPath, fileName, mime string
	err := a.db.QueryRow(r.Context(),
		`select path, filename, mime from ticket_files where id=$1 and ticket_id=$2`,
		fileID, ticketID,
	).Scan(&relPath, &fileName, &mime)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	fullPath := filepath.Join(a.dataDir, relPath)
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", fileName))
	http.ServeFile(w, r, fullPath)
}

func (a *app) adminStatic() http.Handler {
	fs := http.FileServer(http.Dir(a.adminStaticPath))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/admin" {
			http.Redirect(w, r, "/admin/", http.StatusTemporaryRedirect)
			return
		}
		if r.URL.Path == "/admin/" {
			http.ServeFile(w, r, filepath.Join(a.adminStaticPath, "index.html"))
			return
		}
		http.StripPrefix("/admin/", fs).ServeHTTP(w, r)
	})
}

type adminSession struct {
	ID   int64
	Name string
}

type contextKey string

const adminContextKey contextKey = "admin"

func (a *app) withAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("ticket_admin_session")
		if err != nil || strings.TrimSpace(cookie.Value) == "" {
			writeJSON(w, http.StatusUnauthorized, apiResponse{Status: "error", Message: "unauthorized"})
			return
		}
		var admin adminSession
		err = a.db.QueryRow(r.Context(), `
			select ad.id, ad.name
			from admin_sessions s
			join admins ad on ad.id = s.admin_id
			where s.token_hash=$1 and s.expires_at > now()
		`, hashToken(cookie.Value)).Scan(&admin.ID, &admin.Name)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, apiResponse{Status: "error", Message: "unauthorized"})
			return
		}
		ctx := context.WithValue(r.Context(), adminContextKey, admin)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func adminFromContext(ctx context.Context) (adminSession, bool) {
	admin, ok := ctx.Value(adminContextKey).(adminSession)
	return admin, ok
}

func (a *app) withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic: %v", rec)
				writeJSON(w, http.StatusInternalServerError, apiResponse{Status: "error", Message: "internal server error"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (a *app) withRequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s %s", r.Method, r.URL.Path, clientIP(r))
		next.ServeHTTP(w, r)
	})
}

func (a *app) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) upsertClient(ctx context.Context, installID, legacyID, appVersion string) (int64, error) {
	var id int64
	err := a.db.QueryRow(ctx, `
		insert into clients (install_id, legacy_client_id, app_version, first_seen_at, last_seen_at)
		values ($1,$2,$3,now(),now())
		on conflict (install_id) do update
		set legacy_client_id = excluded.legacy_client_id,
			app_version = excluded.app_version,
			last_seen_at = now()
		returning id
	`, installID, nullIfEmpty(legacyID), appVersion).Scan(&id)
	return id, err
}

func (a *app) saveImage(ctx context.Context, ticketID int64, index int, header *multipart.FileHeader) error {
	if header.Size > maxImageBytes {
		return fmt.Errorf("image %s exceeds 1.5MB", header.Filename)
	}
	src, err := header.Open()
	if err != nil {
		return errors.New("open image failed")
	}
	defer src.Close()

	data, err := io.ReadAll(io.LimitReader(src, maxImageBytes+1))
	if err != nil {
		return errors.New("read image failed")
	}
	if int64(len(data)) > maxImageBytes {
		return fmt.Errorf("image %s exceeds 1.5MB", header.Filename)
	}
	mime := http.DetectContentType(data)
	ext, ok := allowedImageMimes[mime]
	if !ok {
		return fmt.Errorf("image %s format not supported", header.Filename)
	}
	baseName := fmt.Sprintf("image-%d%s", index+1, ext)
	relPath := filepath.Join("tickets", strconv.FormatInt(ticketID, 10), baseName)
	fullPath := filepath.Join(a.dataDir, relPath)
	if err := os.WriteFile(fullPath, data, 0o644); err != nil {
		return errors.New("save image failed")
	}
	_, err = a.db.Exec(ctx,
		`insert into ticket_files (ticket_id, kind, filename, path, mime, size) values ($1,'image',$2,$3,$4,$5)`,
		ticketID, header.Filename, relPath, mime, len(data),
	)
	return err
}

func (a *app) saveLogFile(ctx context.Context, ticketID int64, header *multipart.FileHeader) error {
	if header.Size > maxLogBytes {
		return errors.New("log file exceeds 1MB")
	}
	src, err := header.Open()
	if err != nil {
		return errors.New("open log failed")
	}
	defer src.Close()
	data, err := io.ReadAll(io.LimitReader(src, maxLogBytes+1))
	if err != nil {
		return errors.New("read log failed")
	}
	if len(data) > maxLogBytes {
		return errors.New("log file exceeds 1MB")
	}
	baseName := "client-log.jsonl"
	relPath := filepath.Join("tickets", strconv.FormatInt(ticketID, 10), baseName)
	fullPath := filepath.Join(a.dataDir, relPath)
	if err := os.WriteFile(fullPath, data, 0o644); err != nil {
		return errors.New("save log failed")
	}
	_, err = a.db.Exec(ctx,
		`insert into ticket_files (ticket_id, kind, filename, path, mime, size) values ($1,'log',$2,$3,'application/jsonl',$4)`,
		ticketID, header.Filename, relPath, len(data),
	)
	return err
}

func firstFile(items []*multipart.FileHeader) *multipart.FileHeader {
	if len(items) == 0 {
		return nil
	}
	return items[0]
}

func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); ip != "" {
		return strings.TrimSpace(strings.Split(ip, ",")[0])
	}
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func writeJSON(w http.ResponseWriter, status int, payload apiResponse) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func isValidStatus(s string) bool {
	switch s {
	case "pending", "processing", "resolved", "closed":
		return true
	default:
		return false
	}
}

func envOr(key, fallback string) string {
	val := strings.TrimSpace(os.Getenv(key))
	if val == "" {
		return fallback
	}
	return val
}

func nullIfEmpty(s string) interface{} {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func isValidEmail(s string) bool {
	if len(s) < 5 || len(s) > 200 {
		return false
	}
	return strings.Count(s, "@") == 1 && !strings.HasPrefix(s, "@") && !strings.HasSuffix(s, "@")
}

func newSessionToken() (raw string, hashed string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", err
	}
	raw = base64.RawURLEncoding.EncodeToString(buf)
	hashed = hashToken(raw)
	return raw, hashed, nil
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func setSessionCookie(w http.ResponseWriter, value string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     "ticket_admin_session",
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "ticket_admin_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
}

func atoiDefault(s string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return fallback
	}
	return n
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
