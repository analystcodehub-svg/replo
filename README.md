# Female Expert Node.js Client

A standalone Node.js console & WebRTC audio client for Female Experts.

## Features
- **Instant Login**: Type or select any Female UID to log in.
- **Presence Management**: Automatically updates `status`, `queues`, and `expert_buckets` in Firebase Realtime Database to `online` and `available`.
- **Real-Time Messaging**:
  - Automatically receives incoming messages from callers.
  - Displays messages in the terminal and Web panel.
  - Sends immediate delivery ACKs (Double Blue Ticks) to the caller.
  - Credits live message earnings (+₹0.10) to the expert's account.
  - Send messages using `/send <uid> <message>`, quick reply with `/r <message>`, or use `/chat <uid>`.
- **Real-Time Incoming Calls**:
  - Detects incoming audio calls from male callers.
  - Ringing sound & prominent alert banner with caller name, coin balance, and rate.
  - Accept call (`a` or `/accept`), Reject (`r` or `/reject`), End (`e` or `/end`).
  - Native WebRTC Audio (Voicemod / WO Mic / Default mic) supported via the local web dashboard at `http://localhost:3000`.
  - Automatically logs call duration and earnings upon completion.

## How to Start

### Option 1: Double-Click Launcher
Double-click `start.bat` inside this folder, or `Start_Female_Node.bat` on your Desktop.

### Option 2: Command Line
Open Command Prompt in this folder and run:
```cmd
node index.js
```

## WebRTC Audio Dashboard
While the console is running, open `http://localhost:3000` in any browser (Chrome, Edge, etc.) for a visual dashboard with live 2-way microphone & speaker WebRTC audio!

## Commands
| Command | Description |
|---|---|
| `a` or `/accept` | Answer incoming call |
| `r` or `/reject` | Reject incoming call |
| `e` or `/end` | Hang up active call |
| `/send <uid> <message>` | Send a message to a user UID |
| `/r <message>` | Quick reply to last user who contacted you |
| `/chat <uid>` | Focus chat with a specific user |
| `/stats` | View live balance, earnings, and talk time |
| `/users` | List recent male users in the system |
| `/web` | View WebRTC panel URL |
| `/clear` | Clear the terminal screen |
| `/help` | Show command cheat sheet |
| `/exit` | Disconnect, go offline, and quit |
