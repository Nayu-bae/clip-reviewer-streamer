import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'crypto';
import { pipeline } from 'stream/promises';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite');

dotenv.config();

const app = express();
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

function getPositiveNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getNonNegativeIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const TWITCH_CLIPS_PAGE_SIZE = 100;
const TWITCH_CLIPS_MAX_PAGES = getPositiveNumberEnv('TWITCH_CLIPS_MAX_PAGES', 20);
const TWITCH_CLIPS_LOOKBACK_DAYS = getPositiveNumberEnv('TWITCH_CLIPS_LOOKBACK_DAYS', 90);
const MIN_CLIP_VIEWS = getPositiveNumberEnv('MIN_CLIP_VIEWS', 10);
const CLIP_TAG_OPTIONS = ['funny', 'clutch', 'fail', 'skill'] as const;
const TIKTOK_API_BASE = process.env.TIKTOK_API_BASE || 'https://open.tiktokapis.com';
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_ID || '';
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || '';
const TIKTOK_LOGIN_REDIRECT_URI = process.env.TIKTOK_LOGIN_REDIRECT_URI || '';
const TIKTOK_PRIVACY_LEVEL = process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY';
const TIKTOK_OAUTH_SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];
const TIKTOK_DEMO_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.TIKTOK_DEMO_MODE || '').trim().toLowerCase());
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const APP_BASE_URL = String(process.env.APP_BASE_URL || '').replace(/\/+$/g, '');
const EMAIL_VERIFICATION_SECRET = process.env.EMAIL_VERIFICATION_SECRET || SESSION_SECRET;
const EMAIL_VERIFICATION_CODE_TTL_MINUTES = Math.max(1, Math.floor(getPositiveNumberEnv('EMAIL_VERIFICATION_CODE_TTL_MINUTES', 10)));
const EMAIL_VERIFICATION_MAX_ATTEMPTS = Math.max(1, Math.floor(getPositiveNumberEnv('EMAIL_VERIFICATION_MAX_ATTEMPTS', 5)));
const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = Math.max(1, Math.floor(getPositiveNumberEnv('EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS', 60)));
const ACCOUNT_MANAGE_LINK_TTL_MINUTES = Math.max(5, Math.floor(getPositiveNumberEnv('ACCOUNT_MANAGE_LINK_TTL_MINUTES', 30)));
const PASSWORD_RESET_LINK_TTL_MINUTES = Math.max(5, Math.floor(getPositiveNumberEnv('PASSWORD_RESET_LINK_TTL_MINUTES', 30)));
const VIDEO_WORK_DIR = path.join(__dirname, 'tmp', 'videos');
const OVERLAY_MEDIA_DIR = path.join(__dirname, 'tmp', 'overlay-media');
const OVERLAY_MEDIA_MAX_BYTES = 24 * 1024 * 1024;
const TWITCH_LOGO_RELATIVE_PATH = path.join('pictures', 'twitchLogo.png');
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
const LOGICAL_CPU_COUNT = Math.max(1, (os.cpus()?.length || 8));
const DEFAULT_FFMPEG_THREAD_CAP = Math.max(2, Math.min(LOGICAL_CPU_COUNT, Math.max(6, Math.round(LOGICAL_CPU_COUNT * 0.6))));
const FFMPEG_THREAD_CAP = Math.max(0, Math.min(LOGICAL_CPU_COUNT, getNonNegativeIntEnv('FFMPEG_THREAD_CAP', DEFAULT_FFMPEG_THREAD_CAP)));
const DEFAULT_FFMPEG_FILTER_THREAD_CAP = Math.max(1, Math.min(4, Math.ceil((FFMPEG_THREAD_CAP || LOGICAL_CPU_COUNT) / 3)));
const FFMPEG_FILTER_THREAD_CAP = Math.max(0, Math.min(LOGICAL_CPU_COUNT, getNonNegativeIntEnv('FFMPEG_FILTER_THREAD_CAP', DEFAULT_FFMPEG_FILTER_THREAD_CAP)));
const FFMPEG_OUTPUT_FPS = Math.max(24, Math.min(60, Math.round(getPositiveNumberEnv('FFMPEG_OUTPUT_FPS', 30))));
const FFMPEG_GIF_FPS = Math.max(6, Math.min(30, Math.round(getPositiveNumberEnv('FFMPEG_GIF_FPS', 15))));
const DEFAULT_UPLOAD_VIDEO_PRESET = String(process.env.FFMPEG_UPLOAD_PRESET || 'faster').trim() || 'faster';
const DEFAULT_DOWNLOAD_VIDEO_PRESET = String(process.env.FFMPEG_DOWNLOAD_PRESET || 'veryfast').trim() || 'veryfast';
const DEFAULT_UPLOAD_VIDEO_CRF = Math.max(17, Math.min(28, Math.round(getPositiveNumberEnv('FFMPEG_UPLOAD_CRF', 21))));
const DEFAULT_DOWNLOAD_VIDEO_CRF = Math.max(17, Math.min(30, Math.round(getPositiveNumberEnv('FFMPEG_DOWNLOAD_CRF', 22))));
const DEFAULT_MAX_CONCURRENT_RENDERS = Math.max(1, Math.min(4, Math.ceil(LOGICAL_CPU_COUNT / 4)));
const MAX_CONCURRENT_RENDERS = Math.max(1, Math.min(16, Math.floor(getPositiveNumberEnv('FFMPEG_MAX_CONCURRENT_RENDERS', DEFAULT_MAX_CONCURRENT_RENDERS))));
const OVERLAY_MEDIA_RETENTION_DAYS = Math.max(1, Math.min(365, Math.floor(getPositiveNumberEnv('OVERLAY_MEDIA_RETENTION_DAYS', 30))));
const OVERLAY_MEDIA_CLEANUP_INTERVAL_MINUTES = Math.max(10, Math.min(24 * 60, Math.floor(getPositiveNumberEnv('OVERLAY_MEDIA_CLEANUP_INTERVAL_MINUTES', 180))));
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const CLIP_GQL_CACHE_TTL_MS = 10 * 60 * 1000;
const LEGACY_STREAMER_IDS = getStreamerIdsFromEnv();
const clipVideoUrlCache = new Map<string, { url: string; expiresAt: number }>();
const previewBuildJobs = new Map<string, Promise<string>>();
const activeDownloadJobs = new Set<string>();
const pendingRenderResolvers: Array<() => void> = [];
let activeRenderCount = 0;
let overlayCleanupInFlight = false;
const OVERLAY_MIME_TO_EXTENSION: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
const OVERLAY_EXTENSION_TO_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
};

interface OverlayItemConfig {
    id: string;
    enabled: boolean;
    mediaRef: string;
    label: string;
    mediaMime: string;
    startSec: number;
    endSec: number;
    x: number;
    y: number;
    w: number;
    h: number;
}

function getStreamerIdsFromEnv(): string[] {
    const entries = Object.entries(process.env);
    const ids = entries
        .filter(([key, value]) => {
            if (!value) return false;
            if (key === 'TWITCH_STREAMER_ID') return true;
            return key.startsWith('TWITCH_STREAMER_') && key.endsWith('_ID');
        })
        .map(([, value]) => (value || '').trim())
        .filter(Boolean);

    return [...new Set(ids)];
}

const uploadJobs = new Map<string, UploadJobState>();
const activeUploadJobByUser = new Map<number, string>();

interface Clip {
    id: string;
    url: string;
    title: string;
    view_count: number;
    created_at: string;
    thumbnail_url: string;
    broadcaster_name: string;
    approved?: boolean;
}

interface DbClipRow {
    id: string;
    url: string;
    title: string;
    view_count: number;
    created_at: string;
    thumbnail_url: string;
    broadcaster_name: string;
    approved: number;
    sorted_out: number;
    fetched_at: string;
    cam_x: number | null;
    cam_y: number | null;
    cam_w: number | null;
    cam_h: number | null;
    cam_enabled: number | null;
    twitch_name_enabled: number | null;
    twitch_name_x: number | null;
    twitch_name_y: number | null;
    twitch_name_text: string | null;
    twitch_name_scale: number | null;
    gameplay_x: number | null;
    gameplay_y: number | null;
    gameplay_w: number | null;
    gameplay_h: number | null;
    third_x: number | null;
    third_y: number | null;
    third_w: number | null;
    third_h: number | null;
    cam_output_y: number | null;
    cam_output_h: number | null;
    gameplay_output_y: number | null;
    gameplay_output_h: number | null;
    third_area_enabled: number | null;
    third_output_x: number | null;
    third_output_y: number | null;
    third_output_w: number | null;
    third_output_h: number | null;
    split_points_json: string | null;
    split_deleted_segments_json: string | null;
    split_zoom_segments_json: string | null;
    split_zoom_layouts_json: string | null;
    overlay_items_json?: string | null;
    overlay_enabled?: number | null;
    overlay_media_path?: string | null;
    overlay_media_mime?: string | null;
    overlay_start_sec?: number | null;
    overlay_end_sec?: number | null;
    overlay_x?: number | null;
    overlay_y?: number | null;
    overlay_w?: number | null;
    overlay_h?: number | null;
    clip_tags_json?: string | null;
    uploaded_to_tiktok?: number | null;
    uploaded_at?: string | null;
}

interface ClipUploadResult {
    clipId: string;
    title: string;
    status: 'uploaded' | 'failed';
    details: string;
    publishId?: string;
}

interface UploadJobSnapshot {
    jobId: string;
    status: 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';
    dryRun: boolean;
    total: number;
    processed: number;
    uploaded: number;
    failed: number;
    createdAt: string;
    updatedAt: string;
    currentClipId?: string;
    currentTitle?: string;
    results: ClipUploadResult[];
}

interface UploadJobState extends UploadJobSnapshot {
    userId: number;
    clips: DbClipRow[];
    uploadMode: TikTokUploadMode;
    pauseRequested: boolean;
    cancelRequested: boolean;
}

interface UserRow {
    id: number;
    username: string;
    email: string | null;
    email_verified: number;
    email_verified_at: string | null;
    password_hash: string;
}

type TikTokUploadMode = 'draft' | 'direct';

interface TikTokAccountRow {
    user_id: number;
    open_id: string | null;
    scope: string | null;
    access_token: string | null;
    refresh_token: string | null;
    access_token_expires_at: string | null;
    refresh_token_expires_at: string | null;
    token_type: string | null;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    upload_mode: string | null;
    created_at: string;
    updated_at: string;
}

interface TikTokCreatorInfo {
    privacyLevelOptions: string[];
    commentDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
}

interface EmailVerificationCodeRow {
    user_id: number;
    code_hash: string;
    expires_at: string;
    attempts: number;
    last_sent_at: string;
    created_at: string;
}

interface AccountActionTokenRow {
    id: number;
    user_id: number;
    purpose: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    created_at: string;
}

interface AccountActionTokenWithUserRow extends AccountActionTokenRow {
    username: string;
    email: string | null;
    email_verified: number;
    email_verified_at: string | null;
    password_hash: string;
}

interface TwitchClipsResponse {
    data: Clip[];
    pagination?: { cursor?: string };
}

declare module 'express-session' {
    interface SessionData {
        authenticated: boolean;
        userId?: number;
        username?: string;
        pendingVerificationUserId?: number;
        pendingVerificationEmail?: string;
        pendingVerificationUsername?: string;
        tiktokOauthState?: string;
        tiktokOauthUserId?: number;
        tiktokOauthReturnTo?: string;
    }
}

// ── Database setup ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db: any = new DatabaseSync(DB_PATH);

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
        email         TEXT UNIQUE,
        email_verified INTEGER NOT NULL DEFAULT 0,
        email_verified_at TEXT,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
        user_id     INTEGER PRIMARY KEY,
        code_hash   TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_sent_at TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS user_tiktok_accounts (
        user_id                    INTEGER PRIMARY KEY,
        open_id                    TEXT,
        scope                      TEXT,
        access_token               TEXT,
        refresh_token              TEXT,
        access_token_expires_at    TEXT,
        refresh_token_expires_at   TEXT,
        token_type                 TEXT,
        username                   TEXT,
        display_name               TEXT,
        avatar_url                 TEXT,
        upload_mode                TEXT NOT NULL DEFAULT 'draft',
        created_at                 TEXT NOT NULL,
        updated_at                 TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS account_action_tokens (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        purpose    TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at    TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
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
        twitch_name_text TEXT,
        twitch_name_scale REAL,
        gameplay_x    REAL,
        gameplay_y    REAL,
        gameplay_w    REAL,
        gameplay_h    REAL,
        third_x       REAL,
        third_y       REAL,
        third_w       REAL,
        third_h       REAL,
        cam_output_y  REAL,
        cam_output_h  REAL,
        gameplay_output_y REAL,
        gameplay_output_h REAL,
        third_area_enabled INTEGER NOT NULL DEFAULT 0,
        third_output_x REAL,
        third_output_y REAL,
        third_output_w REAL,
        third_output_h REAL,
        split_points_json TEXT,
        split_deleted_segments_json TEXT,
        split_zoom_segments_json TEXT,
        split_zoom_layouts_json TEXT,
        overlay_items_json TEXT NOT NULL DEFAULT '[]',
        overlay_enabled INTEGER NOT NULL DEFAULT 0,
        overlay_media_path TEXT,
        overlay_media_mime TEXT,
        overlay_start_sec REAL,
        overlay_end_sec REAL,
        overlay_x REAL,
        overlay_y REAL,
        overlay_w REAL,
        overlay_h REAL,
        clip_tags_json TEXT NOT NULL DEFAULT '[]',
        uploaded_to_tiktok INTEGER NOT NULL DEFAULT 0,
        uploaded_at TEXT,
        fetched_at    TEXT NOT NULL,
        PRIMARY KEY (user_id, clip_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(clip_id) REFERENCES clips(id) ON DELETE CASCADE
    )
`);

// Add `sorted_out` column to existing DBs that predate this migration
try { db.exec('ALTER TABLE clips ADD COLUMN sorted_out INTEGER NOT NULL DEFAULT 0'); }
catch { /* column already exists */ }

function addColumnIfMissing(sql: string): void {
    try { db.exec(sql); }
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
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_x REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_y REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_w REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_h REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_area_enabled INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_output_x REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_output_y REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_output_w REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN third_output_h REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN twitch_name_enabled INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN twitch_name_x REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN twitch_name_y REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN twitch_name_text TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN twitch_name_scale REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_points_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_deleted_segments_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_zoom_segments_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_zoom_layouts_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_items_json TEXT NOT NULL DEFAULT \'[]\'');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_enabled INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_media_path TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_media_mime TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_start_sec REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_end_sec REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_x REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_y REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_w REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN overlay_h REAL');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN clip_tags_json TEXT NOT NULL DEFAULT \'[]\'');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN uploaded_to_tiktok INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN uploaded_at TEXT');
addColumnIfMissing('ALTER TABLE users ADD COLUMN email TEXT');
addColumnIfMissing('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN open_id TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN scope TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN access_token TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN refresh_token TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN access_token_expires_at TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN refresh_token_expires_at TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN token_type TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN username TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN display_name TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN avatar_url TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN upload_mode TEXT NOT NULL DEFAULT \'draft\'');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN created_at TEXT');
addColumnIfMissing('ALTER TABLE user_tiktok_accounts ADD COLUMN updated_at TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_nocase ON users(email COLLATE NOCASE) WHERE email IS NOT NULL AND email <> \'\'');
db.exec('CREATE INDEX IF NOT EXISTS email_verification_codes_expires_idx ON email_verification_codes(expires_at)');
db.exec('CREATE INDEX IF NOT EXISTS account_action_tokens_expires_idx ON account_action_tokens(expires_at)');
db.exec('CREATE INDEX IF NOT EXISTS account_action_tokens_user_idx ON account_action_tokens(user_id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS user_tiktok_accounts_open_id_unique ON user_tiktok_accounts(open_id) WHERE open_id IS NOT NULL AND open_id <> \'\'');

function hashPassword(plain: string): string {
    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(plain, salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain: string, stored: string): boolean {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, expectedHex] = parts;
    const actual = scryptSync(plain, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizeEmail(email: string): string {
    return String(email || '').trim().toLowerCase();
}

function normalizeAuthIdentifier(identifier: string): string {
    return String(identifier || '').trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function maskEmail(email: string): string {
    const normalized = normalizeEmail(email);
    const [localPart, domainPart] = normalized.split('@');
    if (!localPart || !domainPart) return '';
    const visibleLocal = localPart.length <= 2 ? `${localPart[0] || '*'}*` : `${localPart.slice(0, 2)}***`;
    const domainSegments = domainPart.split('.');
    if (domainSegments.length < 2) return `${visibleLocal}@***`;
    const tld = domainSegments.pop() || '';
    const host = domainSegments.join('.');
    const maskedHost = host.length <= 2 ? `${host[0] || '*'}*` : `${host.slice(0, 2)}***`;
    return `${visibleLocal}@${maskedHost}.${tld}`;
}

function getUserByUsername(username: string): UserRow | undefined {
    return db.prepare(`
        SELECT id, username, email, COALESCE(email_verified, 0) AS email_verified, email_verified_at, password_hash
        FROM users
        WHERE lower(username) = lower($username)
        LIMIT 1
    `)
        .get({ $username: username }) as UserRow | undefined;
}

function getUserByEmail(email: string): UserRow | undefined {
    return db.prepare(`
        SELECT id, username, email, COALESCE(email_verified, 0) AS email_verified, email_verified_at, password_hash
        FROM users
        WHERE lower(email) = lower($email)
        LIMIT 1
    `)
        .get({ $email: email }) as UserRow | undefined;
}

function getUserByIdentifier(identifier: string): UserRow | undefined {
    const normalized = normalizeAuthIdentifier(identifier);
    if (!normalized) return undefined;
    if (normalized.includes('@')) return getUserByEmail(normalized);
    return getUserByUsername(normalized);
}

function getUserById(userId: number): UserRow | undefined {
    return db.prepare('SELECT id, username, email, COALESCE(email_verified, 0) AS email_verified, email_verified_at, password_hash FROM users WHERE id = $id')
        .get({ $id: userId }) as UserRow | undefined;
}

function normalizeTikTokUploadMode(value: unknown): TikTokUploadMode {
    return String(value || '').trim().toLowerCase() === 'direct' ? 'direct' : 'draft';
}

function normalizeTikTokScopes(rawScopes: unknown): string[] {
    if (Array.isArray(rawScopes)) {
        return [...new Set(rawScopes.map(scope => String(scope || '').trim()).filter(Boolean))];
    }
    return [...new Set(String(rawScopes || '')
        .split(/[\s,]+/g)
        .map(scope => scope.trim())
        .filter(Boolean))];
}

function getTikTokAccountByUserId(userId: number): TikTokAccountRow | undefined {
    return db.prepare(`
        SELECT
            user_id,
            open_id,
            scope,
            access_token,
            refresh_token,
            access_token_expires_at,
            refresh_token_expires_at,
            token_type,
            username,
            display_name,
            avatar_url,
            COALESCE(upload_mode, 'draft') AS upload_mode,
            COALESCE(created_at, $now) AS created_at,
            COALESCE(updated_at, $now) AS updated_at
        FROM user_tiktok_accounts
        WHERE user_id = $user_id
        LIMIT 1
    `).get({
        $user_id: userId,
        $now: new Date().toISOString(),
    }) as TikTokAccountRow | undefined;
}

function getTikTokUploadModeForUser(userId: number): TikTokUploadMode {
    const row = db.prepare(`
        SELECT COALESCE(upload_mode, 'draft') AS upload_mode
        FROM user_tiktok_accounts
        WHERE user_id = $user_id
        LIMIT 1
    `).get({ $user_id: userId }) as { upload_mode?: string } | undefined;
    return normalizeTikTokUploadMode(row?.upload_mode || 'draft');
}

function saveTikTokUploadModeForUser(userId: number, mode: TikTokUploadMode): TikTokUploadMode {
    const normalized = normalizeTikTokUploadMode(mode);
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO user_tiktok_accounts (user_id, upload_mode, created_at, updated_at)
        VALUES ($user_id, $upload_mode, $created_at, $updated_at)
        ON CONFLICT(user_id) DO UPDATE SET
            upload_mode = excluded.upload_mode,
            updated_at = excluded.updated_at
    `).run({
        $user_id: userId,
        $upload_mode: normalized,
        $created_at: now,
        $updated_at: now,
    });
    return normalized;
}

function upsertTikTokOAuthAccount(params: {
    userId: number;
    openId: string;
    scopes: string[];
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
    tokenType: string;
    username: string;
    displayName: string;
    avatarUrl: string;
}): void {
    const existing = getTikTokAccountByUserId(params.userId);
    const now = new Date().toISOString();
    const uploadMode = normalizeTikTokUploadMode(existing?.upload_mode || 'draft');
    const createdAt = existing?.created_at || now;
    const scope = normalizeTikTokScopes(params.scopes).join(' ');

    db.prepare(`
        INSERT INTO user_tiktok_accounts (
            user_id,
            open_id,
            scope,
            access_token,
            refresh_token,
            access_token_expires_at,
            refresh_token_expires_at,
            token_type,
            username,
            display_name,
            avatar_url,
            upload_mode,
            created_at,
            updated_at
        ) VALUES (
            $user_id,
            $open_id,
            $scope,
            $access_token,
            $refresh_token,
            $access_token_expires_at,
            $refresh_token_expires_at,
            $token_type,
            $username,
            $display_name,
            $avatar_url,
            $upload_mode,
            $created_at,
            $updated_at
        )
        ON CONFLICT(user_id) DO UPDATE SET
            open_id = excluded.open_id,
            scope = excluded.scope,
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            access_token_expires_at = excluded.access_token_expires_at,
            refresh_token_expires_at = excluded.refresh_token_expires_at,
            token_type = excluded.token_type,
            username = excluded.username,
            display_name = excluded.display_name,
            avatar_url = excluded.avatar_url,
            upload_mode = excluded.upload_mode,
            updated_at = excluded.updated_at
    `).run({
        $user_id: params.userId,
        $open_id: params.openId || null,
        $scope: scope,
        $access_token: params.accessToken || null,
        $refresh_token: params.refreshToken || null,
        $access_token_expires_at: params.accessTokenExpiresAt,
        $refresh_token_expires_at: params.refreshTokenExpiresAt,
        $token_type: params.tokenType || null,
        $username: params.username || null,
        $display_name: params.displayName || null,
        $avatar_url: params.avatarUrl || null,
        $upload_mode: uploadMode,
        $created_at: createdAt,
        $updated_at: now,
    });
}

function connectDemoTikTokAccount(userId: number): void {
    const user = getUserById(userId);
    if (!user) {
        throw new Error('User not found for demo TikTok connect.');
    }

    const seed = String(user.username || `user${userId}`).replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase() || `user${userId}`;
    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
    const refreshExpiresAt = new Date(now.getTime() + (5 * 365 * 24 * 60 * 60 * 1000));

    upsertTikTokOAuthAccount({
        userId,
        openId: `demo-open-${userId}`,
        scopes: [...TIKTOK_OAUTH_SCOPES],
        accessToken: `demo_access_${userId}_${now.getTime()}`,
        refreshToken: `demo_refresh_${userId}_${now.getTime()}`,
        accessTokenExpiresAt: accessExpiresAt.toISOString(),
        refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
        tokenType: 'Bearer',
        username: `${seed}_demo`,
        displayName: `${user.username} Demo`,
        avatarUrl: '',
    });
}

