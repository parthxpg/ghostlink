/**
 * Ghost Link Cryptographic Engine
 * 
 * Implements pure Zero-Knowledge End-to-End Encryption (E2EE) using the 
 * browser's native window.crypto.subtle API.
 * 
 * Protocols:
 * - Asymmetric Key Encapsulation: RSA-OAEP (2048-bit keys)
 * - Digital Signature (Authenticity): RSA-PSS (2048-bit keys)
 * - Symmetric Bubble Encryption: AES-GCM (256-bit keys)
 * - Key Chaining Ratchet: SHA-256 PBKDF2 / Chaining function for sequential forward secrecy.
 */

class GhostCrypto {
  constructor() {
    this.keyPairs = null; // Stores { rsaEncryptionKeyPair, rsaSigningKeyPair }
  }

  // --- Utility Base64 Converters ---
  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // --- Keypair Initialization ---
  async generateIdentityKeyPairs() {
    // 1. Generate RSA-OAEP encryption key pair
    const encryptionKeyPair = await window.crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true, // extractable
      ["encrypt", "decrypt", "wrapKey", "unwrapKey"]
    );

    // 2. Generate RSA-PSS signing key pair
    const signingKeyPair = await window.crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true, // extractable
      ["sign", "verify"]
    );

    this.keyPairs = {
      encryption: encryptionKeyPair,
      signing: signingKeyPair
    };

    // Export public keys in JWK format to send to the server
    const publicEncryptionJWK = await window.crypto.subtle.exportKey("jwk", encryptionKeyPair.publicKey);
    const publicSigningJWK = await window.crypto.subtle.exportKey("jwk", signingKeyPair.publicKey);

    return {
      publicEncryptionJWK,
      publicSigningJWK
    };
  }

  // --- Symmetric Bubble Encryption (AES-GCM-256) ---
  async generateSymmetricKey() {
    return await window.crypto.subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256
      },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async encryptBubble(plaintext, aesKey) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(plaintext);

    const ciphertextBuffer = await window.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv
      },
      aesKey,
      encodedData
    );

    return {
      ciphertext: this.arrayBufferToBase64(ciphertextBuffer),
      iv: this.arrayBufferToBase64(iv)
    };
  }

  async decryptBubble(ciphertextBase64, ivBase64, aesKey) {
    const ciphertext = this.base64ToArrayBuffer(ciphertextBase64);
    const iv = this.base64ToArrayBuffer(ivBase64);

    try {
      const decryptedBuffer = await window.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv
        },
        aesKey,
        ciphertext
      );

      const decoder = new TextDecoder();
      return decoder.decode(decryptedBuffer);
    } catch (err) {
      console.error("Bubble Decryption failed: ", err);
      throw new Error("Failed to decrypt bubble. Keys do not match or integrity compromised.");
    }
  }

  // --- Key Wrapping & Crossing (Mingle Scheme) ---
  // Wraps (encrypts) the message symmetric key for a target peer using their public key bundle
  async wrapMessageKey(aesKey, targetPublicEncryptionJWK) {
    const publicKey = await window.crypto.subtle.importKey(
      "jwk",
      targetPublicEncryptionJWK,
      {
        name: "RSA-OAEP",
        hash: "SHA-256"
      },
      true,
      ["wrapKey"]
    );

    const wrappedBuffer = await window.crypto.subtle.wrapKey(
      "raw",
      aesKey,
      publicKey,
      "RSA-OAEP"
    );

    return this.arrayBufferToBase64(wrappedBuffer);
  }

  // Unwraps (decrypts) the message key using our private key
  async unwrapMessageKey(wrappedKeyBase64) {
    if (!this.keyPairs) throw new Error("Keypair not loaded");

    const wrappedBuffer = this.base64ToArrayBuffer(wrappedKeyBase64);

    return await window.crypto.subtle.unwrapKey(
      "raw",
      wrappedBuffer,
      this.keyPairs.encryption.privateKey,
      "RSA-OAEP",
      {
        name: "AES-GCM",
        length: 256
      },
      true,
      ["encrypt", "decrypt"]
    );
  }

  // --- Signature Engine (Authenticity Verification) ---
  async signPayload(payloadString) {
    if (!this.keyPairs) throw new Error("Keypair not loaded");

    const encoder = new TextEncoder();
    const data = encoder.encode(payloadString);

    const signatureBuffer = await window.crypto.subtle.sign(
      {
        name: "RSA-PSS",
        saltLength: 32
      },
      this.keyPairs.signing.privateKey,
      data
    );

    return this.arrayBufferToBase64(signatureBuffer);
  }

  async verifySignature(payloadString, signatureBase64, signerPublicSigningJWK) {
    const signerPublicKey = await window.crypto.subtle.importKey(
      "jwk",
      signerPublicSigningJWK,
      {
        name: "RSA-PSS",
        hash: "SHA-256"
      },
      true,
      ["verify"]
    );

    const signature = this.base64ToArrayBuffer(signatureBase64);
    const encoder = new TextEncoder();
    const data = encoder.encode(payloadString);

    return await window.crypto.subtle.verify(
      {
        name: "RSA-PSS",
        saltLength: 32
      },
      signerPublicKey,
      signature,
      data
    );
  }

  // --- Advanced Key Chaining Ratchet ---
  // Chains a base symmetric key sequentially to derive the next session key.
  // This guarantees forward secrecy: if key N is leaked, past message keys N-1 cannot be computed.
  async deriveNextKey(currentKeyRawBuffer, sequenceIndex) {
    const encoder = new TextEncoder();
    const salt = encoder.encode("GhostLinkRatchetChainingKeySalt");
    const info = encoder.encode(`sequence-${sequenceIndex}`);

    // Import base raw key material
    const baseKeyMaterial = await window.crypto.subtle.importKey(
      "raw",
      currentKeyRawBuffer,
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    // Derive the next 256-bit AES key in sequence
    return await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100,
        hash: "SHA-256"
      },
      baseKeyMaterial,
      {
        name: "AES-GCM",
        length: 256
      },
      true,
      ["encrypt", "decrypt"]
    );
  }
  /** Persist key pairs to localStorage under a user-specific key */
  async saveKeys(username) {
    try {
      const privEncJWK  = await window.crypto.subtle.exportKey('jwk', this.keyPairs.encryption.privateKey);
      const pubEncJWK   = await window.crypto.subtle.exportKey('jwk', this.keyPairs.encryption.publicKey);
      const privSignJWK = await window.crypto.subtle.exportKey('jwk', this.keyPairs.signing.privateKey);
      const pubSignJWK  = await window.crypto.subtle.exportKey('jwk', this.keyPairs.signing.publicKey);
      localStorage.setItem(`gl_keys_${username}`, JSON.stringify({
        privEncJWK, pubEncJWK, privSignJWK, pubSignJWK
      }));
    } catch (e) {
      console.warn('Could not persist keys:', e);
    }
  }

  /** Load and restore key pairs from localStorage. Returns public JWKs on success, null if not found. */
  async loadKeys(username) {
    try {
      const stored = localStorage.getItem(`gl_keys_${username}`);
      if (!stored) return null;
      const { privEncJWK, pubEncJWK, privSignJWK, pubSignJWK } = JSON.parse(stored);

      const encPrivKey = await window.crypto.subtle.importKey(
        'jwk', privEncJWK,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        true, ['decrypt', 'unwrapKey']
      );
      const encPubKey = await window.crypto.subtle.importKey(
        'jwk', pubEncJWK,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        true, ['encrypt', 'wrapKey']
      );
      const signPrivKey = await window.crypto.subtle.importKey(
        'jwk', privSignJWK,
        { name: 'RSA-PSS', hash: 'SHA-256' },
        true, ['sign']
      );
      const signPubKey = await window.crypto.subtle.importKey(
        'jwk', pubSignJWK,
        { name: 'RSA-PSS', hash: 'SHA-256' },
        true, ['verify']
      );

      this.keyPairs = {
        encryption: { privateKey: encPrivKey, publicKey: encPubKey },
        signing:    { privateKey: signPrivKey, publicKey: signPubKey }
      };

      return { publicEncryptionJWK: pubEncJWK, publicSigningJWK: pubSignJWK };
    } catch (e) {
      console.warn('Could not restore keys:', e);
      return null;
    }
  }
}

const cryptoEngine = new GhostCrypto();
