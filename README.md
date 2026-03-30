# 🟣 Twitch Clip Reviewer

A full-stack web application designed for streamers and editors to efficiently browse, filter, and prepare Twitch clips for cross-platform sharing (e.g., TikTok). It features a robust multi-user system, advanced cropping tools, and automated clip fetching.

## 🚀 Key Features

* **Multi-User Authentication**: Secure login system using `scrypt` password hashing and session management.
* **Twitch API Integration**: Automatically fetches clips for specific broadcasters based on view count and age.
* **Advanced Video Cropping**: Interactive UI for defining "Cam" and "Gameplay" regions, including support for name badges and split-segment editing.
* **Database-Driven Management**: Uses SQLite to track clip approval status, sorting, and custom crop configurations per user.
* **Live Preview**: Real-time rendering of crop layouts directly in the browser using HTML5 Canvas and video metadata.
* **Bulk Processing**: Support for "Upload Jobs" to handle batch video tasks or background processing.

## 🛠️ Tech Stack

* **Backend**: Node.js, Express, TypeScript
* **Frontend**: HTML5, Tailwind CSS, Vanilla JavaScript
* **Database**: SQLite (`node:sqlite` for synchronous operations)
* **Video Processing**: `yt-dlp` (via child process) for video retrieval
* **APIs**: Twitch GQL/Helix, TikTok Open API

## 📋 Prerequisites

* **Node.js** (v18+ recommended for `node:sqlite` support)
* **yt-dlp**: Must be installed and available in your PATH for video fetching.
* **Twitch Developer Account**: To obtain a Client ID and Secret.

## ⚙️ Installation & Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/Nayu-bae/clip-reviewer-streamer.git
    cd twitch-clip-reviewer
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

   3.  **Configure Environment Variables:**
       Create a `.env` file in the root directory and add your credentials:
       ```env
       PORT=3000
       TWITCH_CLIENT_ID=your_id
       TWITCH_CLIENT_SECRET=your_secret
       TIKTOK_CLIENT_KEY=your_id
       TIKTOK_CLIENT_SECRET=your_secret
       YTDLP_BIN=yt-dlp
       # Optional config
       MIN_CLIP_VIEWS=10
       TWITCH_CLIPS_LOOKBACK_DAYS=90
       EMAIL_API_KEY=your_email_api_key
       MAIL_FROM=no-reply@email.address.com
       APP_BASE_URL=https://baseurl.com
    ```

4.  **Run the application:**
    ```bash
    # Development mode
    npm run dev

    # Production mode
    npm run build
    npm start
    ```

## 🖥️ Usage

1.  **Login/Register**: Create an account to start managing your own list of streamers.
2.  **Add Streamers**: Link Twitch broadcaster IDs to your profile to begin fetching clips.
3.  **Review Clips**: Use the dashboard to approve or "sort out" clips based on their quality.
4.  **Crop & Edit**: Click on a clip to open the editor. Drag and resize the Cam and Gameplay boxes to fit your desired vertical format.
5.  **Export**: Approved and cropped clips are saved in the database, ready for automated upload or manual export.

---

### Project Structure
* `server.ts`: The core Express server handling API routes, Twitch/TikTok integration, and SQLite database logic.
* `index.html`: The single-page application (SPA) frontend containing the UI, Tailwind configurations, and complex cropping logic.