function disconnectTikTokAccount(userId: number): void {
    const now = new Date().toISOString();
    db.prepare(`
        UPDATE user_tiktok_accounts
        SET
            open_id = NULL,
            scope = NULL,
            access_token = NULL,
            refresh_token = NULL,
            access_token_expires_at = NULL,
            refresh_token_expires_at = NULL,
            token_type = NULL,
            username = NULL,
            display_name = NULL,
            avatar_url = NULL,
            updated_at = $updated_at
        WHERE user_id = $user_id
    `).run({
        $updated_at: now,
        $user_id: userId,
    });
}

function hasTikTokScope(account: TikTokAccountRow | undefined, scope: string): boolean {
    if (!account) return false;
    const granted = new Set(normalizeTikTokScopes(account.scope));
    return granted.has(scope);
}

function getTikTokReconnectState(
    account: TikTokAccountRow | undefined,
    uploadMode: TikTokUploadMode
): { needsReconnect: boolean; reconnectReason: string } {
    if (!account || !account.access_token) {
        return { needsReconnect: false, reconnectReason: '' };
    }

    const requiredScope = uploadMode === 'direct' ? 'video.publish' : 'video.upload';
    if (!hasTikTokScope(account, requiredScope)) {
        return {
            needsReconnect: true,
            reconnectReason: `Missing TikTok permission: ${requiredScope}. Reconnect TikTok and grant the required permission.`,
        };
    }

    const nowPlusBuffer = Date.now() + (60 * 1000);
    const accessExpiresAt = Date.parse(String(account.access_token_expires_at || ''));
    const accessExpiringSoon = Number.isFinite(accessExpiresAt) && accessExpiresAt <= nowPlusBuffer;
    if (!accessExpiringSoon) {
        return { needsReconnect: false, reconnectReason: '' };
    }

    const refreshToken = String(account.refresh_token || '').trim();
    if (!refreshToken) {
        return {
            needsReconnect: true,
            reconnectReason: 'TikTok access token expired and no refresh token is available. Reconnect TikTok to keep uploading.',
        };
    }

    const refreshExpiresAt = Date.parse(String(account.refresh_token_expires_at || ''));
    const refreshExpired = Number.isFinite(refreshExpiresAt) && refreshExpiresAt <= nowPlusBuffer;
    if (refreshExpired) {
        return {
            needsReconnect: true,
            reconnectReason: 'TikTok refresh token expired. Reconnect TikTok to continue uploading.',
        };
    }

    return { needsReconnect: false, reconnectReason: '' };
}

function getTikTokAccountView(userId: number): {
    connected: boolean;
    demoMode: boolean;
    openId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    scopes: string[];
    uploadMode: TikTokUploadMode;
    needsReconnect: boolean;
    reconnectReason: string;
} {
    const account = getTikTokAccountByUserId(userId);
    const uploadMode = normalizeTikTokUploadMode(account?.upload_mode || 'draft');
    const reconnectState = getTikTokReconnectState(account, uploadMode);
    return {
        connected: Boolean(account?.access_token),
        demoMode: TIKTOK_DEMO_MODE,
        openId: String(account?.open_id || ''),
        username: String(account?.username || ''),
        displayName: String(account?.display_name || ''),
        avatarUrl: String(account?.avatar_url || ''),
        scopes: normalizeTikTokScopes(account?.scope),
        uploadMode,
        needsReconnect: reconnectState.needsReconnect,
        reconnectReason: reconnectState.reconnectReason,
    };
}

function clearTikTokOAuthSessionState(req: Request): void {
    delete req.session.tiktokOauthState;
    delete req.session.tiktokOauthUserId;
    delete req.session.tiktokOauthReturnTo;
}

function sanitizeRelativeReturnPath(rawPath: string): string {
    const candidate = String(rawPath || '').trim();
    if (!candidate.startsWith('/')) return '/app';
    if (candidate.startsWith('//')) return '/app';
    return candidate;
}

function clearPendingVerificationSession(req: Request): void {
    delete req.session.pendingVerificationUserId;
    delete req.session.pendingVerificationEmail;
    delete req.session.pendingVerificationUsername;
}

function setPendingVerificationSession(req: Request, user: UserRow): void {
    req.session.authenticated = false;
    delete req.session.userId;
    delete req.session.username;
    req.session.pendingVerificationUserId = user.id;
    req.session.pendingVerificationEmail = user.email || '';
    req.session.pendingVerificationUsername = user.username;
}

function markEmailVerified(userId: number): void {
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET email_verified = 1, email_verified_at = $now WHERE id = $id').run({
        $id: userId,
        $now: now,
    });
}

function isEmailVerified(user: UserRow): boolean {
    return !user.email || user.email_verified === 1;
}

function createUser(username: string, password: string, email?: string): number {
    const now = new Date().toISOString();
    const normalizedEmail = normalizeEmail(email || '');
    const needsEmailVerification = normalizedEmail.length > 0;
    const result = db.prepare(`
        INSERT INTO users (username, email, email_verified, email_verified_at, password_hash, created_at)
        VALUES ($username, $email, $email_verified, $email_verified_at, $hash, $created_at)
    `).run({
        $username: username,
        $email: normalizedEmail || null,
        $email_verified: needsEmailVerification ? 0 : 1,
        $email_verified_at: needsEmailVerification ? null : now,
        $hash: hashPassword(password),
        $created_at: now,
    });
    return Number(result.lastInsertRowid);
}

function isEmailDeliveryConfigured(): boolean {
    return Boolean(RESEND_API_KEY && MAIL_FROM);
}

function hashVerificationCode(userId: number, code: string): string {
    return createHash('sha256').update(`${EMAIL_VERIFICATION_SECRET}:${userId}:${code}`).digest('hex');
}

