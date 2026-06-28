# Stellar Wallet Signature Format

This document describes the Stellar Ed25519 signature format required for mutating API routes.

## Overview

Any route that creates or updates creator data requires proof that the request comes from the wallet owner. The server verifies an Ed25519 signature computed over the request body and timestamp.

## Required Headers

All protected routes require three headers:

- **`x-wallet-address`**: Stellar public key (56 characters, starts with `G`, Base32 encoded)
- **`x-wallet-signature`**: Base64-encoded Ed25519 signature (64 bytes)
- **`x-timestamp`**: Unix timestamp in milliseconds (must be within 5 minutes of server time)

## Signing Process

### 1. Prepare the Request Body

Serialize your request body to JSON (no extra whitespace, consistent ordering):

```javascript
const body = {
  displayName: "Alice Creator",
  bio: "Building the future on Stellar"
};
const bodyJson = JSON.stringify(body);
```

### 2. Get Current Timestamp

```javascript
const timestamp = Date.now().toString();
```

### 3. Build the Canonical Message

Concatenate the body JSON and timestamp, then hash with SHA-256:

```javascript
const crypto = require('crypto');
const payload = bodyJson + timestamp;
const message = crypto.createHash('sha256').update(payload, 'utf8').digest();
```

### 4. Sign with Your Stellar Keypair

Use the Stellar SDK to sign the message:

```javascript
const { Keypair } = require('@stellar/stellar-base');

// Load your secret key (never share this!)
const keypair = Keypair.fromSecret('S...');

// Sign the message
const signature = keypair.sign(message);

// Encode as Base64
const signatureBase64 = signature.toString('base64');
```

### 5. Send the Request

```javascript
const response = await fetch('https://api.accesslayer.org/api/v1/creators/:creatorId/profile', {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'x-wallet-address': keypair.publicKey(),
    'x-wallet-signature': signatureBase64,
    'x-timestamp': timestamp,
  },
  body: bodyJson,
});
```

## Complete Example

```javascript
const { Keypair } = require('@stellar/stellar-base');
const crypto = require('crypto');
const fetch = require('node-fetch');

async function signedRequest(creatorId, body, secretKey) {
  const keypair = Keypair.fromSecret(secretKey);
  const timestamp = Date.now().toString();
  const bodyJson = JSON.stringify(body);
  
  // Build canonical message
  const payload = bodyJson + timestamp;
  const message = crypto.createHash('sha256').update(payload, 'utf8').digest();
  
  // Sign
  const signature = keypair.sign(message);
  const signatureBase64 = signature.toString('base64');
  
  // Send
  const response = await fetch(
    `https://api.accesslayer.org/api/v1/creators/${creatorId}/profile`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-wallet-address': keypair.publicKey(),
        'x-wallet-signature': signatureBase64,
        'x-timestamp': timestamp,
      },
      body: bodyJson,
    }
  );
  
  return response.json();
}

// Usage
const result = await signedRequest(
  'clxxx123',
  { displayName: 'Alice', bio: 'Creator on Stellar' },
  'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
);
```

## Error Responses

### 401 Unauthorized — Missing Headers

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing required signature headers: x-wallet-address, x-wallet-signature, x-timestamp"
  }
}
```

### 401 Unauthorized — Expired Timestamp

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Signature timestamp is invalid or expired (must be within 5 minutes)"
  }
}
```

### 403 Forbidden — Invalid Signature

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid signature — the request body was tampered with or signed by the wrong key"
  }
}
```

### 400 Bad Request — Malformed Address

```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid Stellar wallet address format"
  }
}
```

## Security Notes

- **Never share your secret key.** Keep it secure and never commit it to version control.
- **Timestamp tolerance is 5 minutes.** This prevents replay attacks while allowing for reasonable clock skew.
- **Body tampering is detected.** Any modification to the request body after signing will cause verification to fail.
- **Signatures are single-use.** Each request must be signed with a fresh timestamp.

## Protected Routes

The following routes require Stellar signature verification:

- `PUT /api/v1/creators/:creatorId/profile` — Update creator profile
- *(Future routes will be added here as they are protected)*

## Testing

For local development and testing, you can use the Stellar test network and generate test keypairs:

```javascript
const { Keypair } = require('@stellar/stellar-base');
const testKeypair = Keypair.random();
console.log('Public Key:', testKeypair.publicKey());
console.log('Secret Key:', testKeypair.secret());
```

Always use test credentials in development and never use production keys in test environments.
