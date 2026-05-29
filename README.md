# Ghost Link 👻

A privacy-focused encrypted messaging platform built for people who actually care about their data. No phone numbers. No data mining. Just end-to-end encrypted conversations under a random Ghost ID.

---

## What is this?

Ghost Link is a real-time chat app where everything is encrypted on your device before it ever touches the server. We can't read your messages. Nobody can. The server just relays sealed envelopes — it never sees what's inside.

Built during a 48-hour hackathon.

---

## Features

- **Zero-Knowledge E2EE** — RSA + AES encryption handled entirely client-side using the Web Crypto API. The server stores only encrypted blobs.
- **Anonymous Ghost IDs** — No email, no phone number required. Roll a random ID and you're in.
- **Real-Time Messaging** — WebSocket-powered via Socket.io. Messages arrive instantly.
- **Encrypted Media Sharing** — Images and files are encrypted as base64 before they leave your browser.
- **Screenshot Shield** — Detects PrintScreen, Cmd+Shift+3/4, and window blur events. Instantly hides the chat and alerts your peer.
- **Consent-Based Forwarding** — Want to forward a message? The original sender has to approve it first. Cryptographically enforced.
- **Group Chats** — Supports multi-member rooms with per-member key wrapping.
- **Dark Mode** — Because obviously.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | HTML, CSS, Vanilla JS, Web Crypto API |
| Backend | Node.js, Express |
| Real-time | Socket.io |
| Crypto | RSA-OAEP + AES-GCM (via WebCrypto) |
| Storage | In-memory / SQLite (via `database.js`) |

---

## Getting Started

### Prerequisites

- Node.js v18+
- npm

### Installation

```bash
git clone https://github.com/parthxpg/ghost-link.git
cd ghost-link/backend
npm install
```

### Run the server

```bash
node server.js
```

Then open your browser and go to `http://localhost:3000`.

---

## How It Works

1. When you log in, your browser generates an RSA key pair locally.
2. The **public key** is registered on the server. The **private key never leaves your device**.
3. When you send a message, a fresh AES key is generated, used to encrypt the message, then the AES key itself is wrapped with each recipient's RSA public key.
4. The server stores the encrypted payload + wrapped keys. It cannot decrypt either.
5. On the receiving end, the recipient uses their private RSA key to unwrap the AES key, then decrypts the message.

The forwarding system works the same way — if Alice wants to forward Bob's message to Charlie, Bob gets a prompt, and only if Bob approves does Alice receive a re-wrapped key to do the forward.

---

## Project Structure

```
ghost-link/
├── frontend/
│   ├── index.html
│   ├── app.js        # UI logic, socket handling, chat flows
│   ├── crypto.js     # All cryptographic operations
│   └── styles.css
├── backend/
│   ├── server.js     # Express + Socket.io server
│   ├── database.js   # In-memory data layer
│   └── package.json
```

---

## Known Limitations

- Private keys are stored in memory only — refreshing the page means you lose access to old messages (by design, honestly).
- Screenshot detection is best-effort on desktop browsers. Mobile is limited.
- Google login is currently a mock — it generates a Ghost ID from a random suffix. OAuth not wired up yet.
- No message persistence across sessions (zero-knowledge tradeoff).

---

## Contributing

PRs welcome. If you find a crypto flaw, please open an issue rather than exploiting it.

---

## License

MIT