function safeEqualHash(leftHex: string, rightHex: string): boolean {
    try {
        const left = Buffer.from(String(leftHex || ''), 'hex');
        const right = Buffer.from(String(rightHex || ''), 'hex');
        return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

function generateVerificationCode(): string {
    return String(randomInt(0, 1000000)).padStart(6, '0');
}

function pruneExpiredVerificationCodes(): void {
    db.prepare('DELETE FROM email_verification_codes WHERE expires_at <= $now').run({
        $now: new Date().toISOString(),
    });
}

function getVerificationCodeRow(userId: number): EmailVerificationCodeRow | undefined {
    return db.prepare(`
        SELECT user_id, code_hash, expires_at, attempts, last_sent_at, created_at
        FROM email_verification_codes
        WHERE user_id = $user_id
        LIMIT 1
    `).get({ $user_id: userId }) as EmailVerificationCodeRow | undefined;
}

function saveVerificationCode(userId: number, code: string): void {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_CODE_TTL_MINUTES * 60 * 1000);
    db.prepare(`
        INSERT INTO email_verification_codes (user_id, code_hash, expires_at, attempts, last_sent_at, created_at)
        VALUES ($user_id, $code_hash, $expires_at, 0, $last_sent_at, $created_at)
        ON CONFLICT(user_id) DO UPDATE SET
            code_hash = excluded.code_hash,
            expires_at = excluded.expires_at,
            attempts = 0,
            last_sent_at = excluded.last_sent_at,
            created_at = excluded.created_at
    `).run({
        $user_id: userId,
        $code_hash: hashVerificationCode(userId, code),
        $expires_at: expiresAt.toISOString(),
        $last_sent_at: now.toISOString(),
        $created_at: now.toISOString(),
    });
}

function incrementVerificationAttempts(userId: number): number {
    db.prepare('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE user_id = $user_id').run({
        $user_id: userId,
    });
    const row = getVerificationCodeRow(userId);
    return Number(row?.attempts || 0);
}

function clearVerificationCode(userId: number): void {
    db.prepare('DELETE FROM email_verification_codes WHERE user_id = $user_id').run({
        $user_id: userId,
    });
}

function getResendAvailableInSeconds(userId: number): number {
    const row = getVerificationCodeRow(userId);
    if (!row?.last_sent_at) return 0;
    const lastSentAtMs = Date.parse(String(row.last_sent_at));
    if (!Number.isFinite(lastSentAtMs)) return 0;
    const elapsedSeconds = Math.floor((Date.now() - lastSentAtMs) / 1000);
    return Math.max(0, EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS - elapsedSeconds);
}

async function sendVerificationCodeEmail(user: UserRow, code: string): Promise<void> {
    if (!isEmailDeliveryConfigured()) {
        throw new Error('Email verification is not configured. Set RESEND_API_KEY and MAIL_FROM.');
    }
    if (!user.email) {
        throw new Error('User is missing an email address.');
    }

    const subject = 'Verify your Clip-Reviewer account';
    const baseText = [
        `Hi ${user.username},`,
        '',
        `Your Clip-Reviewer verification code is: ${code}`,
        '',
        `This code expires in ${EMAIL_VERIFICATION_CODE_TTL_MINUTES} minute(s).`,
    ];
    const withLink = APP_BASE_URL ? `${baseText.join('\n')}\n\nSign in: ${APP_BASE_URL}/login` : baseText.join('\n');

    const response = await axios.post('https://api.resend.com/emails', {
        from: MAIL_FROM,
        to: [user.email],
        subject,
        text: withLink,
        html: `
            <p>Hi ${user.username},</p>
            <p>Your Clip-Reviewer verification code is:</p>
            <p style="font-size: 24px; font-weight: 700; letter-spacing: 4px;">${code}</p>
            <p>This code expires in ${EMAIL_VERIFICATION_CODE_TTL_MINUTES} minute(s).</p>
            ${APP_BASE_URL ? `<p><a href="${APP_BASE_URL}/login">Open Clip-Reviewer</a></p>` : ''}
        `,
    }, {
        headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
        const msg = typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data || {});
        throw new Error(`Resend API error (${response.status}): ${msg}`);
    }
}

async function issueVerificationCode(user: UserRow, enforceCooldown: boolean): Promise<{ sent: boolean; resendAvailableIn: number }> {
    pruneExpiredVerificationCodes();
    const cooldown = getResendAvailableInSeconds(user.id);
    if (enforceCooldown && cooldown > 0) {
        return { sent: false, resendAvailableIn: cooldown };
    }

    const code = generateVerificationCode();
    await sendVerificationCodeEmail(user, code);
    saveVerificationCode(user.id, code);
    return { sent: true, resendAvailableIn: EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS };
}

function getAppBaseUrl(): string {
    return APP_BASE_URL || `http://localhost:${PORT}`;
}

function maskCredential(raw: string, visible = 4): string {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (value.length <= (visible * 2)) return `${value.slice(0, Math.max(1, Math.floor(value.length / 3)))}***`;
    return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function buildTikTokReturnPath(pathname: string, result: 'success' | 'error', message = ''): string {
    const url = new URL(pathname, getAppBaseUrl());
    url.searchParams.set('tiktok', result);
    const text = String(message || '').trim();
    if (text) {
        url.searchParams.set('tiktok_message', text.slice(0, 180));
    } else {
        url.searchParams.delete('tiktok_message');
    }
    return `${url.pathname}${url.search}${url.hash}`;
}

function hashAccountActionToken(rawToken: string): string {
    return createHash('sha256').update(`${EMAIL_VERIFICATION_SECRET}:account_action:${rawToken}`).digest('hex');
}

function pruneExpiredAccountActionTokens(): void {
    db.prepare('DELETE FROM account_action_tokens WHERE expires_at <= $now OR used_at IS NOT NULL').run({
        $now: new Date().toISOString(),
    });
}

function createAccountActionToken(userId: number, purpose: 'manage_account' | 'reset_password', ttlMinutes: number): string {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    db.prepare(`
        INSERT INTO account_action_tokens (user_id, purpose, token_hash, expires_at, created_at)
        VALUES ($user_id, $purpose, $token_hash, $expires_at, $created_at)
    `).run({
        $user_id: userId,
        $purpose: purpose,
        $token_hash: hashAccountActionToken(token),
        $expires_at: expiresAt.toISOString(),
        $created_at: now.toISOString(),
    });
    return token;
}

function getAccountActionTokenRow(rawToken: string): AccountActionTokenWithUserRow | undefined {
    const tokenHash = hashAccountActionToken(rawToken);
    return db.prepare(`
        SELECT
            t.id, t.user_id, t.purpose, t.token_hash, t.expires_at, t.used_at, t.created_at,
            u.username, u.email, COALESCE(u.email_verified, 0) AS email_verified, u.email_verified_at, u.password_hash
        FROM account_action_tokens t
        JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $token_hash
          AND t.used_at IS NULL
          AND t.expires_at > $now
        LIMIT 1
    `).get({
        $token_hash: tokenHash,
        $now: new Date().toISOString(),
    }) as AccountActionTokenWithUserRow | undefined;
}

function markAccountActionTokenUsed(tokenId: number): void {
    db.prepare('UPDATE account_action_tokens SET used_at = $used_at WHERE id = $id').run({
        $id: tokenId,
        $used_at: new Date().toISOString(),
    });
}

async function sendAccountActionLinkEmail(user: UserRow, purpose: 'manage_account' | 'reset_password', rawToken: string): Promise<void> {
    if (!isEmailDeliveryConfigured()) {
        throw new Error('Email links require RESEND_API_KEY and MAIL_FROM.');
    }
    if (!user.email) {
        throw new Error('User is missing an email address.');
    }
    const linkPath = purpose === 'reset_password' ? '/reset-password' : '/account-security';
    const link = `${getAppBaseUrl()}${linkPath}?token=${encodeURIComponent(rawToken)}`;
    const isReset = purpose === 'reset_password';
    const subject = isReset ? 'Reset your Clip-Reviewer password' : 'Secure link to manage your Clip-Reviewer account';
    const text = isReset
        ? `Hi ${user.username},\n\nUse this secure link to reset your password:\n${link}\n\nThis link expires in ${PASSWORD_RESET_LINK_TTL_MINUTES} minute(s).`
        : `Hi ${user.username},\n\nUse this secure link to update your account details (username, email, password):\n${link}\n\nThis link expires in ${ACCOUNT_MANAGE_LINK_TTL_MINUTES} minute(s).`;
    const html = isReset
        ? `<p>Hi ${user.username},</p><p>Use this secure link to reset your password:</p><p><a href="${link}">${link}</a></p><p>This link expires in ${PASSWORD_RESET_LINK_TTL_MINUTES} minute(s).</p>`
        : `<p>Hi ${user.username},</p><p>Use this secure link to update your account details (username, email, password):</p><p><a href="${link}">${link}</a></p><p>This link expires in ${ACCOUNT_MANAGE_LINK_TTL_MINUTES} minute(s).</p>`;

    const response = await axios.post('https://api.resend.com/emails', {
        from: MAIL_FROM,
        to: [user.email],
        subject,
        text,
        html,
    }, {
        headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
        const msg = typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data || {});
        throw new Error(`Resend API error (${response.status}): ${msg}`);
    }
}

function listUserStreamerIds(userId: number): string[] {
    const rows = db.prepare('SELECT twitch_broadcaster_id FROM user_streamers WHERE user_id = $user_id ORDER BY id ASC')
        .all({ $user_id: userId }) as Array<{ twitch_broadcaster_id: string }>;
    return rows.map(r => String(r.twitch_broadcaster_id));
}

function listUserStreamerNameKeys(userId: number): Set<string> {
    const rows = db.prepare(`
        SELECT twitch_login, display_name
        FROM user_streamers
        WHERE user_id = $user_id
    `).all({ $user_id: userId }) as Array<{ twitch_login: string | null; display_name: string | null }>;

    const keys = new Set<string>();
    for (const row of rows) {
        const login = String(row.twitch_login || '').trim().toLowerCase();
        const display = String(row.display_name || '').trim().toLowerCase();
        if (login) keys.add(login);
        if (display) keys.add(display);
    }
    return keys;
}

function getAllUserStreamers(userId: number): Array<{ id: number; twitch_broadcaster_id: string; twitch_login: string | null; display_name: string | null; created_at: string }> {
    return db.prepare(`
        SELECT id, twitch_broadcaster_id, twitch_login, display_name, created_at
        FROM user_streamers
        WHERE user_id = $user_id
        ORDER BY COALESCE(display_name, twitch_login, twitch_broadcaster_id) COLLATE NOCASE ASC
    `).all({ $user_id: userId }) as Array<{ id: number; twitch_broadcaster_id: string; twitch_login: string | null; display_name: string | null; created_at: string }>;
}

function addStreamerToUser(userId: number, streamer: { id: string; login?: string; displayName?: string }): void {
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

function removeStreamerFromUser(userId: number, broadcasterId: string): boolean {
    const result = db.prepare(`
        DELETE FROM user_streamers
        WHERE user_id = $user_id AND twitch_broadcaster_id = $broadcaster_id
    `).run({
        $user_id: userId,
        $broadcaster_id: broadcasterId,
    });
    return Number(result.changes) > 0;
}

function removeStreamerByRowIdWithCleanup(userId: number, rowId: number): { removed: boolean; removedClips: number } {
    const row = db.prepare(`
        SELECT twitch_broadcaster_id, twitch_login, display_name
        FROM user_streamers
        WHERE id = $id AND user_id = $user_id
        LIMIT 1
    `).get({ $id: rowId, $user_id: userId }) as { twitch_broadcaster_id: string; twitch_login: string | null; display_name: string | null } | undefined;

    if (!row) return { removed: false, removedClips: 0 };

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
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

function ensureLegacySeedUser(): void {
    const countRow = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    if (Number(countRow?.n || 0) > 0) return;

    const userId = createUser(LEGACY_SITE_USERNAME, LEGACY_SITE_PASSWORD);

    for (const streamerId of LEGACY_STREAMER_IDS) {
        addStreamerToUser(userId, { id: streamerId });
    }

    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
        const rows = db.prepare('SELECT * FROM clips').all() as DbClipRow[];
        const migrate = db.prepare(`
            INSERT INTO user_clip_state (
                user_id, clip_id, approved, sorted_out,
                cam_x, cam_y, cam_w, cam_h, cam_enabled, twitch_name_enabled,
                twitch_name_x, twitch_name_y, twitch_name_text, twitch_name_scale,
                gameplay_x, gameplay_y, gameplay_w, gameplay_h,
                third_x, third_y, third_w, third_h,
                cam_output_y, cam_output_h,
                gameplay_output_y, gameplay_output_h,
                third_area_enabled, third_output_x, third_output_y, third_output_w, third_output_h,
                split_points_json, split_deleted_segments_json, split_zoom_segments_json, split_zoom_layouts_json,
                fetched_at
            ) VALUES (
                $user_id, $clip_id, $approved, $sorted_out,
                $cam_x, $cam_y, $cam_w, $cam_h, $cam_enabled, $twitch_name_enabled,
                $twitch_name_x, $twitch_name_y, $twitch_name_text, $twitch_name_scale,
                $gameplay_x, $gameplay_y, $gameplay_w, $gameplay_h,
                $third_x, $third_y, $third_w, $third_h,
                $cam_output_y, $cam_output_h,
                $gameplay_output_y, $gameplay_output_h,
                $third_area_enabled, $third_output_x, $third_output_y, $third_output_w, $third_output_h,
                $split_points_json, $split_deleted_segments_json, $split_zoom_segments_json, $split_zoom_layouts_json,
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
                $twitch_name_text: String(row.broadcaster_name || '').trim().slice(0, 64),
                $twitch_name_scale: 1,
                $gameplay_x: row.gameplay_x,
                $gameplay_y: row.gameplay_y,
                $gameplay_w: row.gameplay_w,
                $gameplay_h: row.gameplay_h,
                $third_x: null,
                $third_y: null,
                $third_w: null,
                $third_h: null,
                $cam_output_y: row.cam_output_y,
                $cam_output_h: row.cam_output_h,
                $gameplay_output_y: row.gameplay_output_y,
                $gameplay_output_h: row.gameplay_output_h,
                $third_area_enabled: 0,
                $third_output_x: null,
                $third_output_y: null,
                $third_output_w: null,
                $third_output_h: null,
                $split_points_json: null,
                $split_deleted_segments_json: null,
                $split_zoom_segments_json: null,
                $split_zoom_layouts_json: null,
                $fetched_at: row.fetched_at || now,
            });
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

// Migrate approved.json → DB if it still exists
if (fs.existsSync(APPROVED_FILE)) {
    const ids: string[] = JSON.parse(fs.readFileSync(APPROVED_FILE, 'utf-8'));
    db.exec('BEGIN');
    const migrateStmt = db.prepare('UPDATE clips SET approved = 1 WHERE id = $id');
    for (const id of ids) migrateStmt.run({ $id: id });
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

function upsertClips(clips: Clip[]): void {
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
        for (const c of clips) {
            upsertStmt.run({
                $id:               c.id,
                $url:              c.url,
                $title:            c.title,
                $view_count:       c.view_count,
                $created_at:       c.created_at,
                $thumbnail_url:    c.thumbnail_url,
                $broadcaster_name: c.broadcaster_name,
                $fetched_at:       now,
            });
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

function linkClipsToUser(userId: number, clips: Clip[]): void {
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
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

function getAllClips(userId: number): (Clip & {
    approved: boolean;
    sorted_out: boolean;
    fetched_at: string;
    clip_tags: string[];
    uploaded_to_tiktok: boolean;
    uploaded_at: string | null;
})[] {
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
            s.twitch_name_text,
            s.twitch_name_scale,
            s.gameplay_x,
            s.gameplay_y,
            s.gameplay_w,
            s.gameplay_h,
            s.third_x,
            s.third_y,
            s.third_w,
            s.third_h,
            s.cam_output_y,
            s.cam_output_h,
            s.gameplay_output_y,
            s.gameplay_output_h,
            s.third_area_enabled,
            s.third_output_x,
            s.third_output_y,
            s.third_output_w,
            s.third_output_h,
            s.split_points_json,
            s.split_deleted_segments_json,
            s.split_zoom_segments_json,
            s.split_zoom_layouts_json,
            s.overlay_items_json,
            s.overlay_enabled,
            s.overlay_media_mime,
            s.overlay_start_sec,
            s.overlay_end_sec,
            s.overlay_x,
            s.overlay_y,
            s.overlay_w,
            s.overlay_h,
            s.clip_tags_json,
            s.uploaded_to_tiktok,
            s.uploaded_at
        FROM user_clip_state s
        JOIN clips c ON c.id = s.clip_id
        WHERE s.user_id = $user_id
        ORDER BY c.broadcaster_name COLLATE NOCASE ASC, c.view_count DESC
    `).all({ $user_id: userId }) as DbClipRow[];
    const allowedStreamerNames = listUserStreamerNameKeys(userId);
    const mapped = rows.map(r => {
        const overlayItems = getOverlayItemsForClipRow(r).map((item) => ({
            id: item.id,
            enabled: item.enabled ? 1 : 0,
            media_ref: item.mediaRef,
            label: item.label,
            media_mime: item.mediaMime,
            media_url: buildOverlayMediaUrlByRef(r.id, item.mediaRef, false),
            start_sec: item.startSec,
            end_sec: item.endSec,
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
        }));
        return {
            ...r,
            approved: r.approved === 1,
            sorted_out: r.sorted_out === 1,
            overlay_items: overlayItems,
            clip_tags: parseClipTagsJson(r.clip_tags_json),
            uploaded_to_tiktok: r.uploaded_to_tiktok === 1,
            uploaded_at: typeof r.uploaded_at === 'string' && r.uploaded_at ? r.uploaded_at : null,
        };
    });
    if (allowedStreamerNames.size === 0) return [];

    return mapped.filter(row => {
        const key = String(row.broadcaster_name || '').trim().toLowerCase();
        return allowedStreamerNames.has(key);
    });
}

function validateEnvironment(): void {
    if (!clientID || !clientSecret) {
        console.warn('⚠️  Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in .env; refresh endpoint requires both.');
    }
    if (LEGACY_SITE_USERNAME === 'admin' || LEGACY_SITE_PASSWORD === 'admin') {
        console.warn('⚠️  SITE_USERNAME/SITE_PASSWORD still use defaults. Register a new account and remove defaults in .env.');
    }
    if (IS_PRODUCTION && SESSION_SECRET === 'twitch-clips-secret-2026') {
        throw new Error('SESSION_SECRET must be set in production.');
    }
    if (!isEmailDeliveryConfigured()) {
        console.warn('⚠️  Email verification requires RESEND_API_KEY and MAIL_FROM. Registration is disabled until configured.');
    }
    if (MAIL_FROM && !isValidEmail(MAIL_FROM)) {
        console.warn('⚠️  MAIL_FROM does not look like a valid email address.');
    }
    if (!APP_BASE_URL) {
        console.warn('⚠️  APP_BASE_URL is not set. Email links will default to localhost URLs.');
    }
    if (APP_BASE_URL && !/^https?:\/\//i.test(APP_BASE_URL)) {
        console.warn('⚠️  APP_BASE_URL should start with http:// or https://');
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toJobSnapshot(job: UploadJobState): UploadJobSnapshot {
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

function parseUploadLimit(limitRaw: number | string | undefined): number {
    return Math.max(1, Math.min(100, Number(limitRaw) || 25));
}

function markClipUploadedForUser(userId: number, clipId: string): void {
    db.prepare(`
        UPDATE user_clip_state
        SET uploaded_to_tiktok = 1,
            uploaded_at = $uploaded_at
        WHERE user_id = $user_id AND clip_id = $clip_id
    `).run({
        $uploaded_at: new Date().toISOString(),
        $user_id: userId,
        $clip_id: clipId,
    });
}

function getApprovedClips(userId: number, limit: number): DbClipRow[] {
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
            s.twitch_name_text,
            s.twitch_name_scale,
            s.gameplay_x,
            s.gameplay_y,
            s.gameplay_w,
            s.gameplay_h,
            s.third_x,
            s.third_y,
            s.third_w,
            s.third_h,
            s.cam_output_y,
            s.cam_output_h,
            s.gameplay_output_y,
            s.gameplay_output_h,
            s.third_area_enabled,
            s.third_output_x,
            s.third_output_y,
            s.third_output_w,
            s.third_output_h,
            s.split_points_json,
            s.split_deleted_segments_json,
            s.split_zoom_segments_json,
            s.split_zoom_layouts_json,
            s.overlay_items_json,
            s.overlay_enabled,
            s.overlay_media_path,
            s.overlay_media_mime,
            s.overlay_start_sec,
            s.overlay_end_sec,
            s.overlay_x,
            s.overlay_y,
            s.overlay_w,
            s.overlay_h
        FROM user_clip_state s
        JOIN clips c ON c.id = s.clip_id
        WHERE s.user_id = $user_id AND s.approved = 1 AND s.sorted_out = 0
        ORDER BY c.created_at DESC
        LIMIT $limit
    `).all({ $user_id: userId, $limit: limit }) as DbClipRow[];

    const allowedStreamerNames = listUserStreamerNameKeys(userId);
    if (allowedStreamerNames.size === 0) return [];

    return rows.filter(row => {
        const key = String(row.broadcaster_name || '').trim().toLowerCase();
        return allowedStreamerNames.has(key);
    });
}

async function runUploadJob(job: UploadJobState): Promise<void> {
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

            const result = await uploadSingleClipToTikTok(job.userId, clip, job.uploadMode, job.dryRun);
            job.results.push(result);
            job.processed += 1;
            if (result.status === 'uploaded') {
                job.uploaded += 1;
                if (!job.dryRun) {
                    markClipUploadedForUser(job.userId, clip.id);
                }
            } else {
                job.failed += 1;
            }
            job.updatedAt = new Date().toISOString();
        }

        if (!job.cancelRequested && job.status !== 'failed') {
            job.status = 'completed';
        }
    } catch (err) {
        job.status = 'failed';
        job.results.push({
            clipId: '',
            title: 'job-error',
            status: 'failed',
            details: err instanceof Error ? err.message : 'Upload job failed unexpectedly',
        });
    } finally {
        job.currentClipId = undefined;
        job.currentTitle = undefined;
        job.updatedAt = new Date().toISOString();
        const activeJobId = activeUploadJobByUser.get(job.userId);
        if (activeJobId === job.jobId) activeUploadJobByUser.delete(job.userId);
    }
}

async function startUploadJob(userId: number, limit: number, dryRun: boolean): Promise<UploadJobState> {
    const activeUploadJobId = activeUploadJobByUser.get(userId);
    if (activeUploadJobId) {
        const current = uploadJobs.get(activeUploadJobId);
        if (current && (current.status === 'running' || current.status === 'paused')) {
            throw new Error(`Upload job already active (${current.jobId}).`);
        }
        activeUploadJobByUser.delete(userId);
    }

    const approved = getApprovedClips(userId, limit);
    const uploadMode = getTikTokUploadModeForUser(userId);
    if (approved.length > 0) {
        await ensureTikTokUploadReady(userId, uploadMode);
    }
    const now = new Date().toISOString();
    const job: UploadJobState = {
        jobId: randomUUID(),
        userId,
        status: approved.length > 0 ? 'running' : 'completed',
        dryRun,
        uploadMode,
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

function isValidCropNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizeOverlayMime(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return null;
    return Object.prototype.hasOwnProperty.call(OVERLAY_MIME_TO_EXTENSION, normalized) ? normalized : null;
}

function extensionForOverlayMime(mime: string | null | undefined): string | null {
    const normalized = normalizeOverlayMime(mime);
    if (!normalized) return null;
    return OVERLAY_MIME_TO_EXTENSION[normalized] || null;
}

function resolveSafeOverlayMediaPath(rawPath: string | null | undefined): string | null {
    const candidate = String(rawPath || '').trim();
    if (!candidate) return null;
    const resolved = path.resolve(candidate);
    const root = path.resolve(OVERLAY_MEDIA_DIR);
    if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
        return null;
    }
    return resolved;
}

function buildOverlayMediaUrl(clipId: string, cacheBuster = true): string {
    const base = `/api/crop/${encodeURIComponent(String(clipId || ''))}/overlay-media`;
    if (!cacheBuster) return base;
    return `${base}?v=${Date.now()}`;
}

function buildOverlayMediaUrlByRef(clipId: string, mediaRef: string, cacheBuster = true): string {
    const safeRef = String(mediaRef || '').trim();
    const base = `/api/crop/${encodeURIComponent(String(clipId || ''))}/overlay-media/${encodeURIComponent(safeRef)}`;
    if (!cacheBuster) return base;
    return `${base}?v=${Date.now()}`;
}

function sanitizeOverlayMediaRef(raw: unknown): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (!/^[a-zA-Z0-9._-]{1,180}$/.test(value)) return null;
    return value;
}

function resolveOverlayPathFromRef(rawRef: unknown): string | null {
    const mediaRef = sanitizeOverlayMediaRef(rawRef);
    if (!mediaRef) return null;
    const candidate = path.resolve(path.join(OVERLAY_MEDIA_DIR, mediaRef));
    const root = path.resolve(OVERLAY_MEDIA_DIR);
    if (!(candidate === root || candidate.startsWith(`${root}${path.sep}`))) {
        return null;
    }
    return candidate;
}

function inferOverlayMimeFromRef(mediaRef: string): string | null {
    const clean = String(mediaRef || '').trim().toLowerCase();
    const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1) : '';
    if (!ext) return null;
    return OVERLAY_EXTENSION_TO_MIME[ext] || null;
}

function sanitizeOverlayLabel(raw: unknown, fallback = ''): string {
    const chosen = String(raw || fallback || '').trim();
    if (!chosen) return '';
    const basename = chosen.replace(/\\/g, '/').split('/').pop() || chosen;
    return basename
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function normalizeOverlayItems(raw: unknown, maxItems = 24): OverlayItemConfig[] {
    const source = Array.isArray(raw) ? raw : [];
    const out: OverlayItemConfig[] = [];
    const seenIds = new Set<string>();
    const maxCount = Math.max(1, Math.min(60, Number(maxItems) || 24));

    for (let i = 0; i < source.length && out.length < maxCount; i += 1) {
        const itemRaw = source[i];
        if (!itemRaw || typeof itemRaw !== 'object' || Array.isArray(itemRaw)) continue;
        const item = itemRaw as Record<string, unknown>;
        const mediaRef = sanitizeOverlayMediaRef(item.media_ref ?? item.mediaRef);
        if (!mediaRef) continue;
        const label = sanitizeOverlayLabel(item.label ?? item.file_name, mediaRef);
        const mediaMime = normalizeOverlayMime(item.media_mime ?? item.mediaMime) || inferOverlayMimeFromRef(mediaRef);
        if (!mediaMime) continue;

        const startRaw = Number(item.start_sec ?? item.startSec ?? 0);
        const endRaw = Number(item.end_sec ?? item.endSec ?? (startRaw + 4));
        const startSec = Math.max(0, Math.min(600, Number.isFinite(startRaw) ? startRaw : 0));
        const endSec = Math.max(startSec + 0.05, Math.min(600, Number.isFinite(endRaw) ? endRaw : (startSec + 4)));

        const xRaw = Number(item.x ?? 0.06);
        const yRaw = Number(item.y ?? 0.06);
        const wRaw = Number(item.w ?? 0.34);
        const hRaw = Number(item.h ?? 0.24);
        if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw) || !Number.isFinite(wRaw) || !Number.isFinite(hRaw)) continue;
        const w = Math.max(0.05, Math.min(1, wRaw));
        const h = Math.max(0.05, Math.min(1, hRaw));
        const x = Math.max(0, Math.min(1 - w, xRaw));
        const y = Math.max(0, Math.min(1 - h, yRaw));

        const enabled = Number(item.enabled ?? 1) !== 0;
        const rawId = String(item.id || '').trim();
        const safeBaseId = /^[a-zA-Z0-9_-]{1,80}$/.test(rawId) ? rawId : `ov_${i + 1}`;
        let id = safeBaseId;
        let suffix = 2;
        while (seenIds.has(id)) {
            id = `${safeBaseId}_${suffix}`;
            suffix += 1;
        }
        seenIds.add(id);

        out.push({
            id,
            enabled,
            mediaRef,
            label,
            mediaMime,
            startSec,
            endSec,
            x,
            y,
            w,
            h,
        });
    }

    return out;
}

function parseOverlayItemsJson(raw: string | null | undefined): OverlayItemConfig[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return normalizeOverlayItems(parsed);
    } catch {
        return [];
    }
}

function buildLegacyOverlayItemsFromRow(row: DbClipRow): OverlayItemConfig[] {
    const enabled = Number(row.overlay_enabled || 0) === 1;
    if (!enabled) return [];
    const mediaPath = resolveSafeOverlayMediaPath(row.overlay_media_path);
    if (!mediaPath || !fs.existsSync(mediaPath)) return [];
    const mediaRef = sanitizeOverlayMediaRef(path.basename(mediaPath));
    if (!mediaRef) return [];
    const mediaMime = normalizeOverlayMime(row.overlay_media_mime) || inferOverlayMimeFromRef(mediaRef);
    if (!mediaMime) return [];
    return normalizeOverlayItems([{
        id: 'ov_legacy_1',
        enabled: 1,
        media_ref: mediaRef,
        label: sanitizeOverlayLabel(mediaRef),
        media_mime: mediaMime,
        start_sec: Number(row.overlay_start_sec ?? 0),
        end_sec: Number(row.overlay_end_sec ?? 4),
        x: Number(row.overlay_x ?? 0.06),
        y: Number(row.overlay_y ?? 0.06),
        w: Number(row.overlay_w ?? 0.34),
        h: Number(row.overlay_h ?? 0.24),
    }], 1);
}

function getOverlayItemsForClipRow(row: DbClipRow): OverlayItemConfig[] {
    const fromJson = parseOverlayItemsJson(row.overlay_items_json);
    if (fromJson.length > 0) return fromJson;
    return buildLegacyOverlayItemsFromRow(row);
}

function parseOverlayDataUrl(raw: unknown): { mime: string; buffer: Buffer } | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
    if (!match) return null;
    const mime = normalizeOverlayMime(match[1]);
    if (!mime) return null;
    try {
        const payload = match[2].replace(/\s+/g, '');
        const buffer = Buffer.from(payload, 'base64');
        if (!buffer || buffer.length === 0 || buffer.length > OVERLAY_MEDIA_MAX_BYTES) return null;
        return { mime, buffer };
    } catch {
        return null;
    }
}

function getReferencedOverlayMediaRefs(): Set<string> {
    const refs = new Set<string>();
    const rows = db.prepare(`
        SELECT overlay_items_json, overlay_enabled, overlay_media_path
        FROM user_clip_state
    `).all() as Array<{ overlay_items_json?: string | null; overlay_enabled?: number | null; overlay_media_path?: string | null }>;

    rows.forEach((row) => {
        parseOverlayItemsJson(row.overlay_items_json).forEach((item) => {
            if (item.mediaRef) refs.add(item.mediaRef);
        });
        if (Number(row.overlay_enabled || 0) === 1) {
            const legacyPath = resolveSafeOverlayMediaPath(row.overlay_media_path);
            if (!legacyPath) return;
            const legacyRef = sanitizeOverlayMediaRef(path.basename(legacyPath));
            if (legacyRef) refs.add(legacyRef);
        }
    });

    return refs;
}

async function pruneOverlayMediaFiles(): Promise<{ removed: number; keptReferenced: number; keptFresh: number; errors: number }> {
    if (overlayCleanupInFlight) {
        return { removed: 0, keptReferenced: 0, keptFresh: 0, errors: 0 };
    }
    overlayCleanupInFlight = true;
    let removed = 0;
    let keptReferenced = 0;
    let keptFresh = 0;
    let errors = 0;

    try {
        await fs.promises.mkdir(OVERLAY_MEDIA_DIR, { recursive: true });
        const referencedRefs = getReferencedOverlayMediaRefs();
        const entries = await fs.promises.readdir(OVERLAY_MEDIA_DIR, { withFileTypes: true });
        const cutoffMs = Date.now() - (OVERLAY_MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000);

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const mediaRef = sanitizeOverlayMediaRef(entry.name);
            if (!mediaRef) continue;
            if (!inferOverlayMimeFromRef(mediaRef)) continue;
            if (referencedRefs.has(mediaRef)) {
                keptReferenced += 1;
                continue;
            }
            const filePath = resolveOverlayPathFromRef(mediaRef);
            if (!filePath) continue;
            try {
                const stat = await fs.promises.stat(filePath);
                if (!stat.isFile()) continue;
                if (stat.mtimeMs > cutoffMs) {
                    keptFresh += 1;
                    continue;
                }
                await fs.promises.rm(filePath, { force: true });
                removed += 1;
            } catch {
                errors += 1;
            }
        }
    } finally {
        overlayCleanupInFlight = false;
    }

    if (removed > 0 || errors > 0) {
        console.log(`[cleanup] overlay-media: removed=${removed}, kept_referenced=${keptReferenced}, kept_fresh=${keptFresh}, errors=${errors}`);
    }
    return { removed, keptReferenced, keptFresh, errors };
}

function scheduleOverlayMediaCleanup(): void {
    const run = (): void => {
        void pruneOverlayMediaFiles().catch((err) => {
            console.warn('[cleanup] overlay-media prune failed:', err instanceof Error ? err.message : err);
        });
    };
    run();
    const intervalMs = OVERLAY_MEDIA_CLEANUP_INTERVAL_MINUTES * 60 * 1000;
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
}

function buildClipVideoCandidates(thumbnailUrl: string): string[] {
    const raw = String(thumbnailUrl || '').trim();
    if (!raw) return [];

    const noQuery = raw.split('?')[0];
    const candidates = new Set<string>();
    const pushIfMp4 = (candidate: string): void => {
        if (!/^https?:\/\//i.test(candidate)) return;
        if (!/\.mp4(?:$|\?)/i.test(candidate)) return;
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

function getCropOrDefault(clip: DbClipRow): {
    cam: { x: number; y: number; w: number; h: number };
    gameplay: { x: number; y: number; w: number; h: number };
    third: { x: number; y: number; w: number; h: number };
    camEnabled: boolean;
    camOutput: { y: number; h: number };
    gameplayOutput: { y: number; h: number };
    thirdOutput: { enabled: boolean; x: number; y: number; w: number; h: number };
    twitchName: { enabled: boolean; x: number; y: number; text: string; scale: number };
    overlay: { items: Array<{ id: string; mediaPath: string; mediaMime: string; startSec: number; endSec: number; x: number; y: number; w: number; h: number }> };
    split: { points: number[]; deletedSegments: number[]; zoomSegments: number[]; zoomLayouts: Record<string, { x: number; y: number; w: number; h: number }> };
} {
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const asNum = (v: number | null | undefined, fallback: number) => Number.isFinite(v as number) ? Number(v) : fallback;

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
    const third = {
        x: clamp(asNum(clip.third_x, cam.x)),
        y: clamp(asNum(clip.third_y, cam.y)),
        w: Math.max(0.01, clamp(asNum(clip.third_w, cam.w))),
        h: Math.max(0.01, clamp(asNum(clip.third_h, cam.h))),
    };
    third.x = Math.min(third.x, 1 - third.w);
    third.y = Math.min(third.y, 1 - third.h);

    const camEnabled = clip.cam_enabled !== 0;
    const camOutputH = Math.max(0.05, Math.min(0.95, asNum(clip.cam_output_h, 0.30)));
    const camOutputY = Math.max(0, Math.min(1 - camOutputH, asNum(clip.cam_output_y, 0)));
    const camOutput = { y: camOutputY, h: camOutputH };
    const gameplayFallbackY = Math.max(0, Math.min(1, camOutput.y + camOutput.h));
    const gameplayFallbackH = Math.max(0.05, Math.min(0.95, 1 - gameplayFallbackY));
    const gameplayOutputH = Math.max(0.05, Math.min(0.95, asNum(clip.gameplay_output_h, gameplayFallbackH)));
    const gameplayOutputY = Math.max(0, Math.min(1 - gameplayOutputH, asNum(clip.gameplay_output_y, gameplayFallbackY)));
    const gameplayOutput = { y: gameplayOutputY, h: gameplayOutputH };
    const thirdOutputW = Math.max(0.06, Math.min(1, asNum(clip.third_output_w, 0.36)));
    const thirdOutputH = Math.max(0.06, Math.min(1, asNum(clip.third_output_h, 0.30)));
    const thirdOutputX = Math.max(0, Math.min(1 - thirdOutputW, asNum(clip.third_output_x, 0.58)));
    const thirdOutputY = Math.max(0, Math.min(1 - thirdOutputH, asNum(clip.third_output_y, 0.56)));
    const thirdOutput = {
        enabled: clip.third_area_enabled === 1,
        x: thirdOutputX,
        y: thirdOutputY,
        w: thirdOutputW,
        h: thirdOutputH,
    };
    const twitchNameText = String(clip.twitch_name_text || clip.broadcaster_name || '').trim().slice(0, 64);
    const twitchNameScale = Math.max(0.65, Math.min(2.4, asNum(clip.twitch_name_scale, 1)));
    const twitchName = {
        enabled: clip.twitch_name_enabled === 1 && twitchNameText.length > 0,
        x: clamp(asNum(clip.twitch_name_x, 0.04)),
        y: clamp(asNum(clip.twitch_name_y, 0.04)),
        text: twitchNameText,
        scale: twitchNameScale,
    };
    const overlayItems = getOverlayItemsForClipRow(clip)
        .filter(item => item.enabled)
        .map((item) => {
            const mediaPath = resolveOverlayPathFromRef(item.mediaRef);
            if (!mediaPath || !fs.existsSync(mediaPath)) return null;
            return {
                id: item.id,
                mediaPath,
                mediaMime: item.mediaMime,
                startSec: item.startSec,
                endSec: item.endSec,
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
            };
        })
        .filter((item): item is { id: string; mediaPath: string; mediaMime: string; startSec: number; endSec: number; x: number; y: number; w: number; h: number } => !!item);
    const overlay = { items: overlayItems };

    const split = {
        points: normalizeSplitPoints(parseJsonNumberArray(clip.split_points_json), null),
        deletedSegments: normalizeSplitDeletedSegments(parseJsonIntArray(clip.split_deleted_segments_json), null),
        zoomSegments: normalizeSplitDeletedSegments(parseJsonIntArray(clip.split_zoom_segments_json), null),
        zoomLayouts: normalizeSplitZoomLayouts(parseJsonZoomLayoutMap(clip.split_zoom_layouts_json), null),
    };

    return { cam, gameplay, third, camEnabled, camOutput, gameplayOutput, thirdOutput, twitchName, overlay, split };
}

function parseJsonNumberArray(raw: string | null | undefined): number[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(v => Number(v)).filter(v => Number.isFinite(v));
    } catch {
        return [];
    }
}

function parseJsonIntArray(raw: string | null | undefined): number[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(v => Number(v)).filter(v => Number.isInteger(v));
    } catch {
        return [];
    }
}

function normalizeClipTags(raw: unknown): string[] {
    const source = Array.isArray(raw) ? raw : [];
    const allowed = new Set(CLIP_TAG_OPTIONS);
    const out: string[] = [];
    for (const item of source) {
        const tag = String(item || '').trim().toLowerCase();
        if (!tag || !allowed.has(tag as (typeof CLIP_TAG_OPTIONS)[number])) continue;
        if (out.includes(tag)) continue;
        out.push(tag);
    }
    return out.slice(0, CLIP_TAG_OPTIONS.length);
}

function parseClipTagsJson(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return normalizeClipTags(parsed);
    } catch {
        return [];
    }
}

function normalizeSplitZoomLayouts(
    rawLayouts: Record<string, unknown> | null | undefined,
    segmentCount: number | null
): Record<string, { x: number; y: number; w: number; h: number }> {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    const maxIndex = Number.isInteger(segmentCount) && segmentCount !== null ? Math.max(-1, segmentCount - 1) : null;
    const clampDim = (value: unknown, fallback: number) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0.25, Math.min(2.5, n));
    };
    const clampPos = (value: unknown, size: number, fallback: number) => {
        const n = Number(value);
        const zoomSize = Math.max(0.25, Math.min(2.5, size));
        const minPos = zoomSize > 1 ? (1 - zoomSize) : 0;
        const maxPos = zoomSize > 1 ? 0 : (1 - zoomSize);
        if (!Number.isFinite(n)) return Math.max(minPos, Math.min(maxPos, fallback));
        return Math.max(minPos, Math.min(maxPos, n));
    };

    for (const [rawKey, rawValue] of Object.entries(rawLayouts || {})) {
        const idx = Number(rawKey);
        if (!Number.isInteger(idx) || idx < 0) continue;
        if (maxIndex !== null && idx > maxIndex) continue;
        if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) continue;
        const value = rawValue as Record<string, unknown>;
        const w = clampDim(value.w, 1);
        const h = clampDim(value.h, 1);
        const defaultX = Math.max(0, (1 - w) / 2);
        const defaultY = Math.max(0, (1 - h) / 2);
        const x = clampPos(value.x, w, defaultX);
        const y = clampPos(value.y, h, defaultY);
        if (Math.abs(w - 1) < 0.0001 && Math.abs(h - 1) < 0.0001 && Math.abs(x) < 0.0001 && Math.abs(y) < 0.0001) continue;
        out[String(idx)] = { x, y, w, h };
    }

    return out;
}

function parseJsonZoomLayoutMap(raw: string | null | undefined): Record<string, { x: number; y: number; w: number; h: number }> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return normalizeSplitZoomLayouts(parsed as Record<string, unknown>, null);
    } catch {
        return {};
    }
}

function normalizeSplitPoints(points: number[], durationLimit: number | null): number[] {
    const maxDuration = Number.isFinite(durationLimit as number) && Number(durationLimit) > 0
        ? Number(durationLimit)
        : Number.POSITIVE_INFINITY;
    const dedup = new Set<number>();
    for (const raw of points) {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        if (n <= 0.05) continue;
        if (n >= maxDuration - 0.05) continue;
        dedup.add(Math.round(n * 1000) / 1000);
    }
    return [...dedup].sort((a, b) => a - b).slice(0, 80);
}

function normalizeSplitDeletedSegments(indices: number[], maxSegments: number | null): number[] {
    const out = new Set<number>();
    const maxIndex = Number.isFinite(maxSegments as number) && Number(maxSegments) > 0
        ? Math.max(0, Number(maxSegments) - 1)
        : Number.POSITIVE_INFINITY;
    for (const raw of indices) {
        const idx = Number(raw);
        if (!Number.isInteger(idx) || idx < 0 || idx > maxIndex) continue;
        out.add(idx);
    }
    return [...out].sort((a, b) => a - b);
}

async function probeMediaDurationSeconds(inputPath: string): Promise<number | null> {
    try {
        const { stdout } = await runCommandCaptureOutput(FFPROBE_BIN, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputPath,
        ]);
        const d = Number(String(stdout || '').trim());
        return Number.isFinite(d) && d > 0 ? d : null;
    } catch {
        return null;
    }
}

async function hasAudioStream(inputPath: string): Promise<boolean> {
    try {
        const { stdout } = await runCommandCaptureOutput(FFPROBE_BIN, [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_type',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputPath,
        ]);
        return String(stdout || '').trim().length > 0;
    } catch {
        return false;
    }
}

function buildKeptSplitRanges(points: number[], deletedSegments: number[]): Array<{ start: number; end: number | null }> {
    const normalizedPoints = normalizeSplitPoints(points, null);
    const segmentCount = normalizedPoints.length + 1;
    const deleted = new Set(normalizeSplitDeletedSegments(deletedSegments, segmentCount));
    const kept: Array<{ start: number; end: number | null }> = [];

    for (let i = 0; i < segmentCount; i += 1) {
        if (deleted.has(i)) continue;
        const start = i === 0 ? 0 : normalizedPoints[i - 1];
        const end = i < normalizedPoints.length ? normalizedPoints[i] : null;
        if (end !== null && (end - start) < 0.08) continue;
        kept.push({ start, end });
    }

    return kept;
}

function buildOutputTimelineZoomRanges(points: number[], deletedSegments: number[], zoomSegments: number[]): Array<{ start: number; end: number | null }> {
    const normalizedPoints = normalizeSplitPoints(points, null);
    const segmentCount = normalizedPoints.length + 1;
    const deleted = new Set(normalizeSplitDeletedSegments(deletedSegments, segmentCount));
    const zoomed = new Set(normalizeSplitDeletedSegments(zoomSegments, segmentCount));
    const ranges: Array<{ start: number; end: number | null }> = [];

    let cursor = 0;
    for (let i = 0; i < segmentCount; i += 1) {
        const start = i === 0 ? 0 : normalizedPoints[i - 1];
        const end = i < normalizedPoints.length ? normalizedPoints[i] : null;
        const segDuration = end === null ? null : Math.max(0, end - start);

        if (!deleted.has(i) && zoomed.has(i)) {
            if (end === null) {
                ranges.push({ start: cursor, end: null });
            } else {
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

function buildOutputTimelineZoomLayoutGroups(
    points: number[],
    deletedSegments: number[],
    zoomSegments: number[],
    zoomLayouts: Record<string, { x: number; y: number; w: number; h: number }>
): Array<{ x: number; y: number; w: number; h: number; ranges: Array<{ start: number; end: number | null }> }> {
    const normalizedPoints = normalizeSplitPoints(points, null);
    const segmentCount = normalizedPoints.length + 1;
    const deleted = new Set(normalizeSplitDeletedSegments(deletedSegments, segmentCount));
    const zoomed = new Set(normalizeSplitDeletedSegments(zoomSegments, segmentCount));
    const normalizedLayouts = normalizeSplitZoomLayouts(zoomLayouts, segmentCount);
    const groups = new Map<string, { x: number; y: number; w: number; h: number; ranges: Array<{ start: number; end: number | null }> }>();

    let cursor = 0;
    for (let i = 0; i < segmentCount; i += 1) {
        const start = i === 0 ? 0 : normalizedPoints[i - 1];
        const end = i < normalizedPoints.length ? normalizedPoints[i] : null;
        const duration = end === null ? null : Math.max(0, end - start);

        if (!deleted.has(i) && zoomed.has(i)) {
            const layout = normalizedLayouts[String(i)] || { x: 0, y: 0, w: 1, h: 1 };
            const key = `${layout.x.toFixed(4)}:${layout.y.toFixed(4)}:${layout.w.toFixed(4)}:${layout.h.toFixed(4)}`;
            if (!groups.has(key)) groups.set(key, { x: layout.x, y: layout.y, w: layout.w, h: layout.h, ranges: [] });
            const group = groups.get(key)!;
            if (end === null) {
                group.ranges.push({ start: cursor, end: null });
            } else if (duration !== null && duration >= 0.04) {
                group.ranges.push({ start: cursor, end: cursor + duration });
            }
        }

        if (!deleted.has(i) && end !== null) {
            cursor += Math.max(0, end - start);
        }
    }

    return [...groups.values()];
}

function buildFfmpegEnableExprFromRanges(ranges: Array<{ start: number; end: number | null }>): string {
    const ts = (v: number) => Math.max(0, v).toFixed(3);
    const parts = ranges.map((range) => {
        if (range.end === null) {
            return `gte(t\\,${ts(range.start)})`;
        }
        const end = Math.max(range.start + 0.001, range.end);
        return `between(t\\,${ts(range.start)}\\,${ts(end)})`;
    });
    return parts.join('+');
}

function resolveTwitchLogoPath(): string | null {
    const candidates = [
        path.join(__dirname, 'public', TWITCH_LOGO_RELATIVE_PATH),
        path.join(process.cwd(), 'public', TWITCH_LOGO_RELATIVE_PATH),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function getPngAspectRatio(filePath: string): number | null {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const header = Buffer.alloc(24);
            const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
            if (bytesRead < 24) return null;

            const isPng = header.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            if (!isPng) return null;

            const width = header.readUInt32BE(16);
            const height = header.readUInt32BE(20);
            if (width <= 0 || height <= 0) return null;
            return width / height;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
}

function getLogoAspectRatio(filePath: string): number {
    const pngRatio = getPngAspectRatio(filePath);
    if (pngRatio && Number.isFinite(pngRatio) && pngRatio > 0) return pngRatio;
    return 1;
}

function escapeFfmpegDrawtext(value: string): string {
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

let cachedDrawtextFontPath: string | null | undefined;
let warnedInvalidDrawtextOverride = false;
let cachedDrawtextFilterSupported: boolean | undefined;
let drawtextFilterProbePromise: Promise<boolean> | null = null;
let warnedDrawtextUnavailable = false;

function resolveDrawtextFontPath(): string | null {
    if (cachedDrawtextFontPath !== undefined) return cachedDrawtextFontPath;

    const override = String(process.env.DRAWTEXT_FONT_PATH || '').trim();
    if (override) {
        if (fs.existsSync(override)) {
            cachedDrawtextFontPath = override;
            return cachedDrawtextFontPath;
        }
        if (!warnedInvalidDrawtextOverride) {
            warnedInvalidDrawtextOverride = true;
            console.warn(`[drawtext] DRAWTEXT_FONT_PATH does not exist: ${override}`);
        }
    }

    const candidates = [
        // Windows defaults
        'C:\\Windows\\Fonts\\segoeui.ttf',
        'C:\\Windows\\Fonts\\arial.ttf',
        // Common Linux fallbacks
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
        // macOS fallbacks
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        '/System/Library/Fonts/SFNS.ttf',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            cachedDrawtextFontPath = candidate;
            return cachedDrawtextFontPath;
        }
    }
    cachedDrawtextFontPath = null;
    return cachedDrawtextFontPath;
}

async function isDrawtextFilterSupported(): Promise<boolean> {
    if (cachedDrawtextFilterSupported !== undefined) return cachedDrawtextFilterSupported;
    if (drawtextFilterProbePromise) return drawtextFilterProbePromise;

    drawtextFilterProbePromise = (async () => {
        try {
            const { stdout, stderr } = await runCommandCaptureOutput(FFMPEG_BIN, ['-hide_banner', '-filters']);
            const output = `${stdout}\n${stderr}`.toLowerCase();
            return /\bdrawtext\b/.test(output);
        } catch {
            return false;
        }
    })();

    const supported = await drawtextFilterProbePromise;
    cachedDrawtextFilterSupported = supported;
    drawtextFilterProbePromise = null;
    return supported;
}

const BITMAP_FONT_5X7: Record<string, readonly string[]> = {
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'C': ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'G': ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'N': ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
    '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
    '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
    '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function buildBitmapNameFallbackFilters(
    inputLabel: string,
    text: string,
    x: number,
    y: number,
    pixelSize: number,
    maxWidthPx: number,
    enableExpr: string | null
): { filters: string[]; outLabel: string; rendered: boolean } {
    const raw = String(text || '').toUpperCase();
    if (!raw) return { filters: [], outLabel: inputLabel, rendered: false };

    const px = Math.max(1, Math.round(pixelSize));
    const glyphW = 5 * px;
    const glyphH = 7 * px;
    const charGap = px;
    const spaceW = 3 * px;
    if (glyphH <= 0 || maxWidthPx <= 0) return { filters: [], outLabel: inputLabel, rendered: false };

    const normalizedChars = Array.from(raw).map((char) => {
        if (char === ' ') return ' ';
        return BITMAP_FONT_5X7[char] ? char : '?';
    });

    const filters: string[] = [];
    const enableOpt = enableExpr ? `:enable='${enableExpr}'` : '';
    let currentLabel = inputLabel;
    let labelCounter = 0;
    let cursorX = x;
    let rendered = false;

    for (const char of normalizedChars) {
        const charAdvance = char === ' ' ? (spaceW + charGap) : (glyphW + charGap);
        if ((cursorX - x + charAdvance) > maxWidthPx) break;
        if (char === ' ') {
            cursorX += charAdvance;
            continue;
        }

        const glyph = BITMAP_FONT_5X7[char] || BITMAP_FONT_5X7['?'];
        for (let row = 0; row < glyph.length; row += 1) {
            const pattern = glyph[row] || '00000';
            let col = 0;
            while (col < pattern.length) {
                while (col < pattern.length && pattern[col] !== '1') col += 1;
                if (col >= pattern.length) break;
                const segStart = col;
                while (col < pattern.length && pattern[col] === '1') col += 1;
                const segLen = col - segStart;
                if (segLen <= 0) continue;

                const boxX = cursorX + (segStart * px);
                const boxY = y + (row * px);
                const boxW = segLen * px;
                const nextLabel = `name_bitmap_${labelCounter}`;
                labelCounter += 1;
                filters.push(`[${currentLabel}]drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${px}:color=white@0.96:t=fill${enableOpt}[${nextLabel}]`);
                currentLabel = nextLabel;
                rendered = true;
            }
        }

        cursorX += charAdvance;
    }

    return { filters, outLabel: currentLabel, rendered };
}

function toFfmpegFilterPath(filePath: string): string {
    return String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'");
}

async function isVideoUrlReachable(url: string): Promise<boolean> {
    try {
        const probe = await axios.get(url, {
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

        if (contentType.startsWith('video/')) return true;
        // Some Twitch CDN responses use generic binary content types for valid MP4 streams.
        const genericBinary = contentType.includes('application/octet-stream') || contentType.includes('binary/octet-stream');
        const isMp4LikeUrl = /\.mp4(?:$|\?)/i.test(url);
        if (genericBinary && isMp4LikeUrl) return true;
        return false;
    } catch {
        return false;
    }
}

async function extractMp4CandidatesFromClipPage(clipPageUrl: string): Promise<string[]> {
    try {
        const page = await axios.get<string>(clipPageUrl, {
            timeout: 15000,
            responseType: 'text',
            validateStatus: (status) => status >= 200 && status < 400,
        });

        const html = String(page.data || '')
            .replace(/\\u002F/g, '/')
            .replace(/\\\//g, '/');

        const matches = html.match(/https:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi) || [];
        return [...new Set(matches.map(m => m.replace(/&amp;/g, '&')) )];
    } catch {
        return [];
    }
}

function extractClipSlugFromUrl(rawUrl: string): string | null {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        const parts = parsed.pathname.split('/').filter(Boolean);
        let slug = '';

        if (parsed.hostname.toLowerCase().includes('clips.twitch.tv')) {
            slug = parts[0] || '';
        } else {
            const clipIndex = parts.findIndex((part) => part.toLowerCase() === 'clip');
            if (clipIndex >= 0) slug = parts[clipIndex + 1] || '';
        }

        slug = slug.split('?')[0].split('#')[0];
        if (!/^[A-Za-z0-9_-]+$/.test(slug)) return null;
        return slug;
    } catch {
        return null;
    }
}

function getCachedClipVideoUrl(slug: string): string | null {
    const hit = clipVideoUrlCache.get(slug);
    if (!hit) return null;
    if (Date.now() >= hit.expiresAt) {
        clipVideoUrlCache.delete(slug);
        return null;
    }
    return hit.url;
}

function setCachedClipVideoUrl(slug: string, url: string): void {
    clipVideoUrlCache.set(slug, {
        url,
        expiresAt: Date.now() + CLIP_GQL_CACHE_TTL_MS,
    });
}

function buildTwitchClipGqlPayload(slug: string): unknown[] {
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

async function resolveClipVideoViaGql(clipUrl: string): Promise<string | null> {
    const slug = extractClipSlugFromUrl(clipUrl);
    if (!slug) return null;

    const cached = getCachedClipVideoUrl(slug);
    if (cached) return cached;

    if (!clientID || !clientSecret) return null;

    try {
        const accessToken = await getTwitchAccessToken();
        const response = await axios.post(TWITCH_GQL_URL, buildTwitchClipGqlPayload(slug), {
            headers: {
                'Client-Id': clientID,
                Authorization: `Bearer ${accessToken}`,
            },
            timeout: 15000,
            validateStatus: (status) => status >= 200 && status < 300,
        });

        const gqlRows = Array.isArray(response.data) ? response.data : [];
        const clipRows = gqlRows
            .map((entry: any) => entry?.data?.clip)
            .filter(Boolean) as Array<{
                videoQualities?: Array<{ sourceURL?: string }>;
                playbackAccessToken?: { signature?: string; value?: string };
            }>;

        const baseUrl = clipRows.find((row) => String(row?.videoQualities?.[0]?.sourceURL || '').length > 0)?.videoQualities?.[0]?.sourceURL;
        const tokenRow = clipRows.find((row) => row?.playbackAccessToken?.signature && row?.playbackAccessToken?.value);
        const signature = tokenRow?.playbackAccessToken?.signature;
        const token = tokenRow?.playbackAccessToken?.value;

        if (!baseUrl || !signature || !token) return null;

        const resolved = `${baseUrl}?${new URLSearchParams({ sig: signature, token }).toString()}`;
        setCachedClipVideoUrl(slug, resolved);
        return resolved;
    } catch {
        return null;
    }
}

async function resolveClipVideoUrl(clip: DbClipRow, forceFresh = false): Promise<string | null> {
    const thumbCandidates = buildClipVideoCandidates(clip.thumbnail_url);
    for (const candidate of thumbCandidates) {
        if (await isVideoUrlReachable(candidate)) return candidate;
    }

    const pageCandidates = await extractMp4CandidatesFromClipPage(clip.url);
    for (const candidate of pageCandidates) {
        if (await isVideoUrlReachable(candidate)) return candidate;
    }

    if (forceFresh) {
        const slug = extractClipSlugFromUrl(clip.url);
        if (slug) clipVideoUrlCache.delete(slug);
    }

    const gqlCandidate = await resolveClipVideoViaGql(clip.url);
    if (gqlCandidate && await isVideoUrlReachable(gqlCandidate)) return gqlCandidate;

    return null;
}

function previewFallbackPath(clipId: string): string {
    return path.join(VIDEO_WORK_DIR, `${clipId}.preview.mp4`);
}

async function ensurePreviewFallbackFile(clip: DbClipRow): Promise<string> {
    await fs.promises.mkdir(VIDEO_WORK_DIR, { recursive: true });
    const outPath = previewFallbackPath(clip.id);
    if (await fileExistsAndNonEmpty(outPath)) return outPath;

    const inFlight = previewBuildJobs.get(clip.id);
    if (inFlight) return inFlight;

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
    } finally {
        previewBuildJobs.delete(clip.id);
    }
}

async function streamLocalVideoWithRange(req: Request, res: Response, filePath: string): Promise<void> {
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

        if (startRaw !== '') start = Number(startRaw);
        if (endRaw !== '') end = Number(endRaw);

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
        } else if (endRaw === '') {
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
    } else {
        res.status(200);
    }
    res.setHeader('Content-Length', chunkSize);

    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', reject);
        res.on('close', resolve);
        res.on('finish', resolve);
        stream.pipe(res);
    });
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
    const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 60000,
        validateStatus: (status) => status >= 200 && status < 400,
    });
    await pipeline(response.data, fs.createWriteStream(destinationPath));
}

async function fileExistsAndNonEmpty(filePath: string): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(filePath);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

function runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

function runCommandCaptureOutput(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function withRenderSlot<T>(job: () => Promise<T>): Promise<T> {
    if (activeRenderCount >= MAX_CONCURRENT_RENDERS) {
        await new Promise<void>((resolve) => {
            pendingRenderResolvers.push(resolve);
        });
    }
    activeRenderCount += 1;
    try {
        return await job();
    } finally {
        activeRenderCount = Math.max(0, activeRenderCount - 1);
        while (activeRenderCount < MAX_CONCURRENT_RENDERS && pendingRenderResolvers.length > 0) {
            const next = pendingRenderResolvers.shift();
            if (!next) break;
            next();
        }
    }
}

async function processClipToTikTokFormat(
    inputPath: string,
    outputPath: string,
    clip: DbClipRow,
    videoPreset = DEFAULT_UPLOAD_VIDEO_PRESET,
    videoCrf = DEFAULT_UPLOAD_VIDEO_CRF
): Promise<void> {
    const { cam, gameplay, third, camEnabled, camOutput, gameplayOutput, thirdOutput, twitchName, overlay, split } = getCropOrDefault(clip);
    const n = (v: number) => v.toFixed(6);
    const ts = (v: number) => Math.max(0, v).toFixed(3);
    const outputW = 1080;
    const outputH = 1920;
    const camOutputHeightPx = Math.max(2, Math.round(1920 * camOutput.h));
    const camOutputYPx = Math.max(0, Math.round(1920 * camOutput.y));
    const gameplayOutputHeightPx = Math.max(2, Math.round(1920 * gameplayOutput.h));
    const gameplayOutputYPx = Math.max(0, Math.round(1920 * gameplayOutput.y));
    const thirdOutputWPx = Math.max(2, Math.round(outputW * thirdOutput.w));
    const thirdOutputHPx = Math.max(2, Math.round(outputH * thirdOutput.h));
    const thirdOutputXPx = Math.max(0, Math.round(outputW * thirdOutput.x));
    const thirdOutputYPx = Math.max(0, Math.round(outputH * thirdOutput.y));
    const logoPath = twitchName.enabled ? resolveTwitchLogoPath() : null;
    const showNameBadge = twitchName.enabled;
    const logoInputIndex = showNameBadge && logoPath ? 1 : -1;
    const overlayItems = overlay.items
        .map((item) => ({
            ...item,
            startSec: Math.max(0, item.startSec),
            endSec: Math.max(item.startSec + 0.05, item.endSec),
            boxW: Math.max(2, Math.round(outputW * item.w)),
            boxH: Math.max(2, Math.round(outputH * item.h)),
            boxX: Math.max(0, Math.round(outputW * item.x)),
            boxY: Math.max(0, Math.round(outputH * item.y)),
        }))
        .filter(item => item.mediaPath && fs.existsSync(item.mediaPath));
    const overlayEnabled = overlayItems.length > 0;
    const overlayInputStartIndex = logoInputIndex >= 1 ? (logoInputIndex + 1) : 1;
    const overlayItemsWithInput = overlayItems.map((item, idx) => ({
        ...item,
        inputIndex: overlayInputStartIndex + idx,
    }));
    const drawtextSupported = await isDrawtextFilterSupported();
    const drawtextFontPath = resolveDrawtextFontPath();
    const drawtextFontOpt = drawtextFontPath ? `:fontfile='${toFfmpegFilterPath(drawtextFontPath)}'` : '';

    const badgeScale = Math.max(0.65, Math.min(2.4, twitchName.scale));
    const nameFontPx = Math.max(14, Math.round(outputH * 0.039 * badgeScale));
    const namePadX = Math.round(nameFontPx * 0.60);
    const nameIconHPx = Math.max(2, Math.round(nameFontPx * 1.26));
    const logoAspect = logoPath ? getLogoAspectRatio(logoPath) : 1;
    const clampedLogoAspect = Math.max(0.4, Math.min(3, logoAspect));
    const iconWRaw = Math.max(2, Math.round(nameIconHPx * clampedLogoAspect));
    const nameIconWPx = iconWRaw % 2 === 0 ? iconWRaw : iconWRaw + 1;
    const nameGapPx = Math.round(nameFontPx * 0.24);
    const nameBadgeH = Math.round(nameFontPx * 1.78);
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
    const textY = nameBadgeY + Math.round((nameBadgeH - nameFontPx) / 2 + (nameFontPx * 0.08));
    const safeTwitchName = escapeFfmpegDrawtext(twitchName.text);
    const canDrawNameText = Boolean(drawtextSupported && safeTwitchName);
    if (!drawtextSupported && safeTwitchName && !warnedDrawtextUnavailable) {
        warnedDrawtextUnavailable = true;
        console.warn('[drawtext] ffmpeg drawtext filter is not available in this build. Using bitmap-text fallback for Twitch name overlay.');
    }
    const roundedMask = (alpha: number) => `if(lte(abs(X-W/2),W/2-H/2),${alpha},if(lte((X-H/2)*(X-H/2)+(Y-H/2)*(Y-H/2),(H/2)*(H/2)),${alpha},if(lte((X-(W-H/2))*(X-(W-H/2))+(Y-H/2)*(Y-H/2),(H/2)*(H/2)),${alpha},0)))`;
    const badgeSourceDurationSec = 86400;

    const sourceDurationSec = await probeMediaDurationSeconds(inputPath);
    const splitPoints = normalizeSplitPoints(split.points, sourceDurationSec);
    const splitSegmentCount = splitPoints.length + 1;
    const splitDeletedSegments = normalizeSplitDeletedSegments(split.deletedSegments, splitSegmentCount);
    const splitZoomSegments = normalizeSplitDeletedSegments(split.zoomSegments, splitSegmentCount);
    const splitZoomLayouts = normalizeSplitZoomLayouts(split.zoomLayouts, splitSegmentCount);
    const splitConfigured = splitPoints.length > 0 || splitDeletedSegments.length > 0 || splitZoomSegments.length > 0;
    const splitRanges = splitConfigured ? buildKeptSplitRanges(splitPoints, splitDeletedSegments) : [];
    const zoomLayoutGroups = buildOutputTimelineZoomLayoutGroups(splitPoints, splitDeletedSegments, splitZoomSegments, splitZoomLayouts);
    const zoomRanges = zoomLayoutGroups.flatMap(group => group.ranges);
    const zoomExpr = buildFfmpegEnableExprFromRanges(zoomRanges);
    const notZoomExpr = zoomExpr ? `not(${zoomExpr})` : '1';

    if (splitConfigured && splitRanges.length === 0) {
        throw new Error('All split parts are deleted. Keep at least one segment before exporting.');
    }
    const splitEnabled = splitConfigured && splitRanges.length > 0;
    const expectedOutputDurationSec = (() => {
        if (!Number.isFinite(sourceDurationSec as number) || Number(sourceDurationSec) <= 0) return null;
        const safeSourceDuration = Number(sourceDurationSec);
        if (!splitEnabled) return safeSourceDuration;
        let total = 0;
        splitRanges.forEach((range) => {
            const start = Math.max(0, Math.min(safeSourceDuration, Number(range.start) || 0));
            const rawEnd = range.end === null ? safeSourceDuration : Number(range.end);
            const end = Math.max(start, Math.min(safeSourceDuration, Number.isFinite(rawEnd) ? rawEnd : safeSourceDuration));
            total += Math.max(0, end - start);
        });
        return total > 0 ? total : null;
    })();


    const hasAudio = await hasAudioStream(inputPath);
    const filterSteps: string[] = [];
    const sourceVideoLabel = splitEnabled ? 'vsrc' : '0:v';
    const sourceAudioLabel = splitEnabled ? (hasAudio ? 'asrc' : null) : null;

    if (splitEnabled) {
        if (hasAudio) {
            const avLabels: string[] = [];
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
            } else {
                filterSteps.push(`${avLabels.join('')}concat=n=${splitRanges.length}:v=1:a=1[vsrc][asrc]`);
            }
        } else {
            const videoLabels: string[] = [];
            splitRanges.forEach((range, idx) => {
                const vLabel = `vseg${idx}`;
                videoLabels.push(`[${vLabel}]`);
                const trimEndOpt = range.end === null ? '' : `:end=${ts(range.end)}`;
                filterSteps.push(`[0:v]trim=start=${ts(range.start)}${trimEndOpt},setpts=PTS-STARTPTS[${vLabel}]`);
            });
            if (videoLabels.length === 1) {
                filterSteps.push('[vseg0]setpts=PTS-STARTPTS[vsrc]');
            } else {
                filterSteps.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[vsrc]`);
            }
        }
    }

    // Cap working timeline FPS before expensive split/crop/overlay steps.
    const sourceVideoFpsLabel = 'vsrc_fps';
    filterSteps.push(`[${sourceVideoLabel}]fps=${FFMPEG_OUTPUT_FPS}[${sourceVideoFpsLabel}]`);

    const hasZoomEffect = zoomExpr.length > 0;
    const shouldRenderCamLayer = camEnabled || hasZoomEffect || thirdOutput.enabled;
    if (shouldRenderCamLayer) {
        // Duplicate the source branch once before two crops; a single filter output label cannot be consumed safely twice.
        const gameplaySourceLabel = 'src_game';
        const camSourceLabel = 'src_cam';
        const camThirdSourceLabel = thirdOutput.enabled ? 'src_cam_third' : null;
        const camZoomSourceLabels = zoomLayoutGroups.map((_, idx) => `src_cam_zoom_${idx}`);
        const splitTargets = [`[${gameplaySourceLabel}]`, `[${camSourceLabel}]`];
        if (camThirdSourceLabel) splitTargets.push(`[${camThirdSourceLabel}]`);
        splitTargets.push(...camZoomSourceLabels.map(label => `[${label}]`));
        filterSteps.push(`[${sourceVideoFpsLabel}]split=${splitTargets.length}${splitTargets.join('')}`);
        filterSteps.push(`[${gameplaySourceLabel}]crop=iw*${n(gameplay.w)}:ih*${n(gameplay.h)}:iw*${n(gameplay.x)}:ih*${n(gameplay.y)},scale=${outputW}:${gameplayOutputHeightPx}:flags=bicubic:force_original_aspect_ratio=disable,setsar=1[game]`);
        filterSteps.push(`color=c=black:s=${outputW}x${outputH}:d=${badgeSourceDurationSec}[layout_base]`);
        filterSteps.push(`[layout_base][game]overlay=0:${gameplayOutputYPx}:format=auto:shortest=1[bg]`);
        filterSteps.push(`[${camSourceLabel}]crop=iw*${n(cam.w)}:ih*${n(cam.h)}:iw*${n(cam.x)}:ih*${n(cam.y)},scale=${outputW}:${camOutputHeightPx}:flags=bicubic:force_original_aspect_ratio=disable,setsar=1[cam]`);
        const normalCamEnable = camEnabled ? notZoomExpr : '0';
        filterSteps.push(`[bg][cam]overlay=0:${camOutputYPx}:format=auto:enable='${normalCamEnable}'[base_norm]`);
        let normalBaseLabel = 'base_norm';
        if (thirdOutput.enabled && camThirdSourceLabel) {
            const thirdOverlayX = `${thirdOutputXPx}+(${thirdOutputWPx}-overlay_w)/2`;
            const thirdOverlayY = `${thirdOutputYPx}+(${thirdOutputHPx}-overlay_h)/2`;
            filterSteps.push(`[${camThirdSourceLabel}]crop=iw*${n(third.w)}:ih*${n(third.h)}:iw*${n(third.x)}:ih*${n(third.y)},scale=${thirdOutputWPx}:${thirdOutputHPx}:flags=bicubic:force_original_aspect_ratio=decrease,setsar=1[cam_third]`);
            filterSteps.push(`[base_norm][cam_third]overlay=${thirdOverlayX}:${thirdOverlayY}:format=auto:enable='${notZoomExpr}'[base_norm_third]`);
            normalBaseLabel = 'base_norm_third';
        }
        if (hasZoomEffect) {
            let zoomBaseLabel = normalBaseLabel;
            zoomLayoutGroups.forEach((group, idx) => {
                const zoomW = Math.max(2, Math.round(outputW * group.w));
                const zoomH = Math.max(2, Math.round(outputH * group.h));
                const minZoomX = zoomW > outputW ? (outputW - zoomW) : 0;
                const maxZoomX = zoomW > outputW ? 0 : (outputW - zoomW);
                const minZoomY = zoomH > outputH ? (outputH - zoomH) : 0;
                const maxZoomY = zoomH > outputH ? 0 : (outputH - zoomH);
                const zoomX = Math.max(minZoomX, Math.min(maxZoomX, Math.round(outputW * group.x)));
                const zoomY = Math.max(minZoomY, Math.min(maxZoomY, Math.round(outputH * group.y)));
                const zoomExprForGroup = buildFfmpegEnableExprFromRanges(group.ranges);
                const camZoomLabel = `cam_zoom_${idx}`;
                const nextBaseLabel = idx === (zoomLayoutGroups.length - 1) ? 'base' : `base_zoom_${idx}`;
                const zoomOverlayX = `${zoomX}+(${zoomW}-overlay_w)/2`;
                const zoomOverlayY = `${zoomY}+(${zoomH}-overlay_h)/2`;
                // Keep background gameplay visible around zoom camera; avoid black letterbox padding.
                filterSteps.push(`[${camZoomSourceLabels[idx]}]crop=iw*${n(cam.w)}:ih*${n(cam.h)}:iw*${n(cam.x)}:ih*${n(cam.y)},scale=${zoomW}:${zoomH}:flags=bicubic:force_original_aspect_ratio=decrease,setsar=1[${camZoomLabel}]`);
                filterSteps.push(`[${zoomBaseLabel}][${camZoomLabel}]overlay=${zoomOverlayX}:${zoomOverlayY}:format=auto:enable='${zoomExprForGroup}',setsar=1[${nextBaseLabel}]`);
                zoomBaseLabel = nextBaseLabel;
            });
        } else {
            filterSteps.push(`[${normalBaseLabel}]setsar=1[base]`);
        }
    } else {
        filterSteps.push(`[${sourceVideoFpsLabel}]crop=iw*${n(gameplay.w)}:ih*${n(gameplay.h)}:iw*${n(gameplay.x)}:ih*${n(gameplay.y)},scale=${outputW}:${gameplayOutputHeightPx}:flags=bicubic:force_original_aspect_ratio=disable,setsar=1[game]`);
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
            filterSteps.push(`[${logoInputIndex}:v]scale=${nameIconWPx}:${nameIconHPx}:flags=bicubic:force_original_aspect_ratio=decrease[tw_logo]`);
            // Do not shorten output to a single logo frame; keep base video timeline authoritative.
            filterSteps.push(`[badge_bg][tw_logo]overlay=${logoX}:${logoY}:format=auto:eof_action=repeat${badgeEnableOpt}[badge_logo]`);
            badgeOutLabel = 'badge_logo';
        }

        if (canDrawNameText) {
            const drawTextEnableOpt = hasZoomEffect ? `:enable='${notZoomExpr}'` : '';
            filterSteps.push(`[${badgeOutLabel}]drawtext=text='${safeTwitchName}':x=${textX}:y=${textY}:fontsize=${nameFontPx}${drawtextFontOpt}:fontcolor=white:borderw=1:bordercolor=black@0.55:shadowcolor=black@0.45:shadowx=1:shadowy=1${drawTextEnableOpt}[name_out]`);
            filterSteps.push('[name_out]format=yuv420p[v_base]');
        } else {
            const bitmapPx = Math.max(1, Math.round(nameFontPx / 8));
            const bitmapTextHeight = 7 * bitmapPx;
            const bitmapTextY = nameBadgeY + Math.max(0, Math.floor((nameBadgeH - bitmapTextHeight) / 2));
            const textRightEdge = nameBadgeX + nameBadgeW - namePadX;
            const bitmapMaxWidth = Math.max(0, textRightEdge - textX);
            const bitmapEnableExpr = hasZoomEffect ? notZoomExpr : null;
            const bitmapFallback = buildBitmapNameFallbackFilters(
                badgeOutLabel,
                twitchName.text,
                textX,
                bitmapTextY,
                bitmapPx,
                bitmapMaxWidth,
                bitmapEnableExpr
            );
            if (bitmapFallback.rendered) {
                filterSteps.push(...bitmapFallback.filters);
                filterSteps.push(`[${bitmapFallback.outLabel}]format=yuv420p[v_base]`);
            } else {
                filterSteps.push(`[${badgeOutLabel}]format=yuv420p[v_base]`);
            }
        }
    } else {
        filterSteps.push('[base]format=yuv420p[v_base]');
    }

    if (overlayEnabled) {
        let baseLabel = 'v_base';
        overlayItemsWithInput.forEach((item, idx) => {
            const overlayLabel = `clip_overlay_media_${idx}`;
            const nextBase = `v_overlay_${idx}`;
            const enableExpr = `between(t\\,${ts(item.startSec)}\\,${ts(item.endSec)})`;
            const overlayXExpr = `${item.boxX}+(${item.boxW}-overlay_w)/2`;
            const overlayYExpr = `${item.boxY}+(${item.boxH}-overlay_h)/2`;
            const gifFpsStep = item.mediaMime === 'image/gif' ? `fps=${FFMPEG_GIF_FPS},` : '';
            filterSteps.push(`[${item.inputIndex}:v]${gifFpsStep}scale=${item.boxW}:${item.boxH}:flags=bicubic:force_original_aspect_ratio=decrease,setsar=1,format=rgba[${overlayLabel}]`);
            filterSteps.push(`[${baseLabel}][${overlayLabel}]overlay=${overlayXExpr}:${overlayYExpr}:format=auto:eof_action=repeat:enable='${enableExpr}'[${nextBase}]`);
            baseLabel = nextBase;
        });
        filterSteps.push(`[${baseLabel}]format=yuv420p[v]`);
    } else {
        filterSteps.push('[v_base]format=yuv420p[v]');
    }

    const filter = filterSteps.join(';');

    const args = ['-y', '-i', inputPath];
    if (showNameBadge && logoPath) {
        args.push('-i', logoPath);
    }
    overlayItemsWithInput.forEach((item) => {
        if (item.mediaMime === 'image/gif') {
            // Respect GIF loop metadata for animation during active overlay time.
            args.push('-ignore_loop', '0', '-i', item.mediaPath);
            return;
        }
        args.push('-i', item.mediaPath);
    });
    args.push(
        '-filter_complex', filter,
        '-map', '[v]',
    );

    if (sourceAudioLabel) {
        args.push('-map', `[${sourceAudioLabel}]`);
    } else if (!splitEnabled) {
        args.push('-map', '0:a?');
    }

    if (expectedOutputDurationSec && Number.isFinite(expectedOutputDurationSec)) {
        // Prevent long-running encodes when looping overlay sources (for example animated GIFs) are present.
        args.push('-t', ts(expectedOutputDurationSec + 0.02));
    }

    args.push(
        '-c:v', 'libx264',
        '-preset', videoPreset,
        '-crf', String(videoCrf),
        '-c:a', 'aac',
        '-b:a', '128k',
        ...(FFMPEG_FILTER_THREAD_CAP > 0 ? ['-filter_threads', String(FFMPEG_FILTER_THREAD_CAP), '-filter_complex_threads', String(FFMPEG_FILTER_THREAD_CAP)] : []),
        ...(FFMPEG_THREAD_CAP > 0 ? ['-threads', String(FFMPEG_THREAD_CAP)] : []),
        '-movflags', '+faststart',
        outputPath,
    );

    await runCommand(FFMPEG_BIN, args);
}

function toFutureIso(secondsRaw: unknown): string | null {
    const seconds = Number(secondsRaw || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(Date.now() + (seconds * 1000)).toISOString();
}

async function refreshTikTokAccessToken(account: TikTokAccountRow): Promise<TikTokAccountRow> {
    if (!account.refresh_token) {
        throw new Error('TikTok refresh token missing. Please reconnect TikTok.');
    }
    if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
        throw new Error('Missing TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET in environment.');
    }

    const body = new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: account.refresh_token,
    });

    const tokenResponse = await axios.post(`${TIKTOK_API_BASE}/v2/oauth/token/`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
    });

    if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
        throw new Error(`TikTok token refresh failed (${tokenResponse.status}): ${JSON.stringify(tokenResponse.data)}`);
    }

    const refreshedAccessToken = String(tokenResponse.data?.access_token || '').trim();
    if (!refreshedAccessToken) {
        throw new Error(`TikTok token refresh did not return access_token: ${JSON.stringify(tokenResponse.data)}`);
    }

    const refreshedRefreshToken = String(tokenResponse.data?.refresh_token || account.refresh_token || '').trim();
    const refreshedScopes = normalizeTikTokScopes(tokenResponse.data?.scope || account.scope);
    const now = new Date().toISOString();

    db.prepare(`
        UPDATE user_tiktok_accounts
        SET
            access_token = $access_token,
            refresh_token = $refresh_token,
            access_token_expires_at = $access_token_expires_at,
            refresh_token_expires_at = $refresh_token_expires_at,
            token_type = $token_type,
            scope = $scope,
            updated_at = $updated_at
        WHERE user_id = $user_id
    `).run({
        $access_token: refreshedAccessToken,
        $refresh_token: refreshedRefreshToken || null,
        $access_token_expires_at: toFutureIso(tokenResponse.data?.expires_in),
        $refresh_token_expires_at: toFutureIso(tokenResponse.data?.refresh_expires_in),
        $token_type: String(tokenResponse.data?.token_type || account.token_type || 'Bearer'),
        $scope: refreshedScopes.join(' '),
        $updated_at: now,
        $user_id: account.user_id,
    });

    const refreshed = getTikTokAccountByUserId(account.user_id);
    if (!refreshed || !refreshed.access_token) {
        throw new Error('TikTok token refresh succeeded but account tokens were not persisted.');
    }
    return refreshed;
}

