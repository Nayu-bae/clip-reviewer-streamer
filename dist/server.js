"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_session_1 = __importDefault(require("express-session"));
const axios_1 = __importDefault(require("axios"));
const dotenv = __importStar(require("dotenv"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const crypto_2 = require("crypto");
const promises_1 = require("stream/promises");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite');
dotenv.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'twitch-clips-secret-2026';
const LEGACY_SITE_USERNAME = process.env.SITE_USERNAME || 'admin';
const LEGACY_SITE_PASSWORD = process.env.SITE_PASSWORD || 'admin';
const DB_PATH = path.join(__dirname, 'clips.db');
const APPROVED_FILE = path.join(__dirname, 'approved.json');
const clientID = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
function getPositiveNumberEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
const TWITCH_CLIPS_PAGE_SIZE = 100;
const TWITCH_CLIPS_MAX_PAGES = getPositiveNumberEnv('TWITCH_CLIPS_MAX_PAGES', 20);
const TWITCH_CLIPS_LOOKBACK_DAYS = getPositiveNumberEnv('TWITCH_CLIPS_LOOKBACK_DAYS', 90);
const MIN_CLIP_VIEWS = getPositiveNumberEnv('MIN_CLIP_VIEWS', 10);
const TIKTOK_API_BASE = process.env.TIKTOK_API_BASE || 'https://open.tiktokapis.com';
const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN || '';
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_ID || '';
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || '';
const TIKTOK_LOGIN_REDIRECT_URI = process.env.TIKTOK_LOGIN_REDIRECT_URI || '';
const TIKTOK_PRIVACY_LEVEL = process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY';
const VIDEO_WORK_DIR = path.join(__dirname, 'tmp', 'videos');
const TWITCH_LOGO_RELATIVE_PATH = path.join('pictures', 'twitchLogo.png');
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const CLIP_GQL_CACHE_TTL_MS = 10 * 60 * 1000;
const LEGACY_STREAMER_IDS = getStreamerIdsFromEnv();
const clipVideoUrlCache = new Map();
const previewBuildJobs = new Map();
const activeDownloadJobs = new Set();
function getStreamerIdsFromEnv() {
    const entries = Object.entries(process.env);
    const ids = entries
        .filter(([key, value]) => {
        if (!value)
            return false;
        if (key === 'TWITCH_STREAMER_ID')
            return true;
        return key.startsWith('TWITCH_STREAMER_') && key.endsWith('_ID');
    })
        .map(([, value]) => (value || '').trim())
        .filter(Boolean);
    return [...new Set(ids)];
}
const uploadJobs = new Map();
const activeUploadJobByUser = new Map();
// ── Database setup ─────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
        id               TEXT PRIMARY KEY,
        url              TEXT NOT NULL,
        title            TEXT NOT NULL,
        view_count       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        thumbnail_url    TEXT NOT NULL,
        broadcaster_name TEXT NOT NULL,
        approved         INTEGER NOT NULL DEFAULT 0,
        sorted_out       INTEGER NOT NULL DEFAULT 0,
        fetched_at       TEXT NOT NULL,
        cam_x            REAL,
        cam_y            REAL,
        cam_w            REAL,
        cam_h            REAL,
        cam_enabled      INTEGER NOT NULL DEFAULT 1,
        gameplay_x       REAL,
        gameplay_y       REAL,
        gameplay_w       REAL,
        gameplay_h       REAL,
        cam_output_y     REAL,
        cam_output_h     REAL,
        gameplay_output_y REAL,
        gameplay_output_h REAL
    )
`);
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
    )
`);
db.exec(`
    CREATE TABLE IF NOT EXISTS user_streamers (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id               INTEGER NOT NULL,
        twitch_broadcaster_id TEXT NOT NULL,
        twitch_login          TEXT,
        display_name          TEXT,
        created_at            TEXT NOT NULL,
        UNIQUE(user_id, twitch_broadcaster_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
`);
db.exec(`
    CREATE TABLE IF NOT EXISTS user_clip_state (
        user_id       INTEGER NOT NULL,
        clip_id       TEXT NOT NULL,
        approved      INTEGER NOT NULL DEFAULT 0,
        sorted_out    INTEGER NOT NULL DEFAULT 0,
        cam_x         REAL,
        cam_y         REAL,
        cam_w         REAL,
        cam_h         REAL,
        cam_enabled   INTEGER NOT NULL DEFAULT 1,
        twitch_name_enabled INTEGER NOT NULL DEFAULT 0,
        twitch_name_x REAL,
        twitch_name_y REAL,
        gameplay_x    REAL,
        gameplay_y    REAL,
        gameplay_w    REAL,
        gameplay_h    REAL,
        cam_output_y  REAL,
        cam_output_h  REAL,
        gameplay_output_y REAL,
        gameplay_output_h REAL,
        split_points_json TEXT,
        split_deleted_segments_json TEXT,
        split_zoom_segments_json TEXT,
        fetched_at    TEXT NOT NULL,
        PRIMARY KEY (user_id, clip_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(clip_id) REFERENCES clips(id) ON DELETE CASCADE
    )
`);
// Add `sorted_out` column to existing DBs that predate this migration
try {
    db.exec('ALTER TABLE clips ADD COLUMN sorted_out INTEGER NOT NULL DEFAULT 0');
}
catch { /* column already exists */ }
function addColumnIfMissing(sql) {
    try {
        db.exec(sql);
    }
    catch { /* column already exists */ }
}
addColumnIfMissing('ALTER TABLE clips ADD COLUMN cam_x REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN cam_y REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN cam_w REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN cam_h REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN cam_enabled INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN gameplay_x REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN gameplay_y REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN gameplay_w REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN gameplay_h REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN cam_output_y REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN cam_output_h REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN gameplay_output_y REAL');
addColumnIfMissing('ALTER TABLE clips ADD COLUMN gameplay_output_h REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN cam_output_y REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN cam_output_h REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN gameplay_output_y REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN gameplay_output_h REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN twitch_name_enabled INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN twitch_name_x REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN twitch_name_y REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_points_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_deleted_segments_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_zoom_segments_json TEXT');
function hashPassword(plain) {
    const salt = (0, crypto_2.randomBytes)(16).toString('hex');
    const derived = (0, crypto_2.scryptSync)(plain, salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
}
function verifyPassword(plain, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt')
        return false;
    const [, salt, expectedHex] = parts;
    const actual = (0, crypto_2.scryptSync)(plain, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && (0, crypto_2.timingSafeEqual)(expected, actual);
}
function getUserByUsername(username) {
    return db.prepare('SELECT id, username, password_hash FROM users WHERE username = $username')
        .get({ $username: username });
}
function getUserById(userId) {
    return db.prepare('SELECT id, username, password_hash FROM users WHERE id = $id')
        .get({ $id: userId });
}
function createUser(username, password) {
    const now = new Date().toISOString();
    const result = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES ($username, $hash, $created_at)').run({
        $username: username,
        $hash: hashPassword(password),
        $created_at: now,
    });
    return Number(result.lastInsertRowid);
}
function listUserStreamerIds(userId) {
    const rows = db.prepare('SELECT twitch_broadcaster_id FROM user_streamers WHERE user_id = $user_id ORDER BY id ASC')
        .all({ $user_id: userId });
    return rows.map(r => String(r.twitch_broadcaster_id));
}
function listUserStreamerNameKeys(userId) {
    const rows = db.prepare(`
        SELECT twitch_login, display_name
        FROM user_streamers
        WHERE user_id = $user_id
    `).all({ $user_id: userId });
    const keys = new Set();
    for (const row of rows) {
        const login = String(row.twitch_login || '').trim().toLowerCase();
        const display = String(row.display_name || '').trim().toLowerCase();
        if (login)
            keys.add(login);
        if (display)
            keys.add(display);
    }
    return keys;
}
function getAllUserStreamers(userId) {
    return db.prepare(`
        SELECT id, twitch_broadcaster_id, twitch_login, display_name, created_at
        FROM user_streamers
        WHERE user_id = $user_id
        ORDER BY COALESCE(display_name, twitch_login, twitch_broadcaster_id) COLLATE NOCASE ASC
    `).all({ $user_id: userId });
}
function addStreamerToUser(userId, streamer) {
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO user_streamers (user_id, twitch_broadcaster_id, twitch_login, display_name, created_at)
        VALUES ($user_id, $broadcaster_id, $login, $display_name, $created_at)
        ON CONFLICT(user_id, twitch_broadcaster_id) DO UPDATE SET
            twitch_login = COALESCE(excluded.twitch_login, user_streamers.twitch_login),
            display_name = COALESCE(excluded.display_name, user_streamers.display_name)
    `).run({
        $user_id: userId,
        $broadcaster_id: streamer.id,
        $login: streamer.login || null,
        $display_name: streamer.displayName || null,
        $created_at: now,
    });
}
function removeStreamerFromUser(userId, broadcasterId) {
    const result = db.prepare(`
        DELETE FROM user_streamers
        WHERE user_id = $user_id AND twitch_broadcaster_id = $broadcaster_id
    `).run({
        $user_id: userId,
        $broadcaster_id: broadcasterId,
    });
    return Number(result.changes) > 0;
}
function removeStreamerByRowIdWithCleanup(userId, rowId) {
    const row = db.prepare(`
        SELECT twitch_broadcaster_id, twitch_login, display_name
        FROM user_streamers
        WHERE id = $id AND user_id = $user_id
        LIMIT 1
    `).get({ $id: rowId, $user_id: userId });
    if (!row)
        return { removed: false, removedClips: 0 };
    db.exec('BEGIN');
    try {
        const deleteStreamer = db.prepare('DELETE FROM user_streamers WHERE id = $id AND user_id = $user_id').run({
            $id: rowId,
            $user_id: userId,
        });
        let removedClips = 0;
        if (Number(deleteStreamer.changes) > 0) {
            const candidates = [
                String(row.display_name || '').trim(),
                String(row.twitch_login || '').trim(),
            ].filter(Boolean);
            if (candidates.length > 0) {
                const cleanup = db.prepare(`
                    DELETE FROM user_clip_state
                    WHERE user_id = $user_id
                      AND clip_id IN (
                        SELECT id
                        FROM clips
                        WHERE lower(broadcaster_name) = lower($name1)
                           OR lower(broadcaster_name) = lower($name2)
                      )
                `).run({
                    $user_id: userId,
                    $name1: candidates[0] || '',
                    $name2: candidates[1] || candidates[0] || '',
                });
                removedClips = Number(cleanup.changes || 0);
            }
        }
        db.exec('COMMIT');
        return { removed: Number(deleteStreamer.changes) > 0, removedClips };
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
function ensureLegacySeedUser() {
    const countRow = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    if (Number(countRow?.n || 0) > 0)
        return;
    const userId = createUser(LEGACY_SITE_USERNAME, LEGACY_SITE_PASSWORD);
    for (const streamerId of LEGACY_STREAMER_IDS) {
        addStreamerToUser(userId, { id: streamerId });
    }
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
        const rows = db.prepare('SELECT * FROM clips').all();
        const migrate = db.prepare(`
            INSERT INTO user_clip_state (
                user_id, clip_id, approved, sorted_out,
                cam_x, cam_y, cam_w, cam_h, cam_enabled, twitch_name_enabled,
                twitch_name_x, twitch_name_y,
                gameplay_x, gameplay_y, gameplay_w, gameplay_h,
                cam_output_y, cam_output_h,
                gameplay_output_y, gameplay_output_h,
                split_points_json, split_deleted_segments_json, split_zoom_segments_json,
                fetched_at
            ) VALUES (
                $user_id, $clip_id, $approved, $sorted_out,
                $cam_x, $cam_y, $cam_w, $cam_h, $cam_enabled, $twitch_name_enabled,
                $twitch_name_x, $twitch_name_y,
                $gameplay_x, $gameplay_y, $gameplay_w, $gameplay_h,
                $cam_output_y, $cam_output_h,
                $gameplay_output_y, $gameplay_output_h,
                $split_points_json, $split_deleted_segments_json, $split_zoom_segments_json,
                $fetched_at
            )
            ON CONFLICT(user_id, clip_id) DO NOTHING
        `);
        for (const row of rows) {
            migrate.run({
                $user_id: userId,
                $clip_id: row.id,
                $approved: row.approved,
                $sorted_out: row.sorted_out,
                $cam_x: row.cam_x,
                $cam_y: row.cam_y,
                $cam_w: row.cam_w,
                $cam_h: row.cam_h,
                $cam_enabled: row.cam_enabled ?? 1,
                $twitch_name_enabled: row.twitch_name_enabled ?? 0,
                $twitch_name_x: row.twitch_name_x,
                $twitch_name_y: row.twitch_name_y,
                $gameplay_x: row.gameplay_x,
                $gameplay_y: row.gameplay_y,
                $gameplay_w: row.gameplay_w,
                $gameplay_h: row.gameplay_h,
                $cam_output_y: row.cam_output_y,
                $cam_output_h: row.cam_output_h,
                $gameplay_output_y: row.gameplay_output_y,
                $gameplay_output_h: row.gameplay_output_h,
                $split_points_json: null,
                $split_deleted_segments_json: null,
                $split_zoom_segments_json: null,
                $fetched_at: row.fetched_at || now,
            });
        }
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
// Migrate approved.json → DB if it still exists
if (fs.existsSync(APPROVED_FILE)) {
    const ids = JSON.parse(fs.readFileSync(APPROVED_FILE, 'utf-8'));
    db.exec('BEGIN');
    const migrateStmt = db.prepare('UPDATE clips SET approved = 1 WHERE id = $id');
    for (const id of ids)
        migrateStmt.run({ $id: id });
    db.exec('COMMIT');
    fs.renameSync(APPROVED_FILE, APPROVED_FILE + '.migrated');
    console.log(`✅  Migrated ${ids.length} approved clips from approved.json → SQLite`);
}
ensureLegacySeedUser();
// ── DB helpers ─────────────────────────────────────────────────────────────
const upsertStmt = db.prepare(`
    INSERT INTO clips (id, url, title, view_count, created_at, thumbnail_url, broadcaster_name, fetched_at)
    VALUES ($id, $url, $title, $view_count, $created_at, $thumbnail_url, $broadcaster_name, $fetched_at)
    ON CONFLICT(id) DO UPDATE SET
        view_count       = excluded.view_count,
        title            = excluded.title,
        thumbnail_url    = excluded.thumbnail_url,
        fetched_at       = excluded.fetched_at
`);
function upsertClips(clips) {
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
        for (const c of clips) {
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
function linkClipsToUser(userId, clips) {
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
        const stmt = db.prepare(`
            INSERT INTO user_clip_state (user_id, clip_id, fetched_at)
            VALUES ($user_id, $clip_id, $fetched_at)
            ON CONFLICT(user_id, clip_id) DO UPDATE SET
                fetched_at = excluded.fetched_at
        `);
        for (const clip of clips) {
            stmt.run({
                $user_id: userId,
                $clip_id: clip.id,
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
function getAllClips(userId) {
    const rows = db.prepare(`
        SELECT
            c.id,
            c.url,
            c.title,
            c.view_count,
            c.created_at,
            c.thumbnail_url,
            c.broadcaster_name,
            s.approved,
            s.sorted_out,
            s.fetched_at,
            s.cam_x,
            s.cam_y,
            s.cam_w,
            s.cam_h,
            s.cam_enabled,
            s.twitch_name_enabled,
            s.twitch_name_x,
            s.twitch_name_y,
            s.gameplay_x,
            s.gameplay_y,
            s.gameplay_w,
            s.gameplay_h,
            s.cam_output_y,
            s.cam_output_h,
            s.gameplay_output_y,
            s.gameplay_output_h,
            s.split_points_json,
            s.split_deleted_segments_json,
            s.split_zoom_segments_json
        FROM user_clip_state s
        JOIN clips c ON c.id = s.clip_id
        WHERE s.user_id = $user_id
        ORDER BY c.broadcaster_name COLLATE NOCASE ASC, c.view_count DESC
    `).all({ $user_id: userId });
    const allowedStreamerNames = listUserStreamerNameKeys(userId);
    const mapped = rows.map(r => ({ ...r, approved: r.approved === 1, sorted_out: r.sorted_out === 1 }));
    if (allowedStreamerNames.size === 0)
        return [];
    return mapped.filter(row => {
        const key = String(row.broadcaster_name || '').trim().toLowerCase();
        return allowedStreamerNames.has(key);
    });
}
function validateEnvironment() {
    if (!clientID || !clientSecret) {
        console.warn('⚠️  Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in .env; refresh endpoint requires both.');
    }
    if (LEGACY_SITE_USERNAME === 'admin' || LEGACY_SITE_PASSWORD === 'admin') {
        console.warn('⚠️  SITE_USERNAME/SITE_PASSWORD still use defaults. Register a new account and remove defaults in .env.');
    }
    if (IS_PRODUCTION && SESSION_SECRET === 'twitch-clips-secret-2026') {
        throw new Error('SESSION_SECRET must be set in production.');
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function toJobSnapshot(job) {
    return {
        jobId: job.jobId,
        status: job.status,
        dryRun: job.dryRun,
        total: job.total,
        processed: job.processed,
        uploaded: job.uploaded,
        failed: job.failed,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        currentClipId: job.currentClipId,
        currentTitle: job.currentTitle,
        results: job.results,
    };
}
function parseUploadLimit(limitRaw) {
    return Math.max(1, Math.min(100, Number(limitRaw) || 25));
}
function getApprovedClips(userId, limit) {
    const rows = db.prepare(`
        SELECT
            c.id,
            c.url,
            c.title,
            c.view_count,
            c.created_at,
            c.thumbnail_url,
            c.broadcaster_name,
            s.approved,
            s.sorted_out,
            s.fetched_at,
            s.cam_x,
            s.cam_y,
            s.cam_w,
            s.cam_h,
            s.cam_enabled,
            s.twitch_name_enabled,
            s.twitch_name_x,
            s.twitch_name_y,
            s.gameplay_x,
            s.gameplay_y,
            s.gameplay_w,
            s.gameplay_h,
            s.cam_output_y,
            s.cam_output_h,
            s.gameplay_output_y,
            s.gameplay_output_h,
            s.split_points_json,
            s.split_deleted_segments_json,
            s.split_zoom_segments_json
        FROM user_clip_state s
        JOIN clips c ON c.id = s.clip_id
        WHERE s.user_id = $user_id AND s.approved = 1 AND s.sorted_out = 0
        ORDER BY c.created_at DESC
        LIMIT $limit
    `).all({ $user_id: userId, $limit: limit });
    const allowedStreamerNames = listUserStreamerNameKeys(userId);
    if (allowedStreamerNames.size === 0)
        return [];
    return rows.filter(row => {
        const key = String(row.broadcaster_name || '').trim().toLowerCase();
        return allowedStreamerNames.has(key);
    });
}
async function runUploadJob(job) {
    try {
        for (const clip of job.clips) {
            if (job.cancelRequested) {
                job.status = 'cancelled';
                job.updatedAt = new Date().toISOString();
                break;
            }
            while (job.pauseRequested && !job.cancelRequested) {
                job.status = 'paused';
                job.updatedAt = new Date().toISOString();
                await sleep(350);
            }
            if (job.cancelRequested) {
                job.status = 'cancelled';
                job.updatedAt = new Date().toISOString();
                break;
            }
            job.status = 'running';
            job.currentClipId = clip.id;
            job.currentTitle = clip.title;
            job.updatedAt = new Date().toISOString();
            const result = await uploadSingleClipToTikTok(clip, job.dryRun);
            job.results.push(result);
            job.processed += 1;
            if (result.status === 'uploaded')
                job.uploaded += 1;
            else
                job.failed += 1;
            job.updatedAt = new Date().toISOString();
        }
        if (!job.cancelRequested && job.status !== 'failed') {
            job.status = 'completed';
        }
    }
    catch (err) {
        job.status = 'failed';
        job.results.push({
            clipId: '',
            title: 'job-error',
            status: 'failed',
            details: err instanceof Error ? err.message : 'Upload job failed unexpectedly',
        });
    }
    finally {
        job.currentClipId = undefined;
        job.currentTitle = undefined;
        job.updatedAt = new Date().toISOString();
        const activeJobId = activeUploadJobByUser.get(job.userId);
        if (activeJobId === job.jobId)
            activeUploadJobByUser.delete(job.userId);
    }
}
function startUploadJob(userId, limit, dryRun) {
    const activeUploadJobId = activeUploadJobByUser.get(userId);
    if (activeUploadJobId) {
        const current = uploadJobs.get(activeUploadJobId);
        if (current && (current.status === 'running' || current.status === 'paused')) {
            throw new Error(`Upload job already active (${current.jobId}).`);
        }
        activeUploadJobByUser.delete(userId);
    }
    const approved = getApprovedClips(userId, limit);
    const now = new Date().toISOString();
    const job = {
        jobId: (0, crypto_1.randomUUID)(),
        userId,
        status: approved.length > 0 ? 'running' : 'completed',
        dryRun,
        total: approved.length,
        processed: 0,
        uploaded: 0,
        failed: 0,
        createdAt: now,
        updatedAt: now,
        currentClipId: undefined,
        currentTitle: undefined,
        results: [],
        clips: approved,
        pauseRequested: false,
        cancelRequested: false,
    };
    uploadJobs.set(job.jobId, job);
    if (approved.length > 0) {
        activeUploadJobByUser.set(userId, job.jobId);
        void runUploadJob(job);
    }
    return job;
}
function isValidCropNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function buildClipVideoCandidates(thumbnailUrl) {
    const raw = String(thumbnailUrl || '').trim();
    if (!raw)
        return [];
    const noQuery = raw.split('?')[0];
    const candidates = new Set();
    const pushIfMp4 = (candidate) => {
        if (!/^https?:\/\//i.test(candidate))
            return;
        if (!/\.mp4(?:$|\?)/i.test(candidate))
            return;
        candidates.add(candidate);
    };
    // Generic Twitch preview thumbnail to MP4 conversion for both known URL shapes:
    // 1) ...-preview-480x272.jpg
    // 2) .../preview-480x272.jpg
    pushIfMp4(noQuery.replace(/-preview-[^./]+\.(jpg|jpeg|png)$/i, '.mp4'));
    pushIfMp4(noQuery.replace(/\/preview-[^./]+\.(jpg|jpeg|png)$/i, '.mp4'));
    // Legacy fallback patterns.
    pushIfMp4(noQuery.replace('-preview-480x272.jpg', '.mp4'));
    pushIfMp4(noQuery.replace('-preview-260x147.jpg', '.mp4'));
    pushIfMp4(noQuery.replace('-preview-320x180.jpg', '.mp4'));
    return [...candidates];
}
function getCropOrDefault(clip) {
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const asNum = (v, fallback) => Number.isFinite(v) ? Number(v) : fallback;
    const cam = {
        x: clamp(asNum(clip.cam_x, 0.62)),
        y: clamp(asNum(clip.cam_y, 0.02)),
        w: Math.max(0.01, clamp(asNum(clip.cam_w, 0.35))),
        h: Math.max(0.01, clamp(asNum(clip.cam_h, 0.32))),
    };
    const gameplay = {
        x: clamp(asNum(clip.gameplay_x, 0)),
        y: clamp(asNum(clip.gameplay_y, 0.2)),
        w: Math.max(0.01, clamp(asNum(clip.gameplay_w, 1))),
        h: Math.max(0.01, clamp(asNum(clip.gameplay_h, 0.8))),
    };
    cam.x = Math.min(cam.x, 1 - cam.w);
    cam.y = Math.min(cam.y, 1 - cam.h);
    gameplay.x = Math.min(gameplay.x, 1 - gameplay.w);
    gameplay.y = Math.min(gameplay.y, 1 - gameplay.h);
    const camEnabled = clip.cam_enabled !== 0;
    const camOutputH = Math.max(0.05, Math.min(0.95, asNum(clip.cam_output_h, 0.30)));
    const camOutputY = Math.max(0, Math.min(1 - camOutputH, asNum(clip.cam_output_y, 0)));
    const camOutput = { y: camOutputY, h: camOutputH };
    const gameplayFallbackY = Math.max(0, Math.min(1, camOutput.y + camOutput.h));
    const gameplayFallbackH = Math.max(0.05, Math.min(0.95, 1 - gameplayFallbackY));
    const gameplayOutputH = Math.max(0.05, Math.min(0.95, asNum(clip.gameplay_output_h, gameplayFallbackH)));
    const gameplayOutputY = Math.max(0, Math.min(1 - gameplayOutputH, asNum(clip.gameplay_output_y, gameplayFallbackY)));
    const gameplayOutput = { y: gameplayOutputY, h: gameplayOutputH };
    const twitchNameText = String(clip.broadcaster_name || '').trim().slice(0, 64);
    const twitchName = {
        enabled: clip.twitch_name_enabled === 1 && twitchNameText.length > 0,
        x: clamp(asNum(clip.twitch_name_x, 0.04)),
        y: clamp(asNum(clip.twitch_name_y, 0.04)),
        text: twitchNameText,
    };
    const split = {
        points: normalizeSplitPoints(parseJsonNumberArray(clip.split_points_json), null),
        deletedSegments: normalizeSplitDeletedSegments(parseJsonIntArray(clip.split_deleted_segments_json), null),
        zoomSegments: normalizeSplitDeletedSegments(parseJsonIntArray(clip.split_zoom_segments_json), null),
    };
    return { cam, gameplay, camEnabled, camOutput, gameplayOutput, twitchName, split };
}
function parseJsonNumberArray(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.map(v => Number(v)).filter(v => Number.isFinite(v));
    }
    catch {
        return [];
    }
}
function parseJsonIntArray(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.map(v => Number(v)).filter(v => Number.isInteger(v));
    }
    catch {
        return [];
    }
}
function normalizeSplitPoints(points, durationLimit) {
    const maxDuration = Number.isFinite(durationLimit) && Number(durationLimit) > 0
        ? Number(durationLimit)
        : Number.POSITIVE_INFINITY;
    const dedup = new Set();
    for (const raw of points) {
        const n = Number(raw);
        if (!Number.isFinite(n))
            continue;
        if (n <= 0.05)
            continue;
        if (n >= maxDuration - 0.05)
            continue;
        dedup.add(Math.round(n * 1000) / 1000);
    }
    return [...dedup].sort((a, b) => a - b).slice(0, 80);
}
function normalizeSplitDeletedSegments(indices, maxSegments) {
    const out = new Set();
    const maxIndex = Number.isFinite(maxSegments) && Number(maxSegments) > 0
        ? Math.max(0, Number(maxSegments) - 1)
        : Number.POSITIVE_INFINITY;
    for (const raw of indices) {
        const idx = Number(raw);
        if (!Number.isInteger(idx) || idx < 0 || idx > maxIndex)
            continue;
        out.add(idx);
    }
    return [...out].sort((a, b) => a - b);
}
async function probeMediaDurationSeconds(inputPath) {
    try {
        const { stdout } = await runCommandCaptureOutput('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputPath,
        ]);
        const d = Number(String(stdout || '').trim());
        return Number.isFinite(d) && d > 0 ? d : null;
    }
    catch {
        return null;
    }
}
async function hasAudioStream(inputPath) {
    try {
        const { stdout } = await runCommandCaptureOutput('ffprobe', [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_type',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputPath,
        ]);
        return String(stdout || '').trim().length > 0;
    }
    catch {
        return false;
    }
}
function buildKeptSplitRanges(points, deletedSegments) {
    const normalizedPoints = normalizeSplitPoints(points, null);
    const segmentCount = normalizedPoints.length + 1;
    const deleted = new Set(normalizeSplitDeletedSegments(deletedSegments, segmentCount));
    const kept = [];
    for (let i = 0; i < segmentCount; i += 1) {
        if (deleted.has(i))
            continue;
        const start = i === 0 ? 0 : normalizedPoints[i - 1];
        const end = i < normalizedPoints.length ? normalizedPoints[i] : null;
        if (end !== null && (end - start) < 0.08)
            continue;
        kept.push({ start, end });
    }
    return kept;
}
function buildOutputTimelineZoomRanges(points, deletedSegments, zoomSegments) {
    const normalizedPoints = normalizeSplitPoints(points, null);
    const segmentCount = normalizedPoints.length + 1;
    const deleted = new Set(normalizeSplitDeletedSegments(deletedSegments, segmentCount));
    const zoomed = new Set(normalizeSplitDeletedSegments(zoomSegments, segmentCount));
    const ranges = [];
    let cursor = 0;
    for (let i = 0; i < segmentCount; i += 1) {
        const start = i === 0 ? 0 : normalizedPoints[i - 1];
        const end = i < normalizedPoints.length ? normalizedPoints[i] : null;
        const segDuration = end === null ? null : Math.max(0, end - start);
        if (!deleted.has(i) && zoomed.has(i)) {
            if (end === null) {
                ranges.push({ start: cursor, end: null });
            }
            else {
                const duration = Math.max(0, end - start);
                if (duration >= 0.04) {
                    ranges.push({ start: cursor, end: cursor + duration });
                }
            }
        }
        if (!deleted.has(i) && segDuration !== null) {
            cursor += segDuration;
        }
    }
    return ranges;
}
function buildFfmpegEnableExprFromRanges(ranges) {
    const ts = (v) => Math.max(0, v).toFixed(3);
    const parts = ranges.map((range) => {
        if (range.end === null) {
            return `gte(t\\,${ts(range.start)})`;
        }
        const end = Math.max(range.start + 0.001, range.end);
        return `between(t\\,${ts(range.start)}\\,${ts(end)})`;
    });
    return parts.join('+');
}
function resolveTwitchLogoPath() {
    const candidates = [
        path.join(__dirname, 'public', TWITCH_LOGO_RELATIVE_PATH),
        path.join(process.cwd(), 'public', TWITCH_LOGO_RELATIVE_PATH),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
function getPngAspectRatio(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const header = Buffer.alloc(24);
            const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
            if (bytesRead < 24)
                return null;
            const isPng = header.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            if (!isPng)
                return null;
            const width = header.readUInt32BE(16);
            const height = header.readUInt32BE(20);
            if (width <= 0 || height <= 0)
                return null;
            return width / height;
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return null;
    }
}
function getLogoAspectRatio(filePath) {
    const pngRatio = getPngAspectRatio(filePath);
    if (pngRatio && Number.isFinite(pngRatio) && pngRatio > 0)
        return pngRatio;
    return 1;
}
function escapeFfmpegDrawtext(value) {
    return String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'")
        .replace(/%/g, '\\%')
        .replace(/,/g, '\\,')
        .replace(/\[/g, '\\[')
        .replace(/]/g, '\\]')
        .replace(/\r?\n/g, ' ');
}
function resolveDrawtextFontPath() {
    const candidates = [
        // Windows defaults
        'C:\\Windows\\Fonts\\segoeui.ttf',
        'C:\\Windows\\Fonts\\arial.ttf',
        // Common Linux fallback
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
function toFfmpegFilterPath(filePath) {
    return String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'");
}
async function isVideoUrlReachable(url) {
    try {
        const probe = await axios_1.default.get(url, {
            responseType: 'stream',
            timeout: 12000,
            headers: {
                Range: 'bytes=0-2047',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Referer: 'https://clips.twitch.tv/',
            },
            validateStatus: (status) => status === 200 || status === 206,
        });
        const contentType = String(probe.headers['content-type'] || '').toLowerCase();
        probe.data.destroy();
        if (contentType.startsWith('video/'))
            return true;
        // Some Twitch CDN responses use generic binary content types for valid MP4 streams.
        const genericBinary = contentType.includes('application/octet-stream') || contentType.includes('binary/octet-stream');
        const isMp4LikeUrl = /\.mp4(?:$|\?)/i.test(url);
        if (genericBinary && isMp4LikeUrl)
            return true;
        return false;
    }
    catch {
        return false;
    }
}
async function extractMp4CandidatesFromClipPage(clipPageUrl) {
    try {
        const page = await axios_1.default.get(clipPageUrl, {
            timeout: 15000,
            responseType: 'text',
            validateStatus: (status) => status >= 200 && status < 400,
        });
        const html = String(page.data || '')
            .replace(/\\u002F/g, '/')
            .replace(/\\\//g, '/');
        const matches = html.match(/https:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi) || [];
        return [...new Set(matches.map(m => m.replace(/&amp;/g, '&')))];
    }
    catch {
        return [];
    }
}
function extractClipSlugFromUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        const parts = parsed.pathname.split('/').filter(Boolean);
        let slug = '';
        if (parsed.hostname.toLowerCase().includes('clips.twitch.tv')) {
            slug = parts[0] || '';
        }
        else {
            const clipIndex = parts.findIndex((part) => part.toLowerCase() === 'clip');
            if (clipIndex >= 0)
                slug = parts[clipIndex + 1] || '';
        }
        slug = slug.split('?')[0].split('#')[0];
        if (!/^[A-Za-z0-9_-]+$/.test(slug))
            return null;
        return slug;
    }
    catch {
        return null;
    }
}
function getCachedClipVideoUrl(slug) {
    const hit = clipVideoUrlCache.get(slug);
    if (!hit)
        return null;
    if (Date.now() >= hit.expiresAt) {
        clipVideoUrlCache.delete(slug);
        return null;
    }
    return hit.url;
}
function setCachedClipVideoUrl(slug, url) {
    clipVideoUrlCache.set(slug, {
        url,
        expiresAt: Date.now() + CLIP_GQL_CACHE_TTL_MS,
    });
}
function buildTwitchClipGqlPayload(slug) {
    return [
        {
            operationName: 'VideoPlayerStreamInfoOverlayClip',
            variables: { slug },
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: 'fcefd8b2081e39d16cbdc94bc82142df01b143bb296f0043262c44c37dbd1f63',
                },
            },
        },
        {
            operationName: 'VideoAccessToken_Clip',
            variables: { platform: 'web', slug },
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: '6fd3af2b22989506269b9ac02dd87eb4a6688392d67d94e41a6886f1e9f5c00f',
                },
            },
        },
    ];
}
async function resolveClipVideoViaGql(clipUrl) {
    const slug = extractClipSlugFromUrl(clipUrl);
    if (!slug)
        return null;
    const cached = getCachedClipVideoUrl(slug);
    if (cached)
        return cached;
    if (!clientID || !clientSecret)
        return null;
    try {
        const accessToken = await getTwitchAccessToken();
        const response = await axios_1.default.post(TWITCH_GQL_URL, buildTwitchClipGqlPayload(slug), {
            headers: {
                'Client-Id': clientID,
                Authorization: `Bearer ${accessToken}`,
            },
            timeout: 15000,
            validateStatus: (status) => status >= 200 && status < 300,
        });
        const gqlRows = Array.isArray(response.data) ? response.data : [];
        const clipRows = gqlRows
            .map((entry) => entry?.data?.clip)
            .filter(Boolean);
        const baseUrl = clipRows.find((row) => String(row?.videoQualities?.[0]?.sourceURL || '').length > 0)?.videoQualities?.[0]?.sourceURL;
        const tokenRow = clipRows.find((row) => row?.playbackAccessToken?.signature && row?.playbackAccessToken?.value);
        const signature = tokenRow?.playbackAccessToken?.signature;
        const token = tokenRow?.playbackAccessToken?.value;
        if (!baseUrl || !signature || !token)
            return null;
        const resolved = `${baseUrl}?${new URLSearchParams({ sig: signature, token }).toString()}`;
        setCachedClipVideoUrl(slug, resolved);
        return resolved;
    }
    catch {
        return null;
    }
}
async function resolveClipVideoUrl(clip, forceFresh = false) {
    const thumbCandidates = buildClipVideoCandidates(clip.thumbnail_url);
    for (const candidate of thumbCandidates) {
        if (await isVideoUrlReachable(candidate))
            return candidate;
    }
    const pageCandidates = await extractMp4CandidatesFromClipPage(clip.url);
    for (const candidate of pageCandidates) {
        if (await isVideoUrlReachable(candidate))
            return candidate;
    }
    if (forceFresh) {
        const slug = extractClipSlugFromUrl(clip.url);
        if (slug)
            clipVideoUrlCache.delete(slug);
    }
    const gqlCandidate = await resolveClipVideoViaGql(clip.url);
    if (gqlCandidate && await isVideoUrlReachable(gqlCandidate))
        return gqlCandidate;
    return null;
}
function previewFallbackPath(clipId) {
    return path.join(VIDEO_WORK_DIR, `${clipId}.preview.mp4`);
}
async function ensurePreviewFallbackFile(clip) {
    await fs.promises.mkdir(VIDEO_WORK_DIR, { recursive: true });
    const outPath = previewFallbackPath(clip.id);
    if (await fileExistsAndNonEmpty(outPath))
        return outPath;
    const inFlight = previewBuildJobs.get(clip.id);
    if (inFlight)
        return inFlight;
    const build = (async () => {
        await runCommand(YTDLP_BIN, [
            '--no-progress',
            '--no-warnings',
            '-f',
            'best[ext=mp4]/best',
            '-o',
            outPath,
            clip.url,
        ]);
        if (!(await fileExistsAndNonEmpty(outPath))) {
            throw new Error('yt-dlp fallback did not produce a playable preview file.');
        }
        return outPath;
    })();
    previewBuildJobs.set(clip.id, build);
    try {
        return await build;
    }
    finally {
        previewBuildJobs.delete(clip.id);
    }
}
async function streamLocalVideoWithRange(req, res, filePath) {
    const stat = await fs.promises.stat(filePath);
    const total = stat.size;
    const rangeHeader = String(req.headers.range || '').trim();
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=300');
    let start = 0;
    let end = total - 1;
    let partial = false;
    if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
        if (!match) {
            res.status(416);
            res.setHeader('Content-Range', `bytes */${total}`);
            res.end();
            return;
        }
        const startRaw = match[1];
        const endRaw = match[2];
        if (startRaw === '' && endRaw === '') {
            res.status(416);
            res.setHeader('Content-Range', `bytes */${total}`);
            res.end();
            return;
        }
        if (startRaw !== '')
            start = Number(startRaw);
        if (endRaw !== '')
            end = Number(endRaw);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
            res.status(416);
            res.setHeader('Content-Range', `bytes */${total}`);
            res.end();
            return;
        }
        if (startRaw === '') {
            const suffixLength = Number(endRaw);
            if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
                res.status(416);
                res.setHeader('Content-Range', `bytes */${total}`);
                res.end();
                return;
            }
            start = Math.max(0, total - suffixLength);
            end = total - 1;
        }
        else if (endRaw === '') {
            end = total - 1;
        }
        if (start >= total || end < start) {
            res.status(416);
            res.setHeader('Content-Range', `bytes */${total}`);
            res.end();
            return;
        }
        end = Math.min(end, total - 1);
        partial = true;
    }
    const chunkSize = (end - start) + 1;
    if (partial) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    }
    else {
        res.status(200);
    }
    res.setHeader('Content-Length', chunkSize);
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', reject);
        res.on('close', resolve);
        res.on('finish', resolve);
        stream.pipe(res);
    });
}
async function downloadFile(url, destinationPath) {
    const response = await axios_1.default.get(url, {
        responseType: 'stream',
        timeout: 60000,
        validateStatus: (status) => status >= 200 && status < 400,
    });
    await (0, promises_1.pipeline)(response.data, fs.createWriteStream(destinationPath));
}
async function fileExistsAndNonEmpty(filePath) {
    try {
        const stat = await fs.promises.stat(filePath);
        return stat.isFile() && stat.size > 0;
    }
    catch {
        return false;
    }
}
function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} exited with code ${code}. ${stderr}`));
        });
    });
}
function runCommandCaptureOutput(command, args) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            reject(new Error(`${command} exited with code ${code}. ${stderr}`));
        });
    });
}
async function processClipToTikTokFormat(inputPath, outputPath, clip, videoPreset = 'medium') {
    const { cam, gameplay, camEnabled, camOutput, gameplayOutput, twitchName, split } = getCropOrDefault(clip);
    const n = (v) => v.toFixed(6);
    const ts = (v) => Math.max(0, v).toFixed(3);
    const outputW = 1080;
    const outputH = 1920;
    const camOutputHeightPx = Math.max(2, Math.round(1920 * camOutput.h));
    const camOutputYPx = Math.max(0, Math.round(1920 * camOutput.y));
    const gameplayOutputHeightPx = Math.max(2, Math.round(1920 * gameplayOutput.h));
    const gameplayOutputYPx = Math.max(0, Math.round(1920 * gameplayOutput.y));
    const logoPath = twitchName.enabled ? resolveTwitchLogoPath() : null;
    const showNameBadge = twitchName.enabled;
    const drawtextFontPath = resolveDrawtextFontPath();
    const drawtextFontOpt = drawtextFontPath ? `:fontfile='${toFfmpegFilterPath(drawtextFontPath)}'` : '';
    const nameFontPx = Math.max(18, Math.round(outputH * 0.036));
    const namePadX = Math.round(nameFontPx * 0.62);
    const nameIconHPx = Math.max(2, Math.round(nameFontPx * 1.04));
    const logoAspect = logoPath ? getLogoAspectRatio(logoPath) : 1;
    const clampedLogoAspect = Math.max(0.4, Math.min(3, logoAspect));
    const iconWRaw = Math.max(2, Math.round(nameIconHPx * clampedLogoAspect));
    const nameIconWPx = iconWRaw % 2 === 0 ? iconWRaw : iconWRaw + 1;
    const nameGapPx = Math.round(nameFontPx * 0.30);
    const nameBadgeH = Math.round(nameFontPx * 1.62);
    const estimatedTextW = Math.max(nameFontPx, Math.round(nameFontPx * 0.62 * twitchName.text.length));
    const badgeContentW = (logoPath ? (nameIconWPx + nameGapPx) : 0) + estimatedTextW;
    const nameBadgeW = Math.min(outputW - 24, namePadX + badgeContentW + namePadX);
    const nameBadgeX = Math.max(0, Math.min(outputW - nameBadgeW, Math.round(outputW * twitchName.x)));
    const nameBadgeY = Math.max(0, Math.min(outputH - nameBadgeH, Math.round(outputH * twitchName.y)));
    const nameOutlineW = nameBadgeW + 2;
    const nameOutlineH = nameBadgeH + 2;
    const nameOutlineX = Math.max(0, nameBadgeX - 1);
    const nameOutlineY = Math.max(0, nameBadgeY - 1);
    const logoX = nameBadgeX + namePadX;
    const logoY = nameBadgeY + Math.round((nameBadgeH - nameIconHPx) / 2);
    const textX = nameBadgeX + namePadX + (logoPath ? (nameIconWPx + nameGapPx) : 0);
    const textY = nameBadgeY + Math.round((nameBadgeH - nameFontPx) / 2);
    const safeTwitchName = escapeFfmpegDrawtext(twitchName.text);
    const canDrawNameText = Boolean(drawtextFontPath && safeTwitchName);
    const roundedMask = (alpha) => `if(lte(abs(X-W/2),W/2-H/2),${alpha},if(lte((X-H/2)*(X-H/2)+(Y-H/2)*(Y-H/2),(H/2)*(H/2)),${alpha},if(lte((X-(W-H/2))*(X-(W-H/2))+(Y-H/2)*(Y-H/2),(H/2)*(H/2)),${alpha},0)))`;
    const badgeSourceDurationSec = 86400;
    const splitPoints = normalizeSplitPoints(split.points, null);
    const splitSegmentCount = splitPoints.length + 1;
    const splitDeletedSegments = normalizeSplitDeletedSegments(split.deletedSegments, splitSegmentCount);
    const splitZoomSegments = normalizeSplitDeletedSegments(split.zoomSegments, splitSegmentCount);
    const splitConfigured = splitPoints.length > 0 || splitDeletedSegments.length > 0 || splitZoomSegments.length > 0;
    const splitRanges = splitConfigured ? buildKeptSplitRanges(splitPoints, splitDeletedSegments) : [];
    const zoomRanges = buildOutputTimelineZoomRanges(splitPoints, splitDeletedSegments, splitZoomSegments);
    const zoomExpr = buildFfmpegEnableExprFromRanges(zoomRanges);
    const notZoomExpr = zoomExpr ? `not(${zoomExpr})` : '1';
    if (splitConfigured && splitRanges.length === 0) {
        throw new Error('All split parts are deleted. Keep at least one segment before exporting.');
    }
    const splitEnabled = splitConfigured && splitRanges.length > 0;
    const hasAudio = await hasAudioStream(inputPath);
    const filterSteps = [];
    const sourceVideoLabel = splitEnabled ? 'vsrc' : '0:v';
    const sourceAudioLabel = splitEnabled ? (hasAudio ? 'asrc' : null) : null;
    if (splitEnabled) {
        if (hasAudio) {
            const avLabels = [];
            splitRanges.forEach((range, idx) => {
                const vLabel = `vseg${idx}`;
                const aLabel = `aseg${idx}`;
                avLabels.push(`[${vLabel}][${aLabel}]`);
                const trimEndOpt = range.end === null ? '' : `:end=${ts(range.end)}`;
                filterSteps.push(`[0:v]trim=start=${ts(range.start)}${trimEndOpt},setpts=PTS-STARTPTS[${vLabel}]`);
                filterSteps.push(`[0:a]atrim=start=${ts(range.start)}${trimEndOpt},asetpts=PTS-STARTPTS[${aLabel}]`);
            });
            if (splitRanges.length === 1) {
                filterSteps.push('[vseg0]setpts=PTS-STARTPTS[vsrc]');
                filterSteps.push('[aseg0]asetpts=PTS-STARTPTS[asrc]');
            }
            else {
                filterSteps.push(`${avLabels.join('')}concat=n=${splitRanges.length}:v=1:a=1[vsrc][asrc]`);
            }
        }
        else {
            const videoLabels = [];
            splitRanges.forEach((range, idx) => {
                const vLabel = `vseg${idx}`;
                videoLabels.push(`[${vLabel}]`);
                const trimEndOpt = range.end === null ? '' : `:end=${ts(range.end)}`;
                filterSteps.push(`[0:v]trim=start=${ts(range.start)}${trimEndOpt},setpts=PTS-STARTPTS[${vLabel}]`);
            });
            if (videoLabels.length === 1) {
                filterSteps.push('[vseg0]setpts=PTS-STARTPTS[vsrc]');
            }
            else {
                filterSteps.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[vsrc]`);
            }
        }
    }
    const hasZoomEffect = zoomExpr.length > 0;
    const shouldRenderCamLayer = camEnabled || hasZoomEffect;
    if (shouldRenderCamLayer) {
        // Duplicate the source branch once before two crops; a single filter output label cannot be consumed safely twice.
        const gameplaySourceLabel = 'src_game';
        const camSourceLabel = 'src_cam';
        const camZoomSourceLabel = 'src_cam_zoom';
        if (hasZoomEffect) {
            filterSteps.push(`[${sourceVideoLabel}]split=3[${gameplaySourceLabel}][${camSourceLabel}][${camZoomSourceLabel}]`);
        }
        else {
            filterSteps.push(`[${sourceVideoLabel}]split=2[${gameplaySourceLabel}][${camSourceLabel}]`);
        }
        filterSteps.push(`[${gameplaySourceLabel}]crop=iw*${n(gameplay.w)}:ih*${n(gameplay.h)}:iw*${n(gameplay.x)}:ih*${n(gameplay.y)},scale=${outputW}:${gameplayOutputHeightPx}:flags=lanczos:force_original_aspect_ratio=disable,setsar=1[game]`);
        filterSteps.push(`color=c=black:s=${outputW}x${outputH}:d=${badgeSourceDurationSec}[layout_base]`);
        filterSteps.push(`[layout_base][game]overlay=0:${gameplayOutputYPx}:format=auto:shortest=1[bg]`);
        filterSteps.push(`[${camSourceLabel}]crop=iw*${n(cam.w)}:ih*${n(cam.h)}:iw*${n(cam.x)}:ih*${n(cam.y)},scale=${outputW}:${camOutputHeightPx}:flags=lanczos:force_original_aspect_ratio=disable,setsar=1[cam]`);
        const normalCamEnable = camEnabled ? notZoomExpr : '0';
        filterSteps.push(`[bg][cam]overlay=0:${camOutputYPx}:format=auto:enable='${normalCamEnable}'[base_norm]`);
        if (hasZoomEffect) {
            filterSteps.push(`[${camZoomSourceLabel}]crop=iw*${n(cam.w)}:ih*${n(cam.h)}:iw*${n(cam.x)}:ih*${n(cam.y)},scale=${outputW}:${outputH}:flags=lanczos:force_original_aspect_ratio=disable,setsar=1[cam_zoom]`);
            filterSteps.push(`[base_norm][cam_zoom]overlay=0:0:format=auto:enable='${zoomExpr}',setsar=1[base]`);
        }
        else {
            filterSteps.push('[base_norm]setsar=1[base]');
        }
    }
    else {
        filterSteps.push(`[${sourceVideoLabel}]crop=iw*${n(gameplay.w)}:ih*${n(gameplay.h)}:iw*${n(gameplay.x)}:ih*${n(gameplay.y)},scale=${outputW}:${gameplayOutputHeightPx}:flags=lanczos:force_original_aspect_ratio=disable,setsar=1[game]`);
        filterSteps.push(`color=c=black:s=${outputW}x${outputH}:d=${badgeSourceDurationSec}[layout_base]`);
        filterSteps.push(`[layout_base][game]overlay=0:${gameplayOutputYPx}:format=auto:shortest=1[base]`);
    }
    if (showNameBadge) {
        const badgeEnableOpt = hasZoomEffect ? `:enable='${notZoomExpr}'` : '';
        filterSteps.push(`color=c=0x9147ff:s=${nameOutlineW}x${nameOutlineH}:d=${badgeSourceDurationSec},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${roundedMask(122)}'[pill_outline]`);
        filterSteps.push(`color=c=0x0f1014:s=${nameBadgeW}x${nameBadgeH}:d=${badgeSourceDurationSec},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${roundedMask(186)}'[pill_fill]`);
        // Keep synthetic badge sources from extending output duration.
        filterSteps.push(`[base][pill_outline]overlay=${nameOutlineX}:${nameOutlineY}:format=auto:shortest=1${badgeEnableOpt}[badge_outline]`);
        filterSteps.push(`[badge_outline][pill_fill]overlay=${nameBadgeX}:${nameBadgeY}:format=auto:shortest=1${badgeEnableOpt}[badge_bg]`);
        let badgeOutLabel = 'badge_bg';
        if (logoPath) {
            filterSteps.push(`[1:v]scale=${nameIconWPx}:${nameIconHPx}:flags=lanczos:force_original_aspect_ratio=decrease[tw_logo]`);
            // Do not shorten output to a single logo frame; keep base video timeline authoritative.
            filterSteps.push(`[badge_bg][tw_logo]overlay=${logoX}:${logoY}:format=auto:eof_action=repeat${badgeEnableOpt}[badge_logo]`);
            badgeOutLabel = 'badge_logo';
        }
        if (canDrawNameText) {
            const drawTextEnableOpt = hasZoomEffect ? `:enable='${notZoomExpr}'` : '';
            filterSteps.push(`[${badgeOutLabel}]drawtext=text='${safeTwitchName}':x=${textX}:y=${textY}:fontsize=${nameFontPx}${drawtextFontOpt}:fontcolor=white:borderw=1:bordercolor=black@0.55:shadowcolor=black@0.45:shadowx=1:shadowy=1${drawTextEnableOpt}[name_out]`);
            filterSteps.push('[name_out]format=yuv420p[v]');
        }
        else {
            filterSteps.push(`[${badgeOutLabel}]format=yuv420p[v]`);
        }
    }
    else {
        filterSteps.push('[base]format=yuv420p[v]');
    }
    const filter = filterSteps.join(';');
    const args = ['-y', '-i', inputPath];
    if (showNameBadge && logoPath) {
        args.push('-i', logoPath);
    }
    args.push('-filter_complex', filter, '-map', '[v]');
    if (sourceAudioLabel) {
        args.push('-map', `[${sourceAudioLabel}]`);
    }
    else if (!splitEnabled) {
        args.push('-map', '0:a?');
    }
    args.push('-c:v', 'libx264', '-preset', videoPreset, '-crf', '21', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath);
    await runCommand('ffmpeg', args);
}
async function uploadProcessedVideoToTikTok(processedPath, title) {
    if (!TIKTOK_ACCESS_TOKEN) {
        throw new Error('Missing TIKTOK_ACCESS_TOKEN in environment');
    }
    const stat = await fs.promises.stat(processedPath);
    const fileSize = stat.size;
    const initResponse = await axios_1.default.post(`${TIKTOK_API_BASE}/v2/post/publish/video/init/`, {
        post_info: {
            title: title.slice(0, 150),
            privacy_level: TIKTOK_PRIVACY_LEVEL,
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
        },
        source_info: {
            source: 'FILE_UPLOAD',
            video_size: fileSize,
            chunk_size: fileSize,
            total_chunk_count: 1,
        },
    }, {
        headers: {
            Authorization: `Bearer ${TIKTOK_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        },
        validateStatus: () => true,
    });
    if (initResponse.status < 200 || initResponse.status >= 300) {
        throw new Error(`TikTok init failed (${initResponse.status}): ${JSON.stringify(initResponse.data)}`);
    }
    const uploadUrl = initResponse.data?.data?.upload_url;
    const publishId = initResponse.data?.data?.publish_id;
    if (!uploadUrl) {
        throw new Error(`TikTok init did not return upload_url: ${JSON.stringify(initResponse.data)}`);
    }
    await axios_1.default.put(uploadUrl, fs.createReadStream(processedPath), {
        headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': fileSize,
            'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: (status) => status >= 200 && status < 300,
    });
    return {
        publishId,
        message: publishId ? `Uploaded to TikTok (publish_id=${publishId})` : 'Uploaded to TikTok',
    };
}
async function uploadSingleClipToTikTok(clip, dryRun = false) {
    await fs.promises.mkdir(VIDEO_WORK_DIR, { recursive: true });
    const inPath = path.join(VIDEO_WORK_DIR, `${clip.id}.source.mp4`);
    const outPath = path.join(VIDEO_WORK_DIR, `${clip.id}.tiktok.mp4`);
    try {
        const sourceUrl = await resolveClipVideoUrl(clip);
        if (sourceUrl) {
            await downloadFile(sourceUrl, inPath);
        }
        else {
            // Fallback for clips where static thumbnail transformations do not expose a direct MP4 URL.
            await runCommand(YTDLP_BIN, [
                '--no-progress',
                '--no-warnings',
                '-f',
                'best[ext=mp4]/best',
                '-o',
                inPath,
                clip.url,
            ]);
            if (!(await fileExistsAndNonEmpty(inPath))) {
                return {
                    clipId: clip.id,
                    title: clip.title,
                    status: 'failed',
                    details: 'Could not resolve/download clip video (direct URL failed and yt-dlp output missing).',
                };
            }
        }
        // Keep upload quality defaults for TikTok pipeline.
        await processClipToTikTokFormat(inPath, outPath, clip);
        if (dryRun) {
            return {
                clipId: clip.id,
                title: clip.title,
                status: 'uploaded',
                details: 'Dry run: source resolved, video processed, TikTok upload skipped.',
            };
        }
        const uploaded = await uploadProcessedVideoToTikTok(outPath, clip.title);
        return {
            clipId: clip.id,
            title: clip.title,
            status: 'uploaded',
            details: uploaded.message,
            publishId: uploaded.publishId,
        };
    }
    catch (err) {
        return {
            clipId: clip.id,
            title: clip.title,
            status: 'failed',
            details: err instanceof Error ? err.message : 'Unknown upload error',
        };
    }
    finally {
        await fs.promises.rm(inPath, { force: true }).catch(() => { });
        await fs.promises.rm(outPath, { force: true }).catch(() => { });
    }
}
async function buildProcessedClipForDownload(clip) {
    await fs.promises.mkdir(VIDEO_WORK_DIR, { recursive: true });
    const token = (0, crypto_1.randomUUID)();
    const inPath = path.join(VIDEO_WORK_DIR, `${clip.id}.${token}.source.mp4`);
    const outPath = path.join(VIDEO_WORK_DIR, `${clip.id}.${token}.tiktok.mp4`);
    try {
        const sourceUrl = await resolveClipVideoUrl(clip);
        if (sourceUrl) {
            await downloadFile(sourceUrl, inPath);
        }
        else {
            await runCommand(YTDLP_BIN, [
                '--no-progress',
                '--no-warnings',
                '-f',
                'best[ext=mp4]/best',
                '-o',
                inPath,
                clip.url,
            ]);
            if (!(await fileExistsAndNonEmpty(inPath))) {
                throw new Error('Could not resolve/download clip video for export.');
            }
        }
        // Download path prioritizes faster turnaround over encode efficiency.
        await processClipToTikTokFormat(inPath, outPath, clip, 'veryfast');
        return outPath;
    }
    finally {
        await fs.promises.rm(inPath, { force: true }).catch(() => { });
    }
}
function toSafeMp4Name(rawTitle, clipId) {
    const base = (rawTitle || clipId)
        .replace(/[^a-zA-Z0-9._ -]+/g, '')
        .trim()
        .slice(0, 80);
    const normalized = base || clipId;
    return `${normalized}.mp4`;
}
function parseCamEnabled(value) {
    if (value === undefined || value === null || value === '')
        return 1;
    if (value === true || value === 1 || value === '1' || value === 'true')
        return 1;
    if (value === false || value === 0 || value === '0' || value === 'false')
        return 0;
    return null;
}
function parseTwitchNameEnabled(value) {
    if (value === undefined || value === null || value === '')
        return 0;
    if (value === true || value === 1 || value === '1' || value === 'true')
        return 1;
    if (value === false || value === 0 || value === '0' || value === 'false')
        return 0;
    return null;
}
function parseSplitPointsPayload(value) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        return null;
    const nums = value.map(v => Number(v));
    if (nums.some(v => !Number.isFinite(v) || v < 0 || v > 600))
        return null;
    return normalizeSplitPoints(nums, null);
}
function parseSplitDeletedSegmentsPayload(value, maxSegments) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        return null;
    const ints = value.map(v => Number(v));
    if (ints.some(v => !Number.isInteger(v) || v < 0))
        return null;
    return normalizeSplitDeletedSegments(ints, maxSegments);
}
function parseSplitZoomSegmentsPayload(value, maxSegments) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        return null;
    const ints = value.map(v => Number(v));
    if (ints.some(v => !Number.isInteger(v) || v < 0))
        return null;
    return normalizeSplitDeletedSegments(ints, maxSegments);
}
// ── Twitch helpers ─────────────────────────────────────────────────────────
async function getTwitchAccessToken() {
    const response = await axios_1.default.post('https://id.twitch.tv/oauth2/token', null, {
        params: {
            client_id: clientID,
            client_secret: clientSecret,
            grant_type: 'client_credentials',
        },
    });
    return response.data.access_token;
}
async function resolveBroadcasterByLogin(accessToken, login) {
    const normalized = login.trim().toLowerCase();
    if (!normalized)
        return null;
    const response = await axios_1.default.get('https://api.twitch.tv/helix/users', {
        params: { login: normalized },
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': clientID,
        },
        validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300)
        return null;
    const user = response.data?.data?.[0];
    if (!user?.id)
        return null;
    return { id: String(user.id), login: user.login, displayName: user.display_name };
}
async function resolveBroadcasterById(accessToken, broadcasterId) {
    const normalized = String(broadcasterId || '').trim();
    if (!/^\d+$/.test(normalized))
        return null;
    const response = await axios_1.default.get('https://api.twitch.tv/helix/users', {
        params: { id: normalized },
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': clientID,
        },
        validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300)
        return null;
    const user = response.data?.data?.[0];
    if (!user?.id)
        return null;
    return { id: String(user.id), login: user.login, displayName: user.display_name };
}
async function resolveStreamerInput(accessToken, input) {
    const raw = String(input || '').trim();
    if (!raw)
        return null;
    if (/^\d+$/.test(raw)) {
        const resolvedById = await resolveBroadcasterById(accessToken, raw);
        return resolvedById || { id: raw };
    }
    return resolveBroadcasterByLogin(accessToken, raw.replace(/^@/, ''));
}
async function hydrateMissingStreamerMetadata(userId) {
    const pending = db.prepare(`
        SELECT twitch_broadcaster_id
        FROM user_streamers
        WHERE user_id = $user_id
          AND (
            twitch_login IS NULL OR twitch_login = '' OR
            display_name IS NULL OR display_name = ''
          )
        LIMIT 100
    `).all({ $user_id: userId });
    if (pending.length === 0)
        return;
    if (!clientID || !clientSecret)
        return;
    try {
        const accessToken = await getTwitchAccessToken();
        for (const row of pending) {
            const resolved = await resolveBroadcasterById(accessToken, row.twitch_broadcaster_id);
            if (resolved) {
                addStreamerToUser(userId, resolved);
            }
        }
    }
    catch (err) {
        console.warn('Could not hydrate streamer names:', err instanceof Error ? err.message : err);
    }
}
async function fetchClipsFromTwitch(accessToken, broadcasterID, startedAt, endedAt) {
    const seen = new Map();
    let cursor;
    let pageCount = 0;
    while (pageCount < TWITCH_CLIPS_MAX_PAGES) {
        const response = await axios_1.default.get('https://api.twitch.tv/helix/clips', {
            params: {
                broadcaster_id: broadcasterID,
                first: TWITCH_CLIPS_PAGE_SIZE,
                started_at: startedAt,
                ended_at: endedAt,
                ...(cursor ? { after: cursor } : {}),
            },
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Client-Id': clientID,
            },
        });
        const pageClips = response.data.data || [];
        for (const clip of pageClips) {
            seen.set(clip.id, clip);
        }
        pageCount += 1;
        cursor = response.data.pagination?.cursor;
        if (!cursor || pageClips.length === 0)
            break;
    }
    return [...seen.values()];
}
async function fetchClipsForAllStreamers(accessToken, streamerIDs) {
    const endedAt = new Date();
    const startedAt = new Date(endedAt);
    startedAt.setUTCDate(startedAt.getUTCDate() - TWITCH_CLIPS_LOOKBACK_DAYS);
    const settled = await Promise.allSettled(streamerIDs.map(id => fetchClipsFromTwitch(accessToken, id, startedAt.toISOString(), endedAt.toISOString())));
    const clips = [];
    settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            clips.push(...result.value);
            console.log(`📥  Fetched ${result.value.length} clips for streamer ID ${streamerIDs[index]}`);
            return;
        }
        console.error(`Failed to fetch clips for streamer ID ${streamerIDs[index]}:`, result.reason);
    });
    return clips;
}
// ── Express setup ──────────────────────────────────────────────────────────
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, express_session_1.default)({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: IS_PRODUCTION,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
    },
}));
app.use(express_1.default.static(path.join(__dirname, 'public')));
function requireAuth(req, res, next) {
    if (req.session.authenticated && req.session.userId) {
        next();
    }
    else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}
function getRequiredUserId(req) {
    return Number(req.session.userId);
}
// ── Auth routes ────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const normalized = String(username || '').trim().toLowerCase();
    const pw = String(password || '');
    const user = normalized ? getUserByUsername(normalized) : undefined;
    if (!user || !verifyPassword(pw, user.password_hash)) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
    }
    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    const hasStreamers = listUserStreamerIds(user.id).length > 0;
    res.json({ success: true, username: user.username, needsStreamerSetup: !hasStreamers });
});
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const normalized = String(username || '').trim().toLowerCase();
    const pw = String(password || '');
    if (!/^[a-z0-9_]{3,32}$/.test(normalized)) {
        res.status(400).json({ error: 'Username must be 3-32 chars: a-z, 0-9, _' });
        return;
    }
    if (pw.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters long' });
        return;
    }
    if (getUserByUsername(normalized)) {
        res.status(409).json({ error: 'Username already exists' });
        return;
    }
    const userId = createUser(normalized, pw);
    req.session.authenticated = true;
    req.session.userId = userId;
    req.session.username = normalized;
    res.status(201).json({ success: true, username: normalized, needsStreamerSetup: true });
});
app.get('/api/auth', (req, res) => {
    const userId = req.session.userId;
    if (!req.session.authenticated || !userId) {
        res.json({ authenticated: false });
        return;
    }
    const user = getUserById(Number(userId));
    if (!user) {
        req.session.destroy(() => { });
        res.json({ authenticated: false });
        return;
    }
    const hasStreamers = listUserStreamerIds(user.id).length > 0;
    res.json({ authenticated: true, username: user.username, needsStreamerSetup: !hasStreamers });
});
app.post('/api/logout', (req, res) => {
    req.session.destroy(() => { });
    res.json({ success: true });
});
app.get('/api/tiktok/oauth/callback', async (req, res) => {
    const code = String(req.query.code || '').trim();
    const error = String(req.query.error || '').trim();
    const errorDescription = String(req.query.error_description || '').trim();
    if (error) {
        res.status(400).send(`<h1>TikTok authorization failed</h1><p>${error}</p><p>${errorDescription || 'No error description provided.'}</p>`);
        return;
    }
    if (!code) {
        res.status(400).send('<h1>Missing authorization code</h1><p>No code query parameter found.</p>');
        return;
    }
    // Keep callback usable even before full OAuth wiring is enabled in app config.
    if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !TIKTOK_LOGIN_REDIRECT_URI) {
        res.status(200).send('<h1>TikTok callback reachable</h1><p>Code received. Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_LOGIN_REDIRECT_URI to auto-exchange tokens here.</p>');
        return;
    }
    try {
        const body = new URLSearchParams({
            client_key: TIKTOK_CLIENT_KEY,
            client_secret: TIKTOK_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: TIKTOK_LOGIN_REDIRECT_URI,
        });
        const tokenResponse = await axios_1.default.post(`${TIKTOK_API_BASE}/v2/oauth/token/`, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            validateStatus: () => true,
        });
        if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
            res.status(502).send(`<h1>TikTok token exchange failed</h1><p>Status: ${tokenResponse.status}</p><pre>${JSON.stringify(tokenResponse.data, null, 2)}</pre>`);
            return;
        }
        const tokenType = String(tokenResponse.data?.token_type || 'unknown');
        const expiresIn = Number(tokenResponse.data?.expires_in || 0);
        const refreshExpiresIn = Number(tokenResponse.data?.refresh_expires_in || 0);
        res.status(200).send(`<h1>TikTok connected</h1><p>Token exchange succeeded.</p><p>token_type=${tokenType}, expires_in=${expiresIn}s, refresh_expires_in=${refreshExpiresIn}s</p><p>Next step: store this token per user in DB and use it for upload APIs.</p>`);
    }
    catch (err) {
        res.status(500).send(`<h1>TikTok callback error</h1><p>${err instanceof Error ? err.message : 'Unknown error'}</p>`);
    }
});
app.get('/api/me/streamers', requireAuth, async (req, res) => {
    const userId = getRequiredUserId(req);
    await hydrateMissingStreamerMetadata(userId);
    res.json({ streamers: getAllUserStreamers(userId) });
});
app.post('/api/me/streamers', requireAuth, async (req, res) => {
    const userId = getRequiredUserId(req);
    const rawInputs = req.body?.streamers;
    const normalizedInputs = Array.isArray(rawInputs)
        ? rawInputs
        : String(rawInputs || '').split(/[\n,\s]+/g);
    const uniqueInputs = [...new Set(normalizedInputs.map(v => String(v || '').trim()).filter(Boolean))].slice(0, 200);
    if (uniqueInputs.length === 0) {
        res.status(400).json({ error: 'Please provide at least one streamer login or broadcaster ID.' });
        return;
    }
    try {
        const accessToken = await getTwitchAccessToken();
        const added = [];
        const unresolved = [];
        for (const input of uniqueInputs) {
            const resolved = await resolveStreamerInput(accessToken, input);
            if (!resolved) {
                unresolved.push(input);
                continue;
            }
            addStreamerToUser(userId, resolved);
            added.push(input);
        }
        res.json({ success: true, added: added.length, unresolved, streamers: getAllUserStreamers(userId) });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save streamers' });
    }
});
app.post('/api/me/streamers/add', requireAuth, async (req, res) => {
    const userId = getRequiredUserId(req);
    const input = String(req.body?.streamer || '').trim();
    if (!input) {
        res.status(400).json({ error: 'Missing streamer value' });
        return;
    }
    try {
        const accessToken = await getTwitchAccessToken();
        const resolved = await resolveStreamerInput(accessToken, input);
        if (!resolved) {
            res.status(404).json({ error: 'Streamer not found' });
            return;
        }
        addStreamerToUser(userId, resolved);
        res.json({ success: true, streamers: getAllUserStreamers(userId) });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to add streamer' });
    }
});
app.delete('/api/me/streamers/:broadcasterId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const broadcasterId = String(req.params.broadcasterId || '').trim();
    if (!broadcasterId) {
        res.status(400).json({ error: 'Missing broadcaster ID' });
        return;
    }
    const removed = removeStreamerFromUser(userId, broadcasterId);
    res.json({
        success: true,
        removed,
        streamers: getAllUserStreamers(userId),
    });
});
app.delete('/api/me/streamers/by-row/:rowId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const rowId = Number(req.params.rowId);
    if (!Number.isInteger(rowId) || rowId <= 0) {
        res.status(400).json({ error: 'Invalid streamer row ID' });
        return;
    }
    const result = removeStreamerByRowIdWithCleanup(userId, rowId);
    res.json({
        success: true,
        removed: result.removed,
        removedClips: result.removedClips,
        streamers: getAllUserStreamers(userId),
    });
});
// ── Clips routes ───────────────────────────────────────────────────────────
app.get('/api/clips', requireAuth, async (req, res) => {
    try {
        const userId = getRequiredUserId(req);
        const visibleClips = getAllClips(userId).filter(c => c.view_count >= MIN_CLIP_VIEWS);
        res.json(visibleClips);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch clips' });
    }
});
app.post('/api/clips/refresh', requireAuth, async (req, res) => {
    try {
        const userId = getRequiredUserId(req);
        const streamerIDs = listUserStreamerIds(userId);
        if (streamerIDs.length === 0) {
            res.status(400).json({ error: 'No streamers configured for this account yet.' });
            return;
        }
        const accessToken = await getTwitchAccessToken();
        const twitchClips = await fetchClipsForAllStreamers(accessToken, streamerIDs);
        upsertClips(twitchClips);
        linkClipsToUser(userId, twitchClips);
        console.log(`🔄  User ${userId}: upserted ${twitchClips.length} clips from ${streamerIDs.length} streamer ID(s)`);
        res.json({
            success: true,
            fetched: twitchClips.length,
            streamerCount: streamerIDs.length,
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to refresh clips from Twitch' });
    }
});
app.post('/api/approve/:clipId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    db.prepare('UPDATE user_clip_state SET approved = 1 WHERE user_id = $user_id AND clip_id = $id').run({ $user_id: userId, $id: clipId });
    res.json({ success: true });
});
app.delete('/api/approve/:clipId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    db.prepare('UPDATE user_clip_state SET approved = 0 WHERE user_id = $user_id AND clip_id = $id').run({ $user_id: userId, $id: clipId });
    res.json({ success: true });
});
app.post('/api/sortout/:clipId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    db.prepare('UPDATE user_clip_state SET sorted_out = 1 WHERE user_id = $user_id AND clip_id = $id').run({ $user_id: userId, $id: clipId });
    res.json({ success: true });
});
app.delete('/api/sortout/:clipId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    db.prepare('UPDATE user_clip_state SET sorted_out = 0 WHERE user_id = $user_id AND clip_id = $id').run({ $user_id: userId, $id: clipId });
    res.json({ success: true });
});
app.get('/api/clips/:clipId/video', requireAuth, async (req, res) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    const row = db.prepare(`
        SELECT c.id, c.url, c.thumbnail_url
        FROM clips c
        JOIN user_clip_state s ON s.clip_id = c.id
        WHERE c.id = $id AND s.user_id = $user_id
        LIMIT 1
    `).get({ $id: clipId, $user_id: userId });
    if (!row) {
        res.status(404).json({ error: 'Clip not found' });
        return;
    }
    const attemptStream = async (forceFresh) => {
        const resolvedUrl = await resolveClipVideoUrl(row, forceFresh);
        if (!resolvedUrl)
            throw new Error('Failed to resolve a Twitch clip MP4 URL');
        const rangeHeader = req.headers.range;
        const upstream = await axios_1.default.get(resolvedUrl, {
            responseType: 'stream',
            timeout: 20000,
            headers: {
                ...(rangeHeader ? { Range: String(rangeHeader) } : {}),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Referer: 'https://clips.twitch.tv/',
            },
            validateStatus: (status) => status === 200 || status === 206,
        });
        const contentType = String(upstream.headers['content-type'] || '').toLowerCase();
        const genericBinary = contentType.includes('application/octet-stream') || contentType.includes('binary/octet-stream');
        const isMp4LikeUrl = /\.mp4(?:$|\?)/i.test(resolvedUrl);
        if (!(contentType.startsWith('video/') || (genericBinary && isMp4LikeUrl))) {
            upstream.data.destroy();
            throw new Error(`Resolved media is not video (${contentType || 'unknown'})`);
        }
        res.status(upstream.status);
        res.setHeader('Content-Type', contentType.startsWith('video/') ? upstream.headers['content-type'] : 'video/mp4');
        if (upstream.headers['content-length'])
            res.setHeader('Content-Length', upstream.headers['content-length']);
        if (upstream.headers['content-range'])
            res.setHeader('Content-Range', upstream.headers['content-range']);
        if (upstream.headers['accept-ranges']) {
            res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
        }
        else {
            res.setHeader('Accept-Ranges', 'bytes');
        }
        res.setHeader('Cache-Control', 'private, max-age=300');
        upstream.data.pipe(res);
    };
    try {
        await attemptStream(false);
        return;
    }
    catch (err) {
        try {
            await attemptStream(true);
            return;
        }
        catch {
            try {
                const fallbackPath = await ensurePreviewFallbackFile(row);
                await streamLocalVideoWithRange(req, res, fallbackPath);
                return;
            }
            catch (fallbackErr) {
                const baseError = err instanceof Error ? err.message : 'Failed to stream clip preview video';
                const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : 'yt-dlp fallback failed';
                res.status(502).json({ error: `${baseError}; fallback: ${fallbackMessage}` });
                return;
            }
        }
    }
});
app.get('/api/clips/:clipId/download-cropped', requireAuth, async (req, res) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    const downloadJobKey = `${userId}:${clipId}`;
    if (activeDownloadJobs.has(downloadJobKey)) {
        res.status(409).json({ error: 'This clip download is already in progress.' });
        return;
    }
    activeDownloadJobs.add(downloadJobKey);
    let released = false;
    const releaseDownloadLock = () => {
        if (released)
            return;
        released = true;
        activeDownloadJobs.delete(downloadJobKey);
    };
    let outputPath = null;
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned || !outputPath)
            return;
        cleaned = true;
        await fs.promises.rm(outputPath, { force: true }).catch(() => { });
    };
    try {
        const row = db.prepare(`
            SELECT
                c.id,
                c.url,
                c.title,
                c.view_count,
                c.created_at,
                c.thumbnail_url,
                c.broadcaster_name,
                s.approved,
                s.sorted_out,
                s.fetched_at,
                s.cam_x,
                s.cam_y,
                s.cam_w,
                s.cam_h,
                s.cam_enabled,
                s.twitch_name_enabled,
                s.twitch_name_x,
                s.twitch_name_y,
                s.gameplay_x,
                s.gameplay_y,
                s.gameplay_w,
                s.gameplay_h,
                s.cam_output_y,
                s.cam_output_h,
                s.gameplay_output_y,
                s.gameplay_output_h,
                s.split_points_json,
                s.split_deleted_segments_json,
                s.split_zoom_segments_json
            FROM clips c
            JOIN user_clip_state s ON s.clip_id = c.id
            WHERE c.id = $id AND s.user_id = $user_id
            LIMIT 1
        `).get({ $id: clipId, $user_id: userId });
        if (!row) {
            releaseDownloadLock();
            res.status(404).json({ error: 'Clip not found' });
            return;
        }
        if (row.approved !== 1 || row.sorted_out === 1) {
            releaseDownloadLock();
            res.status(400).json({ error: 'Only approved, non-sorted clips can be downloaded.' });
            return;
        }
        outputPath = await buildProcessedClipForDownload(row);
        const fileName = toSafeMp4Name(row.title, row.id);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'no-store');
        const stream = fs.createReadStream(outputPath);
        stream.on('error', async () => {
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to read cropped file' });
            }
            else {
                res.destroy();
            }
            await cleanup();
            releaseDownloadLock();
        });
        res.on('finish', () => {
            void cleanup();
            releaseDownloadLock();
        });
        res.on('close', () => {
            void cleanup();
            releaseDownloadLock();
        });
        stream.pipe(res);
    }
    catch (err) {
        await cleanup();
        releaseDownloadLock();
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to generate cropped video' });
    }
});
app.post('/api/tiktok/upload-approved', requireAuth, async (req, res) => {
    const userId = getRequiredUserId(req);
    const limitRaw = req.body?.limit;
    const dryRun = Boolean(req.body?.dryRun);
    const limit = parseUploadLimit(limitRaw);
    const approved = getApprovedClips(userId, limit);
    if (approved.length === 0) {
        res.json({ success: true, total: 0, uploaded: 0, failed: 0, results: [] });
        return;
    }
    const results = [];
    for (const clip of approved) {
        const result = await uploadSingleClipToTikTok(clip, dryRun);
        results.push(result);
    }
    const uploaded = results.filter(r => r.status === 'uploaded').length;
    const failed = results.length - uploaded;
    res.json({
        success: failed === 0,
        dryRun,
        total: results.length,
        uploaded,
        failed,
        results,
    });
});
app.post('/api/tiktok/upload-jobs', requireAuth, (req, res) => {
    try {
        const userId = getRequiredUserId(req);
        const limitRaw = req.body?.limit;
        const dryRun = Boolean(req.body?.dryRun);
        const limit = parseUploadLimit(limitRaw);
        const job = startUploadJob(userId, limit, dryRun);
        res.status(202).json({ success: true, job: toJobSnapshot(job) });
    }
    catch (err) {
        res.status(409).json({ error: err instanceof Error ? err.message : 'Could not start upload job' });
    }
});
app.get('/api/tiktok/upload-jobs/active', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const activeUploadJobId = activeUploadJobByUser.get(userId);
    if (!activeUploadJobId) {
        res.json({ active: null });
        return;
    }
    const job = uploadJobs.get(activeUploadJobId);
    if (!job || job.userId !== userId) {
        activeUploadJobByUser.delete(userId);
        res.json({ active: null });
        return;
    }
    res.json({ active: toJobSnapshot(job) });
});
app.get('/api/tiktok/upload-jobs/:jobId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { jobId } = req.params;
    const job = uploadJobs.get(jobId);
    if (!job || job.userId !== userId) {
        res.status(404).json({ error: 'Upload job not found' });
        return;
    }
    res.json({ success: true, job: toJobSnapshot(job) });
});
app.post('/api/tiktok/upload-jobs/:jobId/pause', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { jobId } = req.params;
    const job = uploadJobs.get(jobId);
    if (!job || job.userId !== userId) {
        res.status(404).json({ error: 'Upload job not found' });
        return;
    }
    if (job.status !== 'running' && job.status !== 'paused') {
        res.status(400).json({ error: `Cannot pause job in state ${job.status}` });
        return;
    }
    job.pauseRequested = true;
    job.updatedAt = new Date().toISOString();
    res.json({ success: true, job: toJobSnapshot(job) });
});
app.post('/api/tiktok/upload-jobs/:jobId/resume', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { jobId } = req.params;
    const job = uploadJobs.get(jobId);
    if (!job || job.userId !== userId) {
        res.status(404).json({ error: 'Upload job not found' });
        return;
    }
    if (job.status !== 'running' && job.status !== 'paused') {
        res.status(400).json({ error: `Cannot resume job in state ${job.status}` });
        return;
    }
    job.pauseRequested = false;
    if (job.status === 'paused')
        job.status = 'running';
    job.updatedAt = new Date().toISOString();
    res.json({ success: true, job: toJobSnapshot(job) });
});
app.post('/api/tiktok/upload-jobs/:jobId/cancel', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { jobId } = req.params;
    const job = uploadJobs.get(jobId);
    if (!job || job.userId !== userId) {
        res.status(404).json({ error: 'Upload job not found' });
        return;
    }
    if (job.status !== 'running' && job.status !== 'paused') {
        res.status(400).json({ error: `Cannot cancel job in state ${job.status}` });
        return;
    }
    job.cancelRequested = true;
    job.pauseRequested = false;
    job.updatedAt = new Date().toISOString();
    res.json({ success: true, job: toJobSnapshot(job) });
});
// ── Admin database endpoint ────────────────────────────────────────────────
app.get('/api/admin/db', requireAuth, (req, res) => {
    try {
        const userId = getRequiredUserId(req);
        const allClips = getAllClips(userId);
        const stats = {
            total_clips: allClips.length,
            approved_clips: allClips.filter(c => c.approved).length,
            pending_clips: allClips.filter(c => !c.approved && !c.sorted_out).length,
            sorted_out_clips: allClips.filter(c => c.sorted_out).length,
            clips: allClips.map(c => ({
                id: c.id,
                title: c.title,
                url: c.url,
                view_count: c.view_count,
                created_at: c.created_at,
                broadcaster_name: c.broadcaster_name,
                approved: c.approved,
                sorted_out: c.sorted_out,
                fetched_at: c.fetched_at
            }))
        };
        res.json(stats);
    }
    catch (err) {
        console.error('Admin DB endpoint error:', err);
        res.status(500).json({ error: 'Failed to fetch database info' });
    }
});
// ── Crop editor endpoints ────────────────────────────────────────────────
app.get('/api/crop/:clipId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    const row = db.prepare(`
        SELECT c.id, s.approved, s.cam_x, s.cam_y, s.cam_w, s.cam_h, s.cam_enabled, s.twitch_name_enabled, s.twitch_name_x, s.twitch_name_y, s.gameplay_x, s.gameplay_y, s.gameplay_w, s.gameplay_h, s.cam_output_y, s.cam_output_h, s.gameplay_output_y, s.gameplay_output_h
             , s.split_points_json, s.split_deleted_segments_json, s.split_zoom_segments_json
        FROM clips c
        JOIN user_clip_state s ON s.clip_id = c.id
        WHERE c.id = $id AND s.user_id = $user_id
        LIMIT 1
    `).get({ $id: clipId, $user_id: userId });
    if (!row) {
        res.status(404).json({ error: 'Clip not found' });
        return;
    }
    res.json({
        approved: row.approved === 1,
        crop: {
            cam_x: row.cam_x,
            cam_y: row.cam_y,
            cam_w: row.cam_w,
            cam_h: row.cam_h,
            cam_enabled: row.cam_enabled === 0 ? 0 : 1,
            twitch_name_enabled: row.twitch_name_enabled === 1 ? 1 : 0,
            twitch_name_x: row.twitch_name_x,
            twitch_name_y: row.twitch_name_y,
            gameplay_x: row.gameplay_x,
            gameplay_y: row.gameplay_y,
            gameplay_w: row.gameplay_w,
            gameplay_h: row.gameplay_h,
            cam_output_y: row.cam_output_y,
            cam_output_h: row.cam_output_h,
            gameplay_output_y: row.gameplay_output_y,
            gameplay_output_h: row.gameplay_output_h,
            split_points: parseJsonNumberArray(row.split_points_json),
            split_deleted_segments: parseJsonIntArray(row.split_deleted_segments_json),
            split_zoom_segments: parseJsonIntArray(row.split_zoom_segments_json),
        }
    });
});
app.post('/api/crop/:clipId', requireAuth, (req, res) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    const { cam_x, cam_y, cam_w, cam_h, cam_enabled, twitch_name_enabled, twitch_name_x, twitch_name_y, gameplay_x, gameplay_y, gameplay_w, gameplay_h, cam_output_y, cam_output_h, gameplay_output_y, gameplay_output_h, split_points, split_deleted_segments, split_zoom_segments, } = req.body;
    const parsedCamEnabled = parseCamEnabled(cam_enabled);
    if (parsedCamEnabled === null) {
        res.status(400).json({ error: 'Invalid cam_enabled value. Use 0 or 1.' });
        return;
    }
    const parsedTwitchNameEnabled = parseTwitchNameEnabled(twitch_name_enabled);
    if (parsedTwitchNameEnabled === null) {
        res.status(400).json({ error: 'Invalid twitch_name_enabled value. Use 0 or 1.' });
        return;
    }
    const values = [cam_x, cam_y, cam_w, cam_h, gameplay_x, gameplay_y, gameplay_w, gameplay_h];
    if (!values.every(isValidCropNumber) || cam_w <= 0 || cam_h <= 0 || gameplay_w <= 0 || gameplay_h <= 0) {
        res.status(400).json({ error: 'Invalid crop values. Use numbers between 0 and 1.' });
        return;
    }
    const outputLayoutValues = [cam_output_y, cam_output_h];
    if (!outputLayoutValues.every(isValidCropNumber) || cam_output_h < 0.05 || (cam_output_y + cam_output_h) > 1) {
        res.status(400).json({ error: 'Invalid cam output layout. Keep height >= 0.05 and inside the 9:16 frame.' });
        return;
    }
    const gameplayOutputLayoutValues = [gameplay_output_y, gameplay_output_h];
    if (!gameplayOutputLayoutValues.every(isValidCropNumber) || gameplay_output_h < 0.05 || (gameplay_output_y + gameplay_output_h) > 1) {
        res.status(400).json({ error: 'Invalid gameplay output layout. Keep height >= 0.05 and inside the 9:16 frame.' });
        return;
    }
    const twitchNamePosValues = [twitch_name_x, twitch_name_y];
    if (!twitchNamePosValues.every(isValidCropNumber)) {
        res.status(400).json({ error: 'Invalid Twitch name position. Use numbers between 0 and 1.' });
        return;
    }
    const parsedSplitPoints = parseSplitPointsPayload(split_points);
    if (parsedSplitPoints === null) {
        res.status(400).json({ error: 'Invalid split_points. Provide an array of seconds between 0 and 600.' });
        return;
    }
    const parsedSplitDeletedSegments = parseSplitDeletedSegmentsPayload(split_deleted_segments, parsedSplitPoints.length + 1);
    if (parsedSplitDeletedSegments === null) {
        res.status(400).json({ error: 'Invalid split_deleted_segments. Provide an array of non-negative integers.' });
        return;
    }
    if (parsedSplitDeletedSegments.length >= (parsedSplitPoints.length + 1)) {
        res.status(400).json({ error: 'At least one split segment must remain enabled.' });
        return;
    }
    const parsedSplitZoomSegments = parseSplitZoomSegmentsPayload(split_zoom_segments, parsedSplitPoints.length + 1);
    if (parsedSplitZoomSegments === null) {
        res.status(400).json({ error: 'Invalid split_zoom_segments. Provide an array of non-negative integers.' });
        return;
    }
    const updated = db.prepare(`
        UPDATE user_clip_state
        SET cam_x = $cam_x,
            cam_y = $cam_y,
            cam_w = $cam_w,
            cam_h = $cam_h,
            cam_enabled = $cam_enabled,
            twitch_name_enabled = $twitch_name_enabled,
            twitch_name_x = $twitch_name_x,
            twitch_name_y = $twitch_name_y,
            gameplay_x = $gameplay_x,
            gameplay_y = $gameplay_y,
            gameplay_w = $gameplay_w,
            gameplay_h = $gameplay_h,
            cam_output_y = $cam_output_y,
            cam_output_h = $cam_output_h,
            gameplay_output_y = $gameplay_output_y,
            gameplay_output_h = $gameplay_output_h,
            split_points_json = $split_points_json,
            split_deleted_segments_json = $split_deleted_segments_json,
            split_zoom_segments_json = $split_zoom_segments_json
        WHERE clip_id = $id AND user_id = $user_id AND approved = 1
    `).run({
        $id: clipId,
        $user_id: userId,
        $cam_x: cam_x,
        $cam_y: cam_y,
        $cam_w: cam_w,
        $cam_h: cam_h,
        $cam_enabled: parsedCamEnabled,
        $twitch_name_enabled: parsedTwitchNameEnabled,
        $twitch_name_x: twitch_name_x,
        $twitch_name_y: twitch_name_y,
        $gameplay_x: gameplay_x,
        $gameplay_y: gameplay_y,
        $gameplay_w: gameplay_w,
        $gameplay_h: gameplay_h,
        $cam_output_y: cam_output_y,
        $cam_output_h: cam_output_h,
        $gameplay_output_y: gameplay_output_y,
        $gameplay_output_h: gameplay_output_h,
        $split_points_json: JSON.stringify(parsedSplitPoints),
        $split_deleted_segments_json: JSON.stringify(parsedSplitDeletedSegments),
        $split_zoom_segments_json: JSON.stringify(parsedSplitZoomSegments),
    });
    if (!updated.changes) {
        res.status(400).json({ error: 'Crop can only be saved for approved clips.' });
        return;
    }
    res.json({ success: true });
});
// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    validateEnvironment();
    console.log(`✅  Server running at http://localhost:${PORT}`);
    console.log(`🗄️  Database: ${DB_PATH}`);
    console.log('👥  Multi-user mode enabled: each account manages its own streamer list.');
    console.log(`🧰  Twitch fetch config: lookback=${TWITCH_CLIPS_LOOKBACK_DAYS} days, max_pages=${TWITCH_CLIPS_MAX_PAGES}, page_size=${TWITCH_CLIPS_PAGE_SIZE}`);
    console.log(`🔎  Clip visibility filter: min_views=${MIN_CLIP_VIEWS}`);
    console.log(`🔐  Session mode: ${IS_PRODUCTION ? 'production secure cookies enabled' : 'development cookies (non-secure)'}`);
});
