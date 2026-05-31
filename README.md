<p align="center">
  <img src="frontend/logo.png" alt="Ghost Link Logo" width="200" />
</p>

<h1 align="center">Ghost Link</h1>

**Live Demo:** [https://ghostlink-5cmb.onrender.com/](https://ghostlink-5cmb.onrender.com/)

A high-performance, zero-knowledge messaging platform engineered for minimum latency via persistent WebSockets. Ghost Link delivers state-of-the-art End-to-End Encryption (E2EE) and granular, cryptographic privacy controls without compromising on real-time speed or user experience. No phone numbers. No data mining. Just totally secure conversations under a random Ghost ID.

---

## What is this?

Ghost Link is a low-latency, decentralized-identity secure communication protocol. We leverage WebSockets for real-time bi-directional data transfer, protected by a zero-knowledge E2EE architecture utilizing client-side key exchange and AES-GCM payload wrapping. This ensures absolute data sovereignty and cryptographic privacy. The server acts merely as a blind router — it never sees what's inside your messages.

---

## Features

- **Zero-Knowledge E2EE** — Encryption handled entirely client-side using the Web Crypto API. The server stores only encrypted blobs.
- **Anonymous Ghost IDs** — No email, no phone number required. Roll a random ID and you're in.
- **Ultra-Low Latency** — WebSocket-powered via Socket.io. Messages arrive instantly.
- **Granular Privacy Controls** — Control who sees your profile, your last seen status, and who can add you to groups.
- **Secure Forwarding** — Cryptographically enforced forwarding. If you disable forwarding in your privacy settings, the cryptographic handshakes required to forward your message are automatically denied. 
- **Screenshot Shield** — Detects PrintScreen, Cmd+Shift+3/4, and window blur events. Instantly hides the chat and alerts your peer.
- **Group Chats with Admin Roles** — Supports multi-member rooms with per-member key wrapping, complete with group bios and moderation roles (kicking/deleting).
- **Encrypted Media Sharing** — Images and files are encrypted as base64 before they leave your browser.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | HTML, CSS, Vanilla JS, Web Crypto API |
| Backend | Node.js, Express |
| Real-time | Socket.io |
| Crypto | RSA-OAEP + AES-GCM (via WebCrypto API) |
| Storage | MongoDB Atlas (via Mongoose) |

---

## Getting Started

Ghost Link is built as a monolith where the Node.js backend automatically hosts and serves the frontend. **You do not need to deploy the frontend separately.**

### Prerequisites

- Node.js v18+
- npm
- A MongoDB cluster URL

### Installation

1. Clone the repository:
```bash
git clone https://github.com/parthxpg/ghostlink.git
cd ghostlink/backend
```

2. Install dependencies:
```bash
npm install
```

3. Setup your environment variables in a `.env` file in the `backend` folder:
```env
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
```

### Run the server locally

```bash
npm run dev
```

Then open your browser and go to `http://localhost:3000`.

---

## How It Works

1. When you log in, your browser generates a cryptographic key pair locally.
2. The **public key** is registered on the server. The **private key never leaves your device**.
3. When you send a message, a fresh AES symmetric key is generated. This key is used to encrypt the message, and then the AES key itself is wrapped (encrypted) with each recipient's public key.
4. The server stores the encrypted payload + wrapped keys. It cannot decrypt either.
5. On the receiving end, the recipient uses their local private key to unwrap the AES key, and then decrypts the actual message.

---

## Project Structure

```
ghostlink/
├── frontend/
│   ├── index.html
│   ├── app.js        # UI logic, socket handling, chat flows
│   ├── crypto.js     # All cryptographic operations
│   └── styles.css
├── backend/
│   ├── server.js     # Express + Socket.io server (also serves frontend static files)
│   ├── database.js   # MongoDB data layer
│   └── package.json
```

---

## Contributing

PRs welcome. If you find a crypto flaw, please open an issue rather than exploiting it.

---

## License

MIT