async function getValidTikTokAccountForUpload(userId: number): Promise<TikTokAccountRow> {
    const account = getTikTokAccountByUserId(userId);
    if (!account || !account.access_token) {
        throw new Error('TikTok is not connected. Connect TikTok before uploading.');
    }

    const expiresAt = Date.parse(String(account.access_token_expires_at || ''));
    const mustRefresh = Number.isFinite(expiresAt) && expiresAt <= (Date.now() + 60 * 1000);
    if (!mustRefresh) return account;

    if (!account.refresh_token) {
        throw new Error('TikTok access token expired. Reconnect TikTok to continue uploading.');
    }

    return refreshTikTokAccessToken(account);
}

async function queryTikTokCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
    const response = await axios.post(
        `${TIKTOK_API_BASE}/v2/post/publish/creator_info/query/`,
        {},
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
        }
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`TikTok creator info query failed (${response.status}): ${JSON.stringify(response.data)}`);
    }

    const data = response.data?.data || {};
    const privacyLevelOptions = Array.isArray(data?.privacy_level_options)
        ? data.privacy_level_options.map((v: unknown) => String(v || '').trim()).filter(Boolean)
        : [];
    const asBool = (v: unknown) => v === true || v === 1 || v === '1' || String(v || '').toLowerCase() === 'true';

    return {
        privacyLevelOptions,
        commentDisabled: asBool(data?.comment_disabled),
        duetDisabled: asBool(data?.duet_disabled),
        stitchDisabled: asBool(data?.stitch_disabled),
    };
}

