# AGENTS Guide

## Purpose
This repository is a single-service TypeScript/Express app for reviewing Twitch clips, cropping/exporting video, and uploading to TikTok.

Primary goals for agents:
- Keep auth/session flows safe.
- Avoid regressions in media rendering/export.
- Preserve per-user data isolation in SQLite queries.
- Keep frontend interactions responsive and XSS-safe.

## Quick Start
- Install deps: `npm install`
- Type-check/build: `npm run build`
- Start app (dev-style): `npm start`
- Smoke upload helper: `npm run upload:smoke`

## Tooling Note (Codex Sandbox)
- In this environment, `rg` (ripgrep) may fail in sandboxed runs with `Access is denied`.
- If that happens, rerun `rg` with escalated permissions instead of assuming ripgrep is missing.
- Fallback only if escalation is unavailable: PowerShell `Select-String` or `Get-ChildItem`.

## Project Map
- `server.ts`: Main backend (Express routes, auth, DB access, Twitch/TikTok integrations, ffmpeg pipeline).
- `public/index.html`: Main frontend SPA and UI logic.
- `public/tools/*`: Tool-specific static pages/assets.
- `scripts/smoke-upload.js`: Login + upload flow smoke script.
- `clips.db`: SQLite database (runtime state).
- `tmp/videos`, `tmp/overlay-media`: Temporary media output and overlay files.

## Architecture Notes
- Persistence: `node:sqlite` with a shared `DatabaseSync` connection.
- Auth: session-cookie auth via `express-session`; user identity in `req.session`.
- Media pipeline: Twitch source resolution -> optional yt-dlp fallback -> ffmpeg composition/transcode.
- TikTok upload supports draft and direct publish modes.

## Agent Guardrails
- Treat `server.ts` and `public/index.html` as high-risk, high-coupling files. Make minimal, well-scoped edits.
- Keep all SQL parameterized. Never build SQL with string interpolation for user data.
- Preserve user scoping (`WHERE ... user_id = $user_id`) on every read/write route.
- Do not loosen overlay/media path sanitization.
- Keep ffmpeg argument construction array-based (no shell interpolation).
- Use `escHtml(...)` or safe DOM APIs for all user/API-derived UI content.

## Known Hotspots
- Session/auth flows around login, verification, reset links.
- Clip video proxy route (`/api/clips/:clipId/video`) and stream error handling.
- Crop save payload parsing/validation (`/api/crop/:clipId`).
- TikTok OAuth callback + token refresh paths.
- Inline HTML builders in frontend cards/modals.

## Testing Checklist For Changes
When touching backend auth/media/upload/crop logic:
1. Run `npm run build`.
2. Validate login and logout flow manually.
3. Validate crop save + download for at least one approved clip.
4. If TikTok code changed, verify upload-mode toggle and job lifecycle endpoints.

When touching frontend rendering/state logic:
1. Validate login screen and app screen transitions.
2. Validate clips list render, clip modal, and crop modal open/close.
3. Validate no broken HTML in sections using `innerHTML` templates.

## Security Checklist For Agents
Before finalizing changes, confirm:
- No new unauthenticated mutation endpoints.
- No credentials/tokens returned in responses or logs.
- No new filesystem paths accepted without strict sanitization.
- No unescaped user-controlled content inserted into HTML attributes or inline event handlers.

## Change Style
- Prefer small commits and isolated diffs.
- Add brief comments only where logic is non-obvious.
- Avoid broad refactors unless explicitly requested.
