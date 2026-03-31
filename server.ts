import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
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
const TWITCH_LOGO_RELATIVE_PATH = path.join('pictures', 'twitchLogo.png');
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const CLIP_GQL_CACHE_TTL_MS = 10 * 60 * 1000;
const LEGACY_STREAMER_IDS = getStreamerIdsFromEnv();
const clipVideoUrlCache = new Map<string, { url: string; expiresAt: number }>();
const previewBuildJobs = new Map<string, Promise<string>>();
const activeDownloadJobs = new Set<string>();

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
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_points_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_deleted_segments_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_zoom_segments_json TEXT');
addColumnIfMissing('ALTER TABLE user_clip_state ADD COLUMN split_zoom_layouts_json TEXT');
addColumnIfMissing('ALTER TABLE users ADD COLUMN email TEXT');
addColumnIfMissing('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_nocase ON users(email COLLATE NOCASE) WHERE email IS NOT NULL AND email <> \'\'');
db.exec('CREATE INDEX IF NOT EXISTS email_verification_codes_expires_idx ON email_verification_codes(expires_at)');
db.exec('CREATE INDEX IF NOT EXISTS account_action_tokens_expires_idx ON account_action_tokens(expires_at)');
db.exec('CREATE INDEX IF NOT EXISTS account_action_tokens_user_idx ON account_action_tokens(user_id)');

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
                twitch_name_x, twitch_name_y, twitch_name_text,
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
                $twitch_name_x, $twitch_name_y, $twitch_name_text,
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