async function uploadProcessedVideoToTikTok(
    processedPath: string,
    title: string,
    accessToken: string,
    uploadMode: TikTokUploadMode
): Promise<{ publishId?: string; message: string }> {
    const stat = await fs.promises.stat(processedPath);
    const fileSize = stat.size;

    if (TIKTOK_DEMO_MODE) {
        await sleep(300);
        const publishId = uploadMode === 'direct' ? `demo_publish_${randomUUID().slice(0, 12)}` : undefined;
        return {
            publishId,
            message: uploadMode === 'direct'
                ? `Demo upload complete (direct publish, publish_id=${publishId})`
                : 'Demo upload complete (draft inbox)',
        };
    }

    let endpoint = `${TIKTOK_API_BASE}/v2/post/publish/inbox/video/init/`;
    let body: Record<string, unknown> = {
        source_info: {
            source: 'FILE_UPLOAD',
            video_size: fileSize,
            chunk_size: fileSize,
            total_chunk_count: 1,
        },
    };
    let modeLabel = 'draft';

    if (uploadMode === 'direct') {
        const creatorInfo = await queryTikTokCreatorInfo(accessToken);
        const privacyLevelFallback = creatorInfo.privacyLevelOptions[0] || 'SELF_ONLY';
        const privacyLevel = creatorInfo.privacyLevelOptions.includes(TIKTOK_PRIVACY_LEVEL)
            ? TIKTOK_PRIVACY_LEVEL
            : privacyLevelFallback;

        endpoint = `${TIKTOK_API_BASE}/v2/post/publish/video/init/`;
        body = {
            post_info: {
                title: title.slice(0, 150),
                privacy_level: privacyLevel,
                disable_duet: creatorInfo.duetDisabled,
                disable_comment: creatorInfo.commentDisabled,
                disable_stitch: creatorInfo.stitchDisabled,
            },
            source_info: {
                source: 'FILE_UPLOAD',
                video_size: fileSize,
                chunk_size: fileSize,
                total_chunk_count: 1,
            },
        };
        modeLabel = 'direct publish';
    }

    const initResponse = await axios.post(
        endpoint,
        body,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
        }
    );

    if (initResponse.status < 200 || initResponse.status >= 300) {
        throw new Error(`TikTok upload init failed (${initResponse.status}): ${JSON.stringify(initResponse.data)}`);
    }

    const uploadUrl = initResponse.data?.data?.upload_url as string | undefined;
    const publishId = initResponse.data?.data?.publish_id as string | undefined;
    if (!uploadUrl) {
        throw new Error(`TikTok init did not return upload_url: ${JSON.stringify(initResponse.data)}`);
    }

    await axios.put(uploadUrl, fs.createReadStream(processedPath), {
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
        message: publishId
            ? `Uploaded to TikTok (${modeLabel}, publish_id=${publishId})`
            : `Uploaded to TikTok (${modeLabel})`,
    };
}

function assertTikTokUploadScope(account: TikTokAccountRow, uploadMode: TikTokUploadMode): void {
    const requiredScope = uploadMode === 'direct' ? 'video.publish' : 'video.upload';
    if (!hasTikTokScope(account, requiredScope)) {
        throw new Error(`TikTok permission missing: ${requiredScope}. Reconnect TikTok and grant required scope.`);
    }
}

async function ensureTikTokUploadReady(userId: number, uploadMode: TikTokUploadMode): Promise<void> {
    const account = await getValidTikTokAccountForUpload(userId);
    assertTikTokUploadScope(account, uploadMode);
}

