"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = require("express");
var express_session_1 = require("express-session");
var axios_1 = require("axios");
var dotenv = require("dotenv");
var fs = require("fs");
var path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
var DatabaseSync = require('node:sqlite').DatabaseSync;
dotenv.config();
var app = (0, express_1.default)();
var PORT = process.env.PORT || 3000;
var SITE_PASSWORD = process.env.SITE_PASSWORD || 'admin';
var DB_PATH = path.join(__dirname, 'clips.db');
var APPROVED_FILE = path.join(__dirname, 'approved.json');
var clientID = process.env.TWITCH_CLIENT_ID;
var clientSecret = process.env.TWITCH_CLIENT_SECRET;
var streamerID = process.env.TWITCH_STREAMER_ID;
var DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
var DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
// ── Database setup ─────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
var db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec("\n    CREATE TABLE IF NOT EXISTS clips (\n        id               TEXT PRIMARY KEY,\n        url              TEXT NOT NULL,\n        title            TEXT NOT NULL,\n        view_count       INTEGER NOT NULL DEFAULT 0,\n        created_at       TEXT NOT NULL,\n        thumbnail_url    TEXT NOT NULL,\n        broadcaster_name TEXT NOT NULL,\n        approved         INTEGER NOT NULL DEFAULT 0,\n        sent             INTEGER NOT NULL DEFAULT 0,\n        sorted_out       INTEGER NOT NULL DEFAULT 0,\n        fetched_at       TEXT NOT NULL\n    )\n");
// Add `sent` column to existing DBs that predate this migration
try {
    db.exec('ALTER TABLE clips ADD COLUMN sent INTEGER NOT NULL DEFAULT 0');
}
catch ( /* column already exists */_a) { /* column already exists */ }
// Add `sorted_out` column to existing DBs that predate this migration
try {
    db.exec('ALTER TABLE clips ADD COLUMN sorted_out INTEGER NOT NULL DEFAULT 0');
}
catch ( /* column already exists */_b) { /* column already exists */ }
// Migrate approved.json → DB if it still exists
if (fs.existsSync(APPROVED_FILE)) {
    var ids = JSON.parse(fs.readFileSync(APPROVED_FILE, 'utf-8'));
    db.exec('BEGIN');
    var migrateStmt = db.prepare('UPDATE clips SET approved = 1 WHERE id = $id');
    for (var _i = 0, ids_1 = ids; _i < ids_1.length; _i++) {
        var id = ids_1[_i];
        migrateStmt.run({ $id: id });
    }
    db.exec('COMMIT');
    fs.renameSync(APPROVED_FILE, APPROVED_FILE + '.migrated');
    console.log("\u2705  Migrated ".concat(ids.length, " approved clips from approved.json \u2192 SQLite"));
}
// ── DB helpers ─────────────────────────────────────────────────────────────
var upsertStmt = db.prepare("\n    INSERT INTO clips (id, url, title, view_count, created_at, thumbnail_url, broadcaster_name, fetched_at)\n    VALUES ($id, $url, $title, $view_count, $created_at, $thumbnail_url, $broadcaster_name, $fetched_at)\n    ON CONFLICT(id) DO UPDATE SET\n        view_count       = excluded.view_count,\n        title            = excluded.title,\n        thumbnail_url    = excluded.thumbnail_url,\n        fetched_at       = excluded.fetched_at\n");
function upsertClips(clips) {
    var now = new Date().toISOString();
    db.exec('BEGIN');
    try {
        for (var _i = 0, clips_1 = clips; _i < clips_1.length; _i++) {
            var c = clips_1[_i];
            upsertStmt.run({
                $id: c.id,
                $url: c.url,
                $title: c.title,
                $view_count: c.view_count,
                $created_at: c.created_at,
                $thumbnail_url: c.thumbnail_url,
                $broadcaster_name: c.broadcaster_name,
                $fetched_at: now,
            });
        }
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
var selectAllStmt = db.prepare('SELECT * FROM clips ORDER BY view_count DESC');
function getAllClips() {
    var rows = selectAllStmt.all();
    return rows.map(function (r) { return (__assign(__assign({}, r), { approved: r.approved === 1, sent: r.sent === 1, sorted_out: r.sorted_out === 1 })); });
}
// ── Discord helpers ────────────────────────────────────────────────────────
function sendDiscordMessage(content) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, axios_1.default.post("https://discord.com/api/v10/channels/".concat(DISCORD_CHANNEL_ID, "/messages"), { content: content }, { headers: { Authorization: "Bot ".concat(DISCORD_BOT_TOKEN), 'Content-Type': 'application/json' } })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// Split URLs into chunks that fit within Discord's 2000-char message limit
function chunkUrls(urls) {
    var chunks = [];
    var current = '';
    for (var _i = 0, urls_1 = urls; _i < urls_1.length; _i++) {
        var url = urls_1[_i];
        var line = url + '\n';
        if (current.length + line.length > 1900) {
            chunks.push(current.trimEnd());
            current = line;
        }
        else {
            current += line;
        }
    }
    if (current.trim())
        chunks.push(current.trimEnd());
    return chunks;
}
// ── Twitch helpers ─────────────────────────────────────────────────────────
function getTwitchAccessToken() {
    return __awaiter(this, void 0, void 0, function () {
        var response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, axios_1.default.post('https://id.twitch.tv/oauth2/token', null, {
                        params: {
                            client_id: clientID,
                            client_secret: clientSecret,
                            grant_type: 'client_credentials',
                        },
                    })];
                case 1:
                    response = _a.sent();
                    return [2 /*return*/, response.data.access_token];
            }
        });
    });
}
function fetchClipsFromTwitch(accessToken) {
    return __awaiter(this, void 0, void 0, function () {
        var response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, axios_1.default.get('https://api.twitch.tv/helix/clips', {
                        params: { broadcaster_id: streamerID, first: 100 },
                        headers: {
                            Authorization: "Bearer ".concat(accessToken),
                            'Client-Id': clientID,
                        },
                    })];
                case 1:
                    response = _a.sent();
                    return [2 /*return*/, response.data.data];
            }
        });
    });
}
// ── Express setup ──────────────────────────────────────────────────────────
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, express_session_1.default)({
    secret: 'twitch-clips-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));
app.use(express_1.default.static(path.join(__dirname, 'public')));
function requireAuth(req, res, next) {
    if (req.session.authenticated) {
        next();
    }
    else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}
// ── Auth routes ────────────────────────────────────────────────────────────
app.post('/api/login', function (req, res) {
    var password = req.body.password;
    if (password === SITE_PASSWORD) {
        req.session.authenticated = true;
        res.json({ success: true });
    }
    else {
        res.status(401).json({ error: 'Invalid password' });
    }
});
app.get('/api/auth', function (req, res) {
    res.json({ authenticated: !!req.session.authenticated });
});
app.post('/api/logout', function (req, res) {
    req.session.destroy(function () { });
    res.json({ success: true });
});
// ── Clips routes ───────────────────────────────────────────────────────────
app.get('/api/clips', requireAuth, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var accessToken, twitchClips, err_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 3, , 4]);
                return [4 /*yield*/, getTwitchAccessToken()];
            case 1:
                accessToken = _a.sent();
                return [4 /*yield*/, fetchClipsFromTwitch(accessToken)];
            case 2:
                twitchClips = _a.sent();
                // 2. Upsert into DB (approved column is never overwritten)
                upsertClips(twitchClips);
                console.log("\uD83D\uDD04  Upserted ".concat(twitchClips.length, " clips into DB"));
                // 3. Return the full DB (all accumulated clips, sorted by views)
                res.json(getAllClips());
                return [3 /*break*/, 4];
            case 3:
                err_1 = _a.sent();
                console.error(err_1);
                res.status(500).json({ error: 'Failed to fetch clips' });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
app.post('/api/approve/:clipId', requireAuth, function (req, res) {
    var clipId = req.params.clipId;
    db.prepare('UPDATE clips SET approved = 1 WHERE id = $id').run({ $id: clipId });
    res.json({ success: true });
});
app.delete('/api/approve/:clipId', requireAuth, function (req, res) {
    var clipId = req.params.clipId;
    db.prepare('UPDATE clips SET approved = 0 WHERE id = $id').run({ $id: clipId });
    res.json({ success: true });
});
app.post('/api/sortout/:clipId', requireAuth, function (req, res) {
    var clipId = req.params.clipId;
    db.prepare('UPDATE clips SET sorted_out = 1 WHERE id = $id').run({ $id: clipId });
    res.json({ success: true });
});
app.delete('/api/sortout/:clipId', requireAuth, function (req, res) {
    var clipId = req.params.clipId;
    db.prepare('UPDATE clips SET sorted_out = 0 WHERE id = $id').run({ $id: clipId });
    res.json({ success: true });
});
app.post('/api/send-approved', requireAuth, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var clips, urls, chunks, _i, chunks_1, chunk, markSent, _a, clips_2, c, err_2;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _b.trys.push([0, 5, , 6]);
                clips = db
                    .prepare('SELECT id, url, title FROM clips WHERE approved = 1 AND sent = 0 ORDER BY view_count DESC')
                    .all();
                if (clips.length === 0) {
                    res.json({ success: true, sent: 0 });
                    return [2 /*return*/];
                }
                urls = clips.map(function (c) { return c.url; });
                chunks = chunkUrls(urls);
                _i = 0, chunks_1 = chunks;
                _b.label = 1;
            case 1:
                if (!(_i < chunks_1.length)) return [3 /*break*/, 4];
                chunk = chunks_1[_i];
                return [4 /*yield*/, sendDiscordMessage(chunk)];
            case 2:
                _b.sent();
                _b.label = 3;
            case 3:
                _i++;
                return [3 /*break*/, 1];
            case 4:
                console.log("\uD83D\uDCE8  Sent ".concat(clips.length, " clip URLs to Discord in ").concat(chunks.length, " message(s)"));
                markSent = db.prepare('UPDATE clips SET sent = 1 WHERE id = $id');
                db.exec('BEGIN');
                try {
                    for (_a = 0, clips_2 = clips; _a < clips_2.length; _a++) {
                        c = clips_2[_a];
                        markSent.run({ $id: c.id });
                    }
                    db.exec('COMMIT');
                }
                catch (err) {
                    db.exec('ROLLBACK');
                    throw err;
                }
                res.json({ success: true, sent: clips.length });
                return [3 /*break*/, 6];
            case 5:
                err_2 = _b.sent();
                console.error(err_2);
                res.status(500).json({ error: 'Failed to send to Discord' });
                return [3 /*break*/, 6];
            case 6: return [2 /*return*/];
        }
    });
}); });
// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, function () {
    console.log("\u2705  Server running at http://localhost:".concat(PORT));
    console.log("\uD83D\uDDC4\uFE0F  Database: ".concat(DB_PATH));
});