function getAllClips(userId: number): (Clip & { approved: boolean; sorted_out: boolean; fetched_at: string })[] {
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
            s.split_zoom_layouts_json
        FROM user_clip_state s
        JOIN clips c ON c.id = s.clip_id
        WHERE s.user_id = $user_id
        ORDER BY c.broadcaster_name COLLATE NOCASE ASC, c.view_count DESC
    `).all({ $user_id: userId }) as DbClipRow[];
    const allowedStreamerNames = listUserStreamerNameKeys(userId);
    const mapped = rows.map(r => ({ ...r, approved: r.approved === 1, sorted_out: r.sorted_out === 1 }));
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
            s.split_zoom_layouts_json
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

            const result = await uploadSingleClipToTikTok(clip, job.dryRun);
            job.results.push(result);
            job.processed += 1;
            if (result.status === 'uploaded') job.uploaded += 1;
            else job.failed += 1;
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

function startUploadJob(userId: number, limit: number, dryRun: boolean): UploadJobState {
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
    const job: UploadJobState = {
        jobId: randomUUID(),
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

function isValidCropNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
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
    twitchName: { enabled: boolean; x: number; y: number; text: string };
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
        zoomLayouts: normalizeSplitZoomLayouts(parseJsonZoomLayoutMap(clip.split_zoom_layouts_json), null),
    };

    return { cam, gameplay, third, camEnabled, camOutput, gameplayOutput, thirdOutput, twitchName, split };
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
        const { stdout } = await runCommandCaptureOutput('ffprobe', [
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
        const { stdout } = await runCommandCaptureOutput('ffprobe', [
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

function resolveDrawtextFontPath(): string | null {
    const candidates = [
        // Windows defaults
        'C:\\Windows\\Fonts\\segoeui.ttf',
        'C:\\Windows\\Fonts\\arial.ttf',
        // Common Linux fallback
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
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

async function processClipToTikTokFormat(inputPath: string, outputPath: string, clip: DbClipRow, videoPreset = 'medium'): Promise<void> {
    const { cam, gameplay, third, camEnabled, camOutput, gameplayOutput, thirdOutput, twitchName, split } = getCropOrDefault(clip);
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
    const drawtextFontPath = resolveDrawtextFontPath();
    const drawtextFontOpt = drawtextFontPath ? `:fontfile='${toFfmpegFilterPath(drawtextFontPath)}'` : '';

    const nameFontPx = Math.max(20, Math.round(outputH * 0.039));
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
    const canDrawNameText = Boolean(drawtextFontPath && safeTwitchName);
    const roundedMask = (alpha: number) => `if(lte(abs(X-W/2),W/2-H/2),${alpha},if(lte((X-H/2)*(X-H/2)+(Y-H/2)*(Y-H/2),(H/2)*(H/2)),${alpha},if(lte((X-(W-H/2))*(X-(W-H/2))+(Y-H/2)*(Y-H/2),(H/2)*(H/2)),${alpha},0)))`;
    const badgeSourceDurationSec = 86400;

    const splitPoints = normalizeSplitPoints(split.points, null);
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
        filterSteps.push(`[${sourceVideoLabel}]split=${splitTargets.length}${splitTargets.join('')}`);
        filterSteps.push(`[${gameplaySourceLabel}]crop=iw*${n(gameplay.w)}:ih*${n(gameplay.h)}:iw*${n(gameplay.x)}:ih*${n(gameplay.y)},scale=${outputW}:${gameplayOutputHeightPx}:flags=lanczos:force_original_aspect_ratio=disable,setsar=1[game]`);
        filterSteps.push(`color=c=black:s=${outputW}x${outputH}:d=${badgeSourceDurationSec}[layout_base]`);
        filterSteps.push(`[layout_base][game]overlay=0:${gameplayOutputYPx}:format=auto:shortest=1[bg]`);
        filterSteps.push(`[${camSourceLabel}]crop=iw*${n(cam.w)}:ih*${n(cam.h)}:iw*${n(cam.x)}:ih*${n(cam.y)},scale=${outputW}:${camOutputHeightPx}:flags=lanczos:force_original_aspect_ratio=disable,setsar=1[cam]`);
        const normalCamEnable = camEnabled ? notZoomExpr : '0';
        filterSteps.push(`[bg][cam]overlay=0:${camOutputYPx}:format=auto:enable='${normalCamEnable}'[base_norm]`);
        let normalBaseLabel = 'base_norm';
        if (thirdOutput.enabled && camThirdSourceLabel) {
            const thirdOverlayX = `${thirdOutputXPx}+(${thirdOutputWPx}-overlay_w)/2`;
            const thirdOverlayY = `${thirdOutputYPx}+(${thirdOutputHPx}-overlay_h)/2`;
            filterSteps.push(`[${camThirdSourceLabel}]crop=iw*${n(third.w)}:ih*${n(third.h)}:iw*${n(third.x)}:ih*${n(third.y)},scale=${thirdOutputWPx}:${thirdOutputHPx}:flags=lanczos:force_original_aspect_ratio=decrease,setsar=1[cam_third]`);
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
                filterSteps.push(`[${camZoomSourceLabels[idx]}]crop=iw*${n(cam.w)}:ih*${n(cam.h)}:iw*${n(cam.x)}:ih*${n(cam.y)},scale=${zoomW}:${zoomH}:flags=lanczos:force_original_aspect_ratio=decrease,setsar=1[${camZoomLabel}]`);
                filterSteps.push(`[${zoomBaseLabel}][${camZoomLabel}]overlay=${zoomOverlayX}:${zoomOverlayY}:format=auto:enable='${zoomExprForGroup}',setsar=1[${nextBaseLabel}]`);
                zoomBaseLabel = nextBaseLabel;
            });
        } else {
            filterSteps.push(`[${normalBaseLabel}]setsar=1[base]`);
        }
    } else {
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
        } else {
            filterSteps.push(`[${badgeOutLabel}]format=yuv420p[v]`);
        }
    } else {
        filterSteps.push('[base]format=yuv420p[v]');
    }

    const filter = filterSteps.join(';');

    const args = ['-y', '-i', inputPath];
    if (showNameBadge && logoPath) {
        args.push('-i', logoPath);
    }
    args.push(
        '-filter_complex', filter,
        '-map', '[v]',
    );

    if (sourceAudioLabel) {
        args.push('-map', `[${sourceAudioLabel}]`);
    } else if (!splitEnabled) {
        args.push('-map', '0:a?');
    }

    args.push(
        '-c:v', 'libx264',
        '-preset', videoPreset,
        '-crf', '21',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath,
    );

    await runCommand('ffmpeg', args);
}

async function uploadProcessedVideoToTikTok(processedPath: string, title: string): Promise<{ publishId?: string; message: string }> {
    if (!TIKTOK_ACCESS_TOKEN) {
        throw new Error('Missing TIKTOK_ACCESS_TOKEN in environment');
    }

    const stat = await fs.promises.stat(processedPath);
    const fileSize = stat.size;

    const initResponse = await axios.post(
        `${TIKTOK_API_BASE}/v2/post/publish/video/init/`,
        {
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
        },
        {
            headers: {
                Authorization: `Bearer ${TIKTOK_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
        }
    );

    if (initResponse.status < 200 || initResponse.status >= 300) {
        throw new Error(`TikTok init failed (${initResponse.status}): ${JSON.stringify(initResponse.data)}`);
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
        message: publishId ? `Uploaded to TikTok (publish_id=${publishId})` : 'Uploaded to TikTok',
    };
}