async function uploadSingleClipToTikTok(
    userId: number,
    clip: DbClipRow,
    uploadMode: TikTokUploadMode,
    dryRun = false
): Promise<ClipUploadResult> {
    await fs.promises.mkdir(VIDEO_WORK_DIR, { recursive: true });

    const inPath = path.join(VIDEO_WORK_DIR, `${clip.id}.source.mp4`);
    const outPath = path.join(VIDEO_WORK_DIR, `${clip.id}.tiktok.mp4`);

    try {
        const sourceUrl = await resolveClipVideoUrl(clip);
        if (sourceUrl) {
            await downloadFile(sourceUrl, inPath);
        } else {
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
        await withRenderSlot(() => processClipToTikTokFormat(inPath, outPath, clip));

        if (dryRun) {
            await ensureTikTokUploadReady(userId, uploadMode);
            return {
                clipId: clip.id,
                title: clip.title,
                status: 'uploaded',
                details: 'Dry run: source resolved, video processed, TikTok upload skipped.',
            };
        }

        const account = await getValidTikTokAccountForUpload(userId);
        assertTikTokUploadScope(account, uploadMode);
        const uploaded = await uploadProcessedVideoToTikTok(outPath, clip.title, String(account.access_token || ''), uploadMode);

        return {
            clipId: clip.id,
            title: clip.title,
            status: 'uploaded',
            details: uploaded.message,
            publishId: uploaded.publishId,
        };
    } catch (err) {
        return {
            clipId: clip.id,
            title: clip.title,
            status: 'failed',
            details: err instanceof Error ? err.message : 'Unknown upload error',
        };
    } finally {
        await fs.promises.rm(inPath, { force: true }).catch(() => {});
        await fs.promises.rm(outPath, { force: true }).catch(() => {});
    }
}

async function buildProcessedClipForDownload(clip: DbClipRow): Promise<string> {
    await fs.promises.mkdir(VIDEO_WORK_DIR, { recursive: true });

    const token = randomUUID();
    const inPath = path.join(VIDEO_WORK_DIR, `${clip.id}.${token}.source.mp4`);
    const outPath = path.join(VIDEO_WORK_DIR, `${clip.id}.${token}.tiktok.mp4`);

    try {
        const sourceUrl = await resolveClipVideoUrl(clip);
        if (sourceUrl) {
            await downloadFile(sourceUrl, inPath);
        } else {
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
        await withRenderSlot(() => processClipToTikTokFormat(inPath, outPath, clip, DEFAULT_DOWNLOAD_VIDEO_PRESET, DEFAULT_DOWNLOAD_VIDEO_CRF));
        return outPath;
    } finally {
        await fs.promises.rm(inPath, { force: true }).catch(() => {});
    }
}

function toSafeMp4Name(rawTitle: string, clipId: string): string {
    const base = (rawTitle || clipId)
        .replace(/[^a-zA-Z0-9._ -]+/g, '')
        .trim()
        .slice(0, 80);
    const normalized = base || clipId;
    return `${normalized}.mp4`;
}

function parseCamEnabled(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return 1;
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return null;
}

const TWITCH_NAME_BLOCKED_WORDS = [
    'fuck',
    'shit',
    'bitch',
    'asshole',
    'cunt',
    'dick',
    'pussy',
    'slut',
    'whore',
    'faggot',
    'retard',
    'nigger',
    'nigga',
    'motherfucker',
] as const;

function normalizeTwitchNameForModeration(value: string): string {
    return String(value || '')
        .toLowerCase()
        .replace(/[@4]/g, 'a')
        .replace(/[0]/g, 'o')
        .replace(/[1!|]/g, 'i')
        .replace(/[3]/g, 'e')
        .replace(/[5$]/g, 's')
        .replace(/[7+]/g, 't')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function containsBlockedTwitchNameLanguage(value: string): boolean {
    const normalized = normalizeTwitchNameForModeration(value);
    if (!normalized) return false;
    const compact = normalized.replace(/\s+/g, '');
    return TWITCH_NAME_BLOCKED_WORDS.some((word) => {
        const boundaryRe = new RegExp(`(^|\\s)${word}(\\s|$)`, 'i');
        return boundaryRe.test(normalized) || compact.includes(word);
    });
}

function parseTwitchNameEnabled(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return 0;
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return null;
}

function parseTwitchNameText(value: unknown): string | null {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return null;
    const sanitized = value
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64);
    if (containsBlockedTwitchNameLanguage(sanitized)) return null;
    return sanitized;
}

function parseTwitchNameScale(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return 1;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < 0.65 || n > 2.4) return null;
    return n;
}

function parseClipTagsPayload(value: unknown): string[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    return normalizeClipTags(value);
}

function parseOverlayItemsPayload(value: unknown): OverlayItemConfig[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    return normalizeOverlayItems(value);
}

function parseSplitPointsPayload(value: unknown): number[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const nums = value.map(v => Number(v));
    if (nums.some(v => !Number.isFinite(v) || v < 0 || v > 600)) return null;
    return normalizeSplitPoints(nums, null);
}

function parseSplitDeletedSegmentsPayload(value: unknown, maxSegments: number): number[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const ints = value.map(v => Number(v));
    if (ints.some(v => !Number.isInteger(v) || v < 0)) return null;
    return normalizeSplitDeletedSegments(ints, maxSegments);
}

function parseSplitZoomSegmentsPayload(value: unknown, maxSegments: number): number[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const ints = value.map(v => Number(v));
    if (ints.some(v => !Number.isInteger(v) || v < 0)) return null;
    return normalizeSplitDeletedSegments(ints, maxSegments);
}

function parseSplitZoomLayoutsPayload(value: unknown, maxSegments: number): Record<string, { x: number; y: number; w: number; h: number }> | null {
    if (value === undefined || value === null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return normalizeSplitZoomLayouts(value as Record<string, unknown>, maxSegments);
}

// ── Twitch helpers ─────────────────────────────────────────────────────────

async function getTwitchAccessToken(): Promise<string> {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: {
            client_id: clientID,
            client_secret: clientSecret,
            grant_type: 'client_credentials',
        },
    });
    return response.data.access_token;
}

async function resolveBroadcasterByLogin(accessToken: string, login: string): Promise<{ id: string; login?: string; displayName?: string } | null> {
    const normalized = login.trim().toLowerCase();
    if (!normalized) return null;

    const response = await axios.get<{ data?: Array<{ id: string; login: string; display_name: string }> }>('https://api.twitch.tv/helix/users', {
        params: { login: normalized },
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': clientID,
        },
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) return null;
    const user = response.data?.data?.[0];
    if (!user?.id) return null;
    return { id: String(user.id), login: user.login, displayName: user.display_name };
}

async function resolveBroadcasterById(accessToken: string, broadcasterId: string): Promise<{ id: string; login?: string; displayName?: string } | null> {
    const normalized = String(broadcasterId || '').trim();
    if (!/^\d+$/.test(normalized)) return null;

    const response = await axios.get<{ data?: Array<{ id: string; login: string; display_name: string }> }>('https://api.twitch.tv/helix/users', {
        params: { id: normalized },
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': clientID,
        },
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) return null;
    const user = response.data?.data?.[0];
    if (!user?.id) return null;
    return { id: String(user.id), login: user.login, displayName: user.display_name };
}

async function resolveStreamerInput(accessToken: string, input: string): Promise<{ id: string; login?: string; displayName?: string } | null> {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
        const resolvedById = await resolveBroadcasterById(accessToken, raw);
        return resolvedById || { id: raw };
    }
    return resolveBroadcasterByLogin(accessToken, raw.replace(/^@/, ''));
}

async function hydrateMissingStreamerMetadata(userId: number): Promise<void> {
    const pending = db.prepare(`
        SELECT twitch_broadcaster_id
        FROM user_streamers
        WHERE user_id = $user_id
          AND (
            twitch_login IS NULL OR twitch_login = '' OR
            display_name IS NULL OR display_name = ''
          )
        LIMIT 100
    `).all({ $user_id: userId }) as Array<{ twitch_broadcaster_id: string }>;

    if (pending.length === 0) return;
    if (!clientID || !clientSecret) return;

    try {
        const accessToken = await getTwitchAccessToken();
        for (const row of pending) {
            const resolved = await resolveBroadcasterById(accessToken, row.twitch_broadcaster_id);
            if (resolved) {
                addStreamerToUser(userId, resolved);
            }
        }
    } catch (err) {
        console.warn('Could not hydrate streamer names:', err instanceof Error ? err.message : err);
    }
}

async function fetchClipsFromTwitch(accessToken: string, broadcasterID: string, startedAt: string, endedAt: string): Promise<Clip[]> {
    const seen = new Map<string, Clip>();
    let cursor: string | undefined;
    let pageCount = 0;

    while (pageCount < TWITCH_CLIPS_MAX_PAGES) {
        const response = await axios.get<TwitchClipsResponse>('https://api.twitch.tv/helix/clips', {
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
        if (!cursor || pageClips.length === 0) break;
    }

    return [...seen.values()];
}

async function fetchClipsForAllStreamers(accessToken: string, streamerIDs: string[]): Promise<Clip[]> {
    const endedAt = new Date();
    const startedAt = new Date(endedAt);
    startedAt.setUTCDate(startedAt.getUTCDate() - TWITCH_CLIPS_LOOKBACK_DAYS);

    const settled = await Promise.allSettled(
        streamerIDs.map(id => fetchClipsFromTwitch(accessToken, id, startedAt.toISOString(), endedAt.toISOString()))
    );

    const clips: Clip[] = [];
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

app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: IS_PRODUCTION,
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
        },
    })
);
function resolvePublicDir(): string {
    const localPublicDir = path.join(__dirname, 'public');
    const repoPublicDir = path.resolve(__dirname, '..', 'public');
    if (fs.existsSync(repoPublicDir)) return repoPublicDir;
    return localPublicDir;
}

const PUBLIC_DIR = resolvePublicDir();
const HOME_PAGE_FILE = path.join(PUBLIC_DIR, 'home.html');
const APP_LOGIN_FILE = path.join(PUBLIC_DIR, 'index.html');
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/', (_req: Request, res: Response) => {
    res.sendFile(HOME_PAGE_FILE);
});

app.get('/login', (_req: Request, res: Response) => {
    res.sendFile(APP_LOGIN_FILE);
});

app.get('/reset-password', (_req: Request, res: Response) => {
    res.sendFile(APP_LOGIN_FILE);
});

app.get('/reset-passowrd', (_req: Request, res: Response) => {
    res.sendFile(APP_LOGIN_FILE);
});

app.get('/account-security', (_req: Request, res: Response) => {
    res.sendFile(APP_LOGIN_FILE);
});

app.get('/app', (_req: Request, res: Response) => {
    res.sendFile(APP_LOGIN_FILE);
});

function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (req.session.authenticated && req.session.userId) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

function getRequiredUserId(req: Request): number {
    return Number(req.session.userId);
}

// ── Auth routes ────────────────────────────────────────────────────────────

app.post('/api/login', async (req: Request, res: Response) => {
    const { identifier, username, password } = req.body as { identifier?: string; username?: string; password?: string };
    const normalizedIdentifier = normalizeAuthIdentifier(String(identifier || username || ''));
    const pw = String(password || '');
    const user = normalizedIdentifier ? getUserByIdentifier(normalizedIdentifier) : undefined;
    if (!user || !verifyPassword(pw, user.password_hash)) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
    }

    if (!isEmailVerified(user)) {
        setPendingVerificationSession(req, user);
        try {
            const verification = await issueVerificationCode(user, true);
            res.status(403).json({
                error: verification.sent
                    ? 'Email verification required. We sent a new code.'
                    : 'Email verification required. Please enter your latest code.',
                requiresEmailVerification: true,
                email: maskEmail(user.email || ''),
                username: user.username,
                resendAvailableIn: verification.resendAvailableIn,
            });
        } catch (err) {
            console.error('Failed to send verification code during login:', err);
            res.status(502).json({
                error: 'Email verification is required, but sending the code failed. Please retry in a moment.',
                requiresEmailVerification: true,
                email: maskEmail(user.email || ''),
                username: user.username,
                resendAvailableIn: getResendAvailableInSeconds(user.id),
            });
        }
        return;
    }

    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    clearPendingVerificationSession(req);
    const hasStreamers = listUserStreamerIds(user.id).length > 0;
    res.json({ success: true, username: user.username, needsStreamerSetup: !hasStreamers });
});

app.post('/api/register', async (req: Request, res: Response) => {
    const { email, username, password } = req.body as { email?: string; username?: string; password?: string };
    const normalizedUsername = String(username || '').trim().toLowerCase();
    const normalizedEmail = normalizeEmail(email || '');
    const pw = String(password || '');

    if (!isEmailDeliveryConfigured()) {
        res.status(503).json({ error: 'Email delivery is not configured. Set RESEND_API_KEY and MAIL_FROM.' });
        return;
    }
    if (!isValidEmail(normalizedEmail)) {
        res.status(400).json({ error: 'Please enter a valid email address' });
        return;
    }
    if (!/^[a-z0-9_]{3,32}$/.test(normalizedUsername)) {
        res.status(400).json({ error: 'Username must be 3-32 chars: a-z, 0-9, _' });
        return;
    }
    if (pw.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters long' });
        return;
    }
    if (getUserByUsername(normalizedUsername)) {
        res.status(409).json({ error: 'Username already exists' });
        return;
    }
    if (getUserByEmail(normalizedEmail)) {
        res.status(409).json({ error: 'Email already in use' });
        return;
    }

    let userId = 0;
    try {
        userId = createUser(normalizedUsername, pw, normalizedEmail);
        const user = getUserById(userId);
        if (!user) {
            throw new Error('Failed to create user');
        }

        const verification = await issueVerificationCode(user, false);
        setPendingVerificationSession(req, user);
        res.status(201).json({
            success: true,
            requiresEmailVerification: true,
            username: user.username,
            email: maskEmail(user.email || normalizedEmail),
            resendAvailableIn: verification.resendAvailableIn,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint failed/i.test(message)) {
            res.status(409).json({ error: 'Username or email already exists' });
            return;
        }
        if (userId > 0) {
            clearVerificationCode(userId);
            db.prepare('DELETE FROM users WHERE id = $id').run({ $id: userId });
        }
        clearPendingVerificationSession(req);
        console.error('Registration failed:', err);
        res.status(502).json({ error: 'Could not send verification email. Please try again.' });
    }
});

app.post('/api/verify-email', (req: Request, res: Response) => {
    const pendingUserId = Number(req.session.pendingVerificationUserId || 0);
    if (!pendingUserId) {
        res.status(401).json({ error: 'No pending verification found. Please sign in again.' });
        return;
    }

    const code = String((req.body as { code?: string }).code || '').trim();
    if (!/^\d{6}$/.test(code)) {
        res.status(400).json({ error: 'Verification code must be 6 digits' });
        return;
    }

    const user = getUserById(pendingUserId);
    if (!user || !user.email) {
        clearPendingVerificationSession(req);
        clearVerificationCode(pendingUserId);
        res.status(400).json({ error: 'Verification session is no longer valid. Please sign in again.' });
        return;
    }
    if (isEmailVerified(user)) {
        req.session.authenticated = true;
        req.session.userId = user.id;
        req.session.username = user.username;
        clearPendingVerificationSession(req);
        clearVerificationCode(user.id);
        const hasStreamers = listUserStreamerIds(user.id).length > 0;
        res.json({ success: true, username: user.username, needsStreamerSetup: !hasStreamers });
        return;
    }

    pruneExpiredVerificationCodes();
    const row = getVerificationCodeRow(user.id);
    if (!row) {
        res.status(400).json({ error: 'Verification code expired. Please request a new code.' });
        return;
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
        clearVerificationCode(user.id);
        res.status(400).json({ error: 'Verification code expired. Please request a new code.' });
        return;
    }

    if (Number(row.attempts || 0) >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
        clearVerificationCode(user.id);
        res.status(429).json({
            error: 'Too many failed attempts. Request a new code.',
            resendAvailableIn: getResendAvailableInSeconds(user.id),
        });
        return;
    }

    const expectedHash = hashVerificationCode(user.id, code);
    if (!safeEqualHash(row.code_hash, expectedHash)) {
        const attempts = incrementVerificationAttempts(user.id);
        const attemptsLeft = Math.max(0, EMAIL_VERIFICATION_MAX_ATTEMPTS - attempts);
        if (attemptsLeft === 0) {
            clearVerificationCode(user.id);
            res.status(429).json({
                error: 'Too many failed attempts. Request a new code.',
                resendAvailableIn: getResendAvailableInSeconds(user.id),
            });
            return;
        }
        res.status(400).json({
            error: `Invalid code. ${attemptsLeft} attempt(s) remaining.`,
            attemptsRemaining: attemptsLeft,
        });
        return;
    }

    markEmailVerified(user.id);
    clearVerificationCode(user.id);
    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    clearPendingVerificationSession(req);
    const hasStreamers = listUserStreamerIds(user.id).length > 0;
    res.json({ success: true, username: user.username, needsStreamerSetup: !hasStreamers });
});

app.post('/api/resend-verification', async (req: Request, res: Response) => {
    const pendingUserId = Number(req.session.pendingVerificationUserId || 0);
    if (!pendingUserId) {
        res.status(401).json({ error: 'No pending verification found. Please sign in again.' });
        return;
    }

    const user = getUserById(pendingUserId);
    if (!user || !user.email) {
        clearPendingVerificationSession(req);
        clearVerificationCode(pendingUserId);
        res.status(400).json({ error: 'Verification session is no longer valid. Please sign in again.' });
        return;
    }
    if (isEmailVerified(user)) {
        res.status(400).json({ error: 'Email is already verified' });
        return;
    }

    try {
        const verification = await issueVerificationCode(user, true);
        if (!verification.sent) {
            res.status(429).json({
                error: 'Please wait before requesting another code.',
                resendAvailableIn: verification.resendAvailableIn,
            });
            return;
        }
        res.json({
            success: true,
            email: maskEmail(user.email),
            resendAvailableIn: verification.resendAvailableIn,
        });
    } catch (err) {
        console.error('Failed to resend verification code:', err);
        res.status(502).json({ error: 'Failed to send verification email. Please try again.' });
    }
});

app.get('/api/auth', (req: Request, res: Response) => {
    const userId = req.session.userId;
    if (!req.session.authenticated || !userId) {
        const pendingUserId = Number(req.session.pendingVerificationUserId || 0);
        if (pendingUserId) {
            const pendingUser = getUserById(pendingUserId);
            if (pendingUser && pendingUser.email && !isEmailVerified(pendingUser)) {
                res.json({
                    authenticated: false,
                    pendingVerification: true,
                    username: pendingUser.username,
                    email: maskEmail(pendingUser.email),
                    resendAvailableIn: getResendAvailableInSeconds(pendingUser.id),
                });
                return;
            }
            clearPendingVerificationSession(req);
            clearVerificationCode(pendingUserId);
        }
        res.json({ authenticated: false });
        return;
    }

    const user = getUserById(Number(userId));
    if (!user) {
        req.session.destroy(() => {});
        res.json({ authenticated: false });
        return;
    }

    const hasStreamers = listUserStreamerIds(user.id).length > 0;
    res.json({ authenticated: true, username: user.username, needsStreamerSetup: !hasStreamers });
});

app.get('/api/me/account', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const user = getUserById(userId);
    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    const tiktok = getTikTokAccountView(userId);
    res.json({
        username: user.username,
        email: user.email || '',
        emailMasked: maskEmail(user.email || ''),
        emailVerified: isEmailVerified(user),
        tiktok,
    });
});

app.post('/api/account/add-email', requireAuth, async (req: Request, res: Response) => {
    if (!isEmailDeliveryConfigured()) {
        res.status(503).json({ error: 'Email delivery is not configured. Set RESEND_API_KEY and MAIL_FROM.' });
        return;
    }
    const userId = getRequiredUserId(req);
    const user = getUserById(userId);
    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    if (String(user.email || '').trim()) {
        res.status(400).json({ error: 'Account already has an email. Use the account link flow for updates.' });
        return;
    }

    const { email } = req.body as { email?: string };
    const normalizedEmail = normalizeEmail(email || '');
    if (!isValidEmail(normalizedEmail)) {
        res.status(400).json({ error: 'Please enter a valid email address' });
        return;
    }
    const existing = getUserByEmail(normalizedEmail);
    if (existing && existing.id !== user.id) {
        res.status(409).json({ error: 'Email already in use' });
        return;
    }

    db.prepare(`
        UPDATE users
        SET email = $email, email_verified = 0, email_verified_at = NULL
        WHERE id = $id
    `).run({
        $id: user.id,
        $email: normalizedEmail,
    });

    const updatedUser = getUserById(user.id);
    if (!updatedUser || !updatedUser.email) {
        res.status(500).json({ error: 'Could not save email. Please try again.' });
        return;
    }

    try {
        const verification = await issueVerificationCode(updatedUser, false);
        res.json({
            success: true,
            email: maskEmail(updatedUser.email),
            emailVerified: false,
            needsEmailVerification: true,
            resendAvailableIn: verification.resendAvailableIn,
            message: 'Email saved. Verification code sent.',
        });
    } catch (err) {
        console.error('Failed to send verification after adding email:', err);
        db.prepare('UPDATE users SET email = NULL, email_verified = 0, email_verified_at = NULL WHERE id = $id').run({
            $id: user.id,
        });
        clearVerificationCode(user.id);
        res.status(502).json({ error: 'Could not send verification email. Email was not saved.' });
    }
});

app.post('/api/account/verify-email', requireAuth, (req: Request, res: Response) => {
    const user = getUserById(getRequiredUserId(req));
    if (!user || !user.email) {
        res.status(400).json({ error: 'No email found on this account.' });
        return;
    }
    if (isEmailVerified(user)) {
        res.json({ success: true, email: maskEmail(user.email), emailVerified: true });
        return;
    }

    const code = String((req.body as { code?: string }).code || '').trim();
    if (!/^\d{6}$/.test(code)) {
        res.status(400).json({ error: 'Verification code must be 6 digits' });
        return;
    }

    pruneExpiredVerificationCodes();
    const row = getVerificationCodeRow(user.id);
    if (!row) {
        res.status(400).json({ error: 'Verification code expired. Request a new code.' });
        return;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
        clearVerificationCode(user.id);
        res.status(400).json({ error: 'Verification code expired. Request a new code.' });
        return;
    }
    if (Number(row.attempts || 0) >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
        clearVerificationCode(user.id);
        res.status(429).json({ error: 'Too many failed attempts. Request a new code.' });
        return;
    }

    const expectedHash = hashVerificationCode(user.id, code);
    if (!safeEqualHash(row.code_hash, expectedHash)) {
        const attempts = incrementVerificationAttempts(user.id);
        const attemptsLeft = Math.max(0, EMAIL_VERIFICATION_MAX_ATTEMPTS - attempts);
        if (attemptsLeft === 0) {
            clearVerificationCode(user.id);
            res.status(429).json({ error: 'Too many failed attempts. Request a new code.' });
            return;
        }
        res.status(400).json({ error: `Invalid code. ${attemptsLeft} attempt(s) remaining.` });
        return;
    }

    markEmailVerified(user.id);
    clearVerificationCode(user.id);
    res.json({ success: true, email: maskEmail(user.email), emailVerified: true, message: 'Email verified successfully.' });
});

app.post('/api/account/resend-email-verification', requireAuth, async (req: Request, res: Response) => {
    const user = getUserById(getRequiredUserId(req));
    if (!user || !user.email) {
        res.status(400).json({ error: 'No email found on this account.' });
        return;
    }
    if (isEmailVerified(user)) {
        res.status(400).json({ error: 'Email is already verified.' });
        return;
    }

    try {
        const verification = await issueVerificationCode(user, true);
        if (!verification.sent) {
            res.status(429).json({
                error: 'Please wait before requesting another code.',
                resendAvailableIn: verification.resendAvailableIn,
            });
            return;
        }
        res.json({
            success: true,
            email: maskEmail(user.email),
            emailVerified: false,
            resendAvailableIn: verification.resendAvailableIn,
            message: 'Verification code sent.',
        });
    } catch (err) {
        console.error('Failed to resend account email verification:', err);
        res.status(502).json({ error: 'Could not send verification email. Please try again.' });
    }
});

app.post('/api/account/send-manage-link', requireAuth, async (req: Request, res: Response) => {
    if (!isEmailDeliveryConfigured()) {
        res.status(503).json({ error: 'Email delivery is not configured. Set RESEND_API_KEY and MAIL_FROM.' });
        return;
    }
    const user = getUserById(getRequiredUserId(req));
    if (!user || !user.email) {
        res.status(400).json({ error: 'Your account has no email on file.' });
        return;
    }

    try {
        pruneExpiredAccountActionTokens();
        const token = createAccountActionToken(user.id, 'manage_account', ACCOUNT_MANAGE_LINK_TTL_MINUTES);
        await sendAccountActionLinkEmail(user, 'manage_account', token);
        res.json({ success: true, email: maskEmail(user.email) });
    } catch (err) {
        console.error('Failed to send account manage link:', err);
        res.status(502).json({ error: 'Could not send account link email. Please try again.' });
    }
});

app.post('/api/forgot-password/request', async (req: Request, res: Response) => {
    if (!isEmailDeliveryConfigured()) {
        res.status(503).json({ error: 'Email delivery is not configured. Set RESEND_API_KEY and MAIL_FROM.' });
        return;
    }

    const { identifier, email } = req.body as { identifier?: string; email?: string };
    const normalizedIdentifier = normalizeAuthIdentifier(String(identifier || email || ''));
    if (!normalizedIdentifier) {
        res.json({ success: true });
        return;
    }

    const user = getUserByIdentifier(normalizedIdentifier);
    if (!user || !user.email) {
        // Intentionally generic response to avoid account enumeration.
        res.json({ success: true });
        return;
    }

    try {
        pruneExpiredAccountActionTokens();
        const token = createAccountActionToken(user.id, 'reset_password', PASSWORD_RESET_LINK_TTL_MINUTES);
        await sendAccountActionLinkEmail(user, 'reset_password', token);
    } catch (err) {
        console.error('Failed to send forgot-password link:', err);
    }

    // Always generic success to avoid revealing account existence.
    res.json({ success: true });
});

app.get('/api/account/link/meta', (req: Request, res: Response) => {
    const rawToken = String(req.query.token || '').trim();
    if (!rawToken) {
        res.status(400).json({ error: 'Missing account link token.' });
        return;
    }
    pruneExpiredAccountActionTokens();
    const tokenRow = getAccountActionTokenRow(rawToken);
    if (!tokenRow) {
        res.status(400).json({ error: 'This link is invalid or expired.' });
        return;
    }

    res.json({
        valid: true,
        purpose: tokenRow.purpose,
        username: tokenRow.username,
        email: tokenRow.email || '',
        emailMasked: maskEmail(tokenRow.email || ''),
        expiresAt: tokenRow.expires_at,
    });
});

app.post('/api/account/link/complete', async (req: Request, res: Response) => {
    const { token, username, email, newPassword } = req.body as {
        token?: string;
        username?: string;
        email?: string;
        newPassword?: string;
    };
    const rawToken = String(token || '').trim();
    if (!rawToken) {
        res.status(400).json({ error: 'Missing account link token.' });
        return;
    }

    pruneExpiredAccountActionTokens();
    const tokenRow = getAccountActionTokenRow(rawToken);
    if (!tokenRow) {
        res.status(400).json({ error: 'This link is invalid or expired.' });
        return;
    }

    if (tokenRow.purpose === 'reset_password') {
        const nextPassword = String(newPassword || '');
        if (nextPassword.length < 8) {
            res.status(400).json({ error: 'Password must be at least 8 characters long' });
            return;
        }
        db.exec('BEGIN');
        try {
            db.prepare('UPDATE users SET password_hash = $hash WHERE id = $id').run({
                $hash: hashPassword(nextPassword),
                $id: tokenRow.user_id,
            });
            markAccountActionTokenUsed(tokenRow.id);
            db.exec('COMMIT');
            res.json({ success: true, message: 'Password updated. You can now sign in with your new password.' });
        } catch (err) {
            db.exec('ROLLBACK');
            console.error('Failed to apply password reset:', err);
            res.status(500).json({ error: 'Could not update password right now. Please try again.' });
        }
        return;
    }

    if (tokenRow.purpose !== 'manage_account') {
        res.status(400).json({ error: 'Unsupported account link type.' });
        return;
    }

    const normalizedUsernameInput = String(username || '').trim().toLowerCase();
    const normalizedEmailInput = normalizeEmail(email || '');
    const nextPassword = String(newPassword || '');
    const hasUsernameChange = normalizedUsernameInput.length > 0 && normalizedUsernameInput !== tokenRow.username;
    const hasEmailChange = normalizedEmailInput.length > 0 && normalizedEmailInput !== normalizeEmail(tokenRow.email || '');
    const hasPasswordChange = nextPassword.length > 0;

    if (!hasUsernameChange && !hasEmailChange && !hasPasswordChange) {
        res.status(400).json({ error: 'No changes detected. Enter at least one new value.' });
        return;
    }
    if (hasUsernameChange && !/^[a-z0-9_]{3,32}$/.test(normalizedUsernameInput)) {
        res.status(400).json({ error: 'Username must be 3-32 chars: a-z, 0-9, _' });
        return;
    }
    if (hasEmailChange && !isValidEmail(normalizedEmailInput)) {
        res.status(400).json({ error: 'Please enter a valid email address' });
        return;
    }
    if (hasPasswordChange && nextPassword.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters long' });
        return;
    }

    if (hasUsernameChange) {
        const existing = getUserByUsername(normalizedUsernameInput);
        if (existing && existing.id !== tokenRow.user_id) {
            res.status(409).json({ error: 'Username already exists' });
            return;
        }
    }
    if (hasEmailChange) {
        const existing = getUserByEmail(normalizedEmailInput);
        if (existing && existing.id !== tokenRow.user_id) {
            res.status(409).json({ error: 'Email already in use' });
            return;
        }
    }

    db.exec('BEGIN');
    try {
        db.prepare(`
            UPDATE users
            SET
                username = CASE WHEN $username_change = 1 THEN $username ELSE username END,
                email = CASE WHEN $email_change = 1 THEN $email ELSE email END,
                email_verified = CASE WHEN $email_change = 1 THEN 0 ELSE email_verified END,
                email_verified_at = CASE WHEN $email_change = 1 THEN NULL ELSE email_verified_at END,
                password_hash = CASE WHEN $password_change = 1 THEN $password_hash ELSE password_hash END
            WHERE id = $id
        `).run({
            $id: tokenRow.user_id,
            $username_change: hasUsernameChange ? 1 : 0,
            $username: normalizedUsernameInput,
            $email_change: hasEmailChange ? 1 : 0,
            $email: normalizedEmailInput,
            $password_change: hasPasswordChange ? 1 : 0,
            $password_hash: hasPasswordChange ? hashPassword(nextPassword) : '',
        });
        markAccountActionTokenUsed(tokenRow.id);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Failed to apply account-link changes:', err);
        res.status(500).json({ error: 'Could not update account right now. Please try again.' });
        return;
    }

    if (hasEmailChange) {
        try {
            const updatedUser = getUserById(tokenRow.user_id);
            if (updatedUser && updatedUser.email) {
                await issueVerificationCode(updatedUser, false);
            }
        } catch (err) {
            console.error('Failed to send verification after email change:', err);
        }
    }

    res.json({
        success: true,
        message: hasEmailChange
            ? 'Account updated. Verify your new email at next sign-in using the code we sent.'
            : 'Account updated successfully.',
        requiresEmailVerification: hasEmailChange,
    });
});

app.post('/api/logout', (req: Request, res: Response) => {
    clearPendingVerificationSession(req);
    clearTikTokOAuthSessionState(req);
    req.session.destroy(() => {});
    res.json({ success: true });
});

app.get('/api/tiktok/oauth/start', requireAuth, (req: Request, res: Response) => {
    const returnTo = sanitizeRelativeReturnPath(String(req.query.returnTo || '/app'));
    const userId = getRequiredUserId(req);

    if (TIKTOK_DEMO_MODE) {
        try {
            connectDemoTikTokAccount(userId);
            res.redirect(buildTikTokReturnPath(returnTo, 'success', 'TikTok demo account connected.'));
        } catch (err) {
            res.redirect(buildTikTokReturnPath(returnTo, 'error', err instanceof Error ? err.message : 'TikTok demo connect failed.'));
        }
        return;
    }

    if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !TIKTOK_LOGIN_REDIRECT_URI) {
        res.redirect(buildTikTokReturnPath(returnTo, 'error', 'TikTok OAuth is not configured on the server.'));
        return;
    }

    const state = randomBytes(24).toString('hex');
    req.session.tiktokOauthState = state;
    req.session.tiktokOauthUserId = userId;
    req.session.tiktokOauthReturnTo = returnTo;

    const params = new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        response_type: 'code',
        scope: TIKTOK_OAUTH_SCOPES.join(','),
        redirect_uri: TIKTOK_LOGIN_REDIRECT_URI,
        state,
    });

    res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

app.get('/api/tiktok/oauth/callback', async (req: Request, res: Response) => {
    const returnTo = sanitizeRelativeReturnPath(String(req.session.tiktokOauthReturnTo || '/app'));
    const code = String(req.query.code || '').trim();
    const state = String(req.query.state || '').trim();
    const error = String(req.query.error || '').trim();
    const errorDescription = String(req.query.error_description || '').trim();
    const expectedState = String(req.session.tiktokOauthState || '').trim();
    const expectedUserId = Number(req.session.tiktokOauthUserId || 0);

    const redirectWithError = (message: string): void => {
        clearTikTokOAuthSessionState(req);
        res.redirect(buildTikTokReturnPath(returnTo, 'error', message));
    };

    if (!expectedState || !expectedUserId) {
        redirectWithError('TikTok connect session expired. Start from Connect TikTok again.');
        return;
    }

    if (error) {
        const detail = [error, errorDescription].filter(Boolean).join(': ');
        redirectWithError(detail || 'TikTok authorization was cancelled.');
        return;
    }

    if (!state || state !== expectedState) {
        redirectWithError('Invalid TikTok authorization state. Please try again.');
        return;
    }

    if (!code) {
        redirectWithError('Missing TikTok authorization code.');
        return;
    }

    if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !TIKTOK_LOGIN_REDIRECT_URI) {
        redirectWithError('TikTok OAuth is not configured on the server.');
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

        const tokenResponse = await axios.post(`${TIKTOK_API_BASE}/v2/oauth/token/`, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            validateStatus: () => true,
        });

        if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
            redirectWithError(`TikTok token exchange failed (${tokenResponse.status}).`);
            return;
        }

        const accessToken = String(tokenResponse.data?.access_token || '').trim();
        const refreshToken = String(tokenResponse.data?.refresh_token || '').trim();
        const tokenType = String(tokenResponse.data?.token_type || 'Bearer').trim();
        const scopeList = normalizeTikTokScopes(tokenResponse.data?.scope);
        const scopes = scopeList.length > 0 ? scopeList : [...TIKTOK_OAUTH_SCOPES];
        const openIdFromToken = String(tokenResponse.data?.open_id || '').trim();

        if (!accessToken) {
            redirectWithError('TikTok token exchange did not return an access token.');
            return;
        }

        let profileOpenId = openIdFromToken;
        let profileUsername = '';
        let profileDisplayName = '';
        let profileAvatarUrl = '';

        try {
            const userInfoResponse = await axios.get(
                `${TIKTOK_API_BASE}/v2/user/info/?fields=open_id,username,display_name,avatar_url`,
                {
                    headers: { Authorization: `Bearer ${accessToken}` },
                    validateStatus: () => true,
                }
            );
            if (userInfoResponse.status >= 200 && userInfoResponse.status < 300) {
                const userInfo = userInfoResponse.data?.data?.user || {};
                profileOpenId = String(userInfo?.open_id || profileOpenId || '').trim();
                profileUsername = String(userInfo?.username || '').trim();
                profileDisplayName = String(userInfo?.display_name || '').trim();
                profileAvatarUrl = String(userInfo?.avatar_url || '').trim();
            }
        } catch {
            // Keep OAuth successful even if profile fetch fails.
        }

        upsertTikTokOAuthAccount({
            userId: expectedUserId,
            openId: profileOpenId,
            scopes,
            accessToken,
            refreshToken,
            accessTokenExpiresAt: toFutureIso(tokenResponse.data?.expires_in),
            refreshTokenExpiresAt: toFutureIso(tokenResponse.data?.refresh_expires_in),
            tokenType,
            username: profileUsername,
            displayName: profileDisplayName,
            avatarUrl: profileAvatarUrl,
        });

        clearTikTokOAuthSessionState(req);
        res.redirect(buildTikTokReturnPath(returnTo, 'success'));
    } catch (err) {
        redirectWithError(err instanceof Error ? err.message : 'TikTok callback error');
    }
});

app.post('/api/tiktok/upload-mode', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const rawMode = String((req.body as { mode?: string } | undefined)?.mode || '').trim().toLowerCase();
    if (rawMode && rawMode !== 'draft' && rawMode !== 'direct') {
        res.status(400).json({ error: 'Invalid upload mode. Use "draft" or "direct".' });
        return;
    }

    const mode = saveTikTokUploadModeForUser(userId, normalizeTikTokUploadMode(rawMode || 'draft'));
    res.json({ success: true, uploadMode: mode, tiktok: getTikTokAccountView(userId) });
});

app.post('/api/tiktok/demo/connect', requireAuth, (req: Request, res: Response) => {
    if (!TIKTOK_DEMO_MODE) {
        res.status(403).json({ error: 'TikTok demo mode is disabled.' });
        return;
    }
    const userId = getRequiredUserId(req);
    try {
        connectDemoTikTokAccount(userId);
        res.json({ success: true, tiktok: getTikTokAccountView(userId) });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not connect TikTok demo account.' });
    }
});

app.post('/api/tiktok/disconnect', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    disconnectTikTokAccount(userId);
    res.json({ success: true, tiktok: getTikTokAccountView(userId) });
});

app.get('/api/tiktok/debug', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const account = getTikTokAccountView(userId);
    const authorizeParams = new URLSearchParams({
        client_key: maskCredential(TIKTOK_CLIENT_KEY),
        response_type: 'code',
        scope: TIKTOK_OAUTH_SCOPES.join(','),
        redirect_uri: TIKTOK_LOGIN_REDIRECT_URI,
        state: 'debug-state',
    });

    res.json({
        configured: Boolean(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET && TIKTOK_LOGIN_REDIRECT_URI),
        demoMode: TIKTOK_DEMO_MODE,
        apiBase: TIKTOK_API_BASE,
        redirectUri: TIKTOK_LOGIN_REDIRECT_URI,
        oauthScopes: TIKTOK_OAUTH_SCOPES,
        clientKeyMasked: maskCredential(TIKTOK_CLIENT_KEY),
        clientSecretSet: Boolean(TIKTOK_CLIENT_SECRET),
        authorizeUrlPreview: `https://www.tiktok.com/v2/auth/authorize/?${authorizeParams.toString()}`,
        sessionState: {
            hasTikTokOauthState: Boolean(req.session.tiktokOauthState),
            tiktokOauthUserId: Number(req.session.tiktokOauthUserId || 0) || null,
            tiktokOauthReturnTo: String(req.session.tiktokOauthReturnTo || ''),
        },
        account,
    });
});

app.get('/api/me/streamers', requireAuth, async (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    await hydrateMissingStreamerMetadata(userId);
    res.json({ streamers: getAllUserStreamers(userId) });
});

app.post('/api/me/streamers', requireAuth, async (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const rawInputs = (req.body as { streamers?: string[] | string } | undefined)?.streamers;
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
        const added: string[] = [];
        const unresolved: string[] = [];

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
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save streamers' });
    }
});

app.post('/api/me/streamers/add', requireAuth, async (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const input = String((req.body as { streamer?: string } | undefined)?.streamer || '').trim();
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
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to add streamer' });
    }
});

app.delete('/api/me/streamers/:broadcasterId', requireAuth, (req: Request, res: Response) => {
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

app.delete('/api/me/streamers/by-row/:rowId', requireAuth, (req: Request, res: Response) => {
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

app.get('/api/clips', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = getRequiredUserId(req);
        const visibleClips = getAllClips(userId).filter(c => c.view_count >= MIN_CLIP_VIEWS);
        res.json(visibleClips);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch clips' });
    }
});

app.post('/api/clips/refresh', requireAuth, async (req: Request, res: Response) => {
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to refresh clips from Twitch' });
    }
});

app.post('/api/approve/:clipId', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    db.prepare('UPDATE user_clip_state SET approved = 1 WHERE user_id = $user_id AND clip_id = $id').run({ $user_id: userId, $id: clipId });
    res.json({ success: true });
});

app.delete('/api/approve/:clipId', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    db.prepare('UPDATE user_clip_state SET approved = 0 WHERE user_id = $user_id AND clip_id = $id').run({ $user_id: userId, $id: clipId });
    res.json({ success: true });
});

app.post('/api/sortout/:clipId', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    db.prepare('UPDATE user_clip_state SET sorted_out = 1 WHERE user_id = $user_id AND clip_id = $id').run({ $user_id: userId, $id: clipId });
    res.json({ success: true });
});

app.delete('/api/sortout/:clipId', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    db.prepare('UPDATE user_clip_state SET sorted_out = 0 WHERE user_id = $user_id AND clip_id = $id').run({ $user_id: userId, $id: clipId });
    res.json({ success: true });
});