async function uploadSingleClipToTikTok(clip: DbClipRow, dryRun = false): Promise<ClipUploadResult> {
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
        await processClipToTikTokFormat(inPath, outPath, clip, 'veryfast');
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

function parseTwitchNameEnabled(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return 0;
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return null;
}

function parseTwitchNameText(value: unknown): string | null {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return null;
    return value
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64);
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

app.use(express.json());
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
    const user = getUserById(getRequiredUserId(req));
    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    res.json({
        username: user.username,
        email: user.email || '',
        emailMasked: maskEmail(user.email || ''),
        emailVerified: isEmailVerified(user),
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
    req.session.destroy(() => {});
    res.json({ success: true });
});

app.get('/api/tiktok/oauth/callback', async (req: Request, res: Response) => {
    const code = String(req.query.code || '').trim();
    const error = String(req.query.error || '').trim();
    const errorDescription = String(req.query.error_description || '').trim();

    if (error) {
        res.status(400).send(
            `<h1>TikTok authorization failed</h1><p>${error}</p><p>${errorDescription || 'No error description provided.'}</p>`
        );
        return;
    }

    if (!code) {
        res.status(400).send('<h1>Missing authorization code</h1><p>No code query parameter found.</p>');
        return;
    }

    // Keep callback usable even before full OAuth wiring is enabled in app config.
    if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !TIKTOK_LOGIN_REDIRECT_URI) {
        res.status(200).send(
            '<h1>TikTok callback reachable</h1><p>Code received. Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_LOGIN_REDIRECT_URI to auto-exchange tokens here.</p>'
        );
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
            res.status(502).send(
                `<h1>TikTok token exchange failed</h1><p>Status: ${tokenResponse.status}</p><pre>${JSON.stringify(tokenResponse.data, null, 2)}</pre>`
            );
            return;
        }

        const tokenType = String(tokenResponse.data?.token_type || 'unknown');
        const expiresIn = Number(tokenResponse.data?.expires_in || 0);
        const refreshExpiresIn = Number(tokenResponse.data?.refresh_expires_in || 0);
        res.status(200).send(
            `<h1>TikTok connected</h1><p>Token exchange succeeded.</p><p>token_type=${tokenType}, expires_in=${expiresIn}s, refresh_expires_in=${refreshExpiresIn}s</p><p>Next step: store this token per user in DB and use it for upload APIs.</p>`
        );
    } catch (err) {
        res.status(500).send(`<h1>TikTok callback error</h1><p>${err instanceof Error ? err.message : 'Unknown error'}</p>`);
    }
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
                s.split_zoom_layouts_json
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

    const approved = getApprovedClips(userId, limit);

    if (approved.length === 0) {
        res.json({ success: true, total: 0, uploaded: 0, failed: 0, results: [] });
        return;
    }

    const results: ClipUploadResult[] = [];
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

app.post('/api/tiktok/upload-jobs', requireAuth, (req: Request, res: Response) => {
    try {
        const userId = getRequiredUserId(req);
        const limitRaw = (req.body as { limit?: number | string } | undefined)?.limit;
        const dryRun = Boolean((req.body as { dryRun?: boolean } | undefined)?.dryRun);
        const limit = parseUploadLimit(limitRaw);
        const job = startUploadJob(userId, limit, dryRun);

        res.status(202).json({ success: true, job: toJobSnapshot(job) });
    } catch (err) {
        res.status(409).json({ error: err instanceof Error ? err.message : 'Could not start upload job' });
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

// ── Crop editor endpoints ────────────────────────────────────────────────
app.get('/api/crop/:clipId', requireAuth, (req: Request, res: Response) => {
    const userId = getRequiredUserId(req);
    const { clipId } = req.params;

    const row = db.prepare(`
        SELECT c.id, c.broadcaster_name, s.approved, s.cam_x, s.cam_y, s.cam_w, s.cam_h, s.cam_enabled, s.twitch_name_enabled, s.twitch_name_x, s.twitch_name_y, s.twitch_name_text, s.gameplay_x, s.gameplay_y, s.gameplay_w, s.gameplay_h, s.third_x, s.third_y, s.third_w, s.third_h, s.cam_output_y, s.cam_output_h, s.gameplay_output_y, s.gameplay_output_h
             , s.third_area_enabled, s.third_output_x, s.third_output_y, s.third_output_w, s.third_output_h
             , s.split_points_json, s.split_deleted_segments_json, s.split_zoom_segments_json, s.split_zoom_layouts_json
        FROM clips c
        JOIN user_clip_state s ON s.clip_id = c.id
        WHERE c.id = $id AND s.user_id = $user_id
        LIMIT 1
    `).get({ $id: clipId, $user_id: userId }) as DbClipRow | undefined;

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
            twitch_name_text: row.twitch_name_text || row.broadcaster_name || '',
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
        }
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
        res.status(400).json({ error: 'Invalid twitch_name_text value. Use a string up to 64 characters.' });
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
            split_zoom_layouts_json = $split_zoom_layouts_json
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
    console.log(`🧩  Public assets: ${PUBLIC_DIR}`);
    console.log('👥  Multi-user mode enabled: each account manages its own streamer list.');
    console.log(`🧰  Twitch fetch config: lookback=${TWITCH_CLIPS_LOOKBACK_DAYS} days, max_pages=${TWITCH_CLIPS_MAX_PAGES}, page_size=${TWITCH_CLIPS_PAGE_SIZE}`);
    console.log(`🔎  Clip visibility filter: min_views=${MIN_CLIP_VIEWS}`);
    console.log(`🔐  Session mode: ${IS_PRODUCTION ? 'production secure cookies enabled' : 'development cookies (non-secure)'}`);
});