app.get('/api/clips/:clipId/video', requireAuth, async (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;

    const row = db.prepare(`
        SELECT c.id, c.url, c.thumbnail_url
        FROM clips c
        JOIN user_clip_state s ON s.clip_id = c.id
        WHERE c.id = $id AND s.user_id = $user_id
        LIMIT 1
    `).get({ $id: clipId, $user_id: userId }) as DbClipRow | undefined;
    if (!row) {
        res.status(404).json({ error: 'Clip not found' });
        return;
    }

    const attemptStream = async (forceFresh: boolean): Promise<void> => {
        const resolvedUrl = await resolveClipVideoUrl(row, forceFresh);
        if (!resolvedUrl) throw new Error('Failed to resolve a Twitch clip MP4 URL');

        const rangeHeader = req.headers.range;
        const upstream = await axios.get(resolvedUrl, {
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
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
        if (upstream.headers['accept-ranges']) {
            res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
        } else {
            res.setHeader('Accept-Ranges', 'bytes');
        }
        res.setHeader('Cache-Control', 'private, max-age=300');
        upstream.data.pipe(res);
    };

    try {
        await attemptStream(false);
        return;
    } catch (err) {
        try {
            await attemptStream(true);
            return;
        } catch {
            try {
                const fallbackPath = await ensurePreviewFallbackFile(row);
                await streamLocalVideoWithRange(req, res, fallbackPath);
                return;
            } catch (fallbackErr) {
                const baseError = err instanceof Error ? err.message : 'Failed to stream clip preview video';
                const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : 'yt-dlp fallback failed';
                res.status(502).json({ error: `${baseError}; fallback: ${fallbackMessage}` });
                return;
            }
        }
    }
});

app.get('/api/clips/:clipId/download-cropped', requireAuth, async (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    const downloadJobKey = `${userId}:${clipId}`;

    if (activeDownloadJobs.has(downloadJobKey)) {
        res.status(409).json({ error: 'This clip download is already in progress.' });
        return;
    }
    activeDownloadJobs.add(downloadJobKey);

    let released = false;
    const releaseDownloadLock = (): void => {
        if (released) return;
        released = true;
        activeDownloadJobs.delete(downloadJobKey);
    };

    let outputPath: string | null = null;
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
        if (cleaned || !outputPath) return;
        cleaned = true;
        await fs.promises.rm(outputPath, { force: true }).catch(() => {});
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
                s.twitch_name_text,
                s.twitch_name_scale,
                s.gameplay_x,
                s.gameplay_y,
                s.gameplay_w,
                s.gameplay_h,
                s.third_x,
                s.third_y,
                s.third_w,
                s.third_h,
                s.cam_output_y,
                s.cam_output_h,
                s.gameplay_output_y,
                s.gameplay_output_h,
                s.third_area_enabled,
                s.third_output_x,
                s.third_output_y,
                s.third_output_w,
                s.third_output_h,
                s.split_points_json,
                s.split_deleted_segments_json,
                s.split_zoom_segments_json,
                s.split_zoom_layouts_json,
                s.overlay_items_json,
                s.overlay_enabled,
                s.overlay_media_path,
                s.overlay_media_mime,
                s.overlay_start_sec,
                s.overlay_end_sec,
                s.overlay_x,
                s.overlay_y,
                s.overlay_w,
                s.overlay_h
            FROM clips c
            JOIN user_clip_state s ON s.clip_id = c.id
            WHERE c.id = $id AND s.user_id = $user_id
            LIMIT 1
        `).get({ $id: clipId, $user_id: userId }) as DbClipRow | undefined;
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
            } else {
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
    } catch (err) {
        await cleanup();
        releaseDownloadLock();
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to generate cropped video' });
    }
});

app.post('/api/tiktok/upload-approved', requireAuth, async (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const limitRaw = (req.body as { limit?: number | string } | undefined)?.limit;
    const dryRun = Boolean((req.body as { dryRun?: boolean } | undefined)?.dryRun);
    const limit = parseUploadLimit(limitRaw);
    const uploadMode = getTikTokUploadModeForUser(userId);

    const approved = getApprovedClips(userId, limit);

    if (approved.length === 0) {
        res.json({ success: true, total: 0, uploaded: 0, failed: 0, uploadMode, results: [] });
        return;
    }

    try {
        await ensureTikTokUploadReady(userId, uploadMode);
    } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'TikTok upload is not ready.' });
        return;
    }

    const results: ClipUploadResult[] = [];
    for (const clip of approved) {
        const result = await uploadSingleClipToTikTok(userId, clip, uploadMode, dryRun);
        results.push(result);
        if (!dryRun && result.status === 'uploaded') {
            markClipUploadedForUser(userId, clip.id);
        }
    }

    const uploaded = results.filter(r => r.status === 'uploaded').length;
    const failed = results.length - uploaded;
    res.json({
        success: failed === 0,
        dryRun,
        uploadMode,
        total: results.length,
        uploaded,
        failed,
        results,
    });
});

app.post('/api/tiktok/upload-jobs', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = getRequiredUserId(req);
        const limitRaw = (req.body as { limit?: number | string } | undefined)?.limit;
        const dryRun = Boolean((req.body as { dryRun?: boolean } | undefined)?.dryRun);
        const limit = parseUploadLimit(limitRaw);
        const job = await startUploadJob(userId, limit, dryRun);

        res.status(202).json({ success: true, job: toJobSnapshot(job) });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not start upload job';
        const statusCode = /scope|connect tiktok|permission|expired/i.test(message) ? 400 : 409;
        res.status(statusCode).json({ error: message });
    }
});

app.get('/api/tiktok/upload-jobs/active', requireAuth, (req: Request, res: Response) => {
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

app.get('/api/tiktok/upload-jobs/:jobId', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { jobId } = req.params;
    const job = uploadJobs.get(jobId);
    if (!job || job.userId !== userId) {
        res.status(404).json({ error: 'Upload job not found' });
        return;
    }

    res.json({ success: true, job: toJobSnapshot(job) });
});

app.post('/api/tiktok/upload-jobs/:jobId/pause', requireAuth, (req: Request, res: Response) => {
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

app.post('/api/tiktok/upload-jobs/:jobId/resume', requireAuth, (req: Request, res: Response) => {
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
    if (job.status === 'paused') job.status = 'running';
    job.updatedAt = new Date().toISOString();
    res.json({ success: true, job: toJobSnapshot(job) });
});

app.post('/api/tiktok/upload-jobs/:jobId/cancel', requireAuth, (req: Request, res: Response) => {
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
app.get('/api/admin/db', requireAuth, (req: Request, res: Response) => {
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
    } catch (err) {
        console.error('Admin DB endpoint error:', err);
        res.status(500).json({ error: 'Failed to fetch database info' });
    }
});

app.get('/api/analytics/tags', requireAuth, (req: Request, res: Response) => {
    try {
        const userId = getRequiredUserId(req);
        const rows = db.prepare(`
            SELECT clip_tags_json
            FROM user_clip_state
            WHERE user_id = $user_id AND uploaded_to_tiktok = 1
        `).all({ $user_id: userId }) as Array<{ clip_tags_json: string | null }>;

        const counts = new Map<string, number>();
        for (const tag of CLIP_TAG_OPTIONS) counts.set(tag, 0);

        for (const row of rows) {
            const tags = parseClipTagsJson(row.clip_tags_json);
            for (const tag of tags) {
                counts.set(tag, (counts.get(tag) || 0) + 1);
            }
        }

        res.json({
            uploadedByTag: CLIP_TAG_OPTIONS.map((tag) => ({ tag, count: counts.get(tag) || 0 })),
            totalUploadedClips: rows.length,
            performanceByTag: CLIP_TAG_OPTIONS.map((tag) => ({ tag, value: null })),
        });
    } catch (err) {
        console.error('Tag analytics endpoint error:', err);
        res.status(500).json({ error: 'Failed to build tag analytics' });
    }
});

// ── Crop editor endpoints ────────────────────────────────────────────────
app.get('/api/crop/:clipId', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;

    const row = db.prepare(`
        SELECT c.id, c.broadcaster_name, s.approved, s.cam_x, s.cam_y, s.cam_w, s.cam_h, s.cam_enabled, s.twitch_name_enabled, s.twitch_name_x, s.twitch_name_y, s.twitch_name_text, s.twitch_name_scale, s.gameplay_x, s.gameplay_y, s.gameplay_w, s.gameplay_h, s.third_x, s.third_y, s.third_w, s.third_h, s.cam_output_y, s.cam_output_h, s.gameplay_output_y, s.gameplay_output_h
             , s.third_area_enabled, s.third_output_x, s.third_output_y, s.third_output_w, s.third_output_h
             , s.split_points_json, s.split_deleted_segments_json, s.split_zoom_segments_json, s.split_zoom_layouts_json
             , s.overlay_items_json
             , s.overlay_enabled, s.overlay_media_path, s.overlay_media_mime, s.overlay_start_sec, s.overlay_end_sec, s.overlay_x, s.overlay_y, s.overlay_w, s.overlay_h
             , s.clip_tags_json
        FROM clips c
        JOIN user_clip_state s ON s.clip_id = c.id
        WHERE c.id = $id AND s.user_id = $user_id
        LIMIT 1
    `).get({ $id: clipId, $user_id: userId }) as DbClipRow | undefined;

    if (!row) {
        res.status(404).json({ error: 'Clip not found' });
        return;
    }
    const overlayItems = getOverlayItemsForClipRow(row)
        .filter((item) => {
            const mediaPath = resolveOverlayPathFromRef(item.mediaRef);
            return !!mediaPath && fs.existsSync(mediaPath);
        })
        .map((item) => ({
            id: item.id,
            enabled: item.enabled ? 1 : 0,
            media_ref: item.mediaRef,
            label: item.label,
            media_mime: item.mediaMime,
            media_url: buildOverlayMediaUrlByRef(row.id, item.mediaRef),
            start_sec: item.startSec,
            end_sec: item.endSec,
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
        }));
    const firstOverlay = overlayItems[0] || null;

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
            twitch_name_text: row.twitch_name_text || row.broadcaster_name || '',
            twitch_name_scale: Number.isFinite(row.twitch_name_scale as number) ? Number(row.twitch_name_scale) : 1,
            gameplay_x: row.gameplay_x,
            gameplay_y: row.gameplay_y,
            gameplay_w: row.gameplay_w,
            gameplay_h: row.gameplay_h,
            third_x: row.third_x,
            third_y: row.third_y,
            third_w: row.third_w,
            third_h: row.third_h,
            cam_output_y: row.cam_output_y,
            cam_output_h: row.cam_output_h,
            gameplay_output_y: row.gameplay_output_y,
            gameplay_output_h: row.gameplay_output_h,
            third_area_enabled: row.third_area_enabled === 1 ? 1 : 0,
            third_output_x: row.third_output_x,
            third_output_y: row.third_output_y,
            third_output_w: row.third_output_w,
            third_output_h: row.third_output_h,
            split_points: parseJsonNumberArray(row.split_points_json),
            split_deleted_segments: parseJsonIntArray(row.split_deleted_segments_json),
            split_zoom_segments: parseJsonIntArray(row.split_zoom_segments_json),
            split_zoom_layouts: parseJsonZoomLayoutMap(row.split_zoom_layouts_json),
            overlay_items: overlayItems,
            // Keep legacy single-overlay fields for backwards compatibility with older clients.
            overlay_enabled: firstOverlay ? 1 : 0,
            overlay_media_mime: firstOverlay?.media_mime || null,
            overlay_media_url: firstOverlay?.media_url || null,
            overlay_start_sec: firstOverlay ? Number(firstOverlay.start_sec) : 0,
            overlay_end_sec: firstOverlay ? Number(firstOverlay.end_sec) : 4,
            overlay_x: firstOverlay ? Number(firstOverlay.x) : 0.06,
            overlay_y: firstOverlay ? Number(firstOverlay.y) : 0.06,
            overlay_w: firstOverlay ? Number(firstOverlay.w) : 0.34,
            overlay_h: firstOverlay ? Number(firstOverlay.h) : 0.24,
            clip_tags: parseClipTagsJson(row.clip_tags_json),
        }
    });
});

app.get('/api/crop/:clipId/overlay-media/:mediaRef', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = getRequiredUserId(req);
        const { clipId, mediaRef } = req.params;
        const safeMediaRef = sanitizeOverlayMediaRef(mediaRef);
        if (!safeMediaRef) {
            res.status(404).json({ error: 'Overlay media not found' });
            return;
        }

        const row = db.prepare(`
            SELECT overlay_items_json, overlay_enabled, overlay_media_path, overlay_media_mime
            FROM user_clip_state
            WHERE clip_id = $id AND user_id = $user_id
            LIMIT 1
        `).get({ $id: clipId, $user_id: userId }) as { overlay_items_json?: string | null; overlay_enabled?: number | null; overlay_media_path?: string | null; overlay_media_mime?: string | null } | undefined;

        if (!row) {
            res.status(404).json({ error: 'Overlay media not found' });
            return;
        }

        const allowedRefs = new Set<string>();
        getOverlayItemsForClipRow(row as DbClipRow).forEach((item) => {
            allowedRefs.add(item.mediaRef);
        });
        if (Number(row.overlay_enabled || 0) === 1) {
            const legacyPath = resolveSafeOverlayMediaPath(row.overlay_media_path);
            if (legacyPath) {
                const legacyRef = sanitizeOverlayMediaRef(path.basename(legacyPath));
                if (legacyRef) allowedRefs.add(legacyRef);
            }
        }

        const uploadPrefix = `${userId}_${clipId}_`;
        const canReadByOwnershipPrefix = safeMediaRef.startsWith(uploadPrefix);
        if (!allowedRefs.has(safeMediaRef) && !canReadByOwnershipPrefix) {
            res.status(404).json({ error: 'Overlay media not found' });
            return;
        }

        const overlayPath = resolveOverlayPathFromRef(safeMediaRef);
        if (!overlayPath || !fs.existsSync(overlayPath)) {
            res.status(404).json({ error: 'Overlay media not found' });
            return;
        }

        const mime = inferOverlayMimeFromRef(safeMediaRef) || normalizeOverlayMime(row.overlay_media_mime) || 'application/octet-stream';
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Content-Type', mime);
        res.sendFile(overlayPath);
    } catch {
        res.status(500).json({ error: 'Could not load overlay media' });
    }
});

app.post('/api/crop/:clipId/overlay-media', requireAuth, async (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    const { data_url, mime_type } = req.body as Record<string, unknown>;

    const parsed = parseOverlayDataUrl(data_url);
    if (!parsed) {
        res.status(400).json({ error: 'Invalid image/gif payload. Use a base64 data URL up to 24MB.' });
        return;
    }

    const mime = normalizeOverlayMime(mime_type) || parsed.mime;
    const ext = extensionForOverlayMime(mime);
    if (!ext) {
        res.status(400).json({ error: 'Unsupported image/gif type. Use png, jpg, webp, or gif.' });
        return;
    }

    const currentRow = db.prepare(`
        SELECT approved
        FROM user_clip_state
        WHERE clip_id = $id AND user_id = $user_id
        LIMIT 1
    `).get({ $id: clipId, $user_id: userId }) as { approved?: number | null } | undefined;
    if (!currentRow || Number(currentRow.approved || 0) !== 1) {
        res.status(400).json({ error: 'Overlay can only be added to approved clips.' });
        return;
    }

    await fs.promises.mkdir(OVERLAY_MEDIA_DIR, { recursive: true });
    const fileToken = `${userId}_${clipId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const outputPath = path.join(OVERLAY_MEDIA_DIR, `${fileToken}.${ext}`);
    await fs.promises.writeFile(outputPath, parsed.buffer);
    const mediaRef = path.basename(outputPath);

    res.json({
        success: true,
        overlay: {
            media_ref: mediaRef,
            media_mime: mime,
            media_url: buildOverlayMediaUrlByRef(clipId, mediaRef),
            overlay_media_mime: mime,
            overlay_media_url: buildOverlayMediaUrlByRef(clipId, mediaRef),
        },
    });
});

app.post('/api/crop/:clipId', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;
    const {
        cam_x, cam_y, cam_w, cam_h,
        cam_enabled,
        twitch_name_enabled,
        twitch_name_x,
        twitch_name_y,
        twitch_name_text,
        twitch_name_scale,
        gameplay_x, gameplay_y, gameplay_w, gameplay_h,
        third_x, third_y, third_w, third_h,
        cam_output_y,
        cam_output_h,
        gameplay_output_y,
        gameplay_output_h,
        third_area_enabled,
        third_output_x,
        third_output_y,
        third_output_w,
        third_output_h,
        split_points,
        split_deleted_segments,
        split_zoom_segments,
        split_zoom_layouts,
        overlay_items,
        overlay_enabled,
        overlay_start_sec,
        overlay_end_sec,
        overlay_x,
        overlay_y,
        overlay_w,
        overlay_h,
        clip_tags,
    } = req.body as Record<string, unknown>;

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

    const parsedTwitchNameText = parseTwitchNameText(twitch_name_text);
    if (parsedTwitchNameText === null) {
        res.status(400).json({ error: 'Invalid twitch_name_text value. Use a string up to 64 characters with no bad words.' });
        return;
    }

    const parsedTwitchNameScale = parseTwitchNameScale(twitch_name_scale);
    if (parsedTwitchNameScale === null) {
        res.status(400).json({ error: 'Invalid twitch_name_scale value. Use a number between 0.65 and 2.4.' });
        return;
    }

    const parsedThirdAreaEnabled = parseCamEnabled(third_area_enabled);
    if (parsedThirdAreaEnabled === null) {
        res.status(400).json({ error: 'Invalid third_area_enabled value. Use 0 or 1.' });
        return;
    }

    const values = [cam_x, cam_y, cam_w, cam_h, gameplay_x, gameplay_y, gameplay_w, gameplay_h, third_x, third_y, third_w, third_h];
    if (!values.every(isValidCropNumber) || (cam_w as number) <= 0 || (cam_h as number) <= 0 || (gameplay_w as number) <= 0 || (gameplay_h as number) <= 0 || (third_w as number) <= 0 || (third_h as number) <= 0 || ((third_x as number) + (third_w as number)) > 1 || ((third_y as number) + (third_h as number)) > 1) {
        res.status(400).json({ error: 'Invalid crop values. Use numbers between 0 and 1.' });
        return;
    }

    const outputLayoutValues = [cam_output_y, cam_output_h];
    if (!outputLayoutValues.every(isValidCropNumber) || (cam_output_h as number) < 0.05 || ((cam_output_y as number) + (cam_output_h as number)) > 1) {
        res.status(400).json({ error: 'Invalid cam output layout. Keep height >= 0.05 and inside the 9:16 frame.' });
        return;
    }

    const gameplayOutputLayoutValues = [gameplay_output_y, gameplay_output_h];
    if (!gameplayOutputLayoutValues.every(isValidCropNumber) || (gameplay_output_h as number) < 0.05 || ((gameplay_output_y as number) + (gameplay_output_h as number)) > 1) {
        res.status(400).json({ error: 'Invalid gameplay output layout. Keep height >= 0.05 and inside the 9:16 frame.' });
        return;
    }

    const thirdOutputValues = [third_output_x, third_output_y, third_output_w, third_output_h];
    if (!thirdOutputValues.every(isValidCropNumber) || (third_output_w as number) < 0.06 || (third_output_h as number) < 0.06 || ((third_output_x as number) + (third_output_w as number)) > 1 || ((third_output_y as number) + (third_output_h as number)) > 1) {
        res.status(400).json({ error: 'Invalid third output area. Keep width/height >= 0.06 and inside the 9:16 frame.' });
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

    const parsedSplitZoomLayouts = parseSplitZoomLayoutsPayload(split_zoom_layouts, parsedSplitPoints.length + 1);
    if (parsedSplitZoomLayouts === null) {
        res.status(400).json({ error: 'Invalid split_zoom_layouts. Provide an object of segment indexes with x/y/width/height values.' });
        return;
    }

    const parsedClipTags = parseClipTagsPayload(clip_tags);
    if (parsedClipTags === null) {
        res.status(400).json({ error: `Invalid clip_tags. Use an array of: ${CLIP_TAG_OPTIONS.join(', ')}.` });
        return;
    }

    const existingRow = db.prepare(`
        SELECT overlay_items_json, overlay_media_path, overlay_media_mime, overlay_enabled, approved
        FROM user_clip_state
        WHERE clip_id = $id AND user_id = $user_id
        LIMIT 1
    `).get({ $id: clipId, $user_id: userId }) as {
        overlay_items_json?: string | null;
        overlay_media_path?: string | null;
        overlay_media_mime?: string | null;
        overlay_enabled?: number | null;
        approved?: number | null;
    } | undefined;

    if (!existingRow || Number(existingRow.approved || 0) !== 1) {
        res.status(400).json({ error: 'Crop can only be saved for approved clips.' });
        return;
    }

    let nextOverlayItems: OverlayItemConfig[] = [];
    if (overlay_items !== undefined) {
        const parsedOverlayItems = parseOverlayItemsPayload(overlay_items);
        if (parsedOverlayItems === null) {
            res.status(400).json({ error: 'Invalid overlay_items. Provide an array of overlay entries.' });
            return;
        }
        nextOverlayItems = parsedOverlayItems;
    } else {
        // Backward compatibility for legacy clients still posting single-overlay fields.
        const parsedOverlayEnabled = parseCamEnabled(overlay_enabled);
        if (parsedOverlayEnabled === null) {
            res.status(400).json({ error: 'Invalid overlay_enabled value. Use 0 or 1.' });
            return;
        }
        if (parsedOverlayEnabled === 0) {
            nextOverlayItems = [];
        } else {
            const overlayStartSec = Number.isFinite(Number(overlay_start_sec)) ? Number(overlay_start_sec) : 0;
            const overlayEndSec = Number.isFinite(Number(overlay_end_sec)) ? Number(overlay_end_sec) : Math.max(0.8, overlayStartSec + 4);
            const overlayTimingValues = [overlayStartSec, overlayEndSec];
            if (overlayTimingValues.some((value) => !Number.isFinite(value) || value < 0 || value > 600) || overlayTimingValues[1] <= (overlayTimingValues[0] + 0.05)) {
                res.status(400).json({ error: 'Invalid overlay timing. Use start/end seconds where end is at least 0.05s after start.' });
                return;
            }
            const overlayX = Number.isFinite(Number(overlay_x)) ? Number(overlay_x) : 0.06;
            const overlayY = Number.isFinite(Number(overlay_y)) ? Number(overlay_y) : 0.06;
            const overlayW = Number.isFinite(Number(overlay_w)) ? Number(overlay_w) : 0.34;
            const overlayH = Number.isFinite(Number(overlay_h)) ? Number(overlay_h) : 0.24;
            const overlayLayoutValues = [overlayX, overlayY, overlayW, overlayH];
            if (!overlayLayoutValues.every(isValidCropNumber) || overlayW < 0.05 || overlayH < 0.05 || (overlayX + overlayW) > 1 || (overlayY + overlayH) > 1) {
                res.status(400).json({ error: 'Invalid overlay layout. Keep width/height >= 0.05 and inside the 9:16 frame.' });
                return;
            }

            const existingOverlayPath = resolveSafeOverlayMediaPath(existingRow.overlay_media_path);
            const existingOverlayRef = existingOverlayPath ? sanitizeOverlayMediaRef(path.basename(existingOverlayPath)) : null;
            const existingOverlayMime = normalizeOverlayMime(existingRow.overlay_media_mime) || (existingOverlayRef ? inferOverlayMimeFromRef(existingOverlayRef) : null);
            if (!existingOverlayRef || !existingOverlayMime || !existingOverlayPath || !fs.existsSync(existingOverlayPath)) {
                res.status(400).json({ error: 'Upload an image/gif first before enabling overlay.' });
                return;
            }

            nextOverlayItems = normalizeOverlayItems([{
                id: 'ov_legacy_1',
                enabled: 1,
                media_ref: existingOverlayRef,
                label: sanitizeOverlayLabel(existingOverlayRef),
                media_mime: existingOverlayMime,
                start_sec: overlayStartSec,
                end_sec: overlayEndSec,
                x: overlayX,
                y: overlayY,
                w: overlayW,
                h: overlayH,
            }], 1);
        }
    }

    for (const item of nextOverlayItems) {
        const mediaPath = resolveOverlayPathFromRef(item.mediaRef);
        if (!mediaPath || !fs.existsSync(mediaPath)) {
            res.status(400).json({ error: `Overlay media missing for item ${item.id}. Please re-upload image/gif.` });
            return;
        }
    }

    const firstOverlay = nextOverlayItems[0] || null;
    const firstOverlayPath = firstOverlay ? resolveOverlayPathFromRef(firstOverlay.mediaRef) : null;
    const firstOverlayMime = firstOverlay ? normalizeOverlayMime(firstOverlay.mediaMime) : null;

    const updated = db.prepare(`
        UPDATE user_clip_state
        SET cam_x = $cam_x,
            cam_y = $cam_y,
            cam_w = $cam_w,
            cam_h = $cam_h,
            cam_enabled = $cam_enabled,
            twitch_name_enabled = $twitch_name_enabled,
            third_area_enabled = $third_area_enabled,
            twitch_name_x = $twitch_name_x,
            twitch_name_y = $twitch_name_y,
            twitch_name_text = $twitch_name_text,
            twitch_name_scale = $twitch_name_scale,
            gameplay_x = $gameplay_x,
            gameplay_y = $gameplay_y,
            gameplay_w = $gameplay_w,
            gameplay_h = $gameplay_h,
            third_x = $third_x,
            third_y = $third_y,
            third_w = $third_w,
            third_h = $third_h,
            cam_output_y = $cam_output_y,
            cam_output_h = $cam_output_h,
            gameplay_output_y = $gameplay_output_y,
            gameplay_output_h = $gameplay_output_h,
            third_output_x = $third_output_x,
            third_output_y = $third_output_y,
            third_output_w = $third_output_w,
            third_output_h = $third_output_h,
            split_points_json = $split_points_json,
            split_deleted_segments_json = $split_deleted_segments_json,
            split_zoom_segments_json = $split_zoom_segments_json,
            split_zoom_layouts_json = $split_zoom_layouts_json,
            overlay_items_json = $overlay_items_json,
            overlay_enabled = $overlay_enabled,
            overlay_media_path = $overlay_media_path,
            overlay_media_mime = $overlay_media_mime,
            overlay_start_sec = $overlay_start_sec,
            overlay_end_sec = $overlay_end_sec,
            overlay_x = $overlay_x,
            overlay_y = $overlay_y,
            overlay_w = $overlay_w,
            overlay_h = $overlay_h,
            clip_tags_json = $clip_tags_json
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
        $third_area_enabled: parsedThirdAreaEnabled,
        $twitch_name_x: twitch_name_x,
        $twitch_name_y: twitch_name_y,
        $twitch_name_text: parsedTwitchNameText,
        $twitch_name_scale: parsedTwitchNameScale,
        $gameplay_x: gameplay_x,
        $gameplay_y: gameplay_y,
        $gameplay_w: gameplay_w,
        $gameplay_h: gameplay_h,
        $third_x: third_x,
        $third_y: third_y,
        $third_w: third_w,
        $third_h: third_h,
        $cam_output_y: cam_output_y,
        $cam_output_h: cam_output_h,
        $gameplay_output_y: gameplay_output_y,
        $gameplay_output_h: gameplay_output_h,
        $third_output_x: third_output_x,
        $third_output_y: third_output_y,
        $third_output_w: third_output_w,
        $third_output_h: third_output_h,
        $split_points_json: JSON.stringify(parsedSplitPoints),
        $split_deleted_segments_json: JSON.stringify(parsedSplitDeletedSegments),
        $split_zoom_segments_json: JSON.stringify(parsedSplitZoomSegments),
        $split_zoom_layouts_json: JSON.stringify(parsedSplitZoomLayouts),
        $overlay_items_json: JSON.stringify(nextOverlayItems.map((item) => ({
            id: item.id,
            enabled: item.enabled ? 1 : 0,
            media_ref: item.mediaRef,
            label: item.label,
            media_mime: item.mediaMime,
            start_sec: item.startSec,
            end_sec: item.endSec,
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
        }))),
        $overlay_enabled: firstOverlay ? 1 : 0,
        $overlay_media_path: firstOverlayPath || null,
        $overlay_media_mime: firstOverlayMime || null,
        $overlay_start_sec: firstOverlay ? firstOverlay.startSec : null,
        $overlay_end_sec: firstOverlay ? firstOverlay.endSec : null,
        $overlay_x: firstOverlay ? firstOverlay.x : null,
        $overlay_y: firstOverlay ? firstOverlay.y : null,
        $overlay_w: firstOverlay ? firstOverlay.w : null,
        $overlay_h: firstOverlay ? firstOverlay.h : null,
        $clip_tags_json: JSON.stringify(parsedClipTags),
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
    scheduleOverlayMediaCleanup();
    console.log(`✅  Server running at http://localhost:${PORT}`);
    console.log(`🗄️  Database: ${DB_PATH}`);
    console.log(`🧩  Public assets: ${PUBLIC_DIR}`);
    console.log('👥  Multi-user mode enabled: each account manages its own streamer list.');
    console.log(`🧰  Twitch fetch config: lookback=${TWITCH_CLIPS_LOOKBACK_DAYS} days, max_pages=${TWITCH_CLIPS_MAX_PAGES}, page_size=${TWITCH_CLIPS_PAGE_SIZE}`);
    console.log(`🔎  Clip visibility filter: min_views=${MIN_CLIP_VIEWS}`);
    console.log(`[ffmpeg] render tuning: fps=${FFMPEG_OUTPUT_FPS}, gif_fps=${FFMPEG_GIF_FPS}, threads=${FFMPEG_THREAD_CAP || 'auto'}, filter_threads=${FFMPEG_FILTER_THREAD_CAP || 'auto'}, max_concurrent_renders=${MAX_CONCURRENT_RENDERS}, upload_preset=${DEFAULT_UPLOAD_VIDEO_PRESET}, download_preset=${DEFAULT_DOWNLOAD_VIDEO_PRESET}, upload_crf=${DEFAULT_UPLOAD_VIDEO_CRF}, download_crf=${DEFAULT_DOWNLOAD_VIDEO_CRF}`);
    console.log(`[cleanup] overlay-media retention=${OVERLAY_MEDIA_RETENTION_DAYS}d, interval=${OVERLAY_MEDIA_CLEANUP_INTERVAL_MINUTES}m, dir=${OVERLAY_MEDIA_DIR}`);
    console.log(`🔐  Session mode: ${IS_PRODUCTION ? 'production secure cookies enabled' : 'development cookies (non-secure)'}`);
});
